import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { IRequestUser } from "../../types/requestUser.interface";
import { CreateLeadPayload, UpdateLeadPayload } from "./lead.interface";
import { prisma } from "../../lib/prisma/prisma";
import { IQueryParams } from "../../interface/query.interface";
import { Lead, Prisma } from "../../generated/prisma/client";
import { QueryBuilder } from "../../lib/utils/QueryBuilder";
import { leadFilterableFields, leadSearchableFields } from "./lead.constant";
import { LeadStage } from "../../generated/prisma/enums";

// ─── Helper: generate a sequential lead ref ───────────────────────────────────

const generateLeadRef = async (): Promise<string> => {
    const last = await prisma.lead.findFirst({
        orderBy: { createdAt: "desc" },
        select: { leadRef: true },
    });

    if (last?.leadRef) {
        const parts = last.leadRef.split("-");
        const lastNum = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(lastNum)) {
            return `LEAD-${String(lastNum + 1).padStart(4, "0")}`;
        }
    }
    return "LEAD-0001";
};

// ─── Resolve admin profile (throws if missing / wrong admin) ──────────────────

const resolveAdminProfile = async (user: IRequestUser) => {
    const adminProfile = await prisma.adminProfile.findFirst({
        where: { userId: user.id },
    });

    if (!adminProfile) {
        throw new AppError(status.NOT_FOUND, "Admin profile not found");
    }

    return adminProfile;
};

// ─── Service methods ──────────────────────────────────────────────────────────

const createLead = async (payload: CreateLeadPayload, user: IRequestUser) => {
    const adminProfile = await resolveAdminProfile(user);

    const leadRef = await generateLeadRef();

    return await prisma.lead.create({
        data: {
            leadRef,
            name: payload.name,
            email: payload.email,
            phone: payload.phone,
            serviceInterest: payload.serviceInterest,
            estimatedMin: payload.estimatedMin ?? 0,
            estimatedMax: payload.estimatedMax ?? 0,
            notes: payload.notes,
            sourceRef: payload.sourceRef,
            adminId: adminProfile.id,
        },
    });
};

const getLeads = async (query: IQueryParams, user: IRequestUser) => {
    const adminProfile = await resolveAdminProfile(user);

    const queryBuilder = new QueryBuilder<
        Lead,
        Prisma.LeadWhereInput,
        Prisma.LeadInclude
    >(prisma.lead, query, {
        searchableFields: leadSearchableFields,
        filterableFields: leadFilterableFields,
    });

    const result = await queryBuilder
        .search()
        .filter()
        .where({ adminId: adminProfile.id })
        .paginate()
        .sort()
        .fields()
        .execute();

    return result;
};

const getLeadById = async (id: string, user: IRequestUser) => {
    const adminProfile = await resolveAdminProfile(user);

    return await prisma.lead.findUniqueOrThrow({
        where: { id, adminId: adminProfile.id },
    });
};

const updateLead = async (id: string, payload: UpdateLeadPayload, user: IRequestUser) => {
    const adminProfile = await resolveAdminProfile(user);

    const existing = await prisma.lead.findUnique({ where: { id } });

    if (!existing) {
        throw new AppError(status.NOT_FOUND, "Lead not found");
    }

    if (existing.adminId !== adminProfile.id) {
        throw new AppError(status.FORBIDDEN, "You are not allowed to update this lead.");
    }

    return await prisma.lead.update({
        where: { id },
        data: payload,
    });
};

const updateLeadStage = async (id: string, stage: LeadStage, user: IRequestUser) => {
    const adminProfile = await resolveAdminProfile(user);

    const existing = await prisma.lead.findUnique({ where: { id } });

    if (!existing) {
        throw new AppError(status.NOT_FOUND, "Lead not found");
    }

    if (existing.adminId !== adminProfile.id) {
        throw new AppError(status.FORBIDDEN, "You are not allowed to update this lead.");
    }

    return await prisma.lead.update({
        where: { id },
        data: { stage },
    });
};

const deleteLead = async (id: string, user: IRequestUser) => {
    const adminProfile = await resolveAdminProfile(user);

    const existing = await prisma.lead.findUnique({ where: { id } });

    if (!existing) {
        throw new AppError(status.NOT_FOUND, "Lead not found");
    }

    if (existing.adminId !== adminProfile.id) {
        throw new AppError(status.FORBIDDEN, "You are not allowed to delete this lead.");
    }

    return await prisma.lead.delete({ where: { id } });
};

export const leadService = {
    createLead,
    getLeads,
    getLeadById,
    updateLead,
    updateLeadStage,
    deleteLead,
};
