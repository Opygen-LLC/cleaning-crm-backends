import type { Request } from "express";

export type TargetMarket = "USA" | "Canada" | "UK" | "Europe" | "Australia" | "Other";

const EUROPE_COUNTRIES = new Set([
  "AL", "AD", "AT", "BE", "BA", "BG", "BY", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI",
  "FR", "GR", "HR", "HU", "IE", "IS", "IT", "LI", "LT", "LU", "LV", "MC", "MD", "ME", "MK",
  "MT", "NL", "NO", "PL", "PT", "RO", "RS", "SE", "SI", "SK", "SM", "TR", "UA", "VA",
]);

export const marketForCountry = (countryCode: string | null | undefined): TargetMarket => {
  const country = countryCode?.trim().toUpperCase();
  if (country === "US") return "USA";
  if (country === "CA") return "Canada";
  if (country === "GB") return "UK";
  if (country === "AU") return "Australia";
  if (country && EUROPE_COUNTRIES.has(country)) return "Europe";
  return "Other";
};

type CountrySource = "cf-ipcountry" | "x-vercel-ip-country" | "cloudfront-viewer-country" | "x-country-code" | null;

const normalizeCountry = (value: string | undefined): string | null => {
  const country = value?.split(",", 1)[0]?.trim().toUpperCase();
  return country && /^[A-Z]{2}$/.test(country) && !["XX", "T1"].includes(country) ? country : null;
};

/**
 * Resolve coarse geography only for aggregate performance telemetry. These
 * headers are never used for authentication, authorization, pricing, tenancy
 * or legal/data-residency decisions, so a spoofed direct-request header cannot
 * affect product behaviour.
 */
export const resolveRequestGeography = (req: Request): {
  countryCode: string | null;
  market: TargetMarket;
  source: CountrySource;
} => {
  const candidates: Array<[Exclude<CountrySource, null>, string | undefined]> = [
    ["cf-ipcountry", req.get("cf-ipcountry")],
    ["x-vercel-ip-country", req.get("x-vercel-ip-country")],
    ["cloudfront-viewer-country", req.get("cloudfront-viewer-country")],
    ["x-country-code", req.get("x-country-code")],
  ];

  for (const [source, raw] of candidates) {
    const countryCode = normalizeCountry(raw);
    if (countryCode) return { countryCode, market: marketForCountry(countryCode), source };
  }

  return { countryCode: null, market: "Other", source: null };
};
