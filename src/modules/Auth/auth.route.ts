import { Router } from "express";
import authController from "./auth.controller";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import authValidator from "./auth.validation";
import { checkAuth } from "../../middlewares/checkAuth";
import { checkAuthSession } from "../../middlewares/checkAuthSession";
import { UserRole } from "../../generated/prisma/enums";
import { sessionController } from "../Session/session.controller";
import {
    loginRateLimit,
    otpRateLimit,
    registrationRateLimit,
    passwordResetRateLimit,
} from "../../middlewares/authRateLimit";

const router = Router();

// Auth responses contain session state/Set-Cookie headers and must never be cached.
router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    next();
});

// Auth Routes
router.post(
    "/register",
    registrationRateLimit,
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

router.get(
    "/session",
    checkAuthSession,
    authController.session,
);

// Canonical session-management surface. The legacy /session/my-session routes
// remain mounted during rollout, but new clients use these auth-scoped paths.
router.get(
    "/sessions",
    checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF),
    sessionController.getMySessions,
);
router.post(
    "/sessions/revoke-others",
    checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF),
    sessionController.revokeOtherSessions,
);
router.delete(
    "/sessions/:id",
    checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF),
    sessionController.deleteMySession,
);

router.post("/refresh-token", authController.getNewToken);
router.post(
    "/verify-email",
    otpRateLimit,
    zodValidate(authValidator.verifyEmailValidation, ValidationProperty.BODY),
    authController.verifyEmail,
);
router.get("/resend-otp", (_req, res) => {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
        success: false,
        code: "METHOD_NOT_ALLOWED",
        message: "Verification codes are resent with a POST request. Use the Resend code button on the verification screen.",
    });
});

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
