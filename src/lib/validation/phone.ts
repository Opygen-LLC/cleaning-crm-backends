import { z } from "zod";
import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { isE164Phone, normalizePhone, normalizePhoneToE164 } from "../utils/normalizePhone";

export const PHONE_E164_ERROR = "Enter a valid phone number including country code";

/**
 * Accepts human-friendly international input and emits canonical E.164.
 * Route middleware persists Zod's parsed result onto req.body, so service
 * layers receive the normalized value rather than the original presentation.
 */
export const e164PhoneSchema = (message = PHONE_E164_ERROR) =>
    z
        .string()
        .trim()
        .min(1, message)
        .transform((value) => normalizePhone(value))
        .refine((value) => isE164Phone(value), message);

/** Empty optional form fields become undefined instead of failing validation. */
export const optionalE164PhoneSchema = (message = PHONE_E164_ERROR) =>
    z.preprocess(
        (value) =>
            typeof value === "string" && value.trim() === "" ? undefined : value,
        e164PhoneSchema(message).optional(),
    );

/** Service-level guard for internal callers that bypass route validation. */
export const requireE164Phone = (raw: string, field = "phone"): string => {
    const normalized = normalizePhoneToE164(raw);
    if (normalized) return normalized;

    throw new AppError(status.BAD_REQUEST, PHONE_E164_ERROR, {
        code: "VALIDATION_ERROR",
        retryable: false,
        fieldErrors: { [field]: PHONE_E164_ERROR },
    });
};

export const normalizeOptionalE164Phone = (
    raw: string | null | undefined,
    field = "phone",
): string | null | undefined => {
    if (raw === null || raw === undefined) return raw;
    if (!raw.trim()) return undefined;
    return requireE164Phone(raw, field);
};
