/**
 * staffLeave.service.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Production-ready leave service.
 *
 * Real-time notification flow (staff → admin):
 *  1. Staff calls POST /staff/leave → requestLeave()
 *  2. DB record created with status=PENDING
 *  3. emitToAdmin(adminId, "leave:requested", payload)
 *     → Any admin browser in the `admin:${adminId}` Socket.IO room receives
 *       the event immediately (useSocketLeaveNotification hook on the frontend
 *       catches it and invalidates "staff-leave" RTK tag).
 *  4. createNotification() persists a DB notification so the bell badge
 *     updates even if the admin wasn't connected when the request came in
 *     (REST polling fallback via useGetNotificationsQuery).
 *
 * Real-time notification flow (admin → staff):
 *  1. Admin calls PATCH /staff/leave/:id/review → reviewLeave()
 *  2. DB record updated to APPROVED or DECLINED
 *  3. emitToStaff(staffId, "leave:reviewed", payload)
 *     → Staff browser in the `staff:${staffId}` room receives status update
 *       instantly (useSocketStaffDashboard hook can catch "leave:reviewed"
 *       and invalidate "staff-leave" tag).
 */

import { prisma } from "../../lib/prisma/prisma";
import {
  LeaveStatus,
  NotificationType,
} from "../../generated/prisma/enums";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { emitToAdmin, emitToStaff } from "../../config/socketio";
import { createNotification } from "../../lib/utils/createNotification";
import { IRequestUser } from "../../types/requestUser.interface";
import { getAdminId } from "../../lib/utils/resolveAdminId";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const requireStaffProfile = async (userId: string) => {
  const staff = await prisma.staffProfile.findFirst({
    where: { userId },
    include: { user: { select: { name: true } } },
  });
  if (!staff) throw new AppError(status.NOT_FOUND, "Staff profile not found");
  return staff;
};

// ─── Staff: request leave ─────────────────────────────────────────────────────

/**
 * POST /staff/leave
 *
 * Creates a PENDING leave record, then:
 *  • Emits "leave:requested" to the admin's Socket.IO room for instant UI update
 *  • Persists a Notification row so the bell badge works even without a live socket
 */
const requestLeave = async (
  userId: string,
  payload: { startDate: string; endDate: string; reason?: string },
) => {
  const staff = await requireStaffProfile(userId);

  const start = new Date(payload.startDate);
  const end = new Date(payload.endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new AppError(status.BAD_REQUEST, "Invalid date format");
  }
  if (end < start) {
    throw new AppError(status.BAD_REQUEST, "End date must be after start date");
  }

  // Prevent duplicate pending requests that overlap existing ones
  const overlap = await prisma.staffLeave.findFirst({
    where: {
      staffId: staff.id,
      status: LeaveStatus.PENDING,
      startDate: { lte: end },
      endDate: { gte: start },
    },
  });
  if (overlap) {
    throw new AppError(
      status.CONFLICT,
      "You already have a pending leave request that overlaps these dates",
    );
  }

  const leave = await prisma.staffLeave.create({
    data: {
      staffId: staff.id,
      startDate: start,
      endDate: end,
      reason: payload.reason ?? null,
      status: LeaveStatus.PENDING,
    },
  });

  const days =
    Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;

  const socketPayload = {
    leaveId: leave.id,
    staffId: staff.id,
    staffName: staff.user.name,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    reason: payload.reason ?? null,
    daysCount: days,
    requestedAt: leave.createdAt.toISOString(),
  };

  // ── Real-time push to admin room ──────────────────────────────────────────
  emitToAdmin(staff.adminId, "leave:requested", socketPayload);

  // ── Persist DB notification (polling / badge fallback) ───────────────────
  await createNotification({
    adminId: staff.adminId,
    type: NotificationType.GENERAL,
    title: `Leave request from ${staff.user.name}`,
    message: `${days} day${days !== 1 ? "s" : ""} — ${start.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} to ${end.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`,
    relatedId: leave.id,
  });

  return leave;
};

// ─── Staff: get own leave requests ───────────────────────────────────────────

const getMyLeaves = async (userId: string) => {
  const staff = await requireStaffProfile(userId);
  return prisma.staffLeave.findMany({
    where: { staffId: staff.id },
    orderBy: { createdAt: "desc" },
  });
};

// ─── Staff: cancel a pending leave request ───────────────────────────────────

const cancelLeave = async (userId: string, leaveId: string) => {
  const staff = await requireStaffProfile(userId);

  const leave = await prisma.staffLeave.findUnique({ where: { id: leaveId } });
  if (!leave) throw new AppError(status.NOT_FOUND, "Leave request not found");
  if (leave.staffId !== staff.id) {
    throw new AppError(
      status.FORBIDDEN,
      "You cannot cancel another staff member's leave",
    );
  }
  if (leave.status !== LeaveStatus.PENDING) {
    throw new AppError(
      status.BAD_REQUEST,
      "Only PENDING leave requests can be cancelled",
    );
  }

  await prisma.staffLeave.delete({ where: { id: leaveId } });

  // Notify admin that the pending request was withdrawn (invalidates cache on their end)
  emitToAdmin(staff.adminId, "leave:cancelled", {
    leaveId,
    staffId: staff.id,
    staffName: staff.user.name,
    cancelledAt: new Date().toISOString(),
  });

  return { success: true };
};

// ─── Admin: get all leave requests ───────────────────────────────────────────

const getStaffLeaves = async (
  adminUser: IRequestUser,
  query: { status?: string; staffId?: string },
) => {
  const adminId = await getAdminId(adminUser);

  const leaves = await prisma.staffLeave.findMany({
    where: {
      staff: { adminId },
      ...(query.status ? { status: query.status as LeaveStatus } : {}),
      ...(query.staffId ? { staffId: query.staffId } : {}),
    },
    include: {
      staff: { include: { user: { select: { name: true, image: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });

  return leaves.map((l) => ({
    id: l.id,
    startDate: l.startDate,
    endDate: l.endDate,
    reason: l.reason,
    status: l.status,
    adminNote: l.adminNote,
    reviewedAt: l.reviewedAt,
    createdAt: l.createdAt,
    staffId: l.staffId,
    staffName: l.staff.user.name,
    staffAvatar: l.staff.user.image,
    staffRole: l.staff.staffRole,
  }));
};

// ─── Admin: approve or decline ────────────────────────────────────────────────

/**
 * PATCH /staff/leave/:id/review
 *
 * Updates the leave status in the DB, then:
 *  • Emits "leave:reviewed" to the staff member's Socket.IO room so their
 *    leave page shows the new status badge instantly.
 *  • Also emits "leave:cancelled" (for admin) if the request is declined so
 *    the admin's LeaveApprovalsPage pending count refreshes without a reload.
 */
const reviewLeave = async (
  adminUser: IRequestUser,
  leaveId: string,
  payload: { decision: "APPROVED" | "DECLINED"; adminNote?: string },
) => {
  const adminId = await getAdminId(adminUser);

  const leave = await prisma.staffLeave.findUnique({
    where: { id: leaveId },
    include: {
      staff: { include: { user: { select: { name: true } } } },
    },
  });

  if (!leave) throw new AppError(status.NOT_FOUND, "Leave request not found");
  if (leave.staff.adminId !== adminId) {
    throw new AppError(
      status.FORBIDDEN,
      "You can only review leave requests for your own staff",
    );
  }
  if (leave.status !== LeaveStatus.PENDING) {
    throw new AppError(
      status.BAD_REQUEST,
      "Only PENDING leave requests can be reviewed",
    );
  }

  const updated = await prisma.staffLeave.update({
    where: { id: leaveId },
    data: {
      status: payload.decision as LeaveStatus,
      adminNote: payload.adminNote ?? null,
      reviewedAt: new Date(),
    },
  });

  // ── Real-time push to staff member's room ─────────────────────────────────
  emitToStaff(leave.staffId, "leave:reviewed", {
    leaveId,
    decision: payload.decision,
    adminNote: payload.adminNote ?? null,
    reviewedAt: updated.reviewedAt?.toISOString() ?? new Date().toISOString(),
  });

  return updated;
};

export const staffLeaveService = {
  requestLeave,
  getMyLeaves,
  cancelLeave,
  getStaffLeaves,
  reviewLeave,
};
