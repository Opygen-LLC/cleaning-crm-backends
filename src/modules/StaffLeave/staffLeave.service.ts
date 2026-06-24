import { prisma } from "../../lib/prisma/prisma";
import {
  LeaveStatus,
  NotificationType,
  UserRole,
} from "../../generated/prisma/enums";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { emitToAdmin, emitToStaff } from "../../config/socketio";
import { createNotification } from "../../lib/utils/createNotification";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const requireStaffProfile = async (userId: string) => {
  const staff = await prisma.staffProfile.findFirst({
    where: { userId },
    include: { user: { select: { name: true } } },
  });
  if (!staff) throw new AppError(status.NOT_FOUND, "Staff profile not found");
  return staff;
};

const requireAdminProfile = async (userId: string) => {
  const admin = await prisma.adminProfile.findFirst({ where: { userId } });
  if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");
  return admin;
};

// ─── Staff: request leave ─────────────────────────────────────────────────────

/**
 * POST /staff-leave/leave
 *
 * After saving the DB record, emits "leave:requested" to the admin's
 * Socket.IO room and persists a notification so the bell badge updates
 * instantly on the LeaveApprovalsPage without a manual refresh.
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

  const leave = await prisma.staffLeave.create({
    data: {
      staffId: staff.id,
      startDate: start,
      endDate: end,
      reason: payload.reason,
      status: LeaveStatus.PENDING,
    },
  });

  // ── Real-time: push to admin room ─────────────────────────────────────────
  const socketPayload = {
    leaveId: leave.id,
    staffId: staff.id,
    staffName: staff.user.name,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    reason: payload.reason ?? null,
    requestedAt: leave.createdAt.toISOString(),
  };

  emitToAdmin(staff.adminId, "leave:requested", socketPayload);

  // ── Persist notification (shows in admin bell + DB-backed) ────────────────
  const days =
    Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;

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

  // Notify admin that the pending request was withdrawn
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
  adminUserId: string,
  query: { status?: string; staffId?: string },
) => {
  const admin = await requireAdminProfile(adminUserId);

  const leaves = await prisma.staffLeave.findMany({
    where: {
      staff: { adminId: admin.id },
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
 * PATCH /staff-leave/leave/:id/review
 *
 * After updating the DB, emits "leave:reviewed" to the staff member's
 * Socket.IO room so their leave page status badge updates instantly.
 */
const reviewLeave = async (
  adminUserId: string,
  leaveId: string,
  payload: { decision: "APPROVED" | "DECLINED"; adminNote?: string },
) => {
  const admin = await requireAdminProfile(adminUserId);

  const leave = await prisma.staffLeave.findUnique({
    where: { id: leaveId },
    include: {
      staff: { include: { user: { select: { name: true } } } },
    },
  });

  if (!leave) throw new AppError(status.NOT_FOUND, "Leave request not found");
  if (leave.staff.adminId !== admin.id) {
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
      adminNote: payload.adminNote,
      reviewedAt: new Date(),
    },
  });

  // ── Real-time: push decision to the staff member's room ───────────────────
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
