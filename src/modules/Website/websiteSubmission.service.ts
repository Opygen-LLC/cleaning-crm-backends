import { randomBytes } from "node:crypto";
import status from "http-status";
import AppError from "../../errorHelper/AppError";
import {
  EstimateSubmissionStatus,
  FormSubmissionStatus,
  WebsiteSubmissionKind,
  WebsiteSubmissionStatus,
} from "../../generated/prisma/enums";
import type { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";

const generateWebsiteSubmissionRef = () => `WS-${randomBytes(10).toString("hex").toUpperCase()}`;
const compact = (value?: string | null) => value?.trim() || null;
const boundedSummary = (value: string) => value.trim().slice(0, 4000);

export type WebsiteSubmissionTx = Prisma.TransactionClient;

interface ContactEnvelopeInput {
  adminId: string;
  websiteId: string;
  serviceCatalogId?: string | null;
  serviceNameSnapshot?: string | null;
  name: string;
  email: string;
  phone?: string | null;
  message: string;
  leadId: string;
}

export const createContactWebsiteSubmission = (
  tx: WebsiteSubmissionTx,
  input: ContactEnvelopeInput,
) => tx.websiteSubmission.create({
  data: {
    ref: generateWebsiteSubmissionRef(),
    kind: WebsiteSubmissionKind.CONTACT,
    status: WebsiteSubmissionStatus.NEW,
    adminId: input.adminId,
    websiteId: input.websiteId,
    serviceCatalogId: input.serviceCatalogId ?? null,
    serviceNameSnapshot: compact(input.serviceNameSnapshot),
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    phone: compact(input.phone),
    summary: boundedSummary(input.message),
    leadId: input.leadId,
  },
});

interface BookingEnvelopeInput {
  id: string;
  sourceWebsiteId: string | null;
  serviceCatalogId: string | null;
  serviceNameSnapshot: string | null;
  name: string;
  email: string;
  phone: string;
  notes?: string | null;
  address: string;
  status: FormSubmissionStatus;
}

const bookingEnvelopeStatus = (value: FormSubmissionStatus): WebsiteSubmissionStatus => {
  if (value === FormSubmissionStatus.CONVERTED) return WebsiteSubmissionStatus.CONVERTED;
  if (value === FormSubmissionStatus.REVIEWED) return WebsiteSubmissionStatus.REVIEWED;
  if (value === FormSubmissionStatus.DECLINED) return WebsiteSubmissionStatus.DISMISSED;
  return WebsiteSubmissionStatus.NEW;
};

export const ensureBookingWebsiteSubmission = async (
  tx: WebsiteSubmissionTx,
  input: BookingEnvelopeInput,
  adminId: string,
) => {
  if (!input.sourceWebsiteId) return null;
  const website = await tx.businessWebsite.findFirst({
    where: { id: input.sourceWebsiteId, adminId },
    select: { id: true },
  });
  if (!website) {
    throw new AppError(status.CONFLICT, "Booking submission website attribution is invalid", {
      code: "WEBSITE_SUBMISSION_TENANT_MISMATCH",
      retryable: false,
    });
  }
  return tx.websiteSubmission.upsert({
    where: { bookingFormSubmissionId: input.id },
    create: {
      ref: generateWebsiteSubmissionRef(),
      kind: WebsiteSubmissionKind.BOOKING,
      status: bookingEnvelopeStatus(input.status),
      adminId,
      websiteId: input.sourceWebsiteId,
      serviceCatalogId: input.serviceCatalogId,
      serviceNameSnapshot: compact(input.serviceNameSnapshot),
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      phone: compact(input.phone),
      summary: boundedSummary(compact(input.notes) ?? `Booking request for ${input.serviceNameSnapshot ?? "service"} at ${input.address}`),
      bookingFormSubmissionId: input.id,
    },
    update: {
      status: bookingEnvelopeStatus(input.status),
      serviceCatalogId: input.serviceCatalogId,
      serviceNameSnapshot: compact(input.serviceNameSnapshot),
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      phone: compact(input.phone),
      summary: boundedSummary(compact(input.notes) ?? `Booking request for ${input.serviceNameSnapshot ?? "service"} at ${input.address}`),
    },
  });
};

interface EstimateEnvelopeInput {
  id: string;
  sourceWebsiteId: string | null;
  serviceCatalogId: string | null;
  serviceNameSnapshot: string | null;
  name: string;
  email: string;
  phone: string;
  notes?: string | null;
  postcode: string;
  status: EstimateSubmissionStatus;
}

const estimateEnvelopeStatus = (value: EstimateSubmissionStatus): WebsiteSubmissionStatus => {
  if (value === EstimateSubmissionStatus.CONVERTED) return WebsiteSubmissionStatus.CONVERTED;
  if (value === EstimateSubmissionStatus.QUOTED) return WebsiteSubmissionStatus.REVIEWED;
  if (value === EstimateSubmissionStatus.DISMISSED) return WebsiteSubmissionStatus.DISMISSED;
  return WebsiteSubmissionStatus.NEW;
};

export const ensureEstimateWebsiteSubmission = async (
  tx: WebsiteSubmissionTx,
  input: EstimateEnvelopeInput,
  adminId: string,
) => {
  if (!input.sourceWebsiteId) return null;
  const website = await tx.businessWebsite.findFirst({
    where: { id: input.sourceWebsiteId, adminId },
    select: { id: true },
  });
  if (!website) {
    throw new AppError(status.CONFLICT, "Estimate submission website attribution is invalid", {
      code: "WEBSITE_SUBMISSION_TENANT_MISMATCH",
      retryable: false,
    });
  }
  return tx.websiteSubmission.upsert({
    where: { estimateFormSubmissionId: input.id },
    create: {
      ref: generateWebsiteSubmissionRef(),
      kind: WebsiteSubmissionKind.ESTIMATE,
      status: estimateEnvelopeStatus(input.status),
      adminId,
      websiteId: input.sourceWebsiteId,
      serviceCatalogId: input.serviceCatalogId,
      serviceNameSnapshot: compact(input.serviceNameSnapshot),
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      phone: compact(input.phone),
      summary: boundedSummary(compact(input.notes) ?? `Estimate request for ${input.serviceNameSnapshot ?? "service"} in ${input.postcode}`),
      estimateFormSubmissionId: input.id,
    },
    update: {
      status: estimateEnvelopeStatus(input.status),
      serviceCatalogId: input.serviceCatalogId,
      serviceNameSnapshot: compact(input.serviceNameSnapshot),
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      phone: compact(input.phone),
      summary: boundedSummary(compact(input.notes) ?? `Estimate request for ${input.serviceNameSnapshot ?? "service"} in ${input.postcode}`),
    },
  });
};

export const syncBookingWebsiteSubmissionStatus = (
  tx: WebsiteSubmissionTx,
  submissionId: string,
  value: FormSubmissionStatus,
) => tx.websiteSubmission.updateMany({
  where: { bookingFormSubmissionId: submissionId },
  data: { status: bookingEnvelopeStatus(value) },
});

export const syncEstimateWebsiteSubmissionStatus = (
  tx: WebsiteSubmissionTx,
  submissionId: string,
  value: EstimateSubmissionStatus,
) => tx.websiteSubmission.updateMany({
  where: { estimateFormSubmissionId: submissionId },
  data: { status: estimateEnvelopeStatus(value) },
});

export const syncLeadWebsiteSubmissionsConverted = (
  tx: WebsiteSubmissionTx,
  leadId: string,
) => tx.websiteSubmission.updateMany({
  where: { leadId, kind: WebsiteSubmissionKind.CONTACT },
  data: { status: WebsiteSubmissionStatus.CONVERTED },
});

export interface WebsiteSubmissionListQuery {
  page?: number;
  limit?: number;
  kind?: WebsiteSubmissionKind;
  status?: WebsiteSubmissionStatus;
  search?: string;
}

const itemInclude = {
  website: { select: { id: true, subdomain: true } },
  serviceCatalog: { select: { id: true, serviceName: true } },
  lead: { select: { id: true, leadRef: true, stage: true, convertedClientId: true } },
  bookingFormSubmission: {
    select: {
      id: true,
      ref: true,
      status: true,
      date: true,
      timeSlot: true,
      address: true,
      notes: true,
      convertedBookingId: true,
      convertedBooking: { select: { id: true, bookingRef: true } },
    },
  },
  estimateFormSubmission: {
    select: {
      id: true,
      ref: true,
      status: true,
      postcode: true,
      city: true,
      bedrooms: true,
      bathrooms: true,
      notes: true,
      estimatedMin: true,
      estimatedMax: true,
    },
  },
} as const;

const listWebsiteSubmissions = async (query: WebsiteSubmissionListQuery, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(100, Math.max(1, query.limit ?? 20));
  const search = query.search?.trim();
  const where: Prisma.WebsiteSubmissionWhereInput = {
    adminId,
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(search ? {
      OR: [
        { ref: { contains: search, mode: "insensitive" } },
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { phone: { contains: search, mode: "insensitive" } },
        { serviceNameSnapshot: { contains: search, mode: "insensitive" } },
        { summary: { contains: search, mode: "insensitive" } },
        { lead: { is: { leadRef: { contains: search, mode: "insensitive" } } } },
        { bookingFormSubmission: { is: { ref: { contains: search, mode: "insensitive" } } } },
        { estimateFormSubmission: { is: { ref: { contains: search, mode: "insensitive" } } } },
      ],
    } : {}),
  };

  const [items, total, grouped] = await prisma.$transaction([
    prisma.websiteSubmission.findMany({
      where,
      include: itemInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.websiteSubmission.count({ where }),
    prisma.websiteSubmission.groupBy({
      by: ["status"],
      where: {
        adminId,
        ...(query.kind ? { kind: query.kind } : {}),
        ...(search ? { OR: where.OR } : {}),
      },
      _count: { _all: true },
    } as any),
  ]);

  const counts: Record<string, number> = {
    total: (grouped as any[]).reduce((sum, row) => sum + (row._count?._all ?? 0), 0),
    NEW: 0,
    REVIEWED: 0,
    CONVERTED: 0,
    DISMISSED: 0,
  };
  for (const row of (grouped as any[])) counts[row.status] = row._count?._all ?? 0;

  return {
    items,
    counts,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
};

const updateWebsiteSubmissionStatus = async (
  submissionId: string,
  newStatus: WebsiteSubmissionStatus,
  user: IRequestUser,
) => {
  const adminId = await getAdminId(user);
  const existing = await prisma.websiteSubmission.findFirst({
    where: { id: submissionId, adminId },
    select: { id: true, status: true },
  });
  if (!existing) throw new AppError(status.NOT_FOUND, "Website submission not found");

  if (existing.status === WebsiteSubmissionStatus.CONVERTED && newStatus !== WebsiteSubmissionStatus.CONVERTED) {
    throw new AppError(status.CONFLICT, "Converted submissions cannot be moved back to another inbox status", {
      code: "WEBSITE_SUBMISSION_CONVERSION_IMMUTABLE",
      retryable: false,
    });
  }
  if (newStatus === WebsiteSubmissionStatus.CONVERTED && existing.status !== WebsiteSubmissionStatus.CONVERTED) {
    throw new AppError(status.CONFLICT, "Conversion status is set by the linked CRM workflow", {
      code: "WEBSITE_SUBMISSION_CONVERSION_REQUIRED",
      retryable: false,
    });
  }

  return prisma.websiteSubmission.update({
    where: { id: submissionId },
    data: { status: newStatus },
    include: itemInclude,
  });
};

export const WebsiteSubmissionService = {
  listWebsiteSubmissions,
  updateWebsiteSubmissionStatus,
};
