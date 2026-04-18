import { betterAuth } from "better-auth";
import { BETTER_AUTH_SECRET, BETTER_AUTH_URL } from "../config/ENV";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./prisma/prisma";
import { AccountStatus, UserRole } from "../generated/prisma/enums";
import { bearer, emailOTP } from "better-auth/plugins";
import chalk from "chalk";

export const auth = betterAuth({
    baseURL: BETTER_AUTH_URL,
    secret: BETTER_AUTH_SECRET,
    database: prismaAdapter(prisma, {
        provider: "postgresql",
    }),
    session: {
        expiresIn: 60 * 60 * 60 * 24, // 1 day in seconds
        updateAge: 60 * 60 * 60 * 24, // 1 day in seconds
        cookieCache: {
            enabled: true,
            maxAge: 60 * 60 * 60 * 24, // 1 day in seconds
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
            mobileNumber: {
                type: "string",
                required: false,
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

                    if (user && user.role === UserRole.SUPER_ADMIN) {
                        console.log(
                            chalk.green(
                                `User with email ${email} is a admin. Skipping sending verification OTP.`,
                            ),
                        );
                        return;
                    }

                    if (user && !user.emailVerified) {
                    }
                } else if (type === "forget-password") {
                    const user = await prisma.user.findUnique({
                        where: {
                            email,
                        },
                    });

                    if (user) {}
                }
            },
        }),
    ],
});
