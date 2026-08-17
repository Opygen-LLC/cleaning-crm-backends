import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { ServiceStatus } from "../../generated/prisma/enums";
import { prisma } from "../../lib/prisma/prisma";
import { acquireExtendedTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { PublicWebsiteService } from "./publicWebsite.service";
import { bookingFormService } from "../BookingForm/bookingForm.service";
import { estimateFormService } from "../EstimateForm/estimateForm.service";
import { allocateLeadRef } from "../Lead/leadRef.service";

export interface PublicWebsiteContactPayload {
  name: string;
  email: string;
  phone?: string;
  message: string;
  serviceCatalogId?: string;
  // Honeypot. Real customers never fill this field.
  companyWebsite?: string;
}

const MAX_LEAD_NOTES = 12_000;

const normalizeEmail = (value: string) => value.trim().toLowerCase();
const normalizeOptional = (value?: string) => value?.trim() || undefined;

const appendBoundedNote = (existing: string | null, incoming: string) => {
  const combined = [existing?.trim(), incoming.trim()].filter(Boolean).join("\n\n");
  if (combined.length <= MAX_LEAD_NOTES) return combined;
  return combined.slice(combined.length - MAX_LEAD_NOTES);
};


type WebsiteBookingPayload = Parameters<typeof bookingFormService.submitPublicBookingFormById>[2];
type WebsiteEstimatePayload = Parameters<typeof estimateFormService.submitPublicEstimateFormById>[2];

const submitBooking = async (
  identifier: string,
  payload: WebsiteBookingPayload,
  idempotencyKey?: string,
) => {
  const integration = await PublicWebsiteService.resolvePublicBookingIntegration(identifier);
  const submission = await bookingFormService.submitPublicBookingFormById(
    integration.formId,
    integration.adminId,
    payload,
    idempotencyKey,
    integration.websiteId,
  );
  return {
    submission,
    _websiteId: integration.websiteId,
    _formId: integration.formId,
  };
};

const submitEstimate = async (
  identifier: string,
  payload: WebsiteEstimatePayload,
  idempotencyKey?: string,
) => {
  const integration = await PublicWebsiteService.resolvePublicEstimateIntegration(identifier);
  const submission = await estimateFormService.submitPublicEstimateFormById(
    integration.formId,
    integration.adminId,
    payload,
    idempotencyKey,
    integration.websiteId,
  );
  return {
    submission,
    _websiteId: integration.websiteId,
    _formId: integration.formId,
  };
};

const submitContact = async (identifier: string, payload: PublicWebsiteContactPayload) => {
  const integration = await PublicWebsiteService.resolvePublicContactIntegration(identifier);

  // Return the same generic success shape for honeypot submissions. This keeps
  // bots from learning whether they tripped spam protection and creates no CRM
  // data/no side effects.
  if (payload.companyWebsite?.trim()) {
    return { accepted: true, leadRef: null, merged: false, _websiteId: integration.websiteId };
  }

  const email = normalizeEmail(payload.email);
  const name = payload.name.trim();
  const phone = normalizeOptional(payload.phone);
  const message = payload.message.trim();
  const sourceRef = `WEBSITE:${integration.subdomain}`;

  return prisma.$transaction(async (tx) => {
    // Serialize submissions for the same tenant/email across all app instances.
    // This complements @@unique([email, adminId]) and also protects older rows
    // whose email casing predates normalized public capture.
    const lockKey = `lead-email:${integration.adminId}:${email}`;
    await acquireExtendedTextTransactionAdvisoryLock(tx, lockKey);

    const service = payload.serviceCatalogId
      ? await tx.serviceCatalog.findFirst({
          where: {
            id: payload.serviceCatalogId,
            adminId: integration.adminId,
            status: ServiceStatus.ACTIVE,
          },
          select: { id: true, serviceName: true },
        })
      : null;

    if (payload.serviceCatalogId && !service) {
      throw new AppError(status.UNPROCESSABLE_ENTITY, "That service is no longer available.", {
        code: "WEBSITE_CONTACT_SERVICE_UNAVAILABLE",
        retryable: false,
        fieldErrors: { serviceCatalogId: "Please choose another service." },
      });
    }

    const timestamp = new Date().toISOString();
    const note = `[Website enquiry ${timestamp}]${service ? `\nService: ${service.serviceName}` : ""}\n${message}`;
    const matchingLeads = await tx.lead.findMany({
      where: {
        adminId: integration.adminId,
        email: { equals: email, mode: "insensitive" },
      },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    // Prefer an already-normalized row if historical casing duplicates exist;
    // otherwise use the oldest case-insensitive match and normalize it now.
    const existing = matchingLeads.find((lead) => lead.email === email) ?? matchingLeads[0];

    if (existing) {
      const updated = await tx.lead.update({
        where: { id: existing.id },
        data: {
          name,
          email,
          ...(phone ? { phone } : {}),
          ...(service ? {
            serviceInterest: service.serviceName,
            serviceCatalogId: service.id,
          } : {}),
          sourceRef: existing.sourceRef || sourceRef,
          // Preserve an earlier non-website acquisition source. If this lead
          // had no source yet, keep a stable website FK in addition to the
          // human-readable sourceRef snapshot.
          ...(!existing.sourceRef && !existing.sourceWebsiteId
            ? { sourceWebsiteId: integration.websiteId }
            : {}),
          notes: appendBoundedNote(existing.notes, note),
        },
        select: { leadRef: true },
      });
      return { accepted: true, leadRef: updated.leadRef, merged: true, _websiteId: integration.websiteId };
    }

    const leadRef = await allocateLeadRef(tx);
    const created = await tx.lead.create({
      data: {
        leadRef,
        name,
        email,
        phone,
        serviceInterest: service?.serviceName ?? "Website enquiry",
        estimatedMin: 0,
        estimatedMax: 0,
        notes: note,
        sourceRef,
        serviceCatalogId: service?.id ?? null,
        sourceWebsiteId: integration.websiteId,
        adminId: integration.adminId,
      },
      select: { leadRef: true },
    });

    return { accepted: true, leadRef: created.leadRef, merged: false, _websiteId: integration.websiteId };
  });
};

export const WebsiteAcquisitionService = {
  submitContact,
  submitBooking,
  submitEstimate,
};
