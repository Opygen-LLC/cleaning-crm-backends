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
import { acquireExtendedTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { allocateLeadRef } from "./leadRef.service";
import { requireE164Phone } from "../../lib/validation/phone";
import { ensureLeadActivityAssignee } from "./leadActivity.service";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import { syncLeadWebsiteSubmissionsConverted } from "../Website/websiteSubmission.service";
import { leadDetailSelect, leadListSelect, leadMutationSelect } from "./lead.projection";

// ─── Resolve admin profile ────────────────────────────────────────────────────

const resolveAdminProfile = async (user: IRequestUser) => {
    const adminProfile = await prisma.adminProfile.findFirst({
        where: { userId: user.id },
        select: { id: true, businessName: true },
    });

    if (!adminProfile) {
        throw new AppError(status.NOT_FOUND, "Admin profile not found");
    }

    return adminProfile;
};

type LeadServiceDb = Pick<Prisma.TransactionClient, "serviceCatalog">;

const resolveTenantService = async (db: LeadServiceDb, adminId: string, serviceCatalogId?: string) => {
    if (!serviceCatalogId) return null;
    const service = await db.serviceCatalog.findFirst({
        where: { id: serviceCatalogId, adminId },
        select: { id: true, serviceName: true },
    });
    if (!service) {
        throw new AppError(status.UNPROCESSABLE_ENTITY, "Selected service is not available for this business", {
            code: "LEAD_SERVICE_INVALID",
            retryable: false,
            fieldErrors: { serviceCatalogId: "Choose a service from this business." },
        });
    }
    return service;
};

const STAGE_MAP_TO_DB: Record<string, LeadStage> = {
    "New": LeadStage.NEW,
    "Contacted": LeadStage.CONTACTED,
    "Quote Sent": LeadStage.QUOTE_SENT,
    "Won": LeadStage.WON,
    "Lost": LeadStage.LOST,
    "NEW": LeadStage.NEW,
    "CONTACTED": LeadStage.CONTACTED,
    "QUOTE_SENT": LeadStage.QUOTE_SENT,
    "WON": LeadStage.WON,
    "LOST": LeadStage.LOST,
};

const STAGE_MAP_TO_FE: Record<string, string> = {
    NEW: "New",
    CONTACTED: "Contacted",
    QUOTE_SENT: "Quote Sent",
    WON: "Won",
    LOST: "Lost",
};

interface LeadQueryParams extends IQueryParams {
    assignedToUserId?: string;
    due?: "today" | "overdue" | "upcoming";
    dueFrom?: string;
    dueTo?: string;
    source?: "website" | "manual" | "other";
    sourceRef?: string;
    serviceCatalogId?: string;
    createdFrom?: string;
    createdTo?: string;
    lastContacted?: "never" | "7d" | "30d" | "stale30";
}

const safeDate = (value?: unknown): Date | null => {
    if (!value) return null;
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date;
};

const buildLeadOperationalWhere = (query: LeadQueryParams): Prisma.LeadWhereInput => {
    const where: Prisma.LeadWhereInput = {};
    const activityWhere: Prisma.LeadActivityWhereInput = {};

    if (query.assignedToUserId) activityWhere.assignedToUserId = String(query.assignedToUserId);

    const now = new Date();
    const dueFrom = safeDate(query.dueFrom);
    const dueTo = safeDate(query.dueTo);
    if (query.due === "today" && dueFrom && dueTo) {
        activityWhere.status = "PENDING";
        activityWhere.scheduledAt = { gte: dueFrom, lt: dueTo };
    } else if (query.due === "overdue") {
        activityWhere.status = "PENDING";
        activityWhere.scheduledAt = { lt: now };
    } else if (query.due === "upcoming") {
        activityWhere.status = "PENDING";
        activityWhere.scheduledAt = { gte: now };
    }

    if (Object.keys(activityWhere).length > 0) {
        where.activities = { some: activityWhere };
    }

    if (query.source === "website") where.sourceWebsiteId = { not: null };
    if (query.source === "manual") {
        where.sourceWebsiteId = null;
        where.sourceRef = null;
    }
    if (query.source === "other") {
        where.sourceWebsiteId = null;
        where.sourceRef = { not: null };
    }
    if (query.sourceRef) where.sourceRef = { contains: String(query.sourceRef), mode: "insensitive" };
    if (query.serviceCatalogId) where.serviceCatalogId = String(query.serviceCatalogId);

    const createdFrom = safeDate(query.createdFrom);
    const createdTo = safeDate(query.createdTo);
    if (createdFrom || createdTo) {
        where.createdAt = {
            ...(createdFrom ? { gte: createdFrom } : {}),
            ...(createdTo ? { lte: createdTo } : {}),
        };
    }

    if (query.lastContacted === "never") {
        where.lastContactedAt = null;
    } else if (query.lastContacted) {
        const cutoff = new Date(now);
        cutoff.setDate(cutoff.getDate() - (query.lastContacted === "7d" ? 7 : 30));
        where.lastContactedAt = query.lastContacted === "stale30"
            ? { lt: cutoff }
            : { gte: cutoff };
    }

    return where;
};

// ─── Decimal serialiser & stage formatter ─────────────────────────────────────

function serializeLead(
    lead: Lead & Record<string, unknown>,
    businessName?: string,
): Record<string, unknown> {
    const isWebsiteLead = Boolean(lead.sourceWebsiteId);
    const projectedBusinessName =
        ((lead as Record<string, any>).admin as { businessName?: string } | undefined)?.businessName ?? businessName;
    return {
        ...lead,
        stage: STAGE_MAP_TO_FE[String(lead.stage)] ?? lead.stage,
        estimatedMin: Number(lead.estimatedMin),
        estimatedMax: Number(lead.estimatedMax),
        source: isWebsiteLead ? "Website" : (lead.sourceRef ?? null),
        sourceWebsiteName: isWebsiteLead ? projectedBusinessName ?? null : null,
        sourcePage: isWebsiteLead ? "/contact" : null,
    };
}


// ─── Service methods ──────────────────────────────────────────────────────────

const createLead = async (payload: CreateLeadPayload, user: IRequestUser) => {
    const adminProfile = await resolveAdminProfile(user);
    const email = payload.email.trim().toLowerCase();
    const phone = payload.phone?.trim() ? requireE164Phone(payload.phone, "phone") : undefined;

    const lead = await prisma.$transaction(async (tx) => {
        // Website acquisition and manual CRM entry share this email lock, so
        // case variants cannot race into duplicate tenant leads.
        const lockKeys = [
            `lead-email:${adminProfile.id}:${email}`,
            ...(phone ? [`lead-phone:${adminProfile.id}:${phone}`] : []),
        ].sort();
        for (const lockKey of lockKeys) {
            await acquireExtendedTextTransactionAdvisoryLock(tx, lockKey);
        }

        const existing = await tx.lead.findFirst({
            where: {
                adminId: adminProfile.id,
                OR: [
                    { email: { equals: email, mode: "insensitive" } },
                    ...(phone ? [{ phone }] : []),
                ],
            },
            select: { id: true },
        });
        if (existing) {
            throw new AppError(status.CONFLICT, "A lead with this email or phone already exists", {
                code: "LEAD_CONTACT_EXISTS",
                retryable: false,
                fieldErrors: { email: "A lead with this email or phone already exists." },
            });
        }

        const service = await resolveTenantService(tx, adminProfile.id, payload.serviceCatalogId);
        const leadRef = await allocateLeadRef(tx);

        if (payload.initialFollowUp?.assignedToUserId) {
            await ensureLeadActivityAssignee(tx, adminProfile.id, payload.initialFollowUp.assignedToUserId);
        }

        const createdLead = await tx.lead.create({
            data: {
                leadRef,
                name: payload.name.trim(),
                email,
                phone,
                serviceInterest: service?.serviceName ?? payload.serviceInterest.trim(),
                serviceCatalogId: service?.id ?? null,
                estimatedMin: payload.estimatedMin ?? 0,
                estimatedMax: payload.estimatedMax ?? 0,
                notes: payload.notes,
                sourceRef: payload.sourceRef,
                adminId: adminProfile.id,
            },
        });

        if (payload.initialFollowUp) {
            await tx.leadActivity.create({
                data: {
                    adminId: adminProfile.id,
                    leadId: createdLead.id,
                    type: "FOLLOW_UP",
                    status: "PENDING",
                    scheduledAt: new Date(payload.initialFollowUp.scheduledAt),
                    assignedToUserId: payload.initialFollowUp.assignedToUserId ?? null,
                    note: payload.initialFollowUp.note?.trim() || null,
                    createdBy: user.id,
                },
            });
        }

        return createdLead;
    });

    return serializeLead(lead as Lead & Record<string, unknown>, adminProfile.businessName);
};

const getLeads = async (query: IQueryParams, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const leadQuery = query as LeadQueryParams;

    const normalizedQuery: IQueryParams = { ...query };
    if (normalizedQuery.stage) {
        const rawStage = String(normalizedQuery.stage).trim();
        if (rawStage.toLowerCase() === "all") {
            delete normalizedQuery.stage;
        } else {
            const mapped = STAGE_MAP_TO_DB[rawStage];
            if (mapped) normalizedQuery.stage = mapped;
        }
    }

    const queryBuilder = new QueryBuilder<
        Lead,
        Prisma.LeadWhereInput,
        Prisma.LeadInclude
    >(prisma.lead, normalizedQuery, {
        searchableFields: leadSearchableFields,
        filterableFields: leadFilterableFields,
    });

    const result = await queryBuilder
        .search()
        .filter()
        .where({
            adminId,
            ...buildLeadOperationalWhere(leadQuery),
        })
        .select(leadListSelect)
        .paginate()
        .sort()
        .fields()
        .execute();

    return {
        ...result,
        data: result.data.map((lead) =>
            serializeLead(lead as Lead & Record<string, unknown>),
        ),
    };
};

const getLeadById = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const lead = await prisma.lead.findUniqueOrThrow({
        where: { id, adminId },
        select: leadDetailSelect,
    });
    return serializeLead(lead as unknown as Lead & Record<string, unknown>);
};

const updateLead = async (
    id: string,
    payload: UpdateLeadPayload,
    user: IRequestUser,
) => {
    const adminProfile = await resolveAdminProfile(user);

    const existing = await prisma.lead.findUnique({ where: { id } });

    if (!existing) {
        throw new AppError(status.NOT_FOUND, "Lead not found");
    }

    if (existing.adminId !== adminProfile.id) {
        throw new AppError(
            status.FORBIDDEN,
            "You are not allowed to update this lead.",
        );
    }

    const service = await resolveTenantService(prisma, adminProfile.id, payload.serviceCatalogId);
    const { serviceCatalogId: _serviceCatalogId, ...payloadWithoutCatalogId } = payload;
    const updateData: Prisma.LeadUpdateInput = {
        ...payloadWithoutCatalogId,
        ...(payload.email !== undefined ? { email: payload.email.trim().toLowerCase() } : {}),
        ...(payload.phone !== undefined ? { phone: payload.phone.trim() ? requireE164Phone(payload.phone, "phone") : null } : {}),
    };
    if (service) {
        updateData.serviceCatalog = { connect: { id: service.id } };
        updateData.serviceInterest = service.serviceName;
    } else if (payload.serviceInterest !== undefined) {
        // Free-text/legacy service edits must not retain a stale canonical FK.
        updateData.serviceCatalog = { disconnect: true };
    }

    const lead = await prisma.lead.update({
        where: { id },
        data: updateData,
    });

    return serializeLead(lead as Lead & Record<string, unknown>, adminProfile.businessName);
};

const updateLeadStage = async (
    id: string,
    stage: LeadStage,
    user: IRequestUser,
) => {
    const adminProfile = await resolveAdminProfile(user);

    const existing = await prisma.lead.findUnique({ where: { id } });

    if (!existing) {
        throw new AppError(status.NOT_FOUND, "Lead not found");
    }

    if (existing.adminId !== adminProfile.id) {
        throw new AppError(
            status.FORBIDDEN,
            "You are not allowed to update this lead.",
        );
    }

    const dbStage = STAGE_MAP_TO_DB[String(stage)] ?? LeadStage.NEW;

    const lead = await prisma.lead.update({
        where: { id },
        data: { stage: dbStage },
    });

    return serializeLead(lead as Lead & Record<string, unknown>, adminProfile.businessName);

};

const deleteLead = async (id: string, user: IRequestUser) => {
    const adminProfile = await resolveAdminProfile(user);

    const existing = await prisma.lead.findUnique({ where: { id } });

    if (!existing) {
        throw new AppError(status.NOT_FOUND, "Lead not found");
    }

    if (existing.adminId !== adminProfile.id) {
        throw new AppError(
            status.FORBIDDEN,
            "You are not allowed to delete this lead.",
        );
    }

    if (existing.convertedClientId) {
        throw new AppError(status.CONFLICT, "Converted leads are retained with their activity history", {
            code: "LEAD_ALREADY_CONVERTED",
            retryable: false,
        });
    }

    return prisma.lead.delete({ where: { id } });
};

// ─── Convert Won lead to client ───────────────────────────────────────────────
//
// Rules:
//  1. Lead must belong to this admin.
//  2. Lead stage must be WON — only won leads can be converted.
//  3. If a client with the same (email, adminId) already exists the existing
//     client is returned instead of throwing (idempotent).
//  4. The lead is retained permanently with convertedClientId/convertedAt so
//     CRM activity history and acquisition attribution are never lost.

const convertLeadToClient = async (id: string, user: IRequestUser) => {
    const adminProfile = await resolveAdminProfile(user);

    return prisma.$transaction(async (tx) => {
        const lead = await tx.lead.findFirst({
            where: { id, adminId: adminProfile.id },
        });

        if (!lead) throw new AppError(status.NOT_FOUND, "Lead not found");

        if (lead.stage !== LeadStage.WON) {
            throw new AppError(
                status.UNPROCESSABLE_ENTITY,
                "Only leads in the 'Won' stage can be converted to clients.",
            );
        }

        if (lead.convertedClientId) {
            const existingClient = await tx.client.findFirst({
                where: { id: lead.convertedClientId, adminId: adminProfile.id },
                select: { id: true, name: true, portalAccessToken: true },
            });
            if (existingClient) {
                return {
                    clientId: existingClient.id,
                    clientName: existingClient.name,
                    portalAccessToken: existingClient.portalAccessToken,
                    alreadyConverted: true,
                    message: `Lead was already converted to ${existingClient.name}.`,
                };
            }
        }

        const client = await tx.client.upsert({
            where: {
                email_adminId: {
                    email: lead.email,
                    adminId: adminProfile.id,
                },
            },
            create: {
                name: lead.name,
                email: lead.email,
                phone: lead.phone ?? "",
                servicePreference: lead.serviceInterest,
                addressLine1: "",
                city: "",
                zipcode: "",
                country: "",
                adminId: adminProfile.id,
                notes: {
                    create: {
                        text: `Converted from lead ${lead.leadRef}${lead.notes ? `: ${lead.notes}` : ""}`,
                    },
                },
            },
            update: {},
            select: {
                id: true,
                name: true,
                email: true,
                portalAccessToken: true,
            },
        });

        const convertedAt = new Date();
        await tx.lead.update({
            where: { id: lead.id },
            data: {
                convertedClientId: client.id,
                convertedAt,
            },
        });
        await syncLeadWebsiteSubmissionsConverted(tx, lead.id);

        await tx.leadActivity.create({
            data: {
                adminId: adminProfile.id,
                leadId: lead.id,
                type: "NOTE",
                status: "COMPLETED",
                completedAt: convertedAt,
                note: `Converted to client ${client.name}.`,
                createdBy: user.id,
            },
        });

        return {
            clientId: client.id,
            clientName: client.name,
            portalAccessToken: client.portalAccessToken,
            alreadyConverted: false,
            message: `Lead converted — client record linked for ${client.name}.`,
        };
    });
};

export const leadService = {
    createLead,
    getLeads,
    getLeadById,
    updateLead,
    updateLeadStage,
    deleteLead,
    convertLeadToClient,
};
