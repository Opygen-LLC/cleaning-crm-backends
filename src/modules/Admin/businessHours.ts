import { z } from "zod";

const timeSchema = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must use 24-hour HH:mm format");

const daySchema = z
  .object({
    isOpen: z.boolean(),
    opensAt: timeSchema,
    closesAt: timeSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.isOpen && value.opensAt >= value.closesAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["closesAt"],
        message: "Closing time must be after opening time",
      });
    }
  });

export const businessHoursSchema = z
  .object({
    timezone: z.string().trim().min(1).max(100).optional(),
    monday: daySchema,
    tuesday: daySchema,
    wednesday: daySchema,
    thursday: daySchema,
    friday: daySchema,
    saturday: daySchema,
    sunday: daySchema,
  })
  .strict();

export type BusinessHours = z.infer<typeof businessHoursSchema>;

const parseJsonBodyValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "null") return null;
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

/**
 * Multer turns structured multipart fields into strings. Re-hydrate JSON here
 * so profile updates behave identically with and without a logo upload.
 */
export const businessHoursInputSchema = z.preprocess(
  parseJsonBodyValue,
  businessHoursSchema.nullable(),
).optional();

export const jsonArrayInput = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(parseJsonBodyValue, schema);

export const nullableMultipartInput = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (value) => value === "" || value === "null" ? null : value,
    schema.nullable(),
  ).optional();
