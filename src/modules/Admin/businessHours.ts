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

const DEFAULT_DAY: z.infer<typeof daySchema> = {
  isOpen: true,
  opensAt: "09:00",
  closesAt: "17:00",
};

const DEFAULT_WEEKEND_DAY: z.infer<typeof daySchema> = {
  isOpen: false,
  opensAt: "09:00",
  closesAt: "17:00",
};

/**
 * Converts historical/partial JSON into the canonical seven-day shape used by
 * onboarding. This is intentionally defensive even after the Phase 2 data
 * migration so a restored backup or manually edited legacy row cannot crash
 * the onboarding client.
 */
export const normalizeBusinessHours = (value: unknown): BusinessHours | null => {
  if (value == null) return null;

  const parsed = businessHoursSchema.safeParse(value);
  if (parsed.success) return parsed.data;

  if (typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const normalizeDay = (key: string, fallback: z.infer<typeof daySchema>) => {
    const raw = source[key];
    if (typeof raw !== "object" || raw == null || Array.isArray(raw)) return fallback;
    const row = raw as Record<string, unknown>;
    const candidate = {
      isOpen: typeof row.isOpen === "boolean" ? row.isOpen : fallback.isOpen,
      opensAt: typeof row.opensAt === "string" ? row.opensAt : fallback.opensAt,
      closesAt: typeof row.closesAt === "string" ? row.closesAt : fallback.closesAt,
    };
    const safe = daySchema.safeParse(candidate);
    return safe.success ? safe.data : fallback;
  };

  return {
    ...(typeof source.timezone === "string" && source.timezone.trim()
      ? { timezone: source.timezone.trim().slice(0, 100) }
      : {}),
    monday: normalizeDay("monday", DEFAULT_DAY),
    tuesday: normalizeDay("tuesday", DEFAULT_DAY),
    wednesday: normalizeDay("wednesday", DEFAULT_DAY),
    thursday: normalizeDay("thursday", DEFAULT_DAY),
    friday: normalizeDay("friday", DEFAULT_DAY),
    saturday: normalizeDay("saturday", DEFAULT_WEEKEND_DAY),
    sunday: normalizeDay("sunday", DEFAULT_WEEKEND_DAY),
  };
};
