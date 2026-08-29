import { randomUUID } from "node:crypto";
import status from "http-status";
import type { Prisma } from "../../generated/prisma/client";
import AppError from "../../errorHelper/AppError";
import { prisma } from "../../lib/prisma/prisma";
import { acquireTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { PROVISIONING_TRANSACTION_OPTIONS } from "../../lib/prisma/transactionPolicy";
import { DEFAULT_WEBSITE_PAGES, DEFAULT_WEBSITE_SETTINGS, RESERVED_WEBSITE_SUBDOMAINS } from "./website.constant";
import type { WebsiteCreateInput } from "./website.interface";
import { normalizeSubdomain } from "./websiteIdentity";
import { TemplateRegistry } from "./templateRegistry";
import { WebsiteHostResolverService } from "./websiteHostResolver.service";
import { WEBSITE_STATUS } from "./websiteLifecycle";

export const WEBSITE_SUBDOMAIN_RESERVATION_LOCK = "business-website-subdomain-reservation-v1";
const adminProvisioningLock = (adminId: string) => `business-website-provision:${adminId}`;
const MAX_SUFFIX_ATTEMPTS = 10_000;

const trimForSuffix = (base: string, suffix: string) => {
  const maxBaseLength = 63 - suffix.length;
  return `${base.slice(0, maxBaseLength).replace(/-+$/g, "")}${suffix}`;
};

/**
 * Produces a deterministic, URL-safe base label from a business name.
 * The admin id is only used as a stable fallback for names that contain no
 * ASCII letters/numbers (or collapse to a reserved platform label).
 */
export const buildWebsiteSubdomainBase = (businessName: string, adminId: string): string => {
  const ascii = businessName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  const stableId = adminId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) || "tenant";
  let base = ascii.slice(0, 54).replace(/-+$/g, "");

  if (base.length < 3) base = `business-${stableId}`;
  if (RESERVED_WEBSITE_SUBDOMAINS.has(base)) base = trimForSuffix(base, `-${stableId.slice(0, 6)}`);

  return normalizeSubdomain(base);
};

const isSubdomainTaken = async (db: Prisma.TransactionClient, subdomain: string) => {
  const [website, alias] = await Promise.all([
    db.businessWebsite.findUnique({ where: { subdomain }, select: { id: true } }),
    db.websiteSubdomainAlias.findUnique({ where: { subdomain }, select: { id: true } }),
  ]);
  return Boolean(website || alias);
};

/**
 * Reserves a unique label inside the caller's transaction.
 * A transaction-scoped PostgreSQL advisory lock serializes allocation across
 * app instances and backfill workers so two tenants cannot choose the same
 * candidate between the availability check and the INSERT.
 */
export const reserveWebsiteSubdomainTx = async (
  db: Prisma.TransactionClient,
  businessName: string,
  adminId: string,
): Promise<string> => {
  await acquireTextTransactionAdvisoryLock(db, WEBSITE_SUBDOMAIN_RESERVATION_LOCK);

  const base = buildWebsiteSubdomainBase(businessName, adminId);
  if (!(await isSubdomainTaken(db, base))) return base;

  for (let index = 2; index <= MAX_SUFFIX_ATTEMPTS; index += 1) {
    const suffix = `-${index}`;
    const candidate = trimForSuffix(base, suffix);
    if (!(await isSubdomainTaken(db, candidate))) return candidate;
  }

  // This should only be reachable under pathological data volumes. The stable
  // admin-derived suffix provides one final deterministic candidate before we
  // fail closed instead of silently stealing another tenant's hostname.
  const stableId = adminId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-10) || "tenant";
  const candidate = trimForSuffix(base, `-${stableId}`);
  if (!(await isSubdomainTaken(db, candidate))) return candidate;

  throw new AppError(status.CONFLICT, "Unable to reserve a unique website subdomain");
};

const loadWebsiteSnapshot = async (db: Prisma.TransactionClient, websiteId: string) => {
  const website = await db.businessWebsite.findUnique({
    where: { id: websiteId },
    include: {
      pages: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      domains: { orderBy: { createdAt: "asc" } },
      assets: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!website) throw new AppError(status.INTERNAL_SERVER_ERROR, "Website provisioning did not persist");
  return website;
};

type WebsiteProvisioningSnapshot = Awaited<ReturnType<typeof loadWebsiteSnapshot>>;

const createInitialRevisionTx = async (
  db: Prisma.TransactionClient,
  websiteId: string,
  createdByUserId: string | null,
  reason = "Website provisioned",
  preparedSnapshot?: WebsiteProvisioningSnapshot,
) => {
  const snapshot = preparedSnapshot ?? await loadWebsiteSnapshot(db, websiteId);
  await db.websiteRevision.create({
    data: {
      websiteId,
      revisionNumber: 1,
      snapshot: JSON.parse(JSON.stringify(snapshot)),
      reason,
      createdByUserId,
    },
  });
  await db.businessWebsite.update({
    where: { id: websiteId },
    data: { draftRevisionNumber: 1 },
  });

  // Registration used to reload the complete website (pages/domains/assets)
  // immediately after this snapshot, creating a second expensive lateral-join
  // query inside the same transaction. The snapshot already contains the full
  // relation graph; only the persisted revision counter changed.
  return { ...snapshot, draftRevisionNumber: 1 };
};

const createWebsiteRecordTx = async (
  db: Prisma.TransactionClient,
  adminId: string,
  subdomain: string,
  payload: Omit<WebsiteCreateInput, "subdomain">,
  createdByUserId: string | null,
  initialRevisionReason = "Website provisioned",
) => {
  const template = TemplateRegistry.requireTemplate(
    payload.templateId ?? DEFAULT_WEBSITE_SETTINGS.templateId,
    payload.templateVersion,
  );

  const website = await db.businessWebsite.create({
    data: {
      adminId,
      subdomain,
      status: WEBSITE_STATUS.PROVISIONED,
      templateId: template.id,
      templateVersion: template.version,
      schemaVersion: template.schemaVersion,
      primaryColor: DEFAULT_WEBSITE_SETTINGS.primaryColor,
      secondaryColor: DEFAULT_WEBSITE_SETTINGS.secondaryColor,
      accentColor: DEFAULT_WEBSITE_SETTINGS.accentColor,
      font: DEFAULT_WEBSITE_SETTINGS.font,
      logo: DEFAULT_WEBSITE_SETTINGS.logo,
      favicon: DEFAULT_WEBSITE_SETTINGS.favicon,
      bookingEnabled: DEFAULT_WEBSITE_SETTINGS.bookingEnabled,
      bookingShowNavigation: DEFAULT_WEBSITE_SETTINGS.bookingShowNavigation,
      bookingShowHeaderCta: DEFAULT_WEBSITE_SETTINGS.bookingShowHeaderCta,
      bookingShowServiceCtas: DEFAULT_WEBSITE_SETTINGS.bookingShowServiceCtas,
      bookingShowHomeCta: DEFAULT_WEBSITE_SETTINGS.bookingShowHomeCta,
      bookingShowAvailableSlots: DEFAULT_WEBSITE_SETTINGS.bookingShowAvailableSlots,
      bookingShowPrices: DEFAULT_WEBSITE_SETTINGS.bookingShowPrices,
      bookingShowStartingPrices: DEFAULT_WEBSITE_SETTINGS.bookingShowStartingPrices,
      bookingShowServiceDuration: DEFAULT_WEBSITE_SETTINGS.bookingShowServiceDuration,
      bookingCtaLabel: DEFAULT_WEBSITE_SETTINGS.bookingCtaLabel,
      estimateEnabled: DEFAULT_WEBSITE_SETTINGS.estimateEnabled,
      metaTitle: DEFAULT_WEBSITE_SETTINGS.metaTitle,
      metaDescription: DEFAULT_WEBSITE_SETTINGS.metaDescription,
      socialImageUrl: DEFAULT_WEBSITE_SETTINGS.socialImageUrl,
      indexSite: DEFAULT_WEBSITE_SETTINGS.indexSite,
      primaryBookingFormId: payload.primaryBookingFormId ?? null,
      primaryEstimateFormId: payload.primaryEstimateFormId ?? null,
    },
  });

  // Pre-generate page IDs/timestamps so registration can build revision #1
  // entirely from returned writes. This removes the previous website + pages +
  // domains + assets reread from the registration transaction.
  const pageTimestamp = new Date();
  const pageRows = DEFAULT_WEBSITE_PAGES.map((page) => ({
    id: randomUUID(),
    websiteId: website.id,
    ...page,
    content: JSON.parse(JSON.stringify(page.content ?? {})),
    seoTitle: null,
    seoDescription: null,
    isEnabled: true,
    createdAt: pageTimestamp,
    updatedAt: pageTimestamp,
  }));
  await db.websitePage.createMany({ data: pageRows });

  const initialSnapshot: WebsiteProvisioningSnapshot = {
    ...website,
    pages: pageRows,
    domains: [],
    assets: [],
  };

  return createInitialRevisionTx(
    db,
    website.id,
    createdByUserId,
    initialRevisionReason,
    initialSnapshot,
  );
};

/** Explicit website creation used by the protected Phase-1 API. */
export const createWebsiteForAdminTx = async (
  db: Prisma.TransactionClient,
  adminId: string,
  payload: WebsiteCreateInput,
  createdByUserId: string | null = null,
) => {
  await acquireTextTransactionAdvisoryLock(db, adminProvisioningLock(adminId));
  const existing = await db.businessWebsite.findUnique({ where: { adminId }, select: { id: true } });
  if (existing) throw new AppError(status.CONFLICT, "This business already has a website");

  const subdomain = normalizeSubdomain(payload.subdomain);
  await acquireTextTransactionAdvisoryLock(db, WEBSITE_SUBDOMAIN_RESERVATION_LOCK);
  if (await isSubdomainTaken(db, subdomain)) {
    throw new AppError(status.CONFLICT, "That subdomain is already in use");
  }

  const { subdomain: _subdomain, ...rest } = payload;
  return createWebsiteRecordTx(db, adminId, subdomain, rest, createdByUserId);
};

/**
 * Idempotent automatic provisioning primitive used by registration and the
 * existing-tenant backfill. If a website already exists, it is returned
 * unchanged; otherwise a unique subdomain, default pages and revision #1 are
 * created atomically inside the caller's transaction.
 */
export const provisionDefaultWebsiteForAdminTx = async (
  db: Prisma.TransactionClient,
  input: {
    adminId: string;
    businessName: string;
    createdByUserId?: string | null;
    initialRevisionReason?: string;
    /** Trusted only for a brand-new AdminProfile created in the same transaction. */
    skipExistingCheck?: boolean;
  },
) => {
  if (!input.skipExistingCheck) {
    await acquireTextTransactionAdvisoryLock(db, adminProvisioningLock(input.adminId));
    const existing = await db.businessWebsite.findUnique({ where: { adminId: input.adminId }, select: { id: true } });
    if (existing) {
      return { created: false, website: await loadWebsiteSnapshot(db, existing.id) };
    }
  }

  const subdomain = await reserveWebsiteSubdomainTx(db, input.businessName, input.adminId);
  const website = await createWebsiteRecordTx(
    db,
    input.adminId,
    subdomain,
    {},
    input.createdByUserId ?? null,
    input.initialRevisionReason ?? "Website provisioned",
  );

  return { created: true, website };
};

/**
 * Standalone idempotent provisioning entry point for migrations/repair jobs.
 * Registration intentionally uses the Tx variant so website + trial can share
 * one transaction.
 */
export const provisionDefaultWebsiteForAdmin = async (input: {
  adminId: string;
  businessName: string;
  createdByUserId?: string | null;
  initialRevisionReason?: string;
}) => {
  const result = await prisma.$transaction(
    (tx: Prisma.TransactionClient) => provisionDefaultWebsiteForAdminTx(tx, input),
    PROVISIONING_TRANSACTION_OPTIONS,
  );

  // A wildcard hostname may have been probed before this tenant existed and
  // therefore be sitting in the short negative resolver cache. Drop it after
  // commit so backfills/repair provisioning become reachable immediately.
  if (result.created) {
    await WebsiteHostResolverService.invalidateSubdomains([result.website.subdomain]);
  }
  return result;
};

export const WebsiteProvisioningService = {
  createWebsiteForAdminTx,
  provisionDefaultWebsiteForAdminTx,
  provisionDefaultWebsiteForAdmin,
  reserveWebsiteSubdomainTx,
  buildWebsiteSubdomainBase,
};
