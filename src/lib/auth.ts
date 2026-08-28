import { betterAuth } from "better-auth";
import { BETTER_AUTH_SECRET, BETTER_AUTH_URL, NODE_ENV } from "../config/ENV";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./prisma/prisma";
import { AccountStatus, UserRole } from "../generated/prisma/enums";
import { bearer, emailOTP } from "better-auth/plugins";
import { sendEmail } from "./email";
import { waitUntil } from "@vercel/functions";
import { sendEmailSafely } from "./utils/sendEmailSafely";
import logger from "./logger";

export const auth = betterAuth({
    baseURL: BETTER_AUTH_URL,
    secret: BETTER_AUTH_SECRET,
    database: prismaAdapter(prisma, {
        provider: "postgresql",
    }),
    // Better Auth session cookies are intentionally host-only to the API.
    // Only the short-lived access/role cookies created by tokenUtils are
    // shared with the frontend parent domain for Next.js route gating.
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
        // Better Auth must therefore never send automatically during sign-up.
        sendOnSignUp: false,
        sendOnSignIn: true,
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
                        waitUntil(
                            sendEmailSafely({
                                to: email,
                                subject: "Password Reset OTP",
                                templateName: "otp",
                                templateData: {
                                    name: user.name,
                                    otp,
                                },
                            }),
                        );
                    }
                }
            },
        }),
    ],
});
