// src/middlewares/checkSubscription.ts
//
// ─── Item 8: Subscription enforcement middleware ──────────────────────────────
//
// Apply AFTER checkAuth on all admin-facing routes:
//   /api/v1/admin/*  /api/v1/booking/*  /api/v1/client/*  /api/v1/job/*  etc.
//
// Returns HTTP 402 (Payment Required) if the tenant's subscription is:
//   • SUSPENDED          — manually suspended by super admin
//   • EXPIRED            — billing period ended (set by daily cron, item 10)
//   • PENDING_PAYMENT    — waiting for SA to approve submitted proof
//   • trial ended        — isTrial=true and trialEndsAt < now
//   • period ended       — currentPeriodEnd < now (and not trial)
//
// Super admin routes are NOT affected (they use a separate router).
// ---------------------------------------------------------------------------

import { NextFunction, Request, Response } from "express";
import status from "http-status";
import { UserRole } from "../generated/prisma/enums";
import { prisma } from "../lib/prisma/prisma";
import AppError from "../errorHelper/AppError";

export const checkSubscription = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    // Only enforce for ADMIN role — SUPER_ADMIN and STAFF bypass this check
    if (!req.user || req.user.role !== UserRole.ADMIN) {
      return next();
    }

    // Find the admin profile linked to this user
    const admin = await prisma.adminProfile.findFirst({
      where: { userId: req.user.id },
      select: { id: true },
    });

    if (!admin) {
      // No admin profile = no subscription to check; let other middleware handle it
      return next();
    }

    const sub = await prisma.subscription.findFirst({
      where: { adminId: admin.id },
      select: {
        status: true,
        isTrial: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
      },
    });

    if (!sub) {
      // New account with no subscription yet — allow through so they can register
      return next();
    }

    const now = new Date();

    // Hard-blocked statuses
    if (sub.status === "SUSPENDED") {
      throw new AppError(
        status.PAYMENT_REQUIRED,
        "Your account has been suspended. Please contact support or submit a payment proof.",
      );
    }

    if (sub.status === "EXPIRED") {
      throw new AppError(
        status.PAYMENT_REQUIRED,
        "Your subscription has expired. Please renew to continue using the platform.",
      );
    }

    if (sub.status === "PENDING_PAYMENT") {
      throw new AppError(
        status.PAYMENT_REQUIRED,
        "Your payment proof is under review. Your account will be reactivated once approved.",
      );
    }

    // Trial expiry check (in-band — cron may not have run yet)
    if (sub.isTrial && sub.trialEndsAt && sub.trialEndsAt < now) {
      throw new AppError(
        status.PAYMENT_REQUIRED,
        "Your free trial has ended. Please upgrade to continue.",
      );
    }

    // Billing period expiry check (in-band)
    if (!sub.isTrial && sub.currentPeriodEnd && sub.currentPeriodEnd < now) {
      throw new AppError(
        status.PAYMENT_REQUIRED,
        "Your billing period has ended. Please renew your subscription.",
      );
    }

    next();
  } catch (error) {
    next(error);
  }
};
