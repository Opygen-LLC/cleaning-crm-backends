import { describe, expect, it } from "vitest";
import { Currency } from "../../generated/prisma/enums";
import { getCountryRegionalDefaults } from "./countryRegionalDefaults";

describe("getCountryRegionalDefaults", () => {
  it("normalizes a supported registration country and derives safe defaults", () => {
    expect(getCountryRegionalDefaults("bd")).toEqual({
      countryIso: "BD",
      locale: "en-BD",
      timezone: "Asia/Dhaka",
    });
    expect(getCountryRegionalDefaults("GB")).toEqual({
      countryIso: "GB",
      locale: "en-GB",
      timezone: "Europe/London",
      currency: Currency.GBP,
    });
  });

  it("does not guess a timezone for multi-zone countries", () => {
    expect(getCountryRegionalDefaults("US")).toEqual({
      countryIso: "US",
      locale: "en-US",
      currency: Currency.USD,
    });
  });

  it("rejects unsupported territories/codes", () => {
    expect(getCountryRegionalDefaults("BM")).toBeUndefined();
    expect(getCountryRegionalDefaults("not-a-country")).toBeUndefined();
  });
});
