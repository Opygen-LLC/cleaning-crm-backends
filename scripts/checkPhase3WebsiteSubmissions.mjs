import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const schema = read("prisma/schema/websiteSubmission.prisma");
const migration = read("prisma/migrations/20260901153000_phase3_unified_website_submissions/migration.sql");
const routes = read("src/modules/Website/website.routes.ts");
const inbox = read("src/modules/Website/websiteSubmission.service.ts");
const acquisition = read("src/modules/Website/websiteAcquisition.service.ts");
const booking = read("src/modules/BookingForm/bookingForm.service.ts");
const estimate = read("src/modules/EstimateForm/estimateForm.service.ts");

const required = [
  [schema, "model WebsiteSubmission", "WebsiteSubmission model"],
  [schema, "bookingFormSubmissionId String?                 @unique", "booking one-to-one envelope"],
  [schema, "estimateFormSubmissionId String?                @unique", "estimate one-to-one envelope"],
  [routes, '"/submissions"', "admin submissions endpoint"],
  [routes, '"/submissions/:submissionId/status"', "admin status endpoint"],
  [inbox, "adminId,", "tenant scoped inbox predicate"],
  [acquisition, "createContactWebsiteSubmission(tx", "lossless contact envelope"],
  [booking, "ensureBookingWebsiteSubmission(tx, created, form.adminId)", "booking envelope in native transaction"],
  [estimate, "ensureEstimateWebsiteSubmission(tx, created, form.adminId)", "estimate envelope in native transaction"],
  [migration, "Reliable historical BOOKING backfill", "booking backfill"],
  [migration, "Reliable historical ESTIMATE backfill", "estimate backfill"],
  [migration, "Best-effort CONTACT history", "contact best-effort backfill"],
];
for (const [source, token, label] of required) {
  if (!source.includes(token)) throw new Error(`Phase 3 website submissions contract missing: ${label}`);
}
if (inbox.includes("findMany({ where: {}")) throw new Error("Website submissions inbox contains an unscoped query.");
console.log("Phase 3 website submissions backend contract OK");
