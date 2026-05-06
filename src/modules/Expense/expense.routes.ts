import { Router } from "express";
import { expenseController } from "./expense.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
  ValidationProperty,
  zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { expenseValidation } from "./expense.validation";

const router = Router();

router.post(
  "/",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  zodValidate(expenseValidation.createExpense, ValidationProperty.BODY),
  expenseController.createExpense,
);

router.get(
  "/",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.STAFF),
  expenseController.getAllExpenses,
);

router.get(
  "/statistics",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  expenseController.getExpenseStats,
);

router.get(
  "/spend-analysis",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  expenseController.getExpenseSpendAnalysis,
);

router.get(
  "/:id",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.STAFF),
  expenseController.getExpenseById,
);

router.patch(
  "/:id",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  zodValidate(expenseValidation.updateExpense, ValidationProperty.BODY),
  expenseController.updateExpense,
);

router.delete(
  "/:id",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  expenseController.deleteExpense,
);

export const expenseRoutes = router;
