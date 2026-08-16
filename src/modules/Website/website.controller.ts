import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { DomainService } from "./domain.service";
import { PublicWebsiteService } from "./publicWebsite.service";
import { TemplateRegistry } from "./templateRegistry";
import { WebsiteService } from "./website.service";

const created = (res: any, message: string, data: unknown) => sendResponse(res, { httpStatusCode: status.CREATED, success: true, message, data });
const ok = (res: any, message: string, data: unknown) => sendResponse(res, { httpStatusCode: status.OK, success: true, message, data });

const createWebsite = catchAsync(async (req, res) => created(res, "Website created successfully", await WebsiteService.createWebsite(req.body, req.user)));
const getWebsite = catchAsync(async (req, res) => ok(res, "Website retrieved successfully", await WebsiteService.getWebsite(req.user)));
const updateWebsite = catchAsync(async (req, res) => ok(res, "Website updated successfully", await WebsiteService.updateWebsite(req.body, req.user)));
const saveDraft = catchAsync(async (req, res) => ok(res, "Website draft saved successfully", await WebsiteService.saveDraft(req.body, req.user)));
const publishWebsite = catchAsync(async (req, res) => ok(res, "Website published successfully", await WebsiteService.publishWebsite(req.user)));
const previewWebsite = catchAsync(async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  return ok(res, "Website preview retrieved successfully", await PublicWebsiteService.getPreviewWebsite(req.user));
});
const listPages = catchAsync(async (req, res) => ok(res, "Website pages retrieved successfully", await WebsiteService.listPages(req.user)));
const updatePage = catchAsync(async (req, res) => ok(res, "Website page updated successfully", await WebsiteService.updatePage(req.params.pageId, req.body, req.user)));
const listRevisions = catchAsync(async (req, res) => ok(res, "Website revisions retrieved successfully", await WebsiteService.listRevisions(req.user)));
const getRevision = catchAsync(async (req, res) => ok(res, "Website revision retrieved successfully", await WebsiteService.getRevision(req.params.revisionId, req.user)));
const listAssets = catchAsync(async (req, res) => ok(res, "Website assets retrieved successfully", await WebsiteService.listAssets(req.user)));
const registerAsset = catchAsync(async (req, res) => created(res, "Website asset registered successfully", await WebsiteService.registerAsset(req.body, req.user)));
const deleteAsset = catchAsync(async (req, res) => ok(res, "Website asset deleted successfully", await WebsiteService.deleteAsset(req.params.assetId, req.user)));
const listTemplates = catchAsync(async (_req, res) => ok(res, "Website templates retrieved successfully", TemplateRegistry.list()));
const addDomain = catchAsync(async (req, res) => created(res, "Website domain added successfully", await DomainService.addDomain(req.body, req.user)));
const listDomains = catchAsync(async (req, res) => ok(res, "Website domains retrieved successfully", await DomainService.listDomains(req.user)));
const removeDomain = catchAsync(async (req, res) => ok(res, "Website domain removed successfully", await DomainService.removeDomain(req.params.domainId, req.user)));
const setPrimaryDomain = catchAsync(async (req, res) => ok(res, "Primary website domain updated successfully", await DomainService.setPrimaryDomain(req.params.domainId, req.user)));
const getPublicWebsite = catchAsync(async (req, res) => {
  const data = await PublicWebsiteService.getPublicWebsite(req.params.identifier);
  res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
  return ok(res, "Public website retrieved successfully", data);
});

export const websiteController = {
  createWebsite,
  getWebsite,
  updateWebsite,
  saveDraft,
  publishWebsite,
  previewWebsite,
  listPages,
  updatePage,
  listRevisions,
  getRevision,
  listAssets,
  registerAsset,
  deleteAsset,
  listTemplates,
  addDomain,
  listDomains,
  removeDomain,
  setPrimaryDomain,
  getPublicWebsite,
};
