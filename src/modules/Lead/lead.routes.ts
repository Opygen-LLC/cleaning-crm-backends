import { Router } from "express";
import { leadValidation } from "./lead.validation";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { leadController } from "./lead.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";

const router = Router();

// Create a lead
router.post(
    "/",
    checkAuth(UserRole.ADMIN),
    zodValidate(leadValidation.createLead, ValidationProperty.BODY),
    leadController.createLead,
);

// Get all leads for the authenticated admin
router.get("/", checkAuth(UserRole.ADMIN), leadController.getLeads);

// Get single lead by id
router.get("/:id", checkAuth(UserRole.ADMIN), leadController.getLeadById);

// Update lead fields
router.patch(
    "/:id",
    checkAuth(UserRole.ADMIN),
    zodValidate(leadValidation.updateLead, ValidationProperty.BODY),
    leadController.updateLead,
);

// Update lead stage only
router.patch(
    "/:id/stage",
    checkAuth(UserRole.ADMIN),
    zodValidate(leadValidation.updateLeadStage, ValidationProperty.BODY),
    leadController.updateLeadStage,
);

// Convert a Won lead into a Client record.
// The lead is deleted after conversion; the response includes the new clientId
// so the frontend can redirect to /admin/dashboard/clients/:clientId.
router.post(
    "/:id/convert-to-client",
    checkAuth(UserRole.ADMIN),
    leadController.convertLeadToClient,
);

// Delete a lead
router.delete("/:id", checkAuth(UserRole.ADMIN), leadController.deleteLead);

export const leadRoutes = router;
