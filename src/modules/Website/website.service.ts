import { randomUUID } from "crypto";
import status from "http-status";
import AppError from "../../errorHelper/AppError";
import logger from "../../lib/logger";
import { WEBSITE_BASE_DOMAIN, WEBSITE_CUSTOM_DOMAINS_ENABLED } from "../../config/ENV";
import { prisma } from "../../lib/prisma/prisma";
import { acquireTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { PROVISIONING_TRANSACTION_OPTIONS } from "../../lib/prisma/transactionPolicy";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import { uploadToCloudinary } from "../../lib/utils/cloudinary";
import type { IRequestUser } from "../../types/requestUser.interface";
import { ONBOARDING_STEPS } from "../Admin/admin.constant";
import type {
  WebsiteAssetCreateInput,
  WebsiteManagedBrandAssetInput,
  WebsiteCreateInput,
  WebsiteDraftSaveInput,
  WebsitePageUpdateInput,
  WebsitePublishInput,
  WebsiteUpdateInput,
} from "./website.interface";
import { assertSafeHttpsUrl, normalizeSubdomain } from "./websiteIdentity";
import { TemplateRegistry } from "./templateRegistry";
import { buildTemplateSelectionPatch } from "./templateSelection";
import { WebsiteProvisioningService } from "./websiteProvisioning.service";
import { WebsiteBookingProvisioningService } from "./websiteBookingProvisioning.service";
import { PublicWebsiteService } from "./publicWebsite.service";
import { buildPublishedSnapshot } from "./websiteSnapshot";
import { WebsiteHostResolverService } from "./websiteHostResolver.service";
import { WebsiteProjectionCacheService } from "./websiteProjectionCache.service";
import { isWebsiteDomainRoutingReady } from "./websiteDomainReadiness";
import { WEBSITE_STATUS, statusAfterDraftMutation, type WebsiteLifecycleStatus } from "./websiteLifecycle";
import { validateWebsitePageContent } from "./websiteContent";

const getWebsiteOrThrow = async (adminId: string, db: any = prisma) => {
  const website = await db.businessWebsite.findUnique({ where: { adminId }, select: { id: true } });
  if (!website) throw new AppError(status.NOT_FOUND, "Business website has not been provisioned yet");
  return website;
};


const isManagedBrandAsset = (asset: { metadata: unknown } | null, kind: "logo" | "favicon") => {
  if (!asset?.metadata || typeof asset.metadata !== "object" || Array.isArray(asset.metadata)) return false;
  const metadata = asset.metadata as Record<string, unknown>;
  return metadata.provider === "cloudinary" && metadata.kind === "brand" && metadata.slot === kind && metadata.immutable === true;
};

const assertManagedBrandReferences = async (
  websiteId: string,
  payload: WebsiteUpdateInput,
  current: { logo?: string | null; favicon?: string | null },
  db: any,
) => {
  for (const kind of ["logo", "favicon"] as const) {
    const next = payload[kind];
    if (next === undefined || next === null || next === current[kind]) continue;
    const safeUrl = assertSafeHttpsUrl(next, kind === "logo" ? "Logo URL" : "Favicon URL");
    if (!safeUrl) continue;
    const asset = await db.websiteAsset.findFirst({
      where: { websiteId, url: safeUrl },
      select: { metadata: true },
    });
    if (!isManagedBrandAsset(asset, kind)) {
      throw new AppError(status.BAD_REQUEST, `Upload the ${kind} through Website Branding instead of pasting an external URL`, {
        code: "WEBSITE_MANAGED_ASSET_REQUIRED",
        retryable: false,
      });
    }
  }
};

const assertOwnedForm = async (
  adminId: string,
  id: string | null | undefined,
  kind: "booking" | "estimate",
  db: any = prisma,
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
  db: any,
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
  db: any,
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
const loadDraftSnapshot = async (websiteId: string, db: any) => {
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
      primaryColor: true,
      secondaryColor: true,
      accentColor: true,
      font: true,
      logo: true,
      favicon: true,
      primaryBookingFormId: true,
      primaryEstimateFormId: true,
      bookingEnabled: true,
      bookingShowHeaderCta: true,
      bookingShowServiceCtas: true,
      bookingShowHomeCta: true,
      bookingShowAvailableSlots: true,
      bookingShowPrices: true,
      estimateEnabled: true,
      metaTitle: true,
      metaDescription: true,
      socialImageUrl: true,
      indexSite: true,
      createdAt: true,
      updatedAt: true,
      publishedAt: true,
      publishedRevisionNumber: true,
      pages: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      domains: { orderBy: { createdAt: "asc" } },
      assets: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!website) throw new AppError(status.NOT_FOUND, "Business website not found");
  return website;
};

const loadWebsiteDetailsWhere = async (where: { id: string } | { adminId: string }, db: any = prisma) => {
  const website = await db.businessWebsite.findUnique({
    where,
    include: {
      pages: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      domains: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
      assets: { orderBy: { createdAt: "desc" } },
      subdomainAliases: { orderBy: { createdAt: "desc" } },
      primaryBookingForm: { select: { id: true, slug: true, published: true, headline: true } },
      primaryEstimateForm: { select: { id: true, slug: true, published: true, headline: true } },
    },
  });
  if (!website) throw new AppError(status.NOT_FOUND, "Business website not found");

  const latest = await db.websiteRevision.aggregate({
    where: { websiteId: website.id },
    _max: { revisionNumber: true },
  });
  const draftRevisionNumber = latest._max.revisionNumber ?? 0;
  const { publishedSnapshot: _publishedSnapshot, ...safeWebsite } = website;
  const platformUrl = WEBSITE_BASE_DOMAIN ? `https://${website.subdomain}.${WEBSITE_BASE_DOMAIN}` : null;
  const primaryDomain = WEBSITE_CUSTOM_DOMAINS_ENABLED
    ? website.domains.find((domain: any) => domain.isPrimary && isWebsiteDomainRoutingReady(domain))?.domain ?? null
    : null;
  return {
    ...safeWebsite,
    platformUrl,
    publicUrl: primaryDomain ? `https://${primaryDomain}` : platformUrl,
    draftRevisionNumber,
    // Publication state and draft dirtiness are separate concerns. A
    // SUSPENDED website may still have a perfectly current published snapshot,
    // while PROVISIONED/DRAFT sites have no published revision yet.
    hasUnpublishedChanges:
      website.publishedRevisionNumber === null ||
      draftRevisionNumber > website.publishedRevisionNumber,
  };
};

const loadWebsiteDetails = (websiteId: string, db: any = prisma) =>
  loadWebsiteDetailsWhere({ id: websiteId }, db);

const loadWebsiteDetailsForAdmin = (adminId: string, db: any = prisma) =>
  loadWebsiteDetailsWhere({ adminId }, db);

const getLatestRevisionNumber = async (db: any, websiteId: string): Promise<number> => {
  const latest = await db.websiteRevision.aggregate({
    where: { websiteId },
    _max: { revisionNumber: true },
  });
  return latest._max.revisionNumber ?? 0;
};

const assertExpectedRevision = async (
  db: any,
  websiteId: string,
  expectedRevisionNumber: number | undefined,
): Promise<number> => {
  const currentRevisionNumber = await getLatestRevisionNumber(db, websiteId);
  if (expectedRevisionNumber !== undefined && expectedRevisionNumber !== currentRevisionNumber) {
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

const validateDraftPageContent = (draft: { pages?: Array<{ kind: string; content: unknown }> }) => {
  for (const page of draft.pages ?? []) validateWebsitePageContent(page.kind, page.content);
};

const createRevisionSnapshot = async (
  db: any,
  websiteId: string,
  createdByUserId: string | null,
  reason: string,
  baseRevisionNumber?: number,
) => {
  await acquireTextTransactionAdvisoryLock(db, websiteId);
  const currentRevisionNumber = baseRevisionNumber ?? await getLatestRevisionNumber(db, websiteId);
  const snapshot = await loadDraftSnapshot(websiteId, db);
  return db.websiteRevision.create({
    data: {
      websiteId,
      revisionNumber: currentRevisionNumber + 1,
      snapshot: JSON.parse(JSON.stringify(snapshot)) as any,
      reason,
      createdByUserId,
    },
  });
};

/**
 * Backward-compatible publication guard for websites that were already
 * PUBLISHED before Phase 4 added publishedSnapshot. Capture their current
 * state before the first draft mutation so Save draft cannot leak changes.
 */
const ensurePublishedSnapshotBeforeDraftMutationTx = async (db: any, websiteId: string) => {
  const current = await db.businessWebsite.findUnique({
    where: { id: websiteId },
    select: { status: true, publishedSnapshot: true, publishedRevisionNumber: true },
  });
  if (!current || current.status !== "PUBLISHED" || current.publishedSnapshot) return;

  const draft = await loadDraftSnapshot(websiteId, db);
  const latest = await db.websiteRevision.aggregate({
    where: { websiteId },
    _max: { revisionNumber: true },
  });
  await db.businessWebsite.update({
    where: { id: websiteId },
    data: {
      publishedSnapshot: buildPublishedSnapshot(draft) as any,
      publishedRevisionNumber: current.publishedRevisionNumber ?? latest._max.revisionNumber ?? null,
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
  };
};

const createWebsiteForAdmin = async (
  adminId: string,
  payload: WebsiteCreateInput,
  createdByUserId: string | null = null,
) => {
  const website = await prisma.$transaction(async (tx: any) => {
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

const getWebsite = async (user: IRequestUser) => {
  const adminId = await getAdminId(user);
  return getWebsiteForAdmin(adminId);
};

const updateWebsite = async (payload: WebsiteUpdateInput, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const current = await getWebsiteOrThrow(adminId);

  return prisma.$transaction(async (tx: any) => {
    await acquireTextTransactionAdvisoryLock(tx, current.id);

    // Re-read after acquiring the website lock. Two concurrent editors may both
    // have loaded the same pre-lock template state; using the locked row avoids
    // applying a templateVersion patch against stale templateId data.
    const lockedCurrent = await tx.businessWebsite.findFirst({
      where: { id: current.id, adminId },
      select: { id: true, status: true, templateId: true, templateVersion: true, logo: true, favicon: true },
    });
    if (!lockedCurrent) throw new AppError(status.NOT_FOUND, "Business website not found");
    assertLifecycleAllowsDraftMutation(lockedCurrent.status as WebsiteLifecycleStatus);

    await Promise.all([
      assertOwnedForm(adminId, payload.primaryBookingFormId, "booking", tx),
      assertOwnedForm(adminId, payload.primaryEstimateFormId, "estimate", tx),
    ]);
    await assertManagedBrandReferences(lockedCurrent.id, payload, lockedCurrent, tx);
    const data = prepareWebsitePatch(payload, lockedCurrent);

    await ensurePublishedSnapshotBeforeDraftMutationTx(tx, lockedCurrent.id);
    await tx.businessWebsite.update({
      where: { id: lockedCurrent.id },
      data: { ...data, ...draftLifecyclePatch(lockedCurrent.status as WebsiteLifecycleStatus) },
    });
    await createRevisionSnapshot(tx, lockedCurrent.id, user.id, "Website settings updated");
    return loadWebsiteDetails(lockedCurrent.id, tx);
  });
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
  const website = await getWebsiteOrThrow(adminId);
  const page = await prisma.websitePage.findFirst({
    where: { id: pageId, websiteId: website.id },
    select: { id: true, kind: true },
  });
  if (!page) throw new AppError(status.NOT_FOUND, "Website page not found");

  return prisma.$transaction(async (tx: any) => {
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
    await createRevisionSnapshot(tx, website.id, user.id, `Page updated: ${pageId}`);
    return updated;
  });
};

const saveDraft = async (payload: WebsiteDraftSaveInput, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const current = await getWebsiteOrThrow(adminId);
  const websitePatch = payload.website ?? {};
  const expectedRevisionNumber = payload.expectedRevisionNumber;

  const uniquePageIds = [...new Set((payload.pages ?? []).map((page) => page.id))];
  if (uniquePageIds.length !== (payload.pages ?? []).length) {
    throw new AppError(status.BAD_REQUEST, "A website page can only be updated once per draft save");
  }

  return prisma.$transaction(async (tx: any) => {
    await acquireTextTransactionAdvisoryLock(tx, current.id);

    const lockedCurrent = await tx.businessWebsite.findFirst({
      where: { id: current.id, adminId },
      select: { id: true, status: true, templateId: true, templateVersion: true, logo: true, favicon: true },
    });
    if (!lockedCurrent) throw new AppError(status.NOT_FOUND, "Business website not found");
    assertLifecycleAllowsDraftMutation(lockedCurrent.status as WebsiteLifecycleStatus);

    const baseRevisionNumber = await assertExpectedRevision(tx, lockedCurrent.id, expectedRevisionNumber);

    await Promise.all([
      assertOwnedForm(adminId, websitePatch.primaryBookingFormId, "booking", tx),
      assertOwnedForm(adminId, websitePatch.primaryEstimateFormId, "estimate", tx),
    ]);
    await assertManagedBrandReferences(lockedCurrent.id, websitePatch, lockedCurrent, tx);

    await ensurePublishedSnapshotBeforeDraftMutationTx(tx, lockedCurrent.id);

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

    const lifecyclePatch = draftLifecyclePatch(lockedCurrent.status as WebsiteLifecycleStatus);
    if (Object.keys(websitePatch).length || Object.keys(lifecyclePatch).length) {
      const data = Object.keys(websitePatch).length ? prepareWebsitePatch(websitePatch, lockedCurrent) : {};
      await tx.businessWebsite.update({
        where: { id: lockedCurrent.id },
        data: { ...data, ...lifecyclePatch },
      });
    }

    for (const page of payload.pages ?? []) {
      const { id, ...data } = page;
      const pageKind = ownedPageKinds.get(id);
      if (!pageKind) throw new AppError(status.NOT_FOUND, "Website page not found");
      const normalizedData = data.content === undefined
        ? data
        : { ...data, content: validateWebsitePageContent(pageKind, data.content) };
      await tx.websitePage.update({ where: { id }, data: normalizedData as any });
    }

    await createRevisionSnapshot(tx, lockedCurrent.id, user.id, "Draft saved", baseRevisionNumber);
    return loadWebsiteDetails(lockedCurrent.id, tx);
  });
};

const publishWebsite = async (payload: WebsitePublishInput, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const current = await getWebsiteOrThrow(adminId);

  const website = await prisma.$transaction(async (tx: any) => {
    await acquireTextTransactionAdvisoryLock(tx, current.id);
    const baseRevisionNumber = await assertExpectedRevision(tx, current.id, payload.expectedRevisionNumber);
    const draft = await loadDraftSnapshot(current.id, tx);
    assertLifecycleAllowsPublish(draft.status as WebsiteLifecycleStatus);
    TemplateRegistry.requireTemplate(draft.templateId, draft.templateVersion);
    validateDraftPageContent(draft);
    if (!draft.pages.some((page: any) => page.kind === "HOME" && page.isEnabled)) {
      throw new AppError(status.CONFLICT, "Enable the Home page before publishing the website");
    }

    // Only tenant-owned form IDs can reach the draft through normal APIs, but
    // re-check before publishing to fail closed if the database was modified
    // manually or by an old deployment.
    await Promise.all([
      assertOwnedForm(adminId, draft.primaryBookingFormId, "booking", tx),
      assertOwnedForm(adminId, draft.primaryEstimateFormId, "estimate", tx),
    ]);
    await Promise.all([
      assertBookingReadyForPublish(adminId, draft, tx),
      assertEstimateReadyForPublish(adminId, draft, tx),
    ]);

    const revision = await createRevisionSnapshot(tx, current.id, user.id, "Website published", baseRevisionNumber);
    const publishedSnapshot = buildPublishedSnapshot(draft);
    await tx.businessWebsite.update({
      where: { id: current.id },
      data: {
        status: WEBSITE_STATUS.PUBLISHED,
        publishedAt: new Date(),
        publishedSnapshot: publishedSnapshot as any,
        publishedRevisionNumber: revision.revisionNumber,
      },
    });
    return loadWebsiteDetails(current.id, tx);
  });

  // Routing cache is only a performance layer, but publishing is one of the
  // lifecycle events where we proactively drop the canonical host mapping so
  // every edge immediately re-resolves against the current website row.
  await Promise.all([
    WebsiteHostResolverService.invalidateSubdomains([website.subdomain]),
    WebsiteProjectionCacheService.invalidateWebsite(website.id),
  ]);
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
  const current = await getWebsiteOrThrow(adminId);

  const result = await prisma.$transaction(async (tx: any) => {
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

    const completed = new Set(owner.onboardingCompletedSteps);
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
      latestRevisionNumber <= owner.businessWebsite.publishedRevisionNumber
    ) {
      return {
        businessName: owner.businessName,
        alreadyLive: true,
        website: await loadWebsiteDetails(current.id, tx),
      };
    }

    // Booking attachment participates in this same transaction. This closes
    // the gap where a site could be marked live while /book had no published
    // tenant-owned form attached.
    const preflightDraft = await loadDraftSnapshot(current.id, tx);
    const bookingFormId = preflightDraft.bookingEnabled
      ? await WebsiteBookingProvisioningService.ensureAttachedForLaunchTx(tx, adminId, current.id)
      : null;

    const draft = bookingFormId ? await loadDraftSnapshot(current.id, tx) : preflightDraft;
    TemplateRegistry.requireTemplate(draft.templateId, draft.templateVersion);
    validateDraftPageContent(draft);

    if (!draft.pages.some((page: any) => page.kind === "HOME" && page.isEnabled)) {
      throw new AppError(status.CONFLICT, "Enable the Home page before launching the website", {
        code: "WEBSITE_HOME_REQUIRED",
        retryable: false,
        fieldErrors: { template: "The Home page must be enabled." },
      });
    }
    if (draft.bookingEnabled && !draft.pages.some((page: any) => page.kind === "BOOK" && page.isEnabled)) {
      throw new AppError(status.CONFLICT, "Enable the Book Online page before launching the website", {
        code: "WEBSITE_BOOK_PAGE_REQUIRED",
        retryable: false,
        fieldErrors: { services: "Online booking requires the Book page." },
      });
    }

    if (draft.bookingEnabled) {
      const attachedBookingForm = await tx.bookingForm.findFirst({
        where: { id: bookingFormId!, adminId, published: true },
        select: { id: true },
      });
      if (!attachedBookingForm || draft.primaryBookingFormId !== bookingFormId) {
        throw new AppError(status.CONFLICT, "Website booking is not ready to publish", {
          code: "WEBSITE_BOOKING_NOT_READY",
          retryable: true,
          fieldErrors: { services: "Reconnect Online Booking and try again." },
        });
      }
    }

    await assertEstimateReadyForPublish(adminId, draft, tx);

    // Building the immutable publication document before the write validates
    // the exact config/pages the public projection will consume after commit.
    const publishedSnapshot = buildPublishedSnapshot(draft);
    const revision = await createRevisionSnapshot(
      tx,
      current.id,
      user.id,
      "Website launched",
      latestRevisionNumber,
    );
    const launchedAt = new Date();

    await tx.businessWebsite.update({
      where: { id: current.id },
      data: {
        status: WEBSITE_STATUS.PUBLISHED,
        publishedAt: launchedAt,
        publishedSnapshot: publishedSnapshot as any,
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
      website: await loadWebsiteDetails(current.id, tx),
    };
  }, PROVISIONING_TRANSACTION_OPTIONS);

  // Drop both routing and projection caches only after the database commit, so
  // no worker can rebuild Redis from a half-published transaction.
  await Promise.all([
    WebsiteHostResolverService.invalidateSubdomains([result.website.subdomain]),
    WebsiteProjectionCacheService.invalidateWebsite(result.website.id),
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
  const website = await getWebsiteOrThrow(adminId);
  return prisma.websiteRevision.findMany({
    where: { websiteId: website.id },
    select: { id: true, revisionNumber: true, reason: true, createdByUserId: true, createdAt: true },
    orderBy: { revisionNumber: "desc" },
    take: 50,
  });
};

const getRevision = async (revisionId: string, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await getWebsiteOrThrow(adminId);
  const revision = await prisma.websiteRevision.findFirst({ where: { id: revisionId, websiteId: website.id } });
  if (!revision) throw new AppError(status.NOT_FOUND, "Website revision not found");
  return revision;
};

const attachManagedBrandAsset = async (payload: WebsiteManagedBrandAssetInput, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await getWebsiteOrThrow(adminId);

  return prisma.$transaction(async (tx: any) => {
    await acquireTextTransactionAdvisoryLock(tx, website.id);
    const locked = await tx.businessWebsite.findFirst({
      where: { id: website.id, adminId },
      select: { id: true, status: true, templateId: true, templateVersion: true, logo: true, favicon: true },
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
        altText: payload.kind === "logo" ? "Business logo" : "Website favicon",
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

    const currentUrl = payload.kind === "logo" ? locked.logo : locked.favicon;
    if (currentUrl !== payload.url) {
      await ensurePublishedSnapshotBeforeDraftMutationTx(tx, website.id);
      await tx.businessWebsite.update({
        where: { id: website.id },
        data: {
          [payload.kind]: payload.url,
          ...draftLifecyclePatch(locked.status as WebsiteLifecycleStatus),
        },
      });
      await createRevisionSnapshot(tx, website.id, user.id, `${payload.kind === "logo" ? "Logo" : "Favicon"} uploaded`);
    }

    return { asset, website: await loadWebsiteDetails(website.id, tx) };
  });
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
  return prisma.websiteAsset.create({
    data: {
      ...payload,
      url,
      websiteId: website.id,
      // Legacy external asset registration remains available for non-brand
      // content, but can never impersonate a managed tenant brand upload.
      metadata: { provider: "external", kind: "legacy" } as any,
    },
  });
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
  if (!file?.buffer || !file.mimetype.toLowerCase().startsWith("image/")) {
    throw new AppError(status.BAD_REQUEST, "Upload a valid image file");
  }

  const folder = `Cleaning-CRM/websites/${website.id}/content`;
  const publicId = normalizedSlot;
  const uploaded = await uploadToCloudinary(file.buffer, {
    folder,
    public_id: publicId,
    overwrite: true,
    transformation: [{ width: 1800, height: 1400, crop: "limit", quality: "auto", fetch_format: "auto" }],
  });
  if (!uploaded?.secure_url || !uploaded?.public_id) {
    throw new AppError(status.BAD_GATEWAY, "Image storage did not return a usable asset");
  }

  return prisma.websiteAsset.upsert({
    where: { websiteId_publicId: { websiteId: website.id, publicId: uploaded.public_id } },
    create: {
      websiteId: website.id,
      publicId: uploaded.public_id,
      url: uploaded.secure_url,
      mimeType: `image/${uploaded.format ?? "webp"}`,
      width: uploaded.width ?? null,
      height: uploaded.height ?? null,
      bytes: uploaded.bytes ?? file.size ?? null,
      altText: "About the business",
      folder,
      metadata: { kind: "content", slot: normalizedSlot },
    },
    update: {
      url: uploaded.secure_url,
      mimeType: `image/${uploaded.format ?? "webp"}`,
      width: uploaded.width ?? null,
      height: uploaded.height ?? null,
      bytes: uploaded.bytes ?? file.size ?? null,
      metadata: { kind: "content", slot: normalizedSlot },
    },
  });
};

const deleteAsset = async (assetId: string, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await getWebsiteOrThrow(adminId);
  const asset = await prisma.websiteAsset.findFirst({
    where: { id: assetId, websiteId: website.id },
    select: { id: true },
  });
  if (!asset) throw new AppError(status.NOT_FOUND, "Website asset not found");
  await prisma.websiteAsset.delete({ where: { id: assetId } });
  return { id: assetId, deleted: true };
};

export const WebsiteService = {
  createWebsite,
  createWebsiteForAdmin,
  getWebsite,
  getWebsiteForAdmin,
  updateWebsite,
  saveDraft,
  publishWebsite,
  launchWebsite,
  listPages,
  updatePage,
  listRevisions,
  getRevision,
  attachManagedBrandAsset,
  listAssets,
  registerAsset,
  uploadBrandAsset,
  uploadContentAsset,
  deleteAsset,
};
