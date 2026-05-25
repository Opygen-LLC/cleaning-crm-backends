import { prisma } from "../../lib/prisma/prisma";
import { LeaveStatus, UserRole } from "../../generated/prisma/enums";
import AppError from "../../errorHelper/AppError";
import status from "http-status";


const requireStaffProfile = async (userId: string) => {
    const staff = await prisma.staffProfile.findFirst({ where: { userId } });
    if (!staff) throw new AppError(status.NOT_FOUND, "Staff profile not found");
    return staff;
};

const requireAdminProfile = async (userId: string) => {
    const admin = await prisma.adminProfile.findFirst({ where: { userId } });
    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");
    return admin;
};

// ─── Staff: request leave ─────────────────────────────────────────────────────

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
        throw new AppError(
            status.BAD_REQUEST,
            "End date must be after start date",
        );
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

    return leave;
};

// ─── Staff: get own leave requests ───────────────────────────────────────────

const getMyLeaves = async (userId: string) => {
    const staff = await requireStaffProfile(userId);

    const leaves = await prisma.staffLeave.findMany({
        where: { staffId: staff.id },
        orderBy: { createdAt: "desc" },
    });

    return leaves;
};

// ─── Staff: cancel a pending leave request ───────────────────────────────────

const cancelLeave = async (userId: string, leaveId: string) => {
    const staff = await requireStaffProfile(userId);

    const leave = await prisma.staffLeave.findUnique({
        where: { id: leaveId },
    });

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

    return { success: true };
};

// ─── Admin: get all leave requests for their staff ────────────────────────────

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
            staff: {
                include: {
                    user: { select: { name: true, image: true } },
                },
            },
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

// ─── Admin: approve or decline a leave request ───────────────────────────────

const reviewLeave = async (
    adminUserId: string,
    leaveId: string,
    payload: { decision: "APPROVED" | "DECLINED"; adminNote?: string },
) => {
    const admin = await requireAdminProfile(adminUserId);

    const leave = await prisma.staffLeave.findUnique({
        where: { id: leaveId },
        include: { staff: true },
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

    return updated;
};

export const staffLeaveService = {
    requestLeave,
    getMyLeaves,
    cancelLeave,
    getStaffLeaves,
    reviewLeave,
};
