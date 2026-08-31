/**
 * Phone-number normalization shared by every CRM write boundary.
 *
 * UI phone controls may submit values such as:
 *   "+44 7911 123456 [GB]"
 *   "0044 (0) 7911 123456"
 *
 * `normalizePhone` strips presentation-only characters and converts an
 * international `00` prefix to `+`. `normalizePhoneToE164` additionally
 * verifies the canonical E.164 shape (leading +, non-zero country code,
 * 7–15 digits total after the +).
 */
const UI_ISO_TAG = /\s*\[[A-Z]{2}\]\s*$/i;
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

export const normalizePhone = (raw: string): string => {
    const withoutUiTag = raw.replace(UI_ISO_TAG, "").trim();
    const international = withoutUiTag.startsWith("00")
        ? `+${withoutUiTag.slice(2)}`
        : withoutUiTag;
    const hasLeadingPlus = international.startsWith("+");
    const digits = international.replace(/\D/g, "");

    if (!digits) return "";
    return hasLeadingPlus ? `+${digits}` : digits;
};

export const isE164Phone = (value: string): boolean => E164_PATTERN.test(value);

export const normalizePhoneToE164 = (raw: string): string | null => {
    const normalized = normalizePhone(raw);
    return isE164Phone(normalized) ? normalized : null;
};
