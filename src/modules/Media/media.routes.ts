import { Router } from "express";
import { UserRole } from "../../generated/prisma/enums";
import { checkAuth } from "../../middlewares/checkAuth";
import { zodValidate, ValidationProperty } from "../../middlewares/validations/zodValidation.middleware";
import { mediaController } from "./media.controller";
import { mediaUpload } from "./mediaUpload.middleware";
import { mediaValidation } from "./media.validation";

const router = Router();
router.use(checkAuth(UserRole.ADMIN, UserRole.STAFF));

router.post("/uploads/initiate", zodValidate(mediaValidation.initiateUpload, ValidationProperty.BODY), mediaController.initiateUpload);
router.post("/uploads/:uploadId/complete", zodValidate(mediaValidation.uploadParams, ValidationProperty.PARAMS), mediaController.finalizeUpload);
router.post("/upload", mediaUpload.single("file"), zodValidate(mediaValidation.serverUploadFields, ValidationProperty.BODY), mediaController.uploadFromServer);
router.get("/health", checkAuth(UserRole.ADMIN), mediaController.storageHealth);
router.get("/:assetId/download-url", zodValidate(mediaValidation.assetParams, ValidationProperty.PARAMS), mediaController.getDownloadUrl);
router.get("/:assetId", zodValidate(mediaValidation.assetParams, ValidationProperty.PARAMS), mediaController.getAsset);
router.delete("/:assetId", zodValidate(mediaValidation.assetParams, ValidationProperty.PARAMS), mediaController.deleteAsset);

export const mediaRoutes = router;
