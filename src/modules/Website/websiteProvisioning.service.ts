import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { DEFAULT_WEBSITE_PAGES, RESERVED_WEBSITE_SUBDOMAINS } from "./website.constant";
import type { WebsiteCreateInput } from "./website.interface";
import { normalizeSubdomain } from "./websiteIdentity";
import { TemplateRegistry } from "./templateRegistry";

const SUBDOMAIN_RESERVATION_LOCK = "business-website-subdomain-reservation-v1";
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

const isSubdomainTaken = async (db: any, subdomain: string) => {
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
  db: any,
  businessName: string,
  adminId: string,
): Promise<string> => {
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${SUBDOMAIN_RESERVATION_LOCK}))`;

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

const loadWebsiteSnapshot = async (db: any, websiteId: string) => {
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

const createInitialRevisionTx = async (
  db: any,
  websiteId: string,
  createdByUserId: string | null,
) => {
  const snapshot = await loadWebsiteSnapshot(db, websiteId);
  await db.websiteRevision.create({
    data: {
      websiteId,
      revisionNumber: 1,
      snapshot: JSON.parse(JSON.stringify(snapshot)),
      reason: "Website provisioned",
      createdByUserId,
    },
  });
};

const createWebsiteRecordTx = async (
  db: any,
  adminId: string,
  subdomain: string,
  payload: Omit<WebsiteCreateInput, "subdomain">,
  createdByUserId: string | null,
) => {
  const template = TemplateRegistry.requireTemplate(
    payload.templateId ?? "clean-modern",
    payload.templateVersion,
  );

  const website = await db.businessWebsite.create({
    data: {
      adminId,
      subdomain,
      templateId: template.id,
      templateVersion: template.version,
      schemaVersion: template.schemaVersion,
      primaryBookingFormId: payload.primaryBookingFormId ?? null,
      primaryEstimateFormId: payload.primaryEstimateFormId ?? null,
      pages: {
        create: DEFAULT_WEBSITE_PAGES.map((page) => ({ ...page, content: {} })),
      },
    },
    select: { id: true },
  });

  await createInitialRevisionTx(db, website.id, createdByUserId);
  return loadWebsiteSnapshot(db, website.id);
};

/** Explicit website creation used by the protected Phase-1 API. */
export const createWebsiteForAdminTx = async (
  db: any,
  adminId: string,
  payload: WebsiteCreateInput,
  createdByUserId: string | null = null,
) => {
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${adminProvisioningLock(adminId)}))`;
  const existing = await db.businessWebsite.findUnique({ where: { adminId }, select: { id: true } });
  if (existing) throw new AppError(status.CONFLICT, "This business already has a website");

  const subdomain = normalizeSubdomain(payload.subdomain);
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${SUBDOMAIN_RESERVATION_LOCK}))`;
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
  db: any,
  input: {
    adminId: string;
    businessName: string;
    createdByUserId?: string | null;
  },
) => {
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${adminProvisioningLock(input.adminId)}))`;
  const existing = await db.businessWebsite.findUnique({ where: { adminId: input.adminId }, select: { id: true } });
  if (existing) {
    return { created: false, website: await loadWebsiteSnapshot(db, existing.id) };
  }

  const subdomain = await reserveWebsiteSubdomainTx(db, input.businessName, input.adminId);
  const website = await createWebsiteRecordTx(
    db,
    input.adminId,
    subdomain,
    {},
    input.createdByUserId ?? null,
  );

  return { created: true, website };
};

export const WebsiteProvisioningService = {
  createWebsiteForAdminTx,
  provisionDefaultWebsiteForAdminTx,
  reserveWebsiteSubdomainTx,
  buildWebsiteSubdomainBase,
};
