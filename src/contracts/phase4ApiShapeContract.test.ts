import { describe, expect, it } from "vitest";
import { staffListSelect, staffLookupSelect } from "../modules/Staff/staff.projection";
import { clientLookupSelect, clientListSelect } from "../modules/Client/client.projection";
import { bookingListSelect, bookingMutationSelect } from "../modules/Booking/booking.projection";
import { leadListSelect, leadMutationSelect } from "../modules/Lead/lead.projection";
import { readFileSync } from "node:fs";

const keys = (value: object) => Object.keys(value).sort();
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("Phase 4 API response shape regression protection", () => {
  it("keeps staff list/lookup user projections free of account and security fields", () => {
    expect(keys(staffListSelect.user.select)).toEqual(["email", "id", "image", "name"]);
    expect(keys(staffLookupSelect.user.select)).toEqual(["email", "id", "image", "name"]);
    const serialized = JSON.stringify(staffListSelect.user.select);
    for (const forbidden of ["password", "status", "emailVerified", "needPasswordChange", "twoFactor", "session", "accounts"]) {
      expect(serialized).not.toContain(`\"${forbidden}\":true`);
    }
  });

  it("keeps client lookup deliberately smaller than client list/detail data", () => {
    expect(keys(clientLookupSelect)).toEqual([
      "addressLine1", "addressLine2", "city", "country", "email", "id", "name", "phone", "zipcode",
    ]);
    expect(clientLookupSelect).not.toHaveProperty("portalAccessToken");
    expect(clientLookupSelect).not.toHaveProperty("notes");
    expect(clientLookupSelect).not.toHaveProperty("bookings");
    expect(keys(clientListSelect)).not.toContain("adminId");
  });

  it("keeps booking list and mutation DTOs tenant-safe and bounded", () => {
    expect(bookingListSelect).not.toHaveProperty("adminId");
    expect(bookingListSelect).not.toHaveProperty("sourceBookingFormSubmission");
    expect(keys(bookingMutationSelect)).toEqual(["bookingRef", "id", "scheduledDate", "status", "updatedAt"]);
  });

  it("keeps lead list/mutation DTOs free of tenant identifiers", () => {
    expect(leadListSelect).not.toHaveProperty("adminId");
    expect(keys(leadMutationSelect)).toEqual(["id", "leadRef", "stage", "updatedAt"]);
  });

  it("keeps payment mutations compact instead of returning a payment graph", () => {
    const paymentService = read("src/modules/Payment/payment.service.ts");
    expect(paymentService).toContain('select: { id: true, paymentRef: true, status: true, updatedAt: true }');
    expect(paymentService).toContain('select: { id: true, paymentRef: true, updatedAt: true }');
    expect(paymentService).toContain('return { id, deleted: true }');
    const updateSection = paymentService.slice(paymentService.indexOf("const updatePayment"), paymentService.indexOf("const deletePayment"));
    expect(updateSection).not.toContain("include:");
  });
});
