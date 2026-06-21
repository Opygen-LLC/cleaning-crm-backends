import { betterAuth } from "better-auth";
import { BETTER_AUTH_SECRET, BETTER_AUTH_URL, COOKIE_DOMAIN } from "../config/ENV";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./prisma/prisma";
import { AccountStatus, UserRole } from "../generated/prisma/enums";
import { bearer, emailOTP } from "better-auth/plugins";
import chalk from "chalk";
import { sendEmail } from "./email";
import { waitUntil } from "@vercel/functions";
import { sendEmailSafely } from "./utils/sendEmailSafely";

export const auth = betterAuth({
    baseURL: BETTER_AUTH_URL,
    secret: BETTER_AUTH_SECRET,
    database: prismaAdapter(prisma, {
        provider: "postgresql",
    }),
    // ─── Cross-subdomain cookies ───────────────────────────────────────────
    // The API runs on api.faysaldev.com and the frontend on app.faysaldev.com.
    // Without this, better-auth's own session cookie is host-only (scoped to
    // api.faysaldev.com) and never reaches the Next.js middleware running on
    // app.faysaldev.com, which makes it look like login "does nothing" even
    // though the request succeeded. COOKIE_DOMAIN should be the shared parent
    // domain with a leading dot, e.g. ".faysaldev.com". Left undefined in
    // local dev (localhost) where a domain attribute breaks cookies.
    advanced: COOKIE_DOMAIN
        ? {
              crossSubDomainCookies: {
                  enabled: true,
                  domain: COOKIE_DOMAIN,
              },
              defaultCookieAttributes: {
                  sameSite: "none",
                  secure: true,
              },
          }
        : undefined,
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
        sendOnSignUp: true,
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
                        console.log(
                            chalk.green(
                                `Skipping sending verification OTP.`,
                            ),
                        );
                        return;
                    }

                    if (user && !user.emailVerified) {
                        waitUntil(
                            sendEmailSafely({
                                to: email,
                                subject: "Verify your email",
                                templateName: "otp",
                                templateData: {
                                    name: user.name,
                                    otp,
                                },
                            }),
                        );
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
