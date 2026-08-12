import { Router } from "express";
import { paymentController } from "./payment.controller";
import { paymentValidation } from "./payment.validation";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
  ValidationProperty,
  zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { multerMemory } from "../../config/multerMemory";
import { convertHeicToPng } from "../../middlewares/convertHeicToPngMiddleware";

const router = Router();

// POST /payment — record a standalone manual payment
router.post(
  "/",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  zodValidate(paymentValidation.createPayment, ValidationProperty.BODY),
  paymentController.createPayment,
);

// GET /payment — list all payments with filters
router.get(
  "/",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  paymentController.getAllPayments,
);

// GET /payment/:id — single payment
router.get(
  "/:id",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  paymentController.getPaymentById,
);

// PATCH /payment/:id — update payment fields
router.patch(
  "/:id",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  zodValidate(paymentValidation.updatePayment, ValidationProperty.BODY),
  paymentController.updatePayment,
);

// DELETE /payment/:id
router.delete(
  "/:id",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  paymentController.deletePayment,
);

// PATCH /payment/:id/receipt — upload receipt image
// convertHeicToPng runs after multer so the buffer is already in memory;
// it converts HEIC/HEIF → PNG before Cloudinary upload.
router.patch(
  "/:id/receipt",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  multerMemory.single("receipt"),
  convertHeicToPng,
  paymentController.uploadReceipt,
);

export const paymentRoutes = router;
