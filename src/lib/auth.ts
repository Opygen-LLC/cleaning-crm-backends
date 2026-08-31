import { betterAuth } from "better-auth";
import { BETTER_AUTH_SECRET, BETTER_AUTH_URL, NODE_ENV } from "../config/ENV";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./prisma/prisma";
import { AccountStatus, UserRole } from "../generated/prisma/enums";
import { bearer, emailOTP } from "better-auth/plugins";
import { sendEmail } from "./email";
import logger from "./logger";
import { getAuthenticatedOrigins } from "../config/authSecurity";

export const auth = betterAuth({
    baseURL: BETTER_AUTH_URL,
    secret: BETTER_AUTH_SECRET,
    trustedOrigins: getAuthenticatedOrigins(),
    database: prismaAdapter(prisma, {
        provider: "postgresql",
    }),
    // Better Auth/session credentials are intentionally host-only to the API.
    // The frontend creates its own HttpOnly `user_role` route hint after an
    // authenticated response; that hint is never an authorization credential.
    advanced: {
        defaultCookieAttributes: {
            sameSite: "lax",
            secure: NODE_ENV === "production",
            httpOnly: true,
        },
    },
    session: {
        expiresIn: 60 * 60 * 60 * 24, // 60 days in seconds
        updateAge: 60 * 60 * 60 * 24, // 50 days in seconds
        cookieCache: {
            enabled: true,
            maxAge: 60 * 60 * 60 * 24, // 60 days in seconds
        },
    },
    emailAndPassword: {
        enabled: true,
        requireEmailVerification: true,
    },
    emailVerification: {
        // Registration persists the credential user and tenant records in one
        // Prisma transaction, then a durable outbox worker requests the OTP.
        // Better Auth never sends verification mail directly during sign-up or
        // sign-in. Registration, resend, and unverified-login retries all use
        // the durable outbox so SMTP failures are retryable and observable.
        sendOnSignUp: false,
        sendOnSignIn: false,
        autoSignInAfterVerification: true,
    },
    user: {
        additionalFields: {
            role: {
                type: "string",
                required: true,
                defaultValue: UserRole.ADMIN,
            },
            status: {
                type: "string",
                required: true,
                defaultValue: AccountStatus.PENDING,
            },
            needPasswordChange: {
                type: "boolean",
                required: true,
                defaultValue: false,
            },
        },
    },
    plugins: [
        bearer(),
        emailOTP({
            overrideDefaultEmailVerification: true,
            expiresIn: 5 * 60, // 5 minutes in seconds
            otpLength: 6,
            async sendVerificationOTP({ email, otp, type }) {
                if (type === "email-verification") {
                    const user = await prisma.user.findUnique({
                        where: {
                            email,
                        },
                    });

                    if (user && (user.role === UserRole.SUPER_ADMIN || user.role === UserRole.STAFF)) {
                        logger.info("Skipping verification OTP for trusted role");
                        return;
                    }

                    if (user && !user.emailVerified) {
                        // Verification email delivery is executed by the durable
                        // outbox worker. Await SMTP here so delivery errors bubble
                        // back to the worker and the outbox row can retry safely.
                        await sendEmail({
                            to: email,
                            subject: "Verify your email",
                            templateName: "otp",
                            templateData: {
                                name: user.name,
                                otp,
                            },
                        });
                    }
                } else if (type === "forget-password") {
                    const user = await prisma.user.findUnique({
                        where: {
                            email,
                        },
                    });

                    if (user) {
                        // Google Compute Engine has no Vercel request-lifecycle
                        // waitUntil context. Await SMTP here so the API can report
                        // a real delivery failure instead of claiming the reset
                        // code was sent when the background promise was dropped.
                        await sendEmail({
                            to: email,
                            subject: "Password Reset OTP",
                            templateName: "otp",
                            templateData: {
                                name: user.name,
                                otp,
                            },
                        });
                    }
                }
            },
        }),
    ],
});
