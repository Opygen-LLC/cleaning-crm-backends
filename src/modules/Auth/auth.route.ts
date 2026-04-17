import { Router } from "express";
import authController from "./auth.controller";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import authValidator from "./auth.validation";

const router = Router();

// Auth Routes
router.post(
    "/register",
    zodValidate(authValidator.registerValidation, ValidationProperty.BODY),
    authController.register,
);

router.post(
    "/login",
    zodValidate(authValidator.loginValidation, ValidationProperty.BODY),
    authController.login,
);

// router.post("/verify-email", authController.verifyEmail);

// router.post("/forgot-password", authController.forgotPassword);

// router.post("/reset-password", authController.resetPassword);

// router.post("/resend-verification", authController.resendVerification);

// router.delete("/delete/:userId", authController.deleteUser);

// router.post("/logout", authController.logout);

export default router;
