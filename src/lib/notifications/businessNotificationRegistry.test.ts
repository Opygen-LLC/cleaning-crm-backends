import { describe, expect, it } from "vitest";
import {
  BUSINESS_NOTIFICATION_REGISTRY,
  BUSINESS_NOTIFICATION_TEMPLATE_KEYS,
} from "./businessNotificationRegistry";

const expectedKeys = [
  "booking-confirmation",
  "booking-reminder-24h",
  "booking-reminder-day-of",
  "staff-assigned",
  "quote-sent",
  "estimate-sent",
  "invoice-sent",
  "invoice-due",
  "review-request",
] as const;

const tokens = (value: string) =>
  [...value.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((match) => match[1]);

describe("business notification registry", () => {
  it("exposes exactly the canonical Phase 5 template keys", () => {
    expect(BUSINESS_NOTIFICATION_TEMPLATE_KEYS).toEqual(expectedKeys);
  });

  it("defines valid metadata and supported variables for every template", () => {
    for (const key of BUSINESS_NOTIFICATION_TEMPLATE_KEYS) {
      const definition = BUSINESS_NOTIFICATION_REGISTRY[key];
      expect(definition.key).toBe(key);
      expect(definition.event).toBeTruthy();
      expect(definition.recipient).toMatch(/^(CLIENT|STAFF)$/);
      expect(definition.maxAttempts).toBeGreaterThan(0);
      expect(definition.defaultSubject.trim()).not.toBe("");
      expect(definition.defaultBody.trim()).not.toBe("");

      const supported = new Set(definition.availableVariables);
      for (const token of [
        ...tokens(definition.defaultSubject),
        ...tokens(definition.defaultBody),
      ]) {
        expect(supported.has(token)).toBe(true);
      }
    }
  });

  it("keeps invoice sent and invoice due as independent events", () => {
    expect(BUSINESS_NOTIFICATION_REGISTRY["invoice-sent"].event).not.toBe(
      BUSINESS_NOTIFICATION_REGISTRY["invoice-due"].event,
    );
    expect(BUSINESS_NOTIFICATION_REGISTRY["invoice-sent"].preferenceKey).toBe("emailInvoiceSent");
    expect(BUSINESS_NOTIFICATION_REGISTRY["invoice-due"].preferenceKey).toBe("emailInvoiceOverdue");
  });
});
