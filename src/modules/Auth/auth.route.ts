import { Router } from "express";
import authController from "./auth.controller";

const router = Router();

// Auth Routes
router.post("/register", authController.register);

router.post("/verify-email", authController.verifyEmail);

router.post("/login", authController.login);

router.post("/forgot-password", authController.forgotPassword);

router.post("/reset-password", authController.resetPassword);

router.post("/resend-verification", authController.resendVerification);

router.delete("/delete/:userId", authController.deleteUser);

router.post("/logout", authController.logout);

export default router;
