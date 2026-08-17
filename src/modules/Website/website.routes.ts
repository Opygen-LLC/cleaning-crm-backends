import { Router } from "express";
import { UserRole } from "../../generated/prisma/enums";
import { checkAuth } from "../../middlewares/checkAuth";
import { ValidationProperty, zodValidate } from "../../middlewares/validations/zodValidation.middleware";
import { websiteController } from "./website.controller";
import { websiteValidation } from "./website.validation";
import { multerMemory } from "../../config/multerMemory";
import { convertHeicToPng } from "../../middlewares/convertHeicToPngMiddleware";
import { websiteBrandUploadRateLimit } from "./websiteAssetSecurity";
import {
  websiteSubdomainAvailabilityRateLimit,
  websiteSubdomainMutationRateLimit,
} from "./websiteSubdomainSecurity";
import {
  websiteDomainMutationRateLimit,
  websiteDomainVerificationRateLimit,
} from "./websiteDomainSecurity";

const router = Router();
const isAdmin = checkAuth(UserRole.ADMIN);
router.use(isAdmin);

router.post("/", zodValidate(websiteValidation.createWebsite, ValidationProperty.BODY), websiteController.createWebsite);
router.get("/me", websiteController.getWebsite);
router.get("/studio", websiteController.getStudio);
router.get("/booking-setup", websiteController.getWebsiteBookingSetup);
router.put(
  "/booking-setup",
  zodValidate(websiteValidation.configureWebsiteBooking, ValidationProperty.BODY),
  websiteController.configureWebsiteBooking,
);
router.patch("/me", zodValidate(websiteValidation.updateWebsite, ValidationProperty.BODY), websiteController.updateWebsite);
router.put("/draft", zodValidate(websiteValidation.saveDraft, ValidationProperty.BODY), websiteController.saveDraft);
router.post("/publish", zodValidate(websiteValidation.publishWebsite, ValidationProperty.BODY), websiteController.publishWebsite);
router.post("/launch", zodValidate(websiteValidation.publishWebsite, ValidationProperty.BODY), websiteController.launchWebsite);
router.get("/preview", websiteController.previewWebsite);
router.get("/pages", websiteController.listPages);
router.patch("/pages/:pageId", zodValidate(websiteValidation.updatePage, ValidationProperty.BODY), websiteController.updatePage);
router.get("/revisions", websiteController.listRevisions);
router.get("/revisions/:revisionId", websiteController.getRevision);
router.get("/templates", websiteController.listTemplates);
router.get("/analytics", websiteController.getWebsiteAnalytics);
router.get("/assets", websiteController.listAssets);
router.post(
  "/assets/brand/sign",
  websiteBrandUploadRateLimit,
  zodValidate(websiteValidation.brandUploadSignature, ValidationProperty.BODY),
  websiteController.requestBrandUploadSignature,
);
router.post(
  "/assets/brand/finalize",
  websiteBrandUploadRateLimit,
  zodValidate(websiteValidation.brandUploadFinalize, ValidationProperty.BODY),
  websiteController.finalizeBrandUpload,
);
router.post("/assets", zodValidate(websiteValidation.createAsset, ValidationProperty.BODY), websiteController.registerAsset);
router.post("/assets/upload", websiteBrandUploadRateLimit, multerMemory.single("asset"), convertHeicToPng, websiteController.uploadBrandAsset);
router.post("/assets/upload-content", multerMemory.single("asset"), convertHeicToPng, websiteController.uploadContentAsset);
router.delete("/assets/:assetId", websiteController.deleteAsset);
router.get(
  "/subdomain/availability/:subdomain",
  websiteSubdomainAvailabilityRateLimit,
  websiteController.getSubdomainAvailability,
);
router.patch(
  "/subdomain",
  websiteSubdomainMutationRateLimit,
  zodValidate(websiteValidation.renameSubdomain, ValidationProperty.BODY),
  websiteController.renameSubdomain,
);
router.get("/domains", websiteController.listDomains);
router.post("/domains", websiteDomainMutationRateLimit, zodValidate(websiteValidation.addDomain, ValidationProperty.BODY), websiteController.addDomain);
router.post("/domains/:domainId/verify", websiteDomainVerificationRateLimit, websiteController.verifyDomain);
router.patch("/domains/:domainId/primary", websiteDomainMutationRateLimit, websiteController.setPrimaryDomain);
router.delete("/domains/:domainId", websiteDomainMutationRateLimit, websiteController.removeDomain);

export const websiteRoutes = router;
