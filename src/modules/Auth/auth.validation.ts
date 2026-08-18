import z from "zod";

const registerValidation = z
    .object({
        businessName: z
            .string()
            .min(2, "Business name must be at least 2 characters")
            .max(100, "Business name is too long")
            .trim(),
        name: z
            .string()
            .min(2, "Name must be at least 2 characters")
            .max(50, "Name is too long")
            .trim(),
        email: z.string().email("Invalid email address").toLowerCase(),
        password: z
            .string()
            .min(8, "Password must be at least 8 characters")
            .max(100)
            .regex(/[A-Z]/, "Must include at least one uppercase letter")
            .regex(/[a-z]/, "Must include at least one lowercase letter")
            .regex(/[0-9]/, "Must include at least one number")
            .regex(
                /[^A-Za-z0-9]/,
                "Must include at least one special character",
            ),
        // ── Optional fields from the 2-step wizard ────────────────────────────
        mobileNumber: z
            .string()
            .min(7, "Enter a valid phone number")
            .max(20, "Phone number is too long")
            .optional(),
        businessType: z
            .enum(["residential", "commercial", "both"])
            .optional(),
        licenseNumber: z
            .string()
            .max(60, "License / Trade ID is too long")
            .optional(),
    });
    // NOTE: .strict() intentionally removed so the optional wizard fields
    // are accepted without breaking existing integrations.

const loginValidation = z
    .object({
        email: z.string().email("Invalid email address").toLowerCase(),
        password: z
            .string()
            .min(8, "Password must be at least 8 characters")
            .max(100),
    })
    .strict();

const verifyEmailValidation = z
    .object({
        email: z.string().email("Invalid email address").toLowerCase(),
        otp: z.string().length(6, "OTP must be 6 characters"),
    })
    .strict();

const forgotPasswordValidation = z
    .object({
        email: z.string().email("Invalid email address").toLowerCase(),
    })
    .strict();

const resetPasswordValidation = z
    .object({
        email: z.string().email("Invalid email address").toLowerCase(),
        otp: z.string().length(6, "OTP must be 6 characters"),
        newPassword: z
            .string()
            .min(8, "Password must be at least 8 characters")
            .max(100)
            .regex(/[A-Z]/, "Must include at least one uppercase letter")
            .regex(/[a-z]/, "Must include at least one lowercase letter")
            .regex(/[0-9]/, "Must include at least one number")
            .regex(
                /[^A-Za-z0-9]/,
                "Must include at least one special character",
            ),
    })
    .strict();

const changePasswordValidation = z
    .object({
        currentPassword: z
            .string()
            .min(8, "Password must be at least 8 characters")
            .max(100),
        newPassword: z
            .string()
            .min(8, "Password must be at least 8 characters")
            .max(100)
            .regex(/[A-Z]/, "Must include at least one uppercase letter")
            .regex(/[a-z]/, "Must include at least one lowercase letter")
            .regex(/[0-9]/, "Must include at least one number")
            .regex(
                /[^A-Za-z0-9]/,
                "Must include at least one special character",
            ),
    })
    .strict();

const authValidator = {
    registerValidation,
    loginValidation,
    verifyEmailValidation,
    forgotPasswordValidation,
    resetPasswordValidation,
    changePasswordValidation,
};

export default authValidator;
