/**
 * invoice.routes.ts  (updated — diff: added GET /:id/pdf route)
 *
 * One new line added: the GET /:id/pdf endpoint that streams a PDFKit-
 * generated invoice PDF.  Everything else is unchanged from the original.
 */

import { Router } from "express";
import { invoiceController } from "./invoice.controller";
import { downloadInvoicePDF } from "./invoice.pdf.controller"; // ← NEW
import { checkAuth } from "../../middlewares/checkAuth";
import { checkAuthOrPortalClient } from "../../middlewares/checkPortalAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { invoiceValidation } from "./invoice.validation";
import { multerMemory } from "../../config/multerMemory";
import { convertHeicToPng } from "../../middlewares/convertHeicToPngMiddleware";

const router = Router();

router.get(
    "/payment-history",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    invoiceController.getPaymentHistory,
);

router.post(
    "/",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    zodValidate(invoiceValidation.createInvoice, ValidationProperty.BODY),
    invoiceController.createInvoice,
);

router.get(
    "/",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.STAFF),
    invoiceController.getAllInvoices,
);

// ── NEW: PDF download ────────────────────────────────────────────────────────
// Must be declared BEFORE /:id so the literal segment "pdf" never shadows it.
// (Express matches routes in registration order; /:id would swallow /pdf if
//  it were registered first.)
// Placed here for clarity — it could also sit at the bottom of the file.
// Admin/staff session OR the client's own portalAccessToken (via
// `x-portal-token` header) can download the PDF. Ownership is enforced
// inside downloadInvoicePDF for the portal-token path.
router.get(
    "/:id/pdf",
    checkAuthOrPortalClient(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.STAFF),
    downloadInvoicePDF,
);
// ─────────────────────────────────────────────────────────────────────────────

router.get(
    "/:id",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.STAFF),
    invoiceController.getInvoiceById,
);

router.patch(
    "/:id",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    zodValidate(invoiceValidation.updateInvoice, ValidationProperty.BODY),
    invoiceController.updateInvoice,
);

router.patch(
    "/:id/status",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    zodValidate(invoiceValidation.updateStatus, ValidationProperty.BODY),
    invoiceController.updateInvoiceStatus,
);

router.delete(
    "/:id",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    invoiceController.deleteInvoice,
);

router.post(
    "/:id/record-payment",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    zodValidate(invoiceValidation.recordPayment, ValidationProperty.BODY),
    invoiceController.recordPayment,
);

router.post(
    "/:id/send",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    invoiceController.sendInvoice,
);

// ── Manual bank-transfer proof upload ──────────────────────────────────────────
// Open to the client's own portalAccessToken (client uploads their own bank
// transfer screenshot) as well as admin auth (admin uploads on the client's
// behalf). Ownership is enforced inside invoiceService.submitPaymentProof.
router.post(
    "/:id/payments/:paymentId/proof/uploads/initiate",
    checkAuthOrPortalClient(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    zodValidate(invoiceValidation.paymentProofUploadParams, ValidationProperty.PARAMS),
    zodValidate(invoiceValidation.paymentProofUpload, ValidationProperty.BODY),
    invoiceController.initiatePaymentProofUpload,
);

router.post(
    "/:id/payments/:paymentId/proof/uploads/:uploadId/complete",
    checkAuthOrPortalClient(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    zodValidate(invoiceValidation.paymentProofFinalizeParams, ValidationProperty.PARAMS),
    invoiceController.finalizePaymentProofUpload,
);

router.delete(
    "/:id/payments/:paymentId/proof/uploads/:uploadId",
    checkAuthOrPortalClient(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    zodValidate(invoiceValidation.paymentProofFinalizeParams, ValidationProperty.PARAMS),
    invoiceController.discardPaymentProofUpload,
);

router.post(
    "/:id/payments/:paymentId/proof",
    checkAuthOrPortalClient(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    multerMemory.single("proof"),
    convertHeicToPng,
    invoiceController.submitPaymentProof,
);

// ── Admin approves or rejects a PENDING_APPROVAL payment ─────────────────────
router.patch(
    "/:id/payments/:paymentId/approve",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    invoiceController.approvePayment,
);

export const invoiceRoutes = router;
