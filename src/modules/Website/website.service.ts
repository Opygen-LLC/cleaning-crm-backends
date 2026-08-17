import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { WEBSITE_BASE_DOMAIN, WEBSITE_CUSTOM_DOMAINS_ENABLED } from "../../config/ENV";
import { prisma } from "../../lib/prisma/prisma";
import { acquireTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import type {
  WebsiteAssetCreateInput,
  WebsiteCreateInput,
  WebsiteDraftSaveInput,
  WebsitePageUpdateInput,
  WebsitePublishInput,
  WebsiteUpdateInput,
} from "./website.interface";
import { assertSafeHttpsUrl } from "./websiteIdentity";
import { TemplateRegistry } from "./templateRegistry";
import { WebsiteProvisioningService } from "./websiteProvisioning.service";
import { buildPublishedSnapshot } from "./websiteSnapshot";
import { WebsiteHostResolverService } from "./websiteHostResolver.service";
import { WebsiteProjectionCacheService } from "./websiteProjectionCache.service";
import { isWebsiteDomainRoutingReady } from "./websiteDomainReadiness";
import { WEBSITE_STATUS, statusAfterDraftMutation, type WebsiteLifecycleStatus } from "./websiteLifecycle";

const getWebsiteOrThrow = async (adminId: string, db: any = prisma) => {
  const website = await db.businessWebsite.findUnique({ where: { adminId }, select: { id: true } });
  if (!website) throw new AppError(status.NOT_FOUND, "Business website has not been provisioned yet");
  return website;
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
  let templatePatch: Record<string, unknown> = {};
  if (payload.templateId !== undefined || payload.templateVersion !== undefined) {
    const template = TemplateRegistry.requireTemplate(
      payload.templateId ?? current.templateId,
      payload.templateVersion ?? (payload.templateId ? undefined : current.templateVersion),
    );
    templatePatch = {
      templateId: template.id,
      templateVersion: template.version,
      schemaVersion: template.schemaVersion,
    };
  }

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
      select: { id: true, status: true, templateId: true, templateVersion: true },
    });
    if (!lockedCurrent) throw new AppError(status.NOT_FOUND, "Business website not found");
    assertLifecycleAllowsDraftMutation(lockedCurrent.status as WebsiteLifecycleStatus);

    await Promise.all([
      assertOwnedForm(adminId, payload.primaryBookingFormId, "booking", tx),
      assertOwnedForm(adminId, payload.primaryEstimateFormId, "estimate", tx),
    ]);
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
    select: { id: true },
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
    const updated = await tx.websitePage.update({ where: { id: pageId }, data: payload as any });
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
      select: { id: true, status: true, templateId: true, templateVersion: true },
    });
    if (!lockedCurrent) throw new AppError(status.NOT_FOUND, "Business website not found");
    assertLifecycleAllowsDraftMutation(lockedCurrent.status as WebsiteLifecycleStatus);

    const baseRevisionNumber = await assertExpectedRevision(tx, lockedCurrent.id, expectedRevisionNumber);

    await Promise.all([
      assertOwnedForm(adminId, websitePatch.primaryBookingFormId, "booking", tx),
      assertOwnedForm(adminId, websitePatch.primaryEstimateFormId, "estimate", tx),
    ]);

    await ensurePublishedSnapshotBeforeDraftMutationTx(tx, lockedCurrent.id);

    if (uniquePageIds.length) {
      const ownedPages = await tx.websitePage.findMany({
        where: { websiteId: lockedCurrent.id, id: { in: uniquePageIds } },
        select: { id: true },
      });
      if (ownedPages.length !== uniquePageIds.length) {
        throw new AppError(status.NOT_FOUND, "One or more website pages do not belong to this business");
      }
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
      await tx.websitePage.update({ where: { id }, data: data as any });
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
    data: { ...payload, url, websiteId: website.id, metadata: (payload.metadata ?? {}) as any },
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
  listPages,
  updatePage,
  listRevisions,
  getRevision,
  listAssets,
  registerAsset,
  deleteAsset,
};
