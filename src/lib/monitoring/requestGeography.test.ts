import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { marketForCountry, resolveRequestGeography } from "./requestGeography";

const requestWithHeaders = (headers: Record<string, string | undefined>) => ({
  get: (name: string) => headers[name.toLowerCase()],
}) as unknown as Request;

describe("requestGeography", () => {
  it("maps the target markets into bounded telemetry buckets", () => {
    expect(marketForCountry("US")).toBe("USA");
    expect(marketForCountry("CA")).toBe("Canada");
    expect(marketForCountry("GB")).toBe("UK");
    expect(marketForCountry("DE")).toBe("Europe");
    expect(marketForCountry("AU")).toBe("Australia");
    expect(marketForCountry("JP")).toBe("Other");
  });

  it("prefers Cloudflare then Vercel country headers and ignores invalid values", () => {
    expect(resolveRequestGeography(requestWithHeaders({ "cf-ipcountry": "GB", "x-vercel-ip-country": "US" }))).toEqual({
      countryCode: "GB",
      market: "UK",
      source: "cf-ipcountry",
    });

    expect(resolveRequestGeography(requestWithHeaders({ "cf-ipcountry": "XX", "x-vercel-ip-country": "CA" }))).toEqual({
      countryCode: "CA",
      market: "Canada",
      source: "x-vercel-ip-country",
    });
  });
});
