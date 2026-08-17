import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { ServiceStatus } from "../../generated/prisma/enums";
import { prisma } from "../../lib/prisma/prisma";
import { acquireExtendedTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { PublicWebsiteService } from "./publicWebsite.service";
import { bookingFormService } from "../BookingForm/bookingForm.service";
import { estimateFormService } from "../EstimateForm/estimateForm.service";
import { allocateLeadRef } from "../Lead/leadRef.service";
import { normalizePhone } from "../../lib/utils/normalizePhone";

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
const normalizeOptionalPhone = (value?: string) => {
  const raw = normalizeOptional(value);
  if (!raw) return undefined;
  const normalized = normalizePhone(raw);
  return normalized.replace(/\D/g, "").length >= 7 ? normalized : undefined;
};

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
  const phone = normalizeOptionalPhone(payload.phone);
  const message = payload.message.trim();
  const sourceRef = "Website";
  const sourcePage = "/contact";

  return prisma.$transaction(async (tx) => {
    // Serialize submissions for the same tenant/email across all app instances.
    // This complements @@unique([email, adminId]) and also protects older rows
    // whose email casing predates normalized public capture.
    // Use the same email lock as manual CRM lead creation, plus a phone lock
    // when present. Acquiring in deterministic order prevents lock inversion.
    const lockKeys = [
      `lead-email:${integration.adminId}:${email}`,
      ...(phone ? [`lead-phone:${integration.adminId}:${phone}`] : []),
    ].sort();
    for (const lockKey of lockKeys) {
      await acquireExtendedTextTransactionAdvisoryLock(tx, lockKey);
    }

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
    const note = `[Website enquiry ${timestamp}]\nWebsite: ${integration.businessName}\nPage: ${sourcePage}\nEmail: ${email}${phone ? `\nPhone: ${phone}` : ""}${service ? `\nService: ${service.serviceName}` : ""}\n${message}`;
    const matchingLeads = await tx.lead.findMany({
      where: {
        adminId: integration.adminId,
        OR: [
          { email: { equals: email, mode: "insensitive" } },
          ...(phone ? [{ phone }] : []),
        ],
      },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    // Email is the strongest stable identifier. If no email match exists,
    // reuse a normalized-phone match. We never create a third duplicate when
    // historical data already contains conflicting email/phone rows.
    const emailMatch = matchingLeads.find((lead) => lead.email.toLowerCase() === email);
    const phoneMatch = phone ? matchingLeads.find((lead) => lead.phone === phone) : undefined;
    const existing = emailMatch ?? phoneMatch ?? matchingLeads[0];

    if (existing) {
      const updated = await tx.lead.update({
        where: { id: existing.id },
        data: {
          name,
          // A phone-only dedupe should not silently replace an established
          // email address. The newly submitted address is retained in notes.
          email: emailMatch ? email : existing.email,
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
