import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import status from "http-status";
import { ServiceType, UserRole } from "../../generated/prisma/enums";
import { IRequestUser } from "../../types/requestUser.interface";

// ─── Identity resolvers ───────────────────────────────────────────────────────
//
// Both ADMIN and STAFF can read/tick job checklists, but they live in
// different profile tables. We resolve the right profile depending on the
// caller's role, and re-use a single authorisation helper that understands
// both paths.

/**
 * Resolve the StaffProfile for a STAFF user, then return both the profile id
 * and the adminId that the staff member belongs to.
 */
const resolveStaffProfile = async (
    userId: string,
): Promise<{ staffId: string; adminId: string }> => {
    const staff = await prisma.staffProfile.findUnique({ where: { userId } });
    if (!staff) throw new AppError(status.NOT_FOUND, "Staff profile not found");
    return { staffId: staff.id, adminId: staff.adminId };
};

/**
 * Verify a STAFF user is actually assigned to the given job.
 * Throws 403 if not — prevents staff from ticking checklists on jobs they
 * have no business touching.
 */
const assertStaffAssignedToJob = async (
    jobId: string,
    staffId: string,
): Promise<void> => {
    const assignment = await prisma.jobStaffAssignment.findUnique({
        where: { jobId_staffId: { jobId, staffId } },
    });
    if (!assignment) {
        throw new AppError(
            status.FORBIDDEN,
            "You are not assigned to this job.",
        );
    }
};

// ─── Template includes ─────────────────────────────────────────────────────────

const templateInclude = {
    tasks: { orderBy: { sortOrder: "asc" as const } },
    _count: {
        select: { jobChecklists: true },
    },
} as const;

// ─── ChecklistTemplate CRUD (ADMIN only) ──────────────────────────────────────

interface ITemplateCreate {
    name: string;
    serviceType?: ServiceType | null;
    tasks?: {
        title: string;
        required?: boolean;
        sortOrder?: number;
    }[];
}

const createTemplate = async (payload: ITemplateCreate, user: IRequestUser) => {
    const adminId = await getAdminId(user);

    return prisma.checklistTemplate.create({
        data: {
            name: payload.name,
            serviceType: payload.serviceType ?? null,
            adminId,
            tasks: payload.tasks?.length
                ? {
                      createMany: {
                          data: payload.tasks.map((t, i) => ({
                              title: t.title,
                              required: t.required ?? false,
                              sortOrder: t.sortOrder ?? i,
                          })),
                      },
                  }
                : undefined,
        },
        include: templateInclude,
    });
};

const getAllTemplates = async (user: IRequestUser) => {
    const adminId = await getAdminId(user);

    const templates = await prisma.checklistTemplate.findMany({
        where: { adminId },
        include: templateInclude,
        orderBy: { createdAt: "desc" },
    });

    return { templates, total: templates.length };
};

const getTemplateById = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);

    const template = await prisma.checklistTemplate.findFirst({
        where: { id, adminId },
        include: templateInclude,
    });
    if (!template)
        throw new AppError(status.NOT_FOUND, "Checklist template not found");

    return template;
};

const updateTemplate = async (
    id: string,
    payload: Partial<ITemplateCreate>,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    const existing = await prisma.checklistTemplate.findFirst({
        where: { id, adminId },
    });
    if (!existing)
        throw new AppError(status.NOT_FOUND, "Checklist template not found");

    return prisma.$transaction(async (tx) => {
        if (payload.tasks) {
            await tx.checklistTask.deleteMany({ where: { templateId: id } });
            await tx.checklistTask.createMany({
                data: payload.tasks.map((t, i) => ({
                    templateId: id,
                    title: t.title,
                    required: t.required ?? false,
                    sortOrder: t.sortOrder ?? i,
                })),
            });
        }

        return tx.checklistTemplate.update({
            where: { id },
            data: {
                ...(payload.name !== undefined && { name: payload.name }),
                ...(payload.serviceType !== undefined && {
                    serviceType: payload.serviceType,
                }),
            },
            include: templateInclude,
        });
    });
};

const deleteTemplate = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const existing = await prisma.checklistTemplate.findFirst({
        where: { id, adminId },
    });
    if (!existing)
        throw new AppError(status.NOT_FOUND, "Checklist template not found");
    await prisma.checklistTemplate.delete({ where: { id } });
};

// ─── Job Checklist — read ─────────────────────────────────────────────────────
//
// Both ADMIN and STAFF can read the checklists for a job, but the
// ownership/access check differs:
//   • ADMIN  — job must belong to this admin
//   • STAFF  — job must be assigned to this staff member (any of the jobs
//               their admin manages; staffProfile.adminId identifies the tenant)

const getJobChecklists = async (jobId: string, user: IRequestUser) => {
    if (user.role === UserRole.STAFF) {
        const { staffId, adminId } = await resolveStaffProfile(user.id);
        await assertStaffAssignedToJob(jobId, staffId);

        // Confirm the job exists under the same admin tenant
        const job = await prisma.job.findFirst({
            where: { id: jobId, adminId },
        });
        if (!job) throw new AppError(status.NOT_FOUND, "Job not found");
    } else {
        // ADMIN or SUPER_ADMIN
        const adminId = await getAdminId(user);
        const job = await prisma.job.findFirst({
            where: { id: jobId, adminId },
        });
        if (!job) throw new AppError(status.NOT_FOUND, "Job not found");
    }

    return prisma.jobChecklist.findMany({
        where: { jobId },
        include: {
            template: { select: { name: true, serviceType: true } },
            items: { orderBy: { sortOrder: "asc" } },
        },
    });
};

// ─── Job Checklist — attach / detach (ADMIN only) ────────────────────────────

const attachToJob = async (
    jobId: string,
    templateId: string,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    const job = await prisma.job.findFirst({ where: { id: jobId, adminId } });
    if (!job) throw new AppError(status.NOT_FOUND, "Job not found");

    const template = await prisma.checklistTemplate.findFirst({
        where: { id: templateId, adminId },
        include: { tasks: { orderBy: { sortOrder: "asc" } } },
    });
    if (!template)
        throw new AppError(status.NOT_FOUND, "Checklist template not found");

    const existing = await prisma.jobChecklist.findUnique({
        where: { jobId_templateId: { jobId, templateId } },
    });
    if (existing)
        throw new AppError(
            status.CONFLICT,
            "This checklist is already attached to the job",
        );

    return prisma.jobChecklist.create({
        data: {
            jobId,
            templateId,
            adminId,
            items: {
                createMany: {
                    data: template.tasks.map((t) => ({
                        title: t.title,
                        required: t.required,
                        sortOrder: t.sortOrder,
                    })),
                },
            },
        },
        include: {
            template: { select: { name: true, serviceType: true } },
            items: { orderBy: { sortOrder: "asc" } },
        },
    });
};

const detachFromJob = async (checklistId: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);

    const checklist = await prisma.jobChecklist.findFirst({
        where: { id: checklistId, adminId },
    });
    if (!checklist)
        throw new AppError(status.NOT_FOUND, "Job checklist not found");

    await prisma.jobChecklist.delete({ where: { id: checklistId } });
};

// ─── Job Checklist — tick / untick item ──────────────────────────────────────
//
// The single most important mutation in the staff workflow.
//
// Access rules:
//   • ADMIN  — must own the checklist (via adminId)
//   • STAFF  — must be assigned to the job that owns the checklist.
//               completedBy stores the staffProfile.id (not userId) so it can
//               be joined back to StaffProfile for audit display.
//
// The function returns the full updated item so the frontend can apply an
// optimistic cache patch without a round-trip refetch.

const updateItemCompletion = async (
    checklistId: string,
    itemId: string,
    completed: boolean,
    user: IRequestUser,
) => {
    // ── 1. Fetch the checklist regardless of role so we have jobId ──────────
    const checklist = await prisma.jobChecklist.findUnique({
        where: { id: checklistId },
        select: { id: true, jobId: true, adminId: true },
    });
    if (!checklist)
        throw new AppError(status.NOT_FOUND, "Job checklist not found");

    // ── 2. Role-based authorisation ─────────────────────────────────────────
    let resolvedCompletedBy: string | null = null;

    if (user.role === UserRole.STAFF) {
        const { staffId, adminId } = await resolveStaffProfile(user.id);

        // Staff must belong to the same admin tenant that owns the checklist
        if (adminId !== checklist.adminId) {
            throw new AppError(status.FORBIDDEN, "Access denied.");
        }

        // Staff must be assigned to the job
        await assertStaffAssignedToJob(checklist.jobId, staffId);

        // Store staffProfile.id so the audit trail can join to StaffProfile
        resolvedCompletedBy = completed ? staffId : null;
    } else {
        // ADMIN / SUPER_ADMIN — must own the checklist
        const adminId = await getAdminId(user);
        if (adminId !== checklist.adminId) {
            throw new AppError(status.FORBIDDEN, "Access denied.");
        }
        resolvedCompletedBy = completed ? user.id : null;
    }

    // ── 3. Verify item belongs to this checklist ────────────────────────────
    const item = await prisma.jobChecklistItem.findFirst({
        where: { id: itemId, checklistId },
    });
    if (!item) throw new AppError(status.NOT_FOUND, "Checklist item not found");

    // ── 4. Update and return ────────────────────────────────────────────────
    return prisma.jobChecklistItem.update({
        where: { id: itemId },
        data: {
            completed,
            completedAt: completed ? new Date() : null,
            completedBy: resolvedCompletedBy,
        },
    });
};

// ─── Export ───────────────────────────────────────────────────────────────────

export const checklistService = {
    createTemplate,
    getAllTemplates,
    getTemplateById,
    updateTemplate,
    deleteTemplate,
    attachToJob,
    getJobChecklists,
    updateItemCompletion,
    detachFromJob,
};
