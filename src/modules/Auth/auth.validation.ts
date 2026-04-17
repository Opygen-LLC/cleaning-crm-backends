import z, { email } from "zod";

export const registerValidation = z.object({
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
        .regex(/[^A-Za-z0-9]/, "Must include at least one special character"),
}).strict();

export const loginValidation = z.object({
    email: z.string().email("Invalid email address").toLowerCase(),

    password: z
        .string()
        .min(8, "Password must be at least 8 characters")
        .max(100)
        // .regex(/[A-Z]/, "Must include at least one uppercase letter")
        // .regex(/[a-z]/, "Must include at least one lowercase letter")
        // .regex(/[0-9]/, "Must include at least one number")
        // .regex(/[^A-Za-z0-9]/, "Must include at least one special character"),
}).strict();

const authValidator = {
    registerValidation,
    loginValidation,
    // forgotPasswordValidation,
    // resetPasswordValidation,
    // resendVerificationValidation,
    // verificationValidation,
};

export default authValidator;
