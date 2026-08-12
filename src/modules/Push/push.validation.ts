import { z } from "zod";

const subscriptionSchema = z.object({
    endpoint: z.string().url(),
    keys: z.object({
        p256dh: z.string().min(1),
        auth: z.string().min(1),
    }),
}).strict();

export const pushValidation = { subscription: subscriptionSchema };
