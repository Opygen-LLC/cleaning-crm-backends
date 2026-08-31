import { Router } from "express";
import { leadValidation } from "./lead.validation";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { leadController } from "./lead.controller";
import { leadActivityController } from "./leadActivity.controller";
import { leadActivityValidation } from "./leadActivity.validation";
import { checkAuth } from "../../middlewares/checkAuth";
import { checkFeature } from "../../middlewares/checkSubscription";
import { UserRole } from "../../generated/prisma/enums";

const router = Router();

// "leads pipeline" is the single feature flag seeded on GROWTH+ plans —
// see seedSubscriptionPlan.ts. Matches GATES.leadsPipeline on the frontend.
const isAdmin = checkAuth(UserRole.ADMIN);
const hasLeadsPipeline = checkFeature("leads pipeline");

// Create a lead
router.post(
    "/",
    isAdmin,
    hasLeadsPipeline,
    zodValidate(leadValidation.createLead, ValidationProperty.BODY),
    leadController.createLead,
);

// Get all leads for the authenticated admin
router.get("/", isAdmin, hasLeadsPipeline, leadController.getLeads);

// Get single lead by id
router.get("/:id", isAdmin, hasLeadsPipeline, leadController.getLeadById);


// Lead follow-up/activity timeline. These routes stay inside the existing Lead
// module so the CRM has one source of truth rather than a parallel follow-up app.
router.get(
    "/:id/activities",
    isAdmin,
    hasLeadsPipeline,
    leadActivityController.getActivities,
);
router.post(
    "/:id/activities",
    isAdmin,
    hasLeadsPipeline,
    zodValidate(leadActivityValidation.create, ValidationProperty.BODY),
    leadActivityController.createActivity,
);
router.patch(
    "/:id/activities/:activityId",
    isAdmin,
    hasLeadsPipeline,
    zodValidate(leadActivityValidation.update, ValidationProperty.BODY),
    leadActivityController.updateActivity,
);
router.delete(
    "/:id/activities/:activityId",
    isAdmin,
    hasLeadsPipeline,
    leadActivityController.deleteActivity,
);

// Update lead fields
router.patch(
    "/:id",
    isAdmin,
    hasLeadsPipeline,
    zodValidate(leadValidation.updateLead, ValidationProperty.BODY),
    leadController.updateLead,
);

// Update lead stage only
router.patch(
    "/:id/stage",
    isAdmin,
    hasLeadsPipeline,
    zodValidate(leadValidation.updateLeadStage, ValidationProperty.BODY),
    leadController.updateLeadStage,
);

// Convert a Won lead into a Client record.
// The lead is retained after conversion with convertedClientId/convertedAt and
// its complete activity history; the response includes the linked clientId.
router.post(
    "/:id/convert-to-client",
    isAdmin,
    hasLeadsPipeline,
    leadController.convertLeadToClient,
);

// Delete a lead
router.delete("/:id", isAdmin, hasLeadsPipeline, leadController.deleteLead);

export const leadRoutes = router;
