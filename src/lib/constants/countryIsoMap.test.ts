/**
 * countryIsoMap.test.ts
 *
 * Regression coverage for the Step 1 country-enum bug: the old code derived
 * the Prisma `Country` enum value by transforming the country's *display
 * name* (upper-case + swap punctuation for underscores), which silently
 * broke for any country whose enum spelling doesn't read back 1:1 from its
 * name. These are exactly the countries called out as broken:
 *   - South Korea / North Korea (enum order is reversed: KOREA_SOUTH, not
 *     SOUTH_KOREA)
 *   - Ivory Coast (had no enum value at all before this fix)
 *   - Congo / DR Congo (naive transform doesn't match either real value)
 *   - Myanmar (happened to work before, but only by accident — covered
 *     here so it can't silently regress)
 */
import { describe, expect, it } from "vitest";
import { Country } from "../../generated/prisma/enums";
import { resolveCountryEnum, ISO_TO_COUNTRY_ENUM } from "./countryIsoMap";

describe("resolveCountryEnum", () => {
    it("resolves South Korea (KR) to KOREA_SOUTH, not the naive SOUTH_KOREA", () => {
        expect(resolveCountryEnum("KR")).toBe(Country.KOREA_SOUTH);
    });

    it("resolves North Korea (KP) to KOREA_NORTH, not the naive NORTH_KOREA", () => {
        expect(resolveCountryEnum("KP")).toBe(Country.KOREA_NORTH);
    });

    it("resolves Ivory Coast (CI) to COTE_D_IVOIRE (previously had no enum value at all)", () => {
        expect(resolveCountryEnum("CI")).toBe(Country.COTE_D_IVOIRE);
    });

    it("resolves Congo (CG) to CONGO_REPUBLIC, not the naive CONGO", () => {
        expect(resolveCountryEnum("CG")).toBe(Country.CONGO_REPUBLIC);
    });

    it("resolves DR Congo (CD) to CONGO_DEMOCRATIC_REPUBLIC", () => {
        expect(resolveCountryEnum("CD")).toBe(Country.CONGO_DEMOCRATIC_REPUBLIC);
    });

    it("resolves Myanmar (MM) to MYANMAR", () => {
        expect(resolveCountryEnum("MM")).toBe(Country.MYANMAR);
    });

    it("is case-insensitive on the ISO code", () => {
        expect(resolveCountryEnum("kr")).toBe(Country.KOREA_SOUTH);
    });

    it("passes through an already-valid enum value unchanged (back-compat)", () => {
        expect(resolveCountryEnum("KOREA_SOUTH")).toBe(Country.KOREA_SOUTH);
    });

    it("trims surrounding whitespace", () => {
        expect(resolveCountryEnum("  KR  ")).toBe(Country.KOREA_SOUTH);
    });

    it("returns undefined for an empty string", () => {
        expect(resolveCountryEnum("")).toBeUndefined();
    });

    it("returns undefined for a code with no corresponding enum value (e.g. a micro-territory)", () => {
        // Bermuda has no representation in the Country enum.
        expect(resolveCountryEnum("BM")).toBeUndefined();
    });

    it("returns undefined for garbage input rather than throwing", () => {
        expect(resolveCountryEnum("NOT_A_REAL_CODE")).toBeUndefined();
    });

    it("maps every ISO code in the table to a real Country enum member (no typos)", () => {
        const validValues = new Set<string>(Object.values(Country));
        for (const [iso, value] of Object.entries(ISO_TO_COUNTRY_ENUM)) {
            expect(validValues.has(value), `${iso} -> ${value}`).toBe(true);
        }
    });

    it("has no two ISO codes mapping to the same enum value", () => {
        const seen = new Set<string>();
        for (const value of Object.values(ISO_TO_COUNTRY_ENUM)) {
            expect(seen.has(value), `duplicate mapping to ${value}`).toBe(false);
            seen.add(value);
        }
    });
});
