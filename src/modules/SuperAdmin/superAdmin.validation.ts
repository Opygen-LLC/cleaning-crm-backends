import { z } from "zod";

// ─── Create Admin Account (super-admin endpoint) ───────────────────────────────
// Mirrors the fields the service actually consumes.
// Extra fields sent by the frontend (plan, billingCycle, country …) are
// simply stripped by Zod's `strip` default — no error, no leak.

export const createAdminAccountSchema = z.object({
    name: z
        .string({ message: "name is required." })
        .min(2, "name must be at least 2 characters.")
        .max(80, "name must be at most 80 characters.")
        .trim(),

    email: z
        .string({ message: "email is required." })
        .email("email must be a valid email address.")
        .toLowerCase()
        .trim(),

    password: z
        .string({ message: "password is required." })
        .min(8, "password must be at least 8 characters.")
        .max(128, "password must be at most 128 characters.")
        .regex(/[A-Z]/, "password must contain at least one uppercase letter.")
        .regex(/[0-9]/, "password must contain at least one number."),

    businessName: z
        .string({ message: "businessName is required." })
        .min(2, "businessName must be at least 2 characters.")
        .max(80, "businessName must be at most 80 characters.")
        .trim(),

    // ── Optional metadata fields ───────────────────────────────────────────────
    // sendWelcomeEmail controls whether the admin-created email is sent.
    // Remaining optional fields (plan, billingCycle, country, role, notes …)
    // are accepted and stripped by Zod — reserved for future plan assignment.
    sendWelcomeEmail: z.boolean().optional().default(true),
});

export type TCreateAdminAccountPayload = z.infer<
    typeof createAdminAccountSchema
>;
