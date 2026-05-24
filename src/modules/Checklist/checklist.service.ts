import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { ServiceType } from "../../generated/prisma/enums";
import { IRequestUser } from "../../types/requestUser.interface";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const resolveAdminId = async (userId: string): Promise<string> => {
    const admin = await prisma.adminProfile.findUnique({ where: { userId } });
    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");
    return admin.id;
};

// ─── Template includes ─────────────────────────────────────────────────────────

const templateInclude = {
    tasks: { orderBy: { sortOrder: "asc" as const } },
    _count: {
        select: { jobChecklists: true },
    },
} as const;

// ─── ChecklistTemplate CRUD ───────────────────────────────────────────────────

interface ITemplateCreate {
    name:         string;
    serviceType?: ServiceType | null;
    tasks?: {
        title:     string;
        required?: boolean;
        sortOrder?: number;
    }[];
}

const createTemplate = async (payload: ITemplateCreate, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);

    return prisma.checklistTemplate.create({
        data: {
            name:        payload.name,
            serviceType: payload.serviceType ?? null,
            adminId,
            tasks: payload.tasks?.length
                ? {
                    createMany: {
                        data: payload.tasks.map((t, i) => ({
                            title:     t.title,
                            required:  t.required ?? false,
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
    const adminId = await resolveAdminId(user.id);

    const templates = await prisma.checklistTemplate.findMany({
        where:   { adminId },
        include: templateInclude,
        orderBy: { createdAt: "desc" },
    });

    return { templates, total: templates.length };
};

const getTemplateById = async (id: string, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);

    const template = await prisma.checklistTemplate.findFirst({
        where:   { id, adminId },
        include: templateInclude,
    });
    if (!template) throw new AppError(status.NOT_FOUND, "Checklist template not found");

    return template;
};

const updateTemplate = async (
    id: string,
    payload: Partial<ITemplateCreate>,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);

    const existing = await prisma.checklistTemplate.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Checklist template not found");

    return prisma.$transaction(async (tx) => {
        // Replace tasks when provided
        if (payload.tasks) {
            await tx.checklistTask.deleteMany({ where: { templateId: id } });
            await tx.checklistTask.createMany({
                data: payload.tasks.map((t, i) => ({
                    templateId: id,
                    title:      t.title,
                    required:   t.required ?? false,
                    sortOrder:  t.sortOrder ?? i,
                })),
            });
        }

        return tx.checklistTemplate.update({
            where: { id },
            data: {
                ...(payload.name        !== undefined && { name: payload.name }),
                ...(payload.serviceType !== undefined && { serviceType: payload.serviceType }),
            },
            include: templateInclude,
        });
    });
};

const deleteTemplate = async (id: string, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);
    const existing = await prisma.checklistTemplate.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Checklist template not found");
    await prisma.checklistTemplate.delete({ where: { id } });
};

// ─── Job Checklist (attach template to job) ───────────────────────────────────

const attachToJob = async (
    jobId: string,
    templateId: string,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);

    // Verify job belongs to admin
    const job = await prisma.job.findFirst({ where: { id: jobId, adminId } });
    if (!job) throw new AppError(status.NOT_FOUND, "Job not found");

    // Verify template belongs to admin
    const template = await prisma.checklistTemplate.findFirst({
        where:   { id: templateId, adminId },
        include: { tasks: { orderBy: { sortOrder: "asc" } } },
    });
    if (!template) throw new AppError(status.NOT_FOUND, "Checklist template not found");

    // Check if already attached
    const existing = await prisma.jobChecklist.findUnique({
        where: { jobId_templateId: { jobId, templateId } },
    });
    if (existing) throw new AppError(status.CONFLICT, "This checklist is already attached to the job");

    return prisma.jobChecklist.create({
        data: {
            jobId,
            templateId,
            adminId,
            items: {
                createMany: {
                    data: template.tasks.map((t) => ({
                        title:     t.title,
                        required:  t.required,
                        sortOrder: t.sortOrder,
                    })),
                },
            },
        },
        include: {
            template: { select: { name: true } },
            items:    { orderBy: { sortOrder: "asc" } },
        },
    });
};

const getJobChecklists = async (jobId: string, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);

    const job = await prisma.job.findFirst({ where: { id: jobId, adminId } });
    if (!job) throw new AppError(status.NOT_FOUND, "Job not found");

    return prisma.jobChecklist.findMany({
        where:   { jobId },
        include: {
            template: { select: { name: true, serviceType: true } },
            items:    { orderBy: { sortOrder: "asc" } },
        },
    });
};

const updateItemCompletion = async (
    checklistId: string,
    itemId: string,
    completed: boolean,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);

    // Verify checklist belongs to admin
    const checklist = await prisma.jobChecklist.findFirst({
        where: { id: checklistId, adminId },
    });
    if (!checklist) throw new AppError(status.NOT_FOUND, "Job checklist not found");

    const item = await prisma.jobChecklistItem.findFirst({
        where: { id: itemId, checklistId },
    });
    if (!item) throw new AppError(status.NOT_FOUND, "Checklist item not found");

    return prisma.jobChecklistItem.update({
        where: { id: itemId },
        data: {
            completed,
            completedAt: completed ? new Date() : null,
            completedBy: completed ? user.id : null,
        },
    });
};

const detachFromJob = async (
    checklistId: string,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);

    const checklist = await prisma.jobChecklist.findFirst({
        where: { id: checklistId, adminId },
    });
    if (!checklist) throw new AppError(status.NOT_FOUND, "Job checklist not found");

    await prisma.jobChecklist.delete({ where: { id: checklistId } });
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
