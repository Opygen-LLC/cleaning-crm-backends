import { Router } from "express";
import { invoiceController } from "./invoice.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
  ValidationProperty,
  zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { invoiceValidation } from "./invoice.validation";

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

export const invoiceRoutes = router;
