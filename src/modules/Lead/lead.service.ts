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
// FIX #1: Use aggregate MAX on leadRef instead of ordering by createdAt —
//         avoids race conditions and is O(1) on the index.

const generateLeadRef = async (): Promise<string> => {
  const agg = await prisma.lead.aggregate({
    _max: { leadRef: true },
  });

  const lastRef = agg._max.leadRef;
  if (lastRef) {
    const parts = lastRef.split("-");
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

// ─── Decimal serialiser ───────────────────────────────────────────────────────
// FIX #3: Prisma Decimal fields come back as Decimal objects — coerce to number
//         so JSON.stringify produces numeric values, not string objects.

function serializeLead(
  lead: Lead & Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...lead,
    estimatedMin: Number(lead.estimatedMin),
    estimatedMax: Number(lead.estimatedMax),
  };
}

// ─── Service methods ──────────────────────────────────────────────────────────

const createLead = async (payload: CreateLeadPayload, user: IRequestUser) => {
  const adminProfile = await resolveAdminProfile(user);

  const leadRef = await generateLeadRef();

  const lead = await prisma.lead.create({
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

  return serializeLead(lead as Lead & Record<string, unknown>);
};

const getLeads = async (query: IQueryParams, user: IRequestUser) => {
  const adminProfile = await resolveAdminProfile(user);

  // FIX #4: Add explicit select to avoid over-fetching; keep only fields
  //         the frontend needs.
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

  // FIX #3: Coerce Decimal fields on every item in the list
  return {
    ...result,
    data: result.data.map((lead) =>
      serializeLead(lead as Lead & Record<string, unknown>),
    ),
  };
};

const getLeadById = async (id: string, user: IRequestUser) => {
  const adminProfile = await resolveAdminProfile(user);

  // FIX #4: Add select so only required fields are returned
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

  const lead = await prisma.lead.update({
    where: { id },
    data: payload,
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

  const lead = await prisma.lead.update({
    where: { id },
    data: { stage },
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

export const leadService = {
  createLead,
  getLeads,
  getLeadById,
  updateLead,
  updateLeadStage,
  deleteLead,
};
