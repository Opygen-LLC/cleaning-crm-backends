import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { prisma } from "../../lib/prisma/prisma";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { Prisma } from "../../generated/prisma/client";
import type { IRequestUser } from "../../types/requestUser.interface";
import type {
    LeadActivityStatusInput,
    LeadActivityTypeInput,
} from "./leadActivity.validation";

export interface LeadActivityCreatePayload {
    type: LeadActivityTypeInput;
    status?: LeadActivityStatusInput;
    scheduledAt?: string;
    assignedToUserId?: string | null;
    note?: string;
    outcome?: string;
}

export interface LeadActivityUpdatePayload {
    type?: LeadActivityTypeInput;
    status?: LeadActivityStatusInput;
    scheduledAt?: string | null;
    assignedToUserId?: string | null;
    note?: string | null;
    outcome?: string | null;
}

const CONTACT_TYPES: readonly LeadActivityTypeInput[] = [
    "CALL",
    "EMAIL",
    "FOLLOW_UP",
    "MEETING",
];

const activityInclude = {
    assignedTo: { select: { id: true, name: true, email: true } },
    creator: { select: { id: true, name: true, email: true } },
} as const;

const ensureLead = async (
    db: Pick<Prisma.TransactionClient, "lead">,
    adminId: string,
    leadId: string,
) => {
    const lead = await db.lead.findFirst({
        where: { id: leadId, adminId },
        select: { id: true },
    });
    if (!lead) throw new AppError(status.NOT_FOUND, "Lead not found");
};

const ensureAssignableUser = async (
    db: Pick<Prisma.TransactionClient, "user">,
    adminId: string,
    assignedToUserId?: string | null,
) => {
    if (!assignedToUserId) return;

    const assigned = await db.user.findFirst({
        where: {
            id: assignedToUserId,
            OR: [
                { admin: { is: { id: adminId } } },
                { staff: { is: { adminId } } },
            ],
        },
        select: { id: true },
    });

    if (!assigned) {
        throw new AppError(status.UNPROCESSABLE_ENTITY, "Assigned user does not belong to this business", {
            code: "LEAD_ACTIVITY_ASSIGNEE_INVALID",
            retryable: false,
            fieldErrors: { assignedToUserId: "Choose a user from this business." },
        });
    }
};

const recomputeLastContactedAt = async (
    tx: Prisma.TransactionClient,
    leadId: string,
) => {
    const latest = await tx.leadActivity.findFirst({
        where: {
            leadId,
            status: "COMPLETED",
            type: { in: [...CONTACT_TYPES] },
            completedAt: { not: null },
        },
        select: { completedAt: true },
        orderBy: { completedAt: "desc" },
    });

    await tx.lead.update({
        where: { id: leadId },
        data: { lastContactedAt: latest?.completedAt ?? null },
    });
};

const getActivities = async (leadId: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    await ensureLead(prisma, adminId, leadId);

    return prisma.leadActivity.findMany({
        where: { leadId, adminId },
        include: activityInclude,
        orderBy: [{ scheduledAt: "desc" }, { createdAt: "desc" }],
        take: 200,
    });
};

const createActivity = async (
    leadId: string,
    payload: LeadActivityCreatePayload,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    return prisma.$transaction(async (tx) => {
        await ensureLead(tx, adminId, leadId);
        await ensureAssignableUser(tx, adminId, payload.assignedToUserId);

        const activityStatus = payload.status ?? "PENDING";
        const activity = await tx.leadActivity.create({
            data: {
                adminId,
                leadId,
                type: payload.type,
                status: activityStatus,
                scheduledAt: payload.scheduledAt ? new Date(payload.scheduledAt) : null,
                completedAt: activityStatus === "COMPLETED" ? new Date() : null,
                assignedToUserId: payload.assignedToUserId ?? null,
                note: payload.note?.trim() || null,
                outcome: payload.outcome?.trim() || null,
                createdBy: user.id,
            },
            include: activityInclude,
        });

        await recomputeLastContactedAt(tx, leadId);
        return activity;
    });
};

const updateActivity = async (
    leadId: string,
    activityId: string,
    payload: LeadActivityUpdatePayload,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    return prisma.$transaction(async (tx) => {
        await ensureLead(tx, adminId, leadId);
        const existing = await tx.leadActivity.findFirst({
            where: { id: activityId, leadId, adminId },
        });
        if (!existing) throw new AppError(status.NOT_FOUND, "Lead activity not found");

        if (payload.assignedToUserId !== undefined) {
            await ensureAssignableUser(tx, adminId, payload.assignedToUserId);
        }

        const nextStatus = payload.status ?? existing.status;
        const completedAt =
            nextStatus === "COMPLETED"
                ? existing.completedAt ?? new Date()
                : null;

        const activity = await tx.leadActivity.update({
            where: { id: activityId },
            data: {
                ...(payload.type !== undefined ? { type: payload.type } : {}),
                ...(payload.status !== undefined ? { status: payload.status, completedAt } : {}),
                ...(payload.scheduledAt !== undefined
                    ? { scheduledAt: payload.scheduledAt ? new Date(payload.scheduledAt) : null }
                    : {}),
                ...(payload.assignedToUserId !== undefined
                    ? { assignedToUserId: payload.assignedToUserId }
                    : {}),
                ...(payload.note !== undefined ? { note: payload.note?.trim() || null } : {}),
                ...(payload.outcome !== undefined ? { outcome: payload.outcome?.trim() || null } : {}),
            },
            include: activityInclude,
        });

        await recomputeLastContactedAt(tx, leadId);
        return activity;
    });
};

const deleteActivity = async (
    leadId: string,
    activityId: string,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    await prisma.$transaction(async (tx) => {
        await ensureLead(tx, adminId, leadId);
        const existing = await tx.leadActivity.findFirst({
            where: { id: activityId, leadId, adminId },
            select: { id: true },
        });
        if (!existing) return;

        await tx.leadActivity.delete({ where: { id: activityId } });
        await recomputeLastContactedAt(tx, leadId);
    });
};

export const leadActivityService = {
    getActivities,
    createActivity,
    updateActivity,
    deleteActivity,
};
