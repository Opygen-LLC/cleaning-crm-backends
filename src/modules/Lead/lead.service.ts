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

// ─── Resolve admin profile ────────────────────────────────────────────────────

const resolveAdminProfile = async (user: IRequestUser) => {
    const adminProfile = await prisma.adminProfile.findFirst({
        where: { userId: user.id },
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

// ─── Decimal serialiser & stage formatter ─────────────────────────────────────

function serializeLead(
    lead: Lead & Record<string, unknown>,
): Record<string, unknown> {
    return {
        ...lead,
        stage: STAGE_MAP_TO_FE[String(lead.stage)] ?? lead.stage,
        estimatedMin: Number(lead.estimatedMin),
        estimatedMax: Number(lead.estimatedMax),
    };
}


// ─── Service methods ──────────────────────────────────────────────────────────

const createLead = async (payload: CreateLeadPayload, user: IRequestUser) => {
    const adminProfile = await resolveAdminProfile(user);
    const email = payload.email.trim().toLowerCase();

    const lead = await prisma.$transaction(async (tx) => {
        // Website acquisition and manual CRM entry share this email lock, so
        // case variants cannot race into duplicate tenant leads.
        await acquireExtendedTextTransactionAdvisoryLock(
            tx,
            `lead-email:${adminProfile.id}:${email}`,
        );

        const existing = await tx.lead.findFirst({
            where: {
                adminId: adminProfile.id,
                email: { equals: email, mode: "insensitive" },
            },
            select: { id: true },
        });
        if (existing) {
            throw new AppError(status.CONFLICT, "A lead with this email already exists", {
                code: "LEAD_EMAIL_EXISTS",
                retryable: false,
                fieldErrors: { email: "A lead with this email already exists." },
            });
        }

        const service = await resolveTenantService(tx, adminProfile.id, payload.serviceCatalogId);
        const leadRef = await allocateLeadRef(tx);

        return tx.lead.create({
            data: {
                leadRef,
                name: payload.name.trim(),
                email,
                phone: payload.phone?.trim() || undefined,
                serviceInterest: service?.serviceName ?? payload.serviceInterest.trim(),
                serviceCatalogId: service?.id ?? null,
                estimatedMin: payload.estimatedMin ?? 0,
                estimatedMax: payload.estimatedMax ?? 0,
                notes: payload.notes,
                sourceRef: payload.sourceRef,
                adminId: adminProfile.id,
            },
        });
    });

    return serializeLead(lead as Lead & Record<string, unknown>);
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

    return {
        ...result,
        data: result.data.map((lead) =>
            serializeLead(lead as Lead & Record<string, unknown>),
        ),
    };
};

const getLeadById = async (id: string, user: IRequestUser) => {
    const adminProfile = await resolveAdminProfile(user);

    const lead = await prisma.lead.findUniqueOrThrow({
        where: { id, adminId: adminProfile.id },
        select: {
            id: true,
            leadRef: true,
            name: true,
            email: true,
            phone: true,
            serviceInterest: true,
            estimatedMin: true,
            estimatedMax: true,
            stage: true,
            notes: true,
            sourceRef: true,
            serviceCatalogId: true,
            sourceWebsiteId: true,
            adminId: true,
            createdAt: true,
            updatedAt: true,
        },
    });

    return serializeLead(lead as Lead & Record<string, unknown>);
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
    const updateData: Prisma.LeadUpdateInput = { ...payloadWithoutCatalogId };
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

    return serializeLead(lead as Lead & Record<string, unknown>);
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

    return serializeLead(lead as Lead & Record<string, unknown>);

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

    return await prisma.lead.delete({ where: { id } });
};

// ─── Convert Won lead to client ───────────────────────────────────────────────
//
// Rules:
//  1. Lead must belong to this admin.
//  2. Lead stage must be WON — only won leads can be converted.
//  3. If a client with the same (email, adminId) already exists the existing
//     client is returned instead of throwing (idempotent).
//  4. The lead is then deleted — it has served its purpose once a client record
//     exists.  (If you prefer soft-deletion / keeping a "converted" stage,
//     swap the delete for a stage update to a CONVERTED enum value and add that
//     to the prisma enum.)

const convertLeadToClient = async (id: string, user: IRequestUser) => {
    const adminProfile = await resolveAdminProfile(user);

    // ── 1. Fetch and authorise the lead ────────────────────────────────────────
    const lead = await prisma.lead.findUnique({ where: { id } });

    if (!lead) {
        throw new AppError(status.NOT_FOUND, "Lead not found");
    }

    if (lead.adminId !== adminProfile.id) {
        throw new AppError(
            status.FORBIDDEN,
            "You are not allowed to convert this lead.",
        );
    }

    // ── 2. Stage guard ─────────────────────────────────────────────────────────
    if (lead.stage !== LeadStage.WON) {
        throw new AppError(
            status.UNPROCESSABLE_ENTITY,
            "Only leads in the 'Won' stage can be converted to clients.",
        );
    }

    // ── 3. Upsert client — idempotent on (email, adminId) ─────────────────────
    //    We use upsert so a double-click / retry never creates a duplicate.
    //    Required fields that leads don't capture (address, phone) are seeded
    //    with sensible empty-string defaults so the admin can fill them in later.
    const client = await prisma.client.upsert({
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
            // Address fields are required by the schema; seed with empty strings.
            // The admin is redirected to the client profile to fill these in.
            addressLine1: "",
            city: "",
            zipcode: "",
            country: "",
            adminId: adminProfile.id,
            notes: lead.notes
                ? {
                      create: {
                          text: `Converted from lead ${lead.leadRef}${lead.notes ? ": " + lead.notes : ""}`,
                      },
                  }
                : {
                      create: {
                          text: `Converted from lead ${lead.leadRef}`,
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

    // ── 4. Delete the lead ─────────────────────────────────────────────────────
    await prisma.lead.delete({ where: { id } });

    return {
        clientId: client.id,
        clientName: client.name,
        portalAccessToken: client.portalAccessToken,
        message: `Lead converted — client record created for ${client.name}.`,
    };
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
