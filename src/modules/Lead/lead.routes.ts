import { Router } from "express";
import { leadValidation } from "./lead.validation";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { leadController } from "./lead.controller";
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
// The lead is deleted after conversion; the response includes the new clientId
// so the frontend can redirect to /admin/dashboard/clients/:clientId.
router.post(
    "/:id/convert-to-client",
    isAdmin,
    hasLeadsPipeline,
    leadController.convertLeadToClient,
);

// Delete a lead
router.delete("/:id", isAdmin, hasLeadsPipeline, leadController.deleteLead);

export const leadRoutes = router;
