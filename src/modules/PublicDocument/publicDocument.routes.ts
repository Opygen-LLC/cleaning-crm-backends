import { Router } from "express";
import {
  publicReadRateLimit,
  publicSensitiveNoStore,
} from "../../middlewares/publicApiSecurity";
import { publicDocumentController } from "./publicDocument.controller";

const router = Router();

router.get(
  "/:token/website/:websiteId",
  publicSensitiveNoStore,
  publicReadRateLimit,
  publicDocumentController.resolveForWebsite,
);

export const publicDocumentRoutes = router;
