import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("Phase 3 unified website submissions contract", () => {
  it("defines one tenant-scoped acquisition envelope for all website submission kinds", () => {
    const schema = read("prisma/schema/websiteSubmission.prisma");
    const enums = read("prisma/schema/enum.prisma");
    expect(schema).toContain("model WebsiteSubmission");
    expect(schema).toContain("adminId                 String");
    expect(schema).toContain("websiteId               String");
    expect(schema).toContain("bookingFormSubmissionId String?                 @unique");
    expect(schema).toContain("estimateFormSubmissionId String?                @unique");
    expect(schema).toContain("leadId                  String?");
    expect(enums).toContain("enum WebsiteSubmissionKind");
    expect(enums).toContain("CONTACT\n  BOOKING\n  ESTIMATE");
  });

  it("records contact, booking and estimate acquisition at write time", () => {
    const acquisition = read("src/modules/Website/websiteAcquisition.service.ts");
    const booking = read("src/modules/BookingForm/bookingForm.service.ts");
    const estimate = read("src/modules/EstimateForm/estimateForm.service.ts");
    expect(acquisition).toContain("createContactWebsiteSubmission(tx");
    expect(booking).toContain("ensureBookingWebsiteSubmission(tx, created, form.adminId)");
    expect(estimate).toContain("ensureEstimateWebsiteSubmission(tx, created, form.adminId)");
  });

  it("keeps conversion state synchronized with CRM conversions", () => {
    expect(read("src/modules/Booking/booking.service.ts")).toContain(
      "syncBookingWebsiteSubmissionStatus(tx, submission.id, FormSubmissionStatus.CONVERTED)",
    );
    expect(read("src/modules/Lead/lead.service.ts")).toContain(
      "syncLeadWebsiteSubmissionsConverted(tx, lead.id)",
    );
    expect(read("src/modules/EstimateForm/estimateForm.service.ts")).toContain(
      "syncEstimateWebsiteSubmissionStatus(tx, submissionId, newStatus)",
    );
  });

  it("exposes a protected paginated inbox API instead of reusing booking submissions", () => {
    const routes = read("src/modules/Website/website.routes.ts");
    const service = read("src/modules/Website/websiteSubmission.service.ts");
    expect(routes).toContain('"/submissions"');
    expect(routes).toContain('"/submissions/:submissionId/status"');
    expect(service).toContain("adminId,");
    expect(service).toContain("skip: (page - 1) * limit");
    expect(service).toContain("take: limit");
    expect(service).not.toContain("where: {} // tenant");
  });

  it("backfills native website bookings/estimates and only best-effort historical contacts", () => {
    const migration = read("prisma/migrations/20260901153000_phase3_unified_website_submissions/migration.sql");
    expect(migration).toContain("Reliable historical BOOKING backfill");
    expect(migration).toContain("Reliable historical ESTIMATE backfill");
    expect(migration).toContain("Best-effort CONTACT history");
    expect(migration).toContain('b."sourceWebsiteId" IS NOT NULL');
    expect(migration).toContain('e."sourceWebsiteId" IS NOT NULL');
  });

  it("exports the canonical inbox so contact events are not omitted from profile export", () => {
    const service = read("src/modules/DataExport/dataExport.service.ts");
    expect(service).toContain("prisma.websiteSubmission.findMany");
    expect(service).toContain('Type: r.kind');
    expect(service).toContain('"Lead Ref": r.lead?.leadRef');
  });
});
