import { Router } from "express";
import authController from "./auth.controller";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import authValidator from "./auth.validation";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
    loginRateLimit,
    otpRateLimit,
    passwordResetRateLimit,
} from "../../middlewares/authRateLimit";

const router = Router();

// Auth Routes
router.post(
    "/register",
    zodValidate(authValidator.registerValidation, ValidationProperty.BODY),
    authController.register,
);

router.post(
    "/login",
    loginRateLimit,
    zodValidate(authValidator.loginValidation, ValidationProperty.BODY),
    authController.login,
);

router.get(
    "/me",
    checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF),
    authController.me,
);

router.post("/refresh-token", authController.getNewToken);
router.post(
    "/verify-email",
    otpRateLimit,
    zodValidate(authValidator.verifyEmailValidation, ValidationProperty.BODY),
    authController.verifyEmail,
);
router.post(
    "/resend-otp",
    otpRateLimit,
    zodValidate(
        authValidator.forgotPasswordValidation,
        ValidationProperty.BODY,
    ),
    authController.resendOtp,
);
router.post(
    "/forgot-password",
    passwordResetRateLimit,
    zodValidate(
        authValidator.forgotPasswordValidation,
        ValidationProperty.BODY,
    ),
    authController.forgotPassword,
);
router.post(
    "/reset-password",
    passwordResetRateLimit,
    zodValidate(authValidator.resetPasswordValidation, ValidationProperty.BODY),
    authController.resetPassword,
);

router.post(
    "/change-password",
    checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF),
    zodValidate(
        authValidator.changePasswordValidation,
        ValidationProperty.BODY,
    ),
    authController.changePassword,
);

router.post(
    "/logout",
    checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF),
    authController.logout,
);

export default router;
