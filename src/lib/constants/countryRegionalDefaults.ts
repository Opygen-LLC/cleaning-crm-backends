import { Currency } from "../../generated/prisma/enums";
import { resolveCountryEnum } from "./countryIsoMap";

/**
 * Country-derived defaults that are safe to apply without guessing a user's
 * exact location. Locale is an English regional formatting locale; timezone is
 * provided only for countries where this product has an unambiguous canonical
 * IANA zone. Multi-zone countries intentionally return no timezone.
 *
 * Currency is limited to currencies currently supported by the CRM's Currency
 * enum. Unsupported countries keep the database default until the product adds
 * their currency explicitly.
 */
export interface CountryRegionalDefaults {
  countryIso: string;
  locale: string;
  currency?: Currency;
  timezone?: string;
}

const EUR_COUNTRIES = new Set([
  "AD", "AT", "BE", "HR", "CY", "EE", "FI", "FR", "DE", "GR", "IE",
  "IT", "XK", "LV", "LT", "LU", "MT", "MC", "ME", "NL", "PT", "SM",
  "SK", "SI", "ES", "VA",
]);

const USD_COUNTRIES = new Set(["US", "EC", "SV", "FM", "MH", "PW", "TL"]);

const CURRENCY_BY_ISO: Record<string, Currency> = {
  GB: Currency.GBP,
  CA: Currency.CAD,
  AU: Currency.AUD,
  NZ: Currency.NZD,
  SG: Currency.SGD,
  ZA: Currency.ZAR,
  IN: Currency.INR,
  AE: Currency.AED,
};

/**
 * Deliberately partial. If a country has multiple practical IANA zones we do
 * not pick one on the user's behalf (US/CA/AU/NZ etc.). The dashboard can then
 * ask the business to choose its timezone independently of the locked country.
 */
const UNAMBIGUOUS_TIMEZONE_BY_ISO: Record<string, string> = {
  BD: "Asia/Dhaka",
  GB: "Europe/London",
  IE: "Europe/Dublin",
  IS: "Atlantic/Reykjavik",
  IN: "Asia/Kolkata",
  PK: "Asia/Karachi",
  NP: "Asia/Kathmandu",
  LK: "Asia/Colombo",
  AE: "Asia/Dubai",
  SA: "Asia/Riyadh",
  QA: "Asia/Qatar",
  KW: "Asia/Kuwait",
  BH: "Asia/Bahrain",
  OM: "Asia/Muscat",
  SG: "Asia/Singapore",
  TH: "Asia/Bangkok",
  VN: "Asia/Ho_Chi_Minh",
  PH: "Asia/Manila",
  JP: "Asia/Tokyo",
  KR: "Asia/Seoul",
  ZA: "Africa/Johannesburg",
  NG: "Africa/Lagos",
  KE: "Africa/Nairobi",
  GH: "Africa/Accra",
};

export const getCountryRegionalDefaults = (input: string): CountryRegionalDefaults | undefined => {
  const iso = input.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(iso) || !resolveCountryEnum(iso)) return undefined;

  const currency = EUR_COUNTRIES.has(iso)
    ? Currency.EUR
    : USD_COUNTRIES.has(iso)
      ? Currency.USD
      : CURRENCY_BY_ISO[iso];

  return {
    countryIso: iso,
    // The CRM UI is English; this locale controls regional number/date
    // formatting and is not a claim about the user's preferred language.
    locale: `en-${iso}`,
    ...(currency ? { currency } : {}),
    ...(UNAMBIGUOUS_TIMEZONE_BY_ISO[iso]
      ? { timezone: UNAMBIGUOUS_TIMEZONE_BY_ISO[iso] }
      : {}),
  };
};
