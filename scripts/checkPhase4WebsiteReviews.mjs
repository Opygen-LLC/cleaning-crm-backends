import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const schema = read("prisma/schema/review.prisma");
const serviceSchema = read("prisma/schema/service.prisma");
const enums = read("prisma/schema/enum.prisma");
const migration = read("prisma/migrations/20260901193000_phase4_company_service_reviews/migration.sql");
const routes = read("src/modules/Website/publicWebsite.routes.ts");
const reviewService = read("src/modules/Review/websiteReview.service.ts");
const adminReview = read("src/modules/Review/review.service.ts");
const publicProjection = read("src/modules/Website/publicWebsite.service.ts");
const slugService = read("src/modules/ServiceCatalog/serviceCatalog.slug.ts");

const required = [
  [enums, "enum ReviewScope", "ReviewScope enum"],
  [enums, "COMPANY\n  SERVICE\n  JOB\n  STAFF", "review scopes"],
  [enums, "enum ReviewSource", "ReviewSource enum"],
  [schema, "reviewTokenId       String?", "nullable review token"],
  [schema, "jobId               String?", "nullable job"],
  [schema, "model WebsiteReviewContact", "private website contact table"],
  [serviceSchema, "slug         String", "stable service slug"],
  [serviceSchema, "@@unique([adminId, slug])", "tenant slug uniqueness"],
  [routes, '"/:identifier/review-context"', "public review context route"],
  [routes, '"/:identifier/reviews"', "public review submission route"],
  [routes, 'publicWebsiteMutationOriginGuard', "origin-to-website binding"],
  [routes, 'publicWebsiteSpamGuard("website_review")', "review spam guard"],
  [reviewService, 'source: "WEBSITE"', "website review source"],
  [reviewService, 'status: "pending"', "pending-by-default moderation"],
  [reviewService, "tx.websiteReviewContact.create", "separate private contact write"],
  [reviewService, "submissionKeyHash", "idempotency without raw key storage"],
  [adminReview, 'source: "JOB_TOKEN"', "legacy job-token compatibility"],
  [publicProjection, 'where: { status: "published", staffId: null }', "published-only public projection"],
  [slugService, "allocateServiceSlugTx", "race-safe service slug allocation"],
  [migration, 'ALTER TABLE "review" ALTER COLUMN "reviewTokenId" DROP NOT NULL', "legacy review migration"],
  [migration, 'CREATE TABLE IF NOT EXISTS "website_review_contact"', "private contact migration"],
];
for (const [source, token, label] of required) {
  if (!source.includes(token)) throw new Error(`Phase 4 website reviews contract missing: ${label}`);
}
if (reviewService.includes("payload.adminId")) throw new Error("Public website review trusts browser-supplied adminId.");
if (publicProjection.includes("websiteContact: { select: { email")) {
  throw new Error("Public website projection exposes private reviewer contact data.");
}
console.log("Phase 4 website reviews backend contract OK");
