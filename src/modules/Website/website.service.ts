import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { prisma } from "../../lib/prisma/prisma";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import type {
  WebsiteAssetCreateInput,
  WebsiteCreateInput,
  WebsitePageUpdateInput,
  WebsiteUpdateInput,
} from "./website.interface";
import { assertSafeHttpsUrl } from "./websiteIdentity";
import { TemplateRegistry } from "./templateRegistry";
import { WebsiteProvisioningService } from "./websiteProvisioning.service";

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

const loadSnapshot = async (websiteId: string, db: any) => {
  const website = await db.businessWebsite.findUnique({
    where: { id: websiteId },
    include: {
      pages: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      domains: { orderBy: { createdAt: "asc" } },
      assets: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!website) throw new AppError(status.NOT_FOUND, "Business website not found");
  return website;
};

const createRevisionSnapshot = async (
  db: any,
  websiteId: string,
  createdByUserId: string | null,
  reason: string,
) => {
  // Serializes revision numbering across concurrent writers, including when
  // multiple API instances are running against the same PostgreSQL database.
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${websiteId}))`;
  const latest = await db.websiteRevision.aggregate({
    where: { websiteId },
    _max: { revisionNumber: true },
  });
  const snapshot = await loadSnapshot(websiteId, db);
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
    WebsiteProvisioningService.createWebsiteForAdminTx(
      tx,
      adminId,
      payload,
      createdByUserId,
    ),
  );
};

const createWebsite = async (payload: WebsiteCreateInput, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  return createWebsiteForAdmin(adminId, payload, user.id);
};

const getWebsite = async (user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await getWebsiteOrThrow(adminId);
  return prisma.businessWebsite.findUnique({
    where: { id: website.id },
    include: {
      pages: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      domains: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
      assets: { orderBy: { createdAt: "desc" } },
      primaryBookingForm: { select: { id: true, slug: true, published: true, headline: true } },
      primaryEstimateForm: { select: { id: true, slug: true, published: true, headline: true } },
    },
  });
};

const updateWebsite = async (payload: WebsiteUpdateInput, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const current = await getWebsiteOrThrow(adminId);

  await Promise.all([
    assertOwnedForm(adminId, payload.primaryBookingFormId, "booking"),
    assertOwnedForm(adminId, payload.primaryEstimateFormId, "estimate"),
  ]);

  let templatePatch: Record<string, unknown> = {};
  if (payload.templateId !== undefined || payload.templateVersion !== undefined) {
    const template = TemplateRegistry.requireTemplate(
      payload.templateId ?? current.templateId,
      payload.templateVersion ?? (payload.templateId ? undefined : current.templateVersion),
    );
    templatePatch = { templateId: template.id, templateVersion: template.version, schemaVersion: template.schemaVersion };
  }

  const { templateId: _templateId, templateVersion: _templateVersion, ...rest } = payload;
  const data = {
    ...rest,
    ...templatePatch,
    ...(payload.logo !== undefined ? { logo: assertSafeHttpsUrl(payload.logo, "Logo URL") } : {}),
    ...(payload.favicon !== undefined ? { favicon: assertSafeHttpsUrl(payload.favicon, "Favicon URL") } : {}),
    ...(payload.socialImageUrl !== undefined ? { socialImageUrl: assertSafeHttpsUrl(payload.socialImageUrl, "Social image URL") } : {}),
  };

  return prisma.$transaction(async (tx: any) => {
    await tx.businessWebsite.update({ where: { id: current.id }, data });
    await createRevisionSnapshot(tx, current.id, user.id, "Website settings updated");
    return loadSnapshot(current.id, tx);
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
  const page = await prisma.websitePage.findFirst({ where: { id: pageId, websiteId: website.id }, select: { id: true } });
  if (!page) throw new AppError(status.NOT_FOUND, "Website page not found");

  return prisma.$transaction(async (tx: any) => {
    const updated = await tx.websitePage.update({ where: { id: pageId }, data: payload as any });
    await createRevisionSnapshot(tx, website.id, user.id, `Page updated: ${pageId}`);
    return updated;
  });
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
  const asset = await prisma.websiteAsset.findFirst({ where: { id: assetId, websiteId: website.id }, select: { id: true } });
  if (!asset) throw new AppError(status.NOT_FOUND, "Website asset not found");
  await prisma.websiteAsset.delete({ where: { id: assetId } });
  return { id: assetId, deleted: true };
};

export const WebsiteService = {
  createWebsite,
  createWebsiteForAdmin,
  getWebsite,
  updateWebsite,
  listPages,
  updatePage,
  listRevisions,
  getRevision,
  listAssets,
  registerAsset,
  deleteAsset,
};
