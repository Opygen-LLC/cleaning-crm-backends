import { randomUUID } from "crypto";
import status from "http-status";
import AppError from "../../errorHelper/AppError";
import logger from "../../lib/logger";
import { WEBSITE_BASE_DOMAIN, WEBSITE_CUSTOM_DOMAINS_ENABLED } from "../../config/ENV";
import { prisma } from "../../lib/prisma/prisma";
import { acquireTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { PROVISIONING_TRANSACTION_OPTIONS } from "../../lib/prisma/transactionPolicy";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import { deleteFromCloudinary, uploadToCloudinary } from "../../lib/utils/cloudinary";
import type { IRequestUser } from "../../types/requestUser.interface";
import { ONBOARDING_STEPS } from "../Admin/admin.constant";
import type {
  WebsiteAssetCreateInput,
  WebsiteManagedBrandAssetInput,
  WebsiteCreateInput,
  WebsiteEditorStateInput,
  WebsitePageUpdateInput,
  WebsitePublishInput,
  WebsiteRevisionRestoreInput,
  WebsiteUpdateInput,
  WebsiteEditorSurface,
} from "./website.interface";
import { assertSafeHttpsUrl, normalizeSubdomain } from "./websiteIdentity";
import { TemplateRegistry } from "./templateRegistry";
import { buildTemplateSelectionPatch } from "./templateSelection";
import { WebsiteProvisioningService } from "./websiteProvisioning.service";
import { WebsiteBookingProvisioningService } from "./websiteBookingProvisioning.service";
import { PublicWebsiteService } from "./publicWebsite.service";
import { buildPublishedSnapshot, parsePublishedSnapshot, parseRevisionSnapshotAsPublished } from "./websiteSnapshot";
import { WebsiteHostResolverService } from "./websiteHostResolver.service";
import { WebsiteProjectionCacheService } from "./websiteProjectionCache.service";
import { isWebsiteDomainRoutingReady } from "./websiteDomainReadiness";
import { presentWebsiteDomain } from "./websiteDomainLifecycle";
import { WEBSITE_STATUS, statusAfterDraftMutation, type WebsiteLifecycleStatus } from "./websiteLifecycle";
import { validateWebsitePageContent } from "./websiteContent";
import { parseWebsiteDesignContract } from "./websiteDesignContract";
import { assertWebsiteDesignPublishable } from "./websiteComponentRegistry";
import { WebsiteEntitlementService, type WebsiteEntitlements } from "./websiteEntitlement.service";
import { bumpCacheResourceVersions, CacheResource } from "../../lib/cache/resourceCacheVersion";
import type { Prisma } from "../../generated/prisma/client";

type WebsiteDb = Prisma.TransactionClient | typeof prisma;

const toInputJsonValue = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;


const assertEntitledWebsitePatch = (
  payload: WebsiteUpdateInput,
  current: { templateId: string; templateVersion: string },
  entitlements: WebsiteEntitlements,
) => {
  if (payload.templateId !== undefined || payload.templateVersion !== undefined) {
    const selection = buildTemplateSelectionPatch(payload, current);
    if ("templateId" in selection) {
      const template = TemplateRegistry.requireTemplate(selection.templateId, selection.templateVersion);
      WebsiteEntitlementService.assertTemplateAllowed(template, entitlements);
    }
  }
  if (((typeof payload.socialImageUrl === "string" && payload.socialImageUrl.trim()) || Boolean(payload.metaKeywords?.length)) && !entitlements.advancedSeo) {
    throw new AppError(status.FORBIDDEN, "Social share image customization requires Advanced Website SEO.", {
      code: "WEBSITE_ADVANCED_SEO_REQUIRED", retryable: false,
    });
  }
};

const assertEntitledPagePatch = (payload: WebsitePageUpdateInput, entitlements: WebsiteEntitlements) => {
  const addsAdvancedSeo =
    (typeof payload.seoTitle === "string" && payload.seoTitle.trim().length > 0) ||
    (typeof payload.seoDescription === "string" && payload.seoDescription.trim().length > 0) ||
    Boolean(payload.seoKeywords?.length) ||
    (typeof payload.socialImageUrl === "string" && payload.socialImageUrl.trim().length > 0);
  if (addsAdvancedSeo && !entitlements.advancedSeo) {
    throw new AppError(status.FORBIDDEN, "Page-specific SEO overrides require Advanced Website SEO.", {
      code: "WEBSITE_ADVANCED_SEO_REQUIRED", retryable: false,
    });
  }
};

const getWebsiteOrThrow = async (adminId: string, db: WebsiteDb = prisma) => {
  const website = await db.businessWebsite.findUnique({ where: { adminId }, select: { id: true } });
  if (!website) throw new AppError(status.NOT_FOUND, "Business website has not been provisioned yet");
  return website;
};


const MANAGED_IMAGE_FIELDS = [
  { kind: "logo", field: "logo", label: "logo" },
  { kind: "favicon", field: "favicon", label: "favicon" },
  { kind: "social", field: "socialImageUrl", label: "social share image" },
] as const;

type ManagedImageKind = (typeof MANAGED_IMAGE_FIELDS)[number]["kind"];
type ManagedImageField = (typeof MANAGED_IMAGE_FIELDS)[number]["field"];

const isManagedBrandAsset = (asset: { metadata: unknown } | null, kind: ManagedImageKind) => {
  if (!asset?.metadata || typeof asset.metadata !== "object" || Array.isArray(asset.metadata)) return false;
  const metadata = asset.metadata as Record<string, unknown>;
  return metadata.provider === "cloudinary" && metadata.kind === "brand" && metadata.slot === kind && metadata.immutable === true;
};

const assertManagedBrandReferences = async (
  websiteId: string,
  payload: WebsiteUpdateInput,
  current: Partial<Record<ManagedImageField, string | null>>,
  db: WebsiteDb,
) => {
  for (const { kind, field, label } of MANAGED_IMAGE_FIELDS) {
    const next = payload[field];
    if (next === undefined || next === null || next === current[field]) continue;
    const safeUrl = assertSafeHttpsUrl(next, `${label[0].toUpperCase()}${label.slice(1)} URL`);
    if (!safeUrl) continue;
    const asset = await db.websiteAsset.findFirst({
      where: { websiteId, url: safeUrl },
      select: { metadata: true },
    });
    if (!isManagedBrandAsset(asset, kind)) {
      throw new AppError(status.BAD_REQUEST, `Upload the ${label} through Website Studio instead of pasting an external URL`, {
        code: "WEBSITE_MANAGED_ASSET_REQUIRED",
        retryable: false,
      });
    }
  }
};

const assertManagedPageSocialReferences = async (
  websiteId: string,
  pages: WebsiteEditorStateInput["pages"],
  db: WebsiteDb,
) => {
  for (const page of pages ?? []) {
    if (page.socialImageUrl === undefined || page.socialImageUrl === null) continue;
    const safeUrl = assertSafeHttpsUrl(page.socialImageUrl, "Page social image URL");
    if (!safeUrl) continue;
    const asset = await db.websiteAsset.findFirst({ where: { websiteId, url: safeUrl }, select: { metadata: true } });
    if (!isManagedBrandAsset(asset, "social")) {
      throw new AppError(status.BAD_REQUEST, "Upload page OpenGraph images through Website Studio instead of pasting an external URL", {
        code: "WEBSITE_MANAGED_ASSET_REQUIRED",
        retryable: false,
      });
    }
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Asset deletion removes only the WebsiteAsset row; immutable Cloudinary
 * resources remain available so historical revisions can still be recovered.
 * Rehydrate only brand assets that were already recorded inside this tenant's
 * own revision snapshot and still carry the Phase-8 immutable metadata.
 */
const rehydrateManagedBrandAssetsFromRevision = async (
  websiteId: string,
  rawSnapshot: unknown,
  target: Pick<WebsiteUpdateInput, "logo" | "favicon" | "socialImageUrl">,
  db: WebsiteDb,
) => {
  if (!isRecord(rawSnapshot) || !Array.isArray(rawSnapshot.assets)) return;

  for (const { kind, field, label } of MANAGED_IMAGE_FIELDS) {
    const targetUrl = target[field];
    if (!targetUrl) continue;
    const safeTargetUrl = assertSafeHttpsUrl(targetUrl, `${label[0].toUpperCase()}${label.slice(1)} URL`);
    if (!safeTargetUrl) continue;

    const existing = await db.websiteAsset.findFirst({
      where: { websiteId, url: safeTargetUrl },
      select: { metadata: true },
    });
    if (isManagedBrandAsset(existing, kind)) continue;

    const historical = rawSnapshot.assets.find((candidate: unknown) => {
      if (!isRecord(candidate) || candidate.url !== safeTargetUrl) return false;
      return isManagedBrandAsset({ metadata: candidate.metadata }, kind);
    });
    if (!isRecord(historical)) continue;

    const publicId = typeof historical.publicId === "string" ? historical.publicId : "";
    const mimeType = typeof historical.mimeType === "string" ? historical.mimeType : "";
    const folder = typeof historical.folder === "string" ? historical.folder : "";
    if (!publicId || !mimeType.startsWith("image/") || !folder) continue;

    const publicIdOwner = await db.websiteAsset.findUnique({
      where: { websiteId_publicId: { websiteId, publicId } },
      select: { url: true, metadata: true },
    });
    if (publicIdOwner) {
      if (publicIdOwner.url !== safeTargetUrl || !isManagedBrandAsset(publicIdOwner, kind)) {
        throw new AppError(status.CONFLICT, "A historical website asset no longer matches its immutable tenant record", {
          code: "WEBSITE_REVISION_ASSET_CONFLICT",
          retryable: false,
        });
      }
      continue;
    }

    await db.websiteAsset.create({
      data: {
        websiteId,
        publicId,
        url: safeTargetUrl,
        mimeType,
        width: typeof historical.width === "number" ? historical.width : null,
        height: typeof historical.height === "number" ? historical.height : null,
        bytes: typeof historical.bytes === "number" ? historical.bytes : null,
        altText: typeof historical.altText === "string" ? historical.altText : null,
        folder,
        metadata: historical.metadata as any,
      },
    });
  }
};

const assertOwnedForm = async (
  adminId: string,
  id: string | null | undefined,
  kind: "booking" | "estimate",
  db: Prisma.TransactionClient | typeof prisma = prisma,
) => {
  if (!id) return;
  const record = kind === "booking"
    ? await db.bookingForm.findFirst({ where: { id, adminId }, select: { id: true } })
    : await db.estimateForm.findFirst({ where: { id, adminId }, select: { id: true } });
  if (!record) throw new AppError(status.BAD_REQUEST, `Selected ${kind} form does not belong to this business`);
};

const assertBookingReadyForPublish = async (
  adminId: string,
  draft: {
    bookingEnabled: boolean;
    primaryBookingFormId: string | null;
    pages: Array<{ kind: string; isEnabled: boolean }>;
  },
  db: WebsiteDb,
) => {
  if (!draft.bookingEnabled) return;
  if (!draft.pages.some((page) => page.kind === "BOOK" && page.isEnabled)) {
    throw new AppError(status.CONFLICT, "Enable the Book Online page before publishing online booking", {
      code: "WEBSITE_BOOK_PAGE_REQUIRED",
      retryable: false,
    });
  }
  if (!draft.primaryBookingFormId) {
    throw new AppError(status.CONFLICT, "Select a published booking form before enabling online booking", {
      code: "WEBSITE_BOOKING_FORM_REQUIRED",
      retryable: false,
    });
  }
  const form = await db.bookingForm.findFirst({
    where: { id: draft.primaryBookingFormId, adminId, published: true },
    select: { id: true },
  });
  if (!form) {
    throw new AppError(status.CONFLICT, "The selected booking form must be published before the website can go live", {
      code: "WEBSITE_BOOKING_FORM_UNPUBLISHED",
      retryable: false,
    });
  }
};

const assertEstimateReadyForPublish = async (
  adminId: string,
  draft: {
    estimateEnabled: boolean;
    primaryEstimateFormId: string | null;
    pages: Array<{ kind: string; isEnabled: boolean }>;
  },
  db: WebsiteDb,
) => {
  if (!draft.estimateEnabled) return;
  if (!draft.pages.some((page) => page.kind === "ESTIMATE" && page.isEnabled)) {
    throw new AppError(status.CONFLICT, "Enable the Estimate page before publishing estimate requests", {
      code: "WEBSITE_ESTIMATE_PAGE_REQUIRED",
      retryable: false,
    });
  }
  if (!draft.primaryEstimateFormId) {
    throw new AppError(status.CONFLICT, "Select a published estimate form before enabling estimate requests", {
      code: "WEBSITE_ESTIMATE_FORM_REQUIRED",
      retryable: false,
    });
  }
  const form = await db.estimateForm.findFirst({
    where: { id: draft.primaryEstimateFormId, adminId, published: true },
    select: { id: true },
  });
  if (!form) {
    throw new AppError(status.CONFLICT, "The selected estimate form must be published before the website can go live", {
      code: "WEBSITE_ESTIMATE_FORM_UNPUBLISHED",
      retryable: false,
    });
  }
};

/**
 * Revision snapshots intentionally exclude publishedSnapshot itself. Including
 * it would recursively embed the previous publication in every new revision
 * and make each revision grow exponentially over time.
 */
const loadDraftSnapshot = async (websiteId: string, db: Prisma.TransactionClient | typeof prisma) => {
  const website = await db.businessWebsite.findUnique({
    where: { id: websiteId },
    select: {
      id: true,
      adminId: true,
      subdomain: true,
      status: true,
      templateId: true,
      templateVersion: true,
      schemaVersion: true,
      websiteDesign: true,
      primaryColor: true,
      secondaryColor: true,
      accentColor: true,
      font: true,
      logo: true,
      favicon: true,
      primaryBookingFormId: true,
      primaryEstimateFormId: true,
      bookingEnabled: true,
      bookingShowNavigation: true,
      bookingShowHeaderCta: true,
      bookingShowServiceCtas: true,
      bookingShowHomeCta: true,
      bookingShowAvailableSlots: true,
      bookingShowPrices: true,
      bookingShowStartingPrices: true,
      bookingShowServiceDuration: true,
      bookingCtaLabel: true,
      estimateEnabled: true,
      metaTitle: true,
      metaDescription: true,
      metaKeywords: true,
      socialImageUrl: true,
      indexSite: true,
      googleAnalyticsEnabled: true,
      googleAnalyticsMeasurementId: true,
      createdAt: true,
      updatedAt: true,
      publishedAt: true,
      publishedRevisionNumber: true,
      draftRevisionNumber: true,
      pages: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      domains: { orderBy: { createdAt: "asc" } },
      assets: { orderBy: { createdAt: "asc" } },
      subdomainAliases: { orderBy: { createdAt: "desc" } },
      primaryBookingForm: { select: { id: true, slug: true, published: true, headline: true } },
      primaryEstimateForm: { select: { id: true, slug: true, published: true, headline: true } },
    },
  });
  if (!website) throw new AppError(status.NOT_FOUND, "Business website not found");
  return website;
};

type DraftSnapshot = Awaited<ReturnType<typeof loadDraftSnapshot>>;

const presentDraftSnapshot = (
  draft: DraftSnapshot,
  overrides: {
    status?: WebsiteLifecycleStatus;
    publishedAt?: Date | null;
    publishedRevisionNumber?: number | null;
    draftRevisionNumber?: number;
    publishedSnapshot?: unknown;
  } = {},
) => {
  const domains = draft.domains.map((domain) => presentWebsiteDomain(domain));
  const platformUrl = WEBSITE_BASE_DOMAIN ? `https://${draft.subdomain}.${WEBSITE_BASE_DOMAIN}` : null;
  const primaryDomain = WEBSITE_CUSTOM_DOMAINS_ENABLED
    ? draft.domains.find((domain) => domain.isPrimary && isWebsiteDomainRoutingReady(domain))?.domain ?? null
    : null;
  const liveSnapshot = parsePublishedSnapshot(overrides.publishedSnapshot);
  const draftRevisionNumber = overrides.draftRevisionNumber ?? Number(draft.draftRevisionNumber ?? 0);
  const publishedRevisionNumber =
    overrides.publishedRevisionNumber !== undefined
      ? overrides.publishedRevisionNumber
      : draft.publishedRevisionNumber;

  return {
    ...draft,
    status: overrides.status ?? draft.status,
    publishedAt: overrides.publishedAt !== undefined ? overrides.publishedAt : draft.publishedAt,
    publishedRevisionNumber,
    draftRevisionNumber,
    domains,
    editorSurface: null,
    platformUrl,
    publicUrl: primaryDomain ? `https://${primaryDomain}` : platformUrl,
    publishedTemplateId: liveSnapshot?.website.templateId ?? null,
    publishedTemplateVersion: liveSnapshot?.website.templateVersion ?? null,
    publishedWebsiteDesign: liveSnapshot?.website.websiteDesign ?? null,
    hasUnpublishedChanges:
      publishedRevisionNumber === null || draftRevisionNumber > publishedRevisionNumber,
  };
};

const loadWebsiteDetailsWhere = async (
  where: { id: string } | { adminId: string },
  db: Prisma.TransactionClient | typeof prisma = prisma,
  options: { surface?: WebsiteEditorSurface | "full" } = {},
) => {
  const surface = options.surface ?? "full";
  const includePages = surface === "full" || surface === "content" || surface === "seo";
  const includeDomains = surface === "full";
  const includeAssets = surface === "full" || surface === "branding" || surface === "seo";
  const includeAliases = surface === "full" || surface === "domain";
  const includePrimaryForms = surface === "full" || surface === "booking";

  const website = await db.businessWebsite.findUnique({
    where,
    include: {
      ...(includePages ? { pages: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } } : {}),
      ...(includeDomains ? { domains: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] } } : {}),
      ...(includeAssets ? { assets: { orderBy: { createdAt: "desc" } } } : {}),
      ...(includeAliases ? { subdomainAliases: { orderBy: { createdAt: "desc" } } } : {}),
      ...(includePrimaryForms
        ? {
            primaryBookingForm: { select: { id: true, slug: true, published: true, headline: true } },
            primaryEstimateForm: { select: { id: true, slug: true, published: true, headline: true } },
          }
        : {}),
    },
  });
  if (!website) throw new AppError(status.NOT_FOUND, "Business website not found");

  const { publishedSnapshot: _publishedSnapshot, ...safeWebsite } = website;
  const published = parsePublishedSnapshot(website.publishedSnapshot);
  const websiteDomains = Array.isArray((website as any).domains) ? (website as any).domains : [];
  const presentedDomains = websiteDomains.map((domain: any) => presentWebsiteDomain(domain as any));
  const platformUrl = WEBSITE_BASE_DOMAIN ? `https://${website.subdomain}.${WEBSITE_BASE_DOMAIN}` : null;
  const primaryDomain = WEBSITE_CUSTOM_DOMAINS_ENABLED
    ? websiteDomains.find((domain: any) => domain.isPrimary && isWebsiteDomainRoutingReady(domain))?.domain ?? null
    : null;
  const maxRevision = await (db as any).websiteRevision.aggregate({
    where: { websiteId: website.id },
    _max: { revisionNumber: true },
  });
  const maxNum = Number(maxRevision?._max?.revisionNumber ?? 0);
  const draftRevisionNumber = Math.max(Number(website.draftRevisionNumber ?? 0), maxNum);
  if (Number(website.draftRevisionNumber ?? 0) < draftRevisionNumber) {
    await (db as any).businessWebsite.update({
      where: { id: website.id },
      data: { draftRevisionNumber },
    }).catch(() => undefined);
  }

  return {
    ...safeWebsite,
    // Omitted relations are explicit empty/null values so old clients never
    // crash, while the Studio can request only the relations needed by the
    // active tab. No omitted relation in a local publish payload is interpreted as a delete.
    pages: Array.isArray((website as any).pages) ? (website as any).pages : [],
    domains: presentedDomains,
    assets: Array.isArray((website as any).assets) ? (website as any).assets : [],
    subdomainAliases: Array.isArray((website as any).subdomainAliases) ? (website as any).subdomainAliases : [],
    primaryBookingForm: (website as any).primaryBookingForm ?? null,
    primaryEstimateForm: (website as any).primaryEstimateForm ?? null,
    editorSurface: surface === "full" ? null : surface,
    platformUrl,
    publicUrl: primaryDomain ? `https://${primaryDomain}` : platformUrl,
    // Phase 5 exposes the immutable live design identity separately from the
    // configured editor rows. Website Studio can therefore show SELECTED vs
    // LIVE without ever reading or mutating publishedSnapshot directly.
    publishedTemplateId: published?.website.templateId ?? null,
    publishedTemplateVersion: published?.website.templateVersion ?? null,
    publishedWebsiteDesign: published?.website.websiteDesign ?? null,
    draftRevisionNumber,
    hasUnpublishedChanges:
      website.publishedRevisionNumber === null ||
      draftRevisionNumber > website.publishedRevisionNumber,
  };
};

const loadWebsiteDetails = (websiteId: string, db: Prisma.TransactionClient | typeof prisma = prisma) =>
  loadWebsiteDetailsWhere({ id: websiteId }, db, { surface: "full" });

const loadWebsiteDetailsForAdmin = (adminId: string, db: Prisma.TransactionClient | typeof prisma = prisma) =>
  loadWebsiteDetailsWhere({ adminId }, db, { surface: "full" });

const loadWebsiteEditorDetailsForAdmin = (
  adminId: string,
  surface: WebsiteEditorSurface,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) => loadWebsiteDetailsWhere({ adminId }, db, { surface });

const getLatestRevisionNumber = async (db: WebsiteDb, websiteId: string): Promise<number> => {
  const [website, maxRevision] = await Promise.all([
    db.businessWebsite.findUnique({
      where: { id: websiteId },
      select: { draftRevisionNumber: true },
    }),
    db.websiteRevision.aggregate({
      where: { websiteId },
      _max: { revisionNumber: true },
    }),
  ]);
  if (!website) throw new AppError(status.NOT_FOUND, "Business website not found");
  const draftNum = Number(website.draftRevisionNumber ?? 0);
  const maxNum = Number(maxRevision._max.revisionNumber ?? 0);
  return Math.max(draftNum, maxNum);
};

const assertExpectedRevision = async (
  db: WebsiteDb,
  websiteId: string,
  expectedRevisionNumber: number | undefined,
): Promise<number> => {
  const currentRevisionNumber = await getLatestRevisionNumber(db, websiteId);
  if (
    expectedRevisionNumber !== undefined &&
    expectedRevisionNumber > 0 &&
    expectedRevisionNumber !== currentRevisionNumber
  ) {
    WebsiteProjectionCacheService.invalidateWebsite(websiteId).catch(() => undefined);
    throw new AppError(status.CONFLICT, "This website draft changed in another session. Reload Website Studio before saving again.", {
      code: "WEBSITE_DRAFT_CONFLICT",
      retryable: false,
    });
  }
  return currentRevisionNumber;
};

const assertLifecycleAllowsDraftMutation = (current: WebsiteLifecycleStatus) => {
  if (current === WEBSITE_STATUS.SUSPENDED) {
    throw new AppError(status.CONFLICT, "A suspended website cannot be edited", {
      code: "WEBSITE_SUSPENDED",
      retryable: false,
    });
  }
};

const assertLifecycleAllowsPublish = (current: WebsiteLifecycleStatus) => {
  if (current === WEBSITE_STATUS.SUSPENDED) {
    throw new AppError(status.CONFLICT, "A suspended website cannot be published", {
      code: "WEBSITE_SUSPENDED",
      retryable: false,
    });
  }
};

const draftLifecyclePatch = (current: WebsiteLifecycleStatus) => {
  const next = statusAfterDraftMutation(current);
  return next === current ? {} : { status: next };
};

const normalizeDraftPageContent = <T extends { pages?: Array<{ kind: string; content: unknown }> }>(draft: T): T => ({
  ...draft,
  pages: (draft.pages ?? []).map((page) => ({
    ...page,
    // System-page schemas strip legacy copies of CRM-owned services, reviews,
    // contact details and booking-form payloads before anything is versioned
    // or published. Custom pages retain their generic presentation content.
    content: validateWebsitePageContent(page.kind, page.content),
  })),
}) as T;

export const createRevisionSnapshotTx = async (
  db: WebsiteDb,
  websiteId: string,
  createdByUserId: string | null,
  reason: string,
  baseRevisionNumber?: number,
  preparedSnapshot?: DraftSnapshot,
) => {
  await acquireTextTransactionAdvisoryLock(db, websiteId);
  const currentRevisionNumber = baseRevisionNumber ?? await getLatestRevisionNumber(db, websiteId);
  const nextRevisionNumber = currentRevisionNumber + 1;
  const snapshot = preparedSnapshot ?? normalizeDraftPageContent(await loadDraftSnapshot(websiteId, db));
  const revision = await db.websiteRevision.create({
    data: {
      websiteId,
      revisionNumber: nextRevisionNumber,
      snapshot: JSON.parse(JSON.stringify(snapshot)) as any,
      reason,
      createdByUserId,
    },
  });
  await db.businessWebsite.update({
    where: { id: websiteId },
    data: { draftRevisionNumber: nextRevisionNumber },
  });
  return revision;
};

/**
 * Backward-compatible publication guard for websites that were already
 * PUBLISHED before Phase 4 added publishedSnapshot. Capture their current
 * state before the first draft mutation so Save draft cannot leak changes.
 */
export const ensurePublishedSnapshotBeforeDraftMutationTx = async (db: WebsiteDb, websiteId: string) => {
  const current = await db.businessWebsite.findUnique({
    where: { id: websiteId },
    select: { status: true, publishedSnapshot: true, publishedRevisionNumber: true, draftRevisionNumber: true },
  });
  if (!current || current.status !== "PUBLISHED" || current.publishedSnapshot) return;

  const draft = normalizeDraftPageContent(await loadDraftSnapshot(websiteId, db));
  await db.businessWebsite.update({
    where: { id: websiteId },
    data: {
      publishedSnapshot: buildPublishedSnapshot(draft) as any,
      publishedRevisionNumber: current.publishedRevisionNumber ?? current.draftRevisionNumber ?? null,
    },
  });
};

const prepareWebsitePatch = (
  payload: WebsiteUpdateInput,
  current: { templateId: string; templateVersion: string },
) => {
  const templatePatch = buildTemplateSelectionPatch(payload, current);

  const { templateId: _templateId, templateVersion: _templateVersion, ...rest } = payload;
  return {
    ...rest,
    ...templatePatch,
    ...(payload.logo !== undefined ? { logo: assertSafeHttpsUrl(payload.logo, "Logo URL") } : {}),
    ...(payload.favicon !== undefined ? { favicon: assertSafeHttpsUrl(payload.favicon, "Favicon URL") } : {}),
    ...(payload.socialImageUrl !== undefined
      ? { socialImageUrl: assertSafeHttpsUrl(payload.socialImageUrl, "Social image URL") }
      : {}),
    ...(payload.websiteDesign !== undefined
      ? { websiteDesign: toInputJsonValue(parseWebsiteDesignContract(payload.websiteDesign)) }
      : {}),
  };
};

const createWebsiteForAdmin = async (
  adminId: string,
  payload: WebsiteCreateInput,
  createdByUserId: string | null = null,
) => {
  const website = await prisma.$transaction(async (tx) => {
    // Validate form ownership in the same transaction as provisioning. The
    // tenant check is therefore part of the authoritative write path, while the
    // database foreign keys still arbitrate any concurrent form deletion.
    await Promise.all([
      assertOwnedForm(adminId, payload.primaryBookingFormId, "booking", tx),
      assertOwnedForm(adminId, payload.primaryEstimateFormId, "estimate", tx),
    ]);

    return WebsiteProvisioningService.createWebsiteForAdminTx(
      tx,
      adminId,
      payload,
      createdByUserId,
    );
  });

  await WebsiteHostResolverService.invalidateSubdomains([website.subdomain]);
  return website;
};

const createWebsite = async (payload: WebsiteCreateInput, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  return createWebsiteForAdmin(adminId, payload, user.id);
};

const getWebsiteForAdmin = async (adminId: string) => loadWebsiteDetailsForAdmin(adminId);
const getWebsiteEditorForAdmin = async (adminId: string, surface: WebsiteEditorSurface) =>
  WebsiteProjectionCacheService.getOrLoadStudio(adminId, surface, () =>
    loadWebsiteEditorDetailsForAdmin(adminId, surface),
  );

const getWebsite = async (user: IRequestUser) => {
  const adminId = await getAdminId(user);
  return getWebsiteForAdmin(adminId);
};

const getWebsiteEditor = async (user: IRequestUser, surface: WebsiteEditorSurface = "content") => {
  const adminId = await getAdminId(user);
  return getWebsiteEditorForAdmin(adminId, surface);
};

const updateWebsite = async (payload: WebsiteUpdateInput, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const [current, entitlements] = await Promise.all([getWebsiteOrThrow(adminId), WebsiteEntitlementService.getForAdminId(adminId)]);

  const result = await prisma.$transaction(async (tx) => {
    await acquireTextTransactionAdvisoryLock(tx, current.id);

    // Re-read after acquiring the website lock. Two concurrent editors may both
    // have loaded the same pre-lock template state; using the locked row avoids
    // applying a templateVersion patch against stale templateId data.
    const lockedCurrent = await tx.businessWebsite.findFirst({
      where: { id: current.id, adminId },
      select: { id: true, status: true, templateId: true, templateVersion: true, logo: true, favicon: true, socialImageUrl: true },
    });
    if (!lockedCurrent) throw new AppError(status.NOT_FOUND, "Business website not found");
    assertLifecycleAllowsDraftMutation(lockedCurrent.status as WebsiteLifecycleStatus);

    await Promise.all([
      assertOwnedForm(adminId, payload.primaryBookingFormId, "booking", tx),
      assertOwnedForm(adminId, payload.primaryEstimateFormId, "estimate", tx),
    ]);
    await assertManagedBrandReferences(lockedCurrent.id, payload, lockedCurrent, tx);
    assertEntitledWebsitePatch(payload, lockedCurrent, entitlements);
    const data = prepareWebsitePatch(payload, lockedCurrent);

    await ensurePublishedSnapshotBeforeDraftMutationTx(tx, lockedCurrent.id);
    await tx.businessWebsite.update({
      where: { id: lockedCurrent.id },
      data: { ...data, ...draftLifecyclePatch(lockedCurrent.status as WebsiteLifecycleStatus) },
    });
    await createRevisionSnapshotTx(tx, lockedCurrent.id, user.id, "Website settings updated");
    return loadWebsiteDetails(lockedCurrent.id, tx);
  }, { maxWait: 10_000, timeout: 25_000 });
  await WebsiteProjectionCacheService.invalidateStudioAdmin(adminId);
  return result;
};

const listPages = async (user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await getWebsiteOrThrow(adminId);
  return prisma.websitePage.findMany({
    where: { websiteId: website.id },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
};

const updatePage = async (pageId: string, payload: WebsitePageUpdateInput, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const [website, entitlements] = await Promise.all([getWebsiteOrThrow(adminId), WebsiteEntitlementService.getForAdminId(adminId)]);
  assertEntitledPagePatch(payload, entitlements);
  const page = await prisma.websitePage.findFirst({
    where: { id: pageId, websiteId: website.id },
    select: { id: true, kind: true },
  });
  if (!page) throw new AppError(status.NOT_FOUND, "Website page not found");

  const result = await prisma.$transaction(async (tx) => {
    await acquireTextTransactionAdvisoryLock(tx, website.id);
    const lockedWebsite = await tx.businessWebsite.findUnique({
      where: { id: website.id },
      select: { status: true },
    });
    if (!lockedWebsite) throw new AppError(status.NOT_FOUND, "Business website not found");
    assertLifecycleAllowsDraftMutation(lockedWebsite.status as WebsiteLifecycleStatus);

    await ensurePublishedSnapshotBeforeDraftMutationTx(tx, website.id);
    const nextStatus = statusAfterDraftMutation(lockedWebsite.status as WebsiteLifecycleStatus);
    if (nextStatus !== lockedWebsite.status) {
      await tx.businessWebsite.update({ where: { id: website.id }, data: { status: nextStatus } });
    }
    const normalizedPayload = payload.content === undefined
      ? payload
      : { ...payload, content: validateWebsitePageContent(page.kind, payload.content) };
    const updated = await tx.websitePage.update({ where: { id: pageId }, data: normalizedPayload as any });
    await createRevisionSnapshotTx(tx, website.id, user.id, `Page updated: ${pageId}`);
    return updated;
  });
  await WebsiteProjectionCacheService.invalidateStudioAdmin(adminId);
  return result;
};

const applyPagePatchesBatch = async (
  tx: Prisma.TransactionClient,
  websiteId: string,
  patches: Array<Record<string, any>>,
) => {
  if (!patches.length) return;
  const rows = patches.map((patch) => ({
    id: patch.id,
    hasTitle: Object.prototype.hasOwnProperty.call(patch, "title"), title: patch.title ?? null,
    hasContent: Object.prototype.hasOwnProperty.call(patch, "content"), content: patch.content ?? null,
    hasSeoTitle: Object.prototype.hasOwnProperty.call(patch, "seoTitle"), seoTitle: patch.seoTitle ?? null,
    hasSeoDescription: Object.prototype.hasOwnProperty.call(patch, "seoDescription"), seoDescription: patch.seoDescription ?? null,
    hasSeoKeywords: Object.prototype.hasOwnProperty.call(patch, "seoKeywords"), seoKeywords: patch.seoKeywords ?? [],
    hasSocialImageUrl: Object.prototype.hasOwnProperty.call(patch, "socialImageUrl"), socialImageUrl: patch.socialImageUrl ?? null,
    hasShowInNavigation: Object.prototype.hasOwnProperty.call(patch, "showInNavigation"), showInNavigation: patch.showInNavigation ?? null,
    hasIsEnabled: Object.prototype.hasOwnProperty.call(patch, "isEnabled"), isEnabled: patch.isEnabled ?? null,
    hasSortOrder: Object.prototype.hasOwnProperty.call(patch, "sortOrder"), sortOrder: patch.sortOrder ?? null,
  }));

  await tx.$executeRaw`
    WITH patch AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS p(
        id text,
        "hasTitle" boolean, title text,
        "hasContent" boolean, content jsonb,
        "hasSeoTitle" boolean, "seoTitle" text,
        "hasSeoDescription" boolean, "seoDescription" text,
        "hasSeoKeywords" boolean, "seoKeywords" text[],
        "hasSocialImageUrl" boolean, "socialImageUrl" text,
        "hasShowInNavigation" boolean, "showInNavigation" boolean,
        "hasIsEnabled" boolean, "isEnabled" boolean,
        "hasSortOrder" boolean, "sortOrder" integer
      )
    )
    UPDATE "website_page" wp
    SET
      title = CASE WHEN patch."hasTitle" THEN patch.title ELSE wp.title END,
      content = CASE WHEN patch."hasContent" THEN patch.content ELSE wp.content END,
      "seoTitle" = CASE WHEN patch."hasSeoTitle" THEN patch."seoTitle" ELSE wp."seoTitle" END,
      "seoDescription" = CASE WHEN patch."hasSeoDescription" THEN patch."seoDescription" ELSE wp."seoDescription" END,
      "seoKeywords" = CASE WHEN patch."hasSeoKeywords" THEN patch."seoKeywords" ELSE wp."seoKeywords" END,
      "socialImageUrl" = CASE WHEN patch."hasSocialImageUrl" THEN patch."socialImageUrl" ELSE wp."socialImageUrl" END,
      "showInNavigation" = CASE WHEN patch."hasShowInNavigation" THEN patch."showInNavigation" ELSE wp."showInNavigation" END,
      "isEnabled" = CASE WHEN patch."hasIsEnabled" THEN patch."isEnabled" ELSE wp."isEnabled" END,
      "sortOrder" = CASE WHEN patch."hasSortOrder" THEN patch."sortOrder" ELSE wp."sortOrder" END,
      "updatedAt" = NOW()
    FROM patch
    WHERE wp.id = patch.id AND wp."websiteId" = ${websiteId}
  `;
};

const applyDraftPayloadTx = async (
  tx: Prisma.TransactionClient,
  args: {
    websiteId: string;
    adminId: string;
    payload: WebsiteEditorStateInput;
    entitlements: WebsiteEntitlements;
    applyDraftLifecycle?: boolean;
  },
) => {
  const { websiteId, adminId, payload, entitlements, applyDraftLifecycle = false } = args;
  const websitePatch = payload.website ?? {};
  const uniquePageIds = [...new Set((payload.pages ?? []).map((page) => page.id))];
  if (uniquePageIds.length !== (payload.pages ?? []).length) {
    throw new AppError(status.BAD_REQUEST, "A website page can only be updated once per request");
  }

  const lockedCurrent = await tx.businessWebsite.findFirst({
    where: { id: websiteId, adminId },
    select: {
      id: true,
      status: true,
      templateId: true,
      templateVersion: true,
      logo: true,
      favicon: true,
      socialImageUrl: true,
    },
  });
  if (!lockedCurrent) throw new AppError(status.NOT_FOUND, "Business website not found");
  assertLifecycleAllowsDraftMutation(lockedCurrent.status as WebsiteLifecycleStatus);

  await Promise.all([
    assertOwnedForm(adminId, websitePatch.primaryBookingFormId, "booking", tx),
    assertOwnedForm(adminId, websitePatch.primaryEstimateFormId, "estimate", tx),
  ]);
  await assertManagedBrandReferences(lockedCurrent.id, websitePatch, lockedCurrent, tx);
  await assertManagedPageSocialReferences(lockedCurrent.id, payload.pages, tx);
  assertEntitledWebsitePatch(websitePatch, lockedCurrent, entitlements);
  for (const page of payload.pages ?? []) assertEntitledPagePatch(page, entitlements);

  const ownedPageKinds = new Map<string, string>();
  if (uniquePageIds.length) {
    const ownedPages = await tx.websitePage.findMany({
      where: { websiteId: lockedCurrent.id, id: { in: uniquePageIds } },
      select: { id: true, kind: true },
    });
    if (ownedPages.length !== uniquePageIds.length) {
      throw new AppError(status.NOT_FOUND, "One or more website pages do not belong to this business");
    }
    for (const page of ownedPages) ownedPageKinds.set(page.id, page.kind);
  }

  const lifecyclePatch = applyDraftLifecycle
    ? draftLifecyclePatch(lockedCurrent.status as WebsiteLifecycleStatus)
    : {};
  if (Object.keys(websitePatch).length || Object.keys(lifecyclePatch).length) {
    const data = Object.keys(websitePatch).length ? prepareWebsitePatch(websitePatch, lockedCurrent) : {};
    await tx.businessWebsite.update({
      where: { id: lockedCurrent.id },
      data: { ...data, ...lifecyclePatch },
    });
  }

  const normalizedPagePatches = (payload.pages ?? []).map((page) => {
    const { id, ...data } = page;
    const pageKind = ownedPageKinds.get(id);
    if (!pageKind) throw new AppError(status.NOT_FOUND, "Website page not found");
    return {
      id,
      ...(data.content === undefined
        ? data
        : { ...data, content: validateWebsitePageContent(pageKind, data.content) }),
    };
  });
  await applyPagePatchesBatch(tx, lockedCurrent.id, normalizedPagePatches);
  return lockedCurrent;
};

/**
 * Persist the authenticated Website Studio working copy on the server without
 * changing the immutable public snapshot. This is the canonical configured
 * editor state used by autosave, cross-device editing and Preview.
 */
const saveEditorState = async (payload: WebsiteEditorStateInput, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const hasWebsitePatch = Boolean(payload.website && Object.keys(payload.website).length);
  const hasPagePatch = Boolean(payload.pages?.length);
  const current = await getWebsiteOrThrow(adminId);
  if (!hasWebsitePatch && !hasPagePatch) return loadWebsiteDetails(current.id);

  const entitlements = await WebsiteEntitlementService.getForAdminId(adminId);
  const result = await prisma.$transaction(async (tx) => {
    await acquireTextTransactionAdvisoryLock(tx, current.id);
    const baseRevisionNumber = await assertExpectedRevision(tx, current.id, payload.expectedRevisionNumber);

    // Legacy PUBLISHED rows may not have an immutable snapshot yet. Capture it
    // before touching the working row so an autosave can never become public.
    await ensurePublishedSnapshotBeforeDraftMutationTx(tx, current.id);
    await applyDraftPayloadTx(tx, {
      websiteId: current.id,
      adminId,
      payload,
      entitlements,
      applyDraftLifecycle: true,
    });

    // Autosave advances the optimistic editor revision without creating an
    // immutable WebsiteRevision row for every typing burst. Immutable history
    // remains reserved for explicit revision-worthy mutations and Publish.
    const nextRevisionNumber = baseRevisionNumber + 1;
    await tx.businessWebsite.update({
      where: { id: current.id },
      data: { draftRevisionNumber: nextRevisionNumber },
    });
    const [draft, liveRow] = await Promise.all([
      loadDraftSnapshot(current.id, tx),
      tx.businessWebsite.findUnique({ where: { id: current.id }, select: { publishedSnapshot: true } }),
    ]);
    return presentDraftSnapshot(draft, {
      draftRevisionNumber: nextRevisionNumber,
      publishedSnapshot: liveRow?.publishedSnapshot ?? null,
    });
  }, { maxWait: 10_000, timeout: 25_000 });

  // Editor autosave intentionally invalidates only private Studio caches.
  // Public projection/host caches are invalidated exclusively by Publish.
  await WebsiteProjectionCacheService.invalidateStudioAdmin(adminId);
  void bumpCacheResourceVersions(adminId, [CacheResource.website]);
  return result;
};

const publishWebsite = async (payload: WebsitePublishInput, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const [current, entitlements] = await Promise.all([
    getWebsiteOrThrow(adminId),
    WebsiteEntitlementService.getForAdminId(adminId),
  ]);

  const website = await prisma.$transaction(async (tx) => {
    await acquireTextTransactionAdvisoryLock(tx, current.id);
    const baseRevisionNumber = await assertExpectedRevision(tx, current.id, payload.expectedRevisionNumber);

    // Current Website Studio publishes an already-confirmed server editor
    // revision. Accept website/pages only for rolling-deploy compatibility and
    // still apply them atomically under the same advisory lock when supplied.
    if (payload.website || payload.pages?.length) {
      await applyDraftPayloadTx(tx, {
        websiteId: current.id,
        adminId,
        payload,
        entitlements,
        applyDraftLifecycle: false,
      });
    }

    const draft = normalizeDraftPageContent(await loadDraftSnapshot(current.id, tx));
    assertLifecycleAllowsPublish(draft.status as WebsiteLifecycleStatus);
    const publishTemplate = TemplateRegistry.requireTemplate(draft.templateId, draft.templateVersion);
    WebsiteEntitlementService.assertTemplateAllowed(publishTemplate, entitlements);
    // Publish is the only boundary that can make configured design public.
    // Re-validate stable component IDs, slot assignments, animation/style slots
    // and plan entitlements on the server immediately before snapshotting.
    assertWebsiteDesignPublishable(draft.websiteDesign, entitlements);
    if ((draft.socialImageUrl || draft.metaKeywords?.length || draft.pages.some((page: any) => page.seoKeywords?.length || page.socialImageUrl)) && !entitlements.advancedSeo) {
      throw new AppError(status.FORBIDDEN, "Remove advanced SEO overrides or upgrade to Advanced Website SEO before publishing.", {
        code: "WEBSITE_ADVANCED_SEO_REQUIRED",
        retryable: false,
      });
    }
    if (!draft.pages.some((page: any) => page.kind === "HOME" && page.isEnabled)) {
      throw new AppError(status.CONFLICT, "Enable the Home page before publishing the website");
    }

    await Promise.all([
      assertOwnedForm(adminId, draft.primaryBookingFormId, "booking", tx),
      assertOwnedForm(adminId, draft.primaryEstimateFormId, "estimate", tx),
    ]);
    await Promise.all([
      assertBookingReadyForPublish(adminId, draft, tx),
      assertEstimateReadyForPublish(adminId, draft, tx),
    ]);

    const revision = await createRevisionSnapshotTx(
      tx,
      current.id,
      user.id,
      "Website published",
      baseRevisionNumber,
      draft,
    );
    const publishedSnapshot = buildPublishedSnapshot(draft);
    const publishedAt = new Date();
    await tx.businessWebsite.update({
      where: { id: current.id },
      data: {
        status: WEBSITE_STATUS.PUBLISHED,
        publishedAt,
        publishedSnapshot: toInputJsonValue(publishedSnapshot),
        publishedRevisionNumber: revision.revisionNumber,
      },
    });
    return presentDraftSnapshot(draft, {
      status: WEBSITE_STATUS.PUBLISHED,
      publishedAt,
      publishedRevisionNumber: revision.revisionNumber,
      draftRevisionNumber: revision.revisionNumber,
      publishedSnapshot,
    });
  });

  await Promise.all([
    WebsiteHostResolverService.invalidateSubdomains([website.subdomain]),
    WebsiteHostResolverService.invalidateHosts(website.domains.map((domain: any) => domain.domain)),
    WebsiteProjectionCacheService.invalidateWebsite(website.id),
    WebsiteProjectionCacheService.invalidateStudioAdmin(adminId),
  ]);
  void bumpCacheResourceVersions(adminId, [CacheResource.website]);
  return website;
};


const REQUIRED_ONBOARDING_STEPS = ONBOARDING_STEPS.map((step) => step.key);

/**
 * First-time launch is deliberately stronger than a normal Website Studio
 * publish. It validates tenant identity/routing, guarantees a published
 * BookingForm is attached, snapshots the exact draft, publishes it and stamps
 * onboarding completion in one transaction. The endpoint is retry-safe: once
 * a fully published onboarding launch is committed, a repeated request returns
 * the existing live website without creating another revision.
 */
const launchWebsite = async (payload: WebsitePublishInput, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const [current, entitlements] = await Promise.all([getWebsiteOrThrow(adminId), WebsiteEntitlementService.getForAdminId(adminId)]);

  const result = await prisma.$transaction(async (tx) => {
    await acquireTextTransactionAdvisoryLock(tx, current.id);

    const owner = await tx.adminProfile.findUnique({
      where: { id: adminId },
      select: {
        id: true,
        businessName: true,
        businessEmail: true,
        onboardingCompletedAt: true,
        onboardingCompletedSteps: true,
        user: { select: { email: true, status: true } },
        businessWebsite: {
          select: {
            id: true,
            subdomain: true,
            status: true,
            publishedAt: true,
            publishedSnapshot: true,
            publishedRevisionNumber: true,
          },
        },
      },
    });

    if (!owner?.businessWebsite || owner.businessWebsite.id !== current.id) {
      throw new AppError(status.NOT_FOUND, "Business website not found", {
        code: "WEBSITE_NOT_FOUND",
        retryable: false,
      });
    }
    if (owner.user.status !== "ACTIVE") {
      throw new AppError(status.CONFLICT, "This account cannot launch a public website while it is inactive", {
        code: "ACCOUNT_NOT_ACTIVE",
        retryable: false,
      });
    }
    if (!owner.businessName.trim()) {
      throw new AppError(status.UNPROCESSABLE_ENTITY, "Add your business name before launching the website", {
        code: "BUSINESS_NAME_REQUIRED",
        retryable: false,
        fieldErrors: { business_profile: "Business name is required." },
      });
    }
    const contactEmail = (owner.businessEmail || owner.user.email || "").trim();
    if (!contactEmail || !contactEmail.includes("@")) {
      throw new AppError(status.UNPROCESSABLE_ENTITY, "Add a valid business email before launching the website", {
        code: "BUSINESS_EMAIL_REQUIRED",
        retryable: false,
        fieldErrors: { business_profile: "A valid email is required." },
      });
    }
    if (!WEBSITE_BASE_DOMAIN) {
      throw new AppError(status.SERVICE_UNAVAILABLE, "Website base domain is not configured", {
        code: "WEBSITE_BASE_DOMAIN_NOT_CONFIGURED",
        retryable: false,
      });
    }

    const normalizedSubdomain = normalizeSubdomain(owner.businessWebsite.subdomain);
    if (normalizedSubdomain !== owner.businessWebsite.subdomain) {
      throw new AppError(status.CONFLICT, "Website subdomain is not normalized", {
        code: "WEBSITE_SUBDOMAIN_INVALID",
        retryable: false,
        fieldErrors: { website_address: "Choose the website address again." },
      });
    }

    const [canonicalCollision, aliasCollision] = await Promise.all([
      tx.businessWebsite.findFirst({
        where: { subdomain: normalizedSubdomain, id: { not: current.id } },
        select: { id: true },
      }),
      tx.websiteSubdomainAlias.findFirst({
        where: { subdomain: normalizedSubdomain },
        select: { websiteId: true },
      }),
    ]);
    if (canonicalCollision || aliasCollision) {
      throw new AppError(status.CONFLICT, "That website address is no longer available", {
        code: "WEBSITE_SUBDOMAIN_CONFLICT",
        retryable: false,
        fieldErrors: { website_address: "Choose another available website address." },
      });
    }

    const completed = new Set(
      owner.onboardingCompletedSteps.map((step) =>
        step === "template" ? "review_launch" : step,
      ),
    );
    const missingSteps = owner.onboardingCompletedAt
      ? []
      : REQUIRED_ONBOARDING_STEPS.filter((step) => !completed.has(step));
    if (missingSteps.length > 0) {
      throw new AppError(status.CONFLICT, "Complete the website setup before launching", {
        code: "ACCOUNT_SETUP_INCOMPLETE",
        retryable: false,
        fieldErrors: Object.fromEntries(missingSteps.map((step) => [step, "Complete this step first."])),
      });
    }

    assertLifecycleAllowsPublish(owner.businessWebsite.status as WebsiteLifecycleStatus);
    const latestRevisionNumber = await assertExpectedRevision(tx, current.id, payload.expectedRevisionNumber);

    // Idempotent retry path: the first launch committed completely and there
    // are no newer draft revisions. Do not create a duplicate publish revision.
    if (
      owner.onboardingCompletedAt &&
      owner.businessWebsite.status === WEBSITE_STATUS.PUBLISHED &&
      owner.businessWebsite.publishedAt &&
      owner.businessWebsite.publishedSnapshot &&
      owner.businessWebsite.publishedRevisionNumber !== null &&
      latestRevisionNumber <= owner.businessWebsite.publishedRevisionNumber &&
      !payload.website &&
      !payload.pages?.length
    ) {
      return {
        businessName: owner.businessName,
        alreadyLive: true,
        website: await loadWebsiteDetails(current.id, tx),
      };
    }

    // Rolling-deploy callers may still send editor fields with first launch.
    // Apply them under this same transaction before booking provisioning and
    // before the immutable publication snapshot is built.
    if (payload.website || payload.pages?.length) {
      await applyDraftPayloadTx(tx, {
        websiteId: current.id,
        adminId,
        payload,
        entitlements,
        applyDraftLifecycle: false,
      });
    }

    // Booking attachment participates in this same transaction. This closes
    // the gap where a site could be marked live while /book had no published
    // tenant-owned form attached.
    const preflightDraft = await loadDraftSnapshot(current.id, tx);
    const bookingFormId = preflightDraft.bookingEnabled
      ? await WebsiteBookingProvisioningService.ensureAttachedForLaunchTx(tx, adminId, current.id, {
          id: adminId,
          businessName: owner.businessName,
          businessWebsite: {
            id: current.id,
            status: preflightDraft.status,
            accentColor: preflightDraft.accentColor,
            primaryBookingFormId: preflightDraft.primaryBookingFormId,
            bookingEnabled: preflightDraft.bookingEnabled,
          },
        })
      : null;

    // Booking provisioning can only change primaryBookingFormId on the website
    // row. Patch that field into the already-loaded snapshot instead of loading
    // the entire website/pages/domains/assets graph a second time.
    const draft = normalizeDraftPageContent(
      bookingFormId && bookingFormId !== preflightDraft.primaryBookingFormId
        ? { ...preflightDraft, primaryBookingFormId: bookingFormId }
        : preflightDraft,
    );
    const launchTemplate = TemplateRegistry.requireTemplate(draft.templateId, draft.templateVersion);
    WebsiteEntitlementService.assertTemplateAllowed(launchTemplate, entitlements);
    assertWebsiteDesignPublishable(draft.websiteDesign, entitlements);
    if ((draft.socialImageUrl || draft.metaKeywords?.length || draft.pages.some((page: any) => page.seoKeywords?.length || page.socialImageUrl)) && !entitlements.advancedSeo) {
      throw new AppError(status.FORBIDDEN, "Remove advanced SEO overrides or upgrade to Advanced Website SEO before launching.", { code: "WEBSITE_ADVANCED_SEO_REQUIRED", retryable: false });
    }

    if (!draft.pages.some((page: any) => page.kind === "HOME" && page.isEnabled)) {
      throw new AppError(status.CONFLICT, "Enable the Home page before launching the website", {
        code: "WEBSITE_HOME_REQUIRED",
        retryable: false,
        fieldErrors: { review_launch: "The Home page must be enabled." },
      });
    }
    if (draft.bookingEnabled && !draft.pages.some((page: any) => page.kind === "BOOK" && page.isEnabled)) {
      throw new AppError(status.CONFLICT, "Enable the Book Online page before launching the website", {
        code: "WEBSITE_BOOK_PAGE_REQUIRED",
        retryable: false,
        fieldErrors: { services: "Online booking requires the Book page." },
      });
    }

    if (draft.bookingEnabled && (!bookingFormId || draft.primaryBookingFormId !== bookingFormId)) {
      // ensureAttachedForLaunchTx only returns a published tenant-owned form;
      // this assertion protects the in-memory snapshot/database handoff without
      // issuing another redundant BookingForm read.
      throw new AppError(status.CONFLICT, "Website booking is not ready to publish", {
        code: "WEBSITE_BOOKING_NOT_READY",
        retryable: true,
        fieldErrors: { services: "Reconnect Online Booking and try again." },
      });
    }

    await assertEstimateReadyForPublish(adminId, draft, tx);

    // Building the immutable publication document before the write validates
    // the exact config/pages the public projection will consume after commit.
    const publishedSnapshot = buildPublishedSnapshot(draft);
    const revision = await createRevisionSnapshotTx(
      tx,
      current.id,
      user.id,
      "Website launched",
      latestRevisionNumber,
      draft,
    );
    const launchedAt = new Date();

    await tx.businessWebsite.update({
      where: { id: current.id },
      data: {
        status: WEBSITE_STATUS.PUBLISHED,
        publishedAt: launchedAt,
        publishedSnapshot: toInputJsonValue(publishedSnapshot),
        publishedRevisionNumber: revision.revisionNumber,
      },
    });
    if (!owner.onboardingCompletedAt) {
      await tx.adminProfile.update({
        where: { id: adminId },
        data: { onboardingCompletedAt: launchedAt },
      });
    }

    return {
      businessName: owner.businessName,
      alreadyLive: false,
      website: presentDraftSnapshot(draft, {
        status: WEBSITE_STATUS.PUBLISHED,
        publishedAt: launchedAt,
        publishedRevisionNumber: revision.revisionNumber,
        draftRevisionNumber: revision.revisionNumber,
        publishedSnapshot,
      }),
    };
  }, PROVISIONING_TRANSACTION_OPTIONS);

  // Drop both routing and projection caches only after the database commit, so
  // no worker can rebuild Redis from a half-published transaction.
  await Promise.all([
    WebsiteHostResolverService.invalidateSubdomains([result.website.subdomain]),
    WebsiteHostResolverService.invalidateHosts(result.website.domains.map((domain: any) => domain.domain)),
    WebsiteProjectionCacheService.invalidateWebsite(result.website.id),
    WebsiteProjectionCacheService.invalidateStudioAdmin(adminId),
  ]);

  // Warm the canonical public projection. A cache outage must not roll back a
  // successful database publication; the first real visitor can rebuild it.
  try {
    await PublicWebsiteService.getPublicWebsiteById(result.website.id);
  } catch (error) {
    logger.warn(
      `[website-launch] projection warm failed for ${result.website.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    businessName: result.businessName,
    alreadyLive: result.alreadyLive,
    launchedAt: result.website.publishedAt,
    publicUrl: result.website.publicUrl,
    website: result.website,
  };
};

const listRevisions = async (user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await prisma.businessWebsite.findUnique({
    where: { adminId },
    select: { id: true, publishedRevisionNumber: true, draftRevisionNumber: true },
  });
  if (!website) throw new AppError(status.NOT_FOUND, "Business website has not been provisioned yet");

  const revisions = await prisma.websiteRevision.findMany({
    where: { websiteId: website.id },
    select: { id: true, revisionNumber: true, reason: true, createdByUserId: true, createdAt: true },
    orderBy: { revisionNumber: "desc" },
    take: 100,
  });
  const latestRevisionNumber = website.draftRevisionNumber ?? revisions[0]?.revisionNumber ?? 0;
  return revisions.map((revision) => ({
    ...revision,
    isCurrentDraft: revision.revisionNumber === latestRevisionNumber,
    isCurrentPublished: revision.revisionNumber === website.publishedRevisionNumber,
    kind: /publish|launch/i.test(revision.reason ?? "")
      ? "PUBLISHED"
      : /^Restored revision #/i.test(revision.reason ?? "")
        ? "RESTORED"
        : "DRAFT",
  }));
};

const getRevision = async (revisionId: string, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await getWebsiteOrThrow(adminId);
  const revision = await prisma.websiteRevision.findFirst({ where: { id: revisionId, websiteId: website.id } });
  if (!revision) throw new AppError(status.NOT_FOUND, "Website revision not found");
  return revision;
};

const restoreRevision = async (revisionId: string, payload: WebsiteRevisionRestoreInput, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await getWebsiteOrThrow(adminId);

  const result = await prisma.$transaction(async (tx) => {
    await acquireTextTransactionAdvisoryLock(tx, website.id);

    const current = await tx.businessWebsite.findFirst({
      where: { id: website.id, adminId },
      select: {
        id: true,
        status: true,
        templateId: true,
        templateVersion: true,
        logo: true,
        favicon: true,
        socialImageUrl: true,
      },
    });
    if (!current) throw new AppError(status.NOT_FOUND, "Business website not found");
    assertLifecycleAllowsDraftMutation(current.status as WebsiteLifecycleStatus);

    const baseRevisionNumber = await assertExpectedRevision(tx, current.id, payload.expectedRevisionNumber);
    const revision = await tx.websiteRevision.findFirst({
      where: { id: revisionId, websiteId: current.id },
      select: { id: true, revisionNumber: true, snapshot: true },
    });
    if (!revision) throw new AppError(status.NOT_FOUND, "Website revision not found");

    const parsedRestored = parseRevisionSnapshotAsPublished(revision.snapshot);
    if (!parsedRestored) {
      throw new AppError(status.UNPROCESSABLE_ENTITY, "This historical revision cannot be restored safely", {
        code: "WEBSITE_REVISION_INVALID",
        retryable: false,
      });
    }
    const restored = normalizeDraftPageContent(parsedRestored);

    TemplateRegistry.requireTemplate(restored.website.templateId, restored.website.templateVersion);

    const pageIds = new Set<string>();
    const pageSlugs = new Set<string>();
    for (const page of restored.pages) {
      if (pageIds.has(page.id) || pageSlugs.has(page.slug)) {
        throw new AppError(status.UNPROCESSABLE_ENTITY, "This revision contains duplicate website pages and cannot be restored safely", {
          code: "WEBSITE_REVISION_INVALID",
          retryable: false,
        });
      }
      pageIds.add(page.id);
      pageSlugs.add(page.slug);
    }

    await Promise.all([
      assertOwnedForm(adminId, restored.website.primaryBookingFormId, "booking", tx),
      assertOwnedForm(adminId, restored.website.primaryEstimateFormId, "estimate", tx),
    ]);
    await rehydrateManagedBrandAssetsFromRevision(
      current.id,
      revision.snapshot,
      {
        logo: restored.website.logo,
        favicon: restored.website.favicon,
        socialImageUrl: restored.website.socialImageUrl,
      },
      tx,
    );
    await assertManagedBrandReferences(
      current.id,
      {
        logo: restored.website.logo,
        favicon: restored.website.favicon,
        socialImageUrl: restored.website.socialImageUrl,
      },
      current,
      tx,
    );

    // Preserve the currently-live immutable snapshot before replacing the
    // working draft. Restore is intentionally a draft-only operation.
    await ensurePublishedSnapshotBeforeDraftMutationTx(tx, current.id);

    // Autosave intentionally does not create a permanent revision on every
    // typing burst. A restore is destructive to the configured editor state,
    // so capture that exact current server draft first to guarantee it remains
    // recoverable from History.
    const draftBeforeRestore = normalizeDraftPageContent(await loadDraftSnapshot(current.id, tx));
    const preservedRevision = await createRevisionSnapshotTx(
      tx,
      current.id,
      user.id,
      `Draft preserved before restoring revision #${revision.revisionNumber}`,
      baseRevisionNumber,
      draftBeforeRestore,
    );

    await tx.businessWebsite.update({
      where: { id: current.id },
      data: {
        templateId: restored.website.templateId,
        templateVersion: restored.website.templateVersion,
        schemaVersion: restored.website.schemaVersion,
        websiteDesign: toInputJsonValue(restored.website.websiteDesign),
        primaryColor: restored.website.primaryColor,
        secondaryColor: restored.website.secondaryColor,
        accentColor: restored.website.accentColor,
        font: restored.website.font,
        logo: restored.website.logo,
        favicon: restored.website.favicon,
        primaryBookingFormId: restored.website.primaryBookingFormId,
        primaryEstimateFormId: restored.website.primaryEstimateFormId,
        bookingEnabled: restored.website.bookingEnabled,
        bookingShowNavigation: restored.website.bookingShowNavigation,
        bookingShowHeaderCta: restored.website.bookingShowHeaderCta,
        bookingShowServiceCtas: restored.website.bookingShowServiceCtas,
        bookingShowHomeCta: restored.website.bookingShowHomeCta,
        bookingShowAvailableSlots: restored.website.bookingShowAvailableSlots,
        bookingShowPrices: restored.website.bookingShowPrices,
        bookingShowStartingPrices: restored.website.bookingShowStartingPrices,
        bookingShowServiceDuration: restored.website.bookingShowServiceDuration,
        bookingCtaLabel: restored.website.bookingCtaLabel,
        estimateEnabled: restored.website.estimateEnabled,
        metaTitle: restored.website.metaTitle,
        metaDescription: restored.website.metaDescription,
        metaKeywords: restored.website.metaKeywords,
        socialImageUrl: restored.website.socialImageUrl,
        indexSite: restored.website.indexSite,
        googleAnalyticsEnabled: restored.website.googleAnalyticsEnabled,
        googleAnalyticsMeasurementId: restored.website.googleAnalyticsMeasurementId,
        ...draftLifecyclePatch(current.status as WebsiteLifecycleStatus),
      },
    });

    // Rebuild the page set exactly as it existed in the selected revision.
    // The transaction preserves the previous draft as the current/latest
    // revision, so even pages removed by this restore can be recovered again.
    await tx.websitePage.deleteMany({ where: { websiteId: current.id } });
    if (restored.pages.length) {
      await tx.websitePage.createMany({
        data: restored.pages.map((page) => ({
          id: page.id,
          websiteId: current.id,
          kind: page.kind,
          slug: page.slug,
          title: page.title,
          content: JSON.parse(JSON.stringify(page.content ?? {})),
          seoTitle: page.seoTitle,
          seoDescription: page.seoDescription,
          seoKeywords: page.seoKeywords,
          socialImageUrl: page.socialImageUrl,
          showInNavigation: page.showInNavigation,
          isEnabled: page.isEnabled,
          sortOrder: page.sortOrder,
        })) as any,
      });
    }

    const createdRevision = await createRevisionSnapshotTx(
      tx,
      current.id,
      user.id,
      `Restored revision #${revision.revisionNumber}`,
      preservedRevision.revisionNumber,
    );

    return {
      restoredFrom: { id: revision.id, revisionNumber: revision.revisionNumber },
      newRevisionNumber: createdRevision.revisionNumber,
      website: await loadWebsiteDetails(current.id, tx),
    };
  });
  await WebsiteProjectionCacheService.invalidateStudioAdmin(adminId);
  return result;
};

const attachManagedBrandAsset = async (payload: WebsiteManagedBrandAssetInput, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await getWebsiteOrThrow(adminId);

  const result = await prisma.$transaction(async (tx) => {
    await acquireTextTransactionAdvisoryLock(tx, website.id);
    const locked = await tx.businessWebsite.findFirst({
      where: { id: website.id, adminId },
      select: { id: true, status: true, templateId: true, templateVersion: true, logo: true, favicon: true, socialImageUrl: true },
    });
    if (!locked) throw new AppError(status.NOT_FOUND, "Business website not found");
    assertLifecycleAllowsDraftMutation(locked.status as WebsiteLifecycleStatus);

    const asset = await tx.websiteAsset.upsert({
      where: { websiteId_publicId: { websiteId: website.id, publicId: payload.publicId } },
      create: {
        websiteId: website.id,
        publicId: payload.publicId,
        url: payload.url,
        mimeType: payload.mimeType,
        width: payload.width,
        height: payload.height,
        bytes: payload.bytes,
        altText: payload.kind === "logo" ? "Business logo" : payload.kind === "favicon" ? "Website favicon" : "Social share image",
        folder: payload.folder,
        metadata: payload.metadata as any,
      },
      update: {
        url: payload.url,
        mimeType: payload.mimeType,
        width: payload.width,
        height: payload.height,
        bytes: payload.bytes,
        metadata: payload.metadata as any,
      },
    });


    // Finalizing a managed upload registers the immutable tenant asset. The
    // Website Studio editor then persists the chosen logo/favicon/global/page
    // reference through the canonical server editor-state endpoint. Publish
    // later validates that managed reference in the same transaction.
    return { asset };
  });
  await WebsiteProjectionCacheService.invalidateStudioAdmin(adminId);
  return result;
};

const listAssets = async (user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await getWebsiteOrThrow(adminId);
  return prisma.websiteAsset.findMany({ where: { websiteId: website.id }, orderBy: { createdAt: "desc" } });
};

const registerAsset = async (payload: WebsiteAssetCreateInput, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await getWebsiteOrThrow(adminId);
  const url = assertSafeHttpsUrl(payload.url, "Asset URL");
  if (!url) throw new AppError(status.BAD_REQUEST, "Asset URL is required");
  const asset = await prisma.websiteAsset.create({
    data: {
      ...payload,
      url,
      websiteId: website.id,
      // Legacy external asset registration remains available for non-brand
      // content, but can never impersonate a managed tenant brand upload.
      metadata: { provider: "external", kind: "legacy" } as any,
    },
  });
  await WebsiteProjectionCacheService.invalidateStudioAdmin(adminId);
  return asset;
};


const uploadBrandAsset = async (
  file: Express.Multer.File,
  kind: "logo" | "favicon",
  user: IRequestUser,
) => {
  const adminId = await getAdminId(user);
  const website = await getWebsiteOrThrow(adminId);
  if (!file?.buffer || !["image/jpeg", "image/png", "image/webp", "image/avif"].includes(file.mimetype.toLowerCase())) {
    throw new AppError(status.BAD_REQUEST, "Upload a JPEG, PNG, WEBP, or AVIF image");
  }
  const maxBytes = kind === "favicon" ? 2 * 1024 * 1024 : 5 * 1024 * 1024;
  if (file.size > maxBytes) throw new AppError(status.BAD_REQUEST, `${kind === "logo" ? "Logo" : "Favicon"} file is too large`);

  // Backward-compatible server upload for older clients. New clients use the
  // signed direct-to-Cloudinary flow. The unique public ID is essential: never
  // overwrite the asset referenced by the currently published snapshot.
  const folder = `Cleaning-CRM/websites/${website.id}/brand`;
  const publicId = `${kind}-${randomUUID()}`;
  const uploaded = await uploadToCloudinary(file.buffer, {
    folder,
    public_id: publicId,
    overwrite: false,
    transformation: kind === "favicon"
      ? [{ width: 512, height: 512, crop: "limit", quality: "auto:good" }]
      : [{ width: 1600, height: 1600, crop: "limit", quality: "auto:good" }],
  });
  if (!uploaded?.secure_url || !uploaded?.public_id || !uploaded?.width || !uploaded?.height) {
    throw new AppError(status.BAD_GATEWAY, "Image storage did not return a usable asset");
  }
  if (kind === "favicon") {
    const ratio = uploaded.width / uploaded.height;
    if (uploaded.width < 32 || uploaded.height < 32 || ratio < 0.8 || ratio > 1.25) {
      throw new AppError(status.BAD_REQUEST, "Favicon must be at least 32×32 and approximately square");
    }
  } else {
    const ratio = uploaded.width / uploaded.height;
    if (uploaded.width < 64 || uploaded.height < 24 || ratio < 0.1 || ratio > 10) {
      throw new AppError(status.BAD_REQUEST, "Logo dimensions or aspect ratio are not supported");
    }
  }

  const result = await attachManagedBrandAsset({
    kind,
    publicId: uploaded.public_id,
    url: uploaded.secure_url,
    mimeType: `image/${uploaded.format === "jpg" ? "jpeg" : (uploaded.format ?? "webp")}`,
    width: uploaded.width,
    height: uploaded.height,
    bytes: uploaded.bytes ?? file.size,
    folder,
    metadata: { provider: "cloudinary", kind: "brand", slot: kind, immutable: true, legacyDirectUpload: true },
  }, user);
  return result.asset;
};

const CONTENT_ASSET_SLOTS = new Set(["about-image"]);

const uploadContentAsset = async (
  file: Express.Multer.File,
  slot: string,
  user: IRequestUser,
) => {
  const adminId = await getAdminId(user);
  const website = await getWebsiteOrThrow(adminId);
  const normalizedSlot = slot.trim().toLowerCase();
  if (!CONTENT_ASSET_SLOTS.has(normalizedSlot)) {
    throw new AppError(status.BAD_REQUEST, "Unsupported website content asset slot");
  }
  const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);
  if (!file?.buffer || !allowedTypes.has(file.mimetype.toLowerCase())) {
    throw new AppError(status.BAD_REQUEST, "Upload a JPEG, PNG, WEBP, or AVIF image");
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new AppError(status.BAD_REQUEST, "Website image must be no larger than 5 MB");
  }

  // Content images are immutable for the same reason as logos: published and
  // historical snapshots must never change underneath a stored URL.
  const folder = `Cleaning-CRM/websites/${website.id}/content`;
  const publicId = `${normalizedSlot}-${randomUUID()}`;
  const uploaded = await uploadToCloudinary(file.buffer, {
    folder,
    public_id: publicId,
    overwrite: false,
    transformation: [{ width: 1800, height: 1400, crop: "limit", quality: "auto", fetch_format: "auto" }],
  });
  if (!uploaded?.secure_url || !uploaded?.public_id || !uploaded?.width || !uploaded?.height) {
    if (uploaded?.public_id) await deleteFromCloudinary(uploaded.public_id).catch(() => undefined);
    throw new AppError(status.BAD_GATEWAY, "Image storage did not return a usable asset");
  }

  const bytes = Number(uploaded.bytes ?? file.size ?? 0);
  const width = Number(uploaded.width);
  const height = Number(uploaded.height);
  if (bytes <= 0 || bytes > 5 * 1024 * 1024 || width < 320 || height < 180 || width > 5000 || height > 5000) {
    await deleteFromCloudinary(uploaded.public_id).catch(() => undefined);
    throw new AppError(status.BAD_REQUEST, "Website image dimensions or file size are not supported");
  }

  const asset = await prisma.websiteAsset.create({
    data: {
      websiteId: website.id,
      publicId: uploaded.public_id,
      url: uploaded.secure_url,
      mimeType: `image/${uploaded.format === "jpg" ? "jpeg" : (uploaded.format ?? "webp")}`,
      width,
      height,
      bytes,
      altText: "About the business",
      folder,
      metadata: { provider: "cloudinary", kind: "content", slot: normalizedSlot, immutable: true },
    },
  });
  await WebsiteProjectionCacheService.invalidateStudioAdmin(adminId);
  return asset;
};

const deleteAsset = async (assetId: string, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await prisma.businessWebsite.findUnique({
    where: { adminId },
    select: {
      id: true,
      logo: true,
      favicon: true,
      socialImageUrl: true,
      publishedSnapshot: true,
    },
  });
  if (!website) throw new AppError(status.NOT_FOUND, "Business website has not been provisioned yet");
  const asset = await prisma.websiteAsset.findFirst({
    where: { id: assetId, websiteId: website.id },
    select: { id: true, url: true },
  });
  if (!asset) throw new AppError(status.NOT_FOUND, "Website asset not found");

  const published = parsePublishedSnapshot(website.publishedSnapshot);
  const referencedByDraft = [website.logo, website.favicon, website.socialImageUrl].includes(asset.url);
  const referencedByPublished = published
    ? [published.website.logo, published.website.favicon, published.website.socialImageUrl].includes(asset.url)
    : false;
  if (referencedByDraft || referencedByPublished) {
    throw new AppError(status.CONFLICT, "Remove or replace this image in Website Studio and publish the change before deleting the asset", {
      code: "WEBSITE_ASSET_IN_USE",
      retryable: false,
    });
  }

  await prisma.websiteAsset.delete({ where: { id: assetId } });
  await WebsiteProjectionCacheService.invalidateStudioAdmin(adminId);
  return { id: assetId, deleted: true };
};

export const WebsiteService = {
  createRevisionSnapshotTx,
  ensurePublishedSnapshotBeforeDraftMutationTx,
  createWebsite,
  createWebsiteForAdmin,
  getWebsite,
  getWebsiteForAdmin,
  getWebsiteEditor,
  getWebsiteEditorForAdmin,
  updateWebsite,
  saveEditorState,
  publishWebsite,
  launchWebsite,
  listPages,
  updatePage,
  listRevisions,
  getRevision,
  restoreRevision,
  attachManagedBrandAsset,
  listAssets,
  registerAsset,
  uploadBrandAsset,
  uploadContentAsset,
  deleteAsset,
};
