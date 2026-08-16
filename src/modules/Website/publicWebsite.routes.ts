import { Router } from "express";
import { publicReadRateLimit } from "../../middlewares/publicApiSecurity";
import { websiteController } from "./website.controller";

const router = Router();
router.get("/:identifier", publicReadRateLimit, websiteController.getPublicWebsite);
export const publicWebsiteRoutes = router;
