import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { ServiceStatus } from "../../generated/prisma/enums";
import type { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";
import { acquireExtendedTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { PublicWebsiteService } from "./publicWebsite.service";

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

const generateLeadRef = async (tx: Prisma.TransactionClient): Promise<string> => {
  // Lead.leadRef is globally unique. Serialize the existing sequential ref
  // generator so a burst of public enquiries cannot race on the same value.
  await acquireExtendedTextTransactionAdvisoryLock(tx, "lead-ref-sequence");
  const rows = await tx.$queryRaw<Array<{ maxNumber: string }>>`
    SELECT COALESCE(MAX((regexp_match("leadRef", '([0-9]+)$'))[1]::bigint), 0)::text AS "maxNumber"
    FROM "lead"
    WHERE "leadRef" ~ '[0-9]+$'
  `;
  const lastNumber = Number.parseInt(rows[0]?.maxNumber ?? "0", 10);
  const nextNumber = Number.isFinite(lastNumber) ? lastNumber + 1 : 1;
  return `LEAD-${String(nextNumber).padStart(4, "0")}`;
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
    const lockKey = `website-contact:${integration.adminId}:${email}`;
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
          ...(service ? { serviceInterest: service.serviceName } : {}),
          sourceRef: existing.sourceRef || sourceRef,
          notes: appendBoundedNote(existing.notes, note),
        },
        select: { leadRef: true },
      });
      return { accepted: true, leadRef: updated.leadRef, merged: true, _websiteId: integration.websiteId };
    }

    const leadRef = await generateLeadRef(tx);
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
        adminId: integration.adminId,
      },
      select: { leadRef: true },
    });

    return { accepted: true, leadRef: created.leadRef, merged: false, _websiteId: integration.websiteId };
  });
};

export const WebsiteAcquisitionService = { submitContact };
