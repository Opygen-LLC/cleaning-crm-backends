/**
 * normalizePhone — Phase 3 (S6)
 * ─────────────────────────────────────────────────────────────────────────
 * The booking/client Zod schemas accept flexible phone input on purpose
 * (spaces, dashes, parens, a leading "+") so the form stays easy to type
 * into: `/^[+\d\s\-()]+$/`. That flexible string was previously saved to
 * the database as-is, which meant "07700 900100", "07700-900100" and
 * "(07700) 900100" were all stored as different values for what is really
 * the same number.
 *
 * This strips everything except digits and a leading "+" so the stored
 * value is consistent no matter how the admin (or a client via the public
 * booking form) typed it in.
 *
 *   normalizePhone("07700 900-100")   -> "07700900100"
 *   normalizePhone("+44 (0) 7700 900100") -> "+4407700900100"
 */
export const normalizePhone = (raw: string): string => {
    const trimmed = raw.trim();
    const hasLeadingPlus = trimmed.startsWith("+");
    const digits = trimmed.replace(/\D/g, "");
    return hasLeadingPlus ? `+${digits}` : digits;
};
