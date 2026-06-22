// ─── Create admin account (super-admin dedicated endpoint) ────────────────────
// Drop-in replacement for the existing createAdminAccount function in
// src/modules/SuperAdmin/superAdmin.service.ts
//
// Changes vs the original:
//   1. Accepts `sendWelcomeEmail` flag (defaults true).
//   2. After the account is fully created and the admin profile exists,
//      fires a fire-and-forget welcome email via sendEmailSafely so that
//      a flaky SMTP server cannot roll back a successful DB write.
//   3. Sets needPasswordChange = true so the admin is prompted to pick a
//      new password on first login.
//
// Everything else (duplicate-check, auth.api.signUpEmail, role/status patch,
// adminProfile creation, rollback on failure) is unchanged.

import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { AccountStatus, UserRole } from "../../generated/prisma/enums";
import { prisma } from "../../lib/prisma/prisma";
import { sendEmailSafely } from "../../lib/utils/sendEmailSafely";
import { auth } from "../../lib/auth";
import { adminService } from "../Admin/admin.service";
import { FRONTEND_URL } from "../../config/ENV";

export const createAdminAccount = async (payload: {
    name: string;
    email: string;
    password: string;
    businessName: string;
    /** When true (default), fire-and-forget a welcome email with credentials. */
    sendWelcomeEmail?: boolean;
}) => {
    const {
        name,
        email,
        password,
        businessName,
        sendWelcomeEmail = true,
    } = payload;

    // ── 1. Guard: duplicate email ──────────────────────────────────────────────
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
        throw new AppError(
            status.CONFLICT,
            `An account with email ${email} already exists.`,
        );
    }

    // ── 2. Create the auth record via better-auth ──────────────────────────────
    // This hashes the password and inserts a row in `user` + `account`.
    // The account starts PENDING / emailVerified=false — we fix that next.
    const data = await auth.api
        .signUpEmail({ body: { name, email, password } })
        .catch((err) => {
            if (err?.body?.code === "USER_ALREADY_EXISTS") {
                throw new AppError(status.CONFLICT, "User already exists.");
            }
            throw err;
        });

    if (!data.user?.id) {
        throw new AppError(status.BAD_REQUEST, "Failed to register user.");
    }

    // ── 3. Elevate to ADMIN, mark email verified, flag password change ─────────
    try {
        const user = await prisma.user.update({
            where: { id: data.user.id },
            data: {
                role: UserRole.ADMIN,
                status: AccountStatus.ACTIVE,
                emailVerified: true,
                // Prompt the admin to set their own password on first login.
                needPasswordChange: true,
            },
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                status: true,
                createdAt: true,
            },
        });

        // ── 4. Create the AdminProfile record ─────────────────────────────────
        const admin = await adminService.createAdmin({
            userId: data.user.id,
            businessName,
        });

        // ── 5. Welcome email (fire-and-forget) ────────────────────────────────
        // We do NOT await this — a failed SMTP call must not roll back a
        // successful account creation. sendEmailSafely already logs the error.
        if (sendWelcomeEmail) {
            const loginUrl = FRONTEND_URL
                ? `${FRONTEND_URL}/login`
                : "https://app.opygen.com/login";

            sendEmailSafely({
                to: email,
                subject: "Your Opygen CleanCRM admin account is ready",
                templateName: "admin-created",
                templateData: {
                    name,
                    email,
                    password, // plaintext — admin should change on first login
                    businessName,
                    loginUrl,
                },
            });
        }

        return { ...user, admin };
    } catch (error) {
        // ── Rollback: remove the auth record so the email is not permanently
        //    claimed by an orphaned/broken account.
        await prisma.user.delete({ where: { id: data.user.id } }).catch(() => {
            // Best-effort — log but don't surface a secondary error.
        });

        throw new AppError(
            status.INTERNAL_SERVER_ERROR,
            "Registration failed. Please try again.",
        );
    }
};
