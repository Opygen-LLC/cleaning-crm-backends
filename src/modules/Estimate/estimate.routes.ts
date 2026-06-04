import { Router } from "express";
import { estimateController } from "./estimate.controller";
import { checkAuth } from "../../middlewares/checkAuth";
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
