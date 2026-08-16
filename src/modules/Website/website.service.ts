import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { WEBSITE_BASE_DOMAIN } from "../../config/ENV";
import { prisma } from "../../lib/prisma/prisma";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import type {
  WebsiteAssetCreateInput,
  WebsiteCreateInput,
  WebsiteDraftSaveInput,
  WebsitePageUpdateInput,
  WebsiteUpdateInput,
} from "./website.interface";
import { assertSafeHttpsUrl } from "./websiteIdentity";
import { TemplateRegistry } from "./templateRegistry";
import { WebsiteProvisioningService } from "./websiteProvisioning.service";
import { buildPublishedSnapshot } from "./websiteSnapshot";
import { WebsiteHostResolverService } from "./websiteHostResolver.service";
import { WebsiteProjectionCacheService } from "./websiteProjectionCache.service";

const getWebsiteOrThrow = async (adminId: string, db: any = prisma) => {
  const website = await db.businessWebsite.findUnique({ where: { adminId } });
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

const loadWebsiteDetails = async (websiteId: string, db: any = prisma) => {
  const website = await db.businessWebsite.findUnique({
    where: { id: websiteId },
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
    where: { websiteId },
    _max: { revisionNumber: true },
  });
  const draftRevisionNumber = latest._max.revisionNumber ?? 0;
  const { publishedSnapshot: _publishedSnapshot, ...safeWebsite } = website;
  const platformUrl = WEBSITE_BASE_DOMAIN ? `https://${website.subdomain}.${WEBSITE_BASE_DOMAIN}` : null;
  const primaryDomain = website.domains.find((domain: any) => domain.isPrimary && domain.status === "VERIFIED")?.domain ?? null;
  return {
    ...safeWebsite,
    platformUrl,
    publicUrl: primaryDomain ? `https://${primaryDomain}` : platformUrl,
    draftRevisionNumber,
    hasUnpublishedChanges:
      website.status !== "PUBLISHED" ||
      website.publishedRevisionNumber === null ||
      draftRevisionNumber > website.publishedRevisionNumber,
  };
};

const createRevisionSnapshot = async (
  db: any,
  websiteId: string,
  createdByUserId: string | null,
  reason: string,
) => {
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${websiteId}))`;
  const latest = await db.websiteRevision.aggregate({
    where: { websiteId },
    _max: { revisionNumber: true },
  });
  const snapshot = await loadDraftSnapshot(websiteId, db);
  return db.websiteRevision.create({
    data: {
      websiteId,
      revisionNumber: (latest._max.revisionNumber ?? 0) + 1,
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
  await Promise.all([
    assertOwnedForm(adminId, payload.primaryBookingFormId, "booking"),
    assertOwnedForm(adminId, payload.primaryEstimateFormId, "estimate"),
  ]);

  return prisma.$transaction((tx: any) =>
    WebsiteProvisioningService.createWebsiteForAdminTx(tx, adminId, payload, createdByUserId),
  );
};

const createWebsite = async (payload: WebsiteCreateInput, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  return createWebsiteForAdmin(adminId, payload, user.id);
};

const getWebsite = async (user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await getWebsiteOrThrow(adminId);
  return loadWebsiteDetails(website.id);
};

const updateWebsite = async (payload: WebsiteUpdateInput, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const current = await getWebsiteOrThrow(adminId);

  await Promise.all([
    assertOwnedForm(adminId, payload.primaryBookingFormId, "booking"),
    assertOwnedForm(adminId, payload.primaryEstimateFormId, "estimate"),
  ]);
  const data = prepareWebsitePatch(payload, current);

  return prisma.$transaction(async (tx: any) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${current.id}))`;
    await ensurePublishedSnapshotBeforeDraftMutationTx(tx, current.id);
    await tx.businessWebsite.update({ where: { id: current.id }, data });
    await createRevisionSnapshot(tx, current.id, user.id, "Website settings updated");
    return loadWebsiteDetails(current.id, tx);
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
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${website.id}))`;
    await ensurePublishedSnapshotBeforeDraftMutationTx(tx, website.id);
    const updated = await tx.websitePage.update({ where: { id: pageId }, data: payload as any });
    await createRevisionSnapshot(tx, website.id, user.id, `Page updated: ${pageId}`);
    return updated;
  });
};

const saveDraft = async (payload: WebsiteDraftSaveInput, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const current = await getWebsiteOrThrow(adminId);
  const websitePatch = payload.website ?? {};

  await Promise.all([
    assertOwnedForm(adminId, websitePatch.primaryBookingFormId, "booking"),
    assertOwnedForm(adminId, websitePatch.primaryEstimateFormId, "estimate"),
  ]);

  const uniquePageIds = [...new Set((payload.pages ?? []).map((page) => page.id))];
  if (uniquePageIds.length !== (payload.pages ?? []).length) {
    throw new AppError(status.BAD_REQUEST, "A website page can only be updated once per draft save");
  }

  return prisma.$transaction(async (tx: any) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${current.id}))`;
    await ensurePublishedSnapshotBeforeDraftMutationTx(tx, current.id);

    if (uniquePageIds.length) {
      const ownedPages = await tx.websitePage.findMany({
        where: { websiteId: current.id, id: { in: uniquePageIds } },
        select: { id: true },
      });
      if (ownedPages.length !== uniquePageIds.length) {
        throw new AppError(status.NOT_FOUND, "One or more website pages do not belong to this business");
      }
    }

    if (Object.keys(websitePatch).length) {
      const data = prepareWebsitePatch(websitePatch, current);
      await tx.businessWebsite.update({ where: { id: current.id }, data });
    }

    for (const page of payload.pages ?? []) {
      const { id, ...data } = page;
      await tx.websitePage.update({ where: { id }, data: data as any });
    }

    await createRevisionSnapshot(tx, current.id, user.id, "Draft saved");
    return loadWebsiteDetails(current.id, tx);
  });
};

const publishWebsite = async (user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const current = await getWebsiteOrThrow(adminId);

  const website = await prisma.$transaction(async (tx: any) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${current.id}))`;
    const draft = await loadDraftSnapshot(current.id, tx);
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

    const revision = await createRevisionSnapshot(tx, current.id, user.id, "Website published");
    const publishedSnapshot = buildPublishedSnapshot(draft);
    await tx.businessWebsite.update({
      where: { id: current.id },
      data: {
        status: "PUBLISHED",
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
