import { Router } from "express";
import { quoteController } from "./quote.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { quoteValidation } from "./quote.validation";

const router = Router();

// ── Public routes (no auth) ───────────────────────────────────────────────────
// Must be declared before the /:id routes to avoid collision

router.get("/public/:ref", quoteController.getPublicQuote);

router.post(
    "/public/:ref/action",
    zodValidate(quoteValidation.publicQuoteAction, ValidationProperty.BODY),
    quoteController.publicQuoteAction,
);

// ── Quote Templates ───────────────────────────────────────────────────────────

router.get(
    "/templates",
    checkAuth(UserRole.ADMIN),
    quoteController.getAllQuoteTemplates,
);

router.post(
    "/templates",
    checkAuth(UserRole.ADMIN),
    zodValidate(quoteValidation.createTemplate, ValidationProperty.BODY),
    quoteController.createQuoteTemplate,
);

router.patch(
    "/templates/:id",
    checkAuth(UserRole.ADMIN),
    zodValidate(quoteValidation.updateTemplate, ValidationProperty.BODY),
    quoteController.updateQuoteTemplate,
);

router.delete(
    "/templates/:id",
    checkAuth(UserRole.ADMIN),
    quoteController.deleteQuoteTemplate,
);

// ── CRUD ──────────────────────────────────────────────────────────────────────

router.post(
    "/",
    checkAuth(UserRole.ADMIN),
    zodValidate(quoteValidation.createQuote, ValidationProperty.BODY),
    quoteController.createQuote,
);

router.get("/", checkAuth(UserRole.ADMIN), quoteController.getAllQuotes);

router.get("/:id", checkAuth(UserRole.ADMIN), quoteController.getQuoteById);

router.patch(
    "/:id",
    checkAuth(UserRole.ADMIN),
    zodValidate(quoteValidation.updateQuote, ValidationProperty.BODY),
    quoteController.updateQuote,
);

router.patch(
    "/:id/status",
    checkAuth(UserRole.ADMIN),
    zodValidate(quoteValidation.updateStatus, ValidationProperty.BODY),
    quoteController.updateQuoteStatus,
);

router.delete("/:id", checkAuth(UserRole.ADMIN), quoteController.deleteQuote);

// ── Send email ────────────────────────────────────────────────────────────────

router.post(
    "/:id/send-email",
    checkAuth(UserRole.ADMIN),
    quoteController.sendQuoteEmail,
);

// ── Convert to Booking ────────────────────────────────────────────────────────

router.post(
    "/:id/convert-to-booking",
    checkAuth(UserRole.ADMIN),
    zodValidate(quoteValidation.convertToBooking, ValidationProperty.BODY),
    quoteController.convertQuoteToBooking,
);

export const quoteRoutes = router;
