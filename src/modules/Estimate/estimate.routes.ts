import { Router } from "express";
import { estimateController } from "./estimate.controller";
import { downloadEstimatePDF } from "./estimate.pdf.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { checkAuthOrPortalClient } from "../../middlewares/checkPortalAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { estimateValidation } from "./estimate.validation";

const router = Router();

// ── CRUD ──────────────────────────────────────────────────────────────────────

router.post(
    "/",
    checkAuth(UserRole.ADMIN),
    zodValidate(estimateValidation.createEstimate, ValidationProperty.BODY),
    estimateController.createEstimate,
);

router.get("/", checkAuth(UserRole.ADMIN), estimateController.getAllEstimates);

router.get(
    "/:id",
    checkAuth(UserRole.ADMIN),
    estimateController.getEstimateById,
);

// ── PDF download (admin/staff session OR client portal token) ────────────────
router.get(
    "/:id/pdf",
    checkAuthOrPortalClient(UserRole.ADMIN),
    downloadEstimatePDF,
);

router.patch(
    "/:id",
    checkAuth(UserRole.ADMIN),
    zodValidate(estimateValidation.updateEstimate, ValidationProperty.BODY),
    estimateController.updateEstimate,
);

router.patch(
    "/:id/status",
    checkAuth(UserRole.ADMIN),
    zodValidate(estimateValidation.updateStatus, ValidationProperty.BODY),
    estimateController.updateEstimateStatus,
);

router.delete(
    "/:id",
    checkAuth(UserRole.ADMIN),
    estimateController.deleteEstimate,
);

// Canonical tenant-owned client share lifecycle.
router.post(
    "/:id/share",
    checkAuth(UserRole.ADMIN),
    estimateController.shareEstimate,
);

router.post(
    "/:id/send-email",
    checkAuth(UserRole.ADMIN),
    estimateController.sendEstimateEmail,
);

// ── Convert to Booking ────────────────────────────────────────────────────────

router.post(
    "/:id/convert-to-booking",
    checkAuth(UserRole.ADMIN),
    zodValidate(estimateValidation.convertToBooking, ValidationProperty.BODY),
    estimateController.convertEstimateToBooking,
);

// ── Convert to Quote ──────────────────────────────────────────────────────────

router.post(
    "/:id/convert-to-quote",
    checkAuth(UserRole.ADMIN),
    zodValidate(estimateValidation.convertToQuote, ValidationProperty.BODY),
    estimateController.convertEstimateToQuote,
);

export const estimateRoutes = router;
