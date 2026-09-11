import { z } from "zod";

const uuidParams = (key: "token" | "id" | "jobId", message: string) =>
  z.object({ [key]: z.string().uuid(message) }).strict();

const reviewTokenParams = uuidParams("token", "Review link is invalid.");
const reviewIdParams = uuidParams("id", "Choose a valid review.");
const reviewJobIdParams = uuidParams("jobId", "Choose a valid completed job.");

const reviewDateInput = z.string().trim().max(40).refine((value) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }
  return !Number.isNaN(Date.parse(value));
}, "Choose a valid date.");

const submitPublicReview = z.object({
  serviceRating: z.number().int().min(1).max(5),
  serviceComment: z.string().trim().max(5000).optional(),
  staffReviews: z.array(
    z.object({
      staffId: z.string().uuid(),
      staffName: z.string().trim().max(120),
      rating: z.number().int().min(1).max(5),
      comment: z.string().trim().max(5000).optional(),
    })
  ).max(50),
}).strict();


const reviewContextQuery = z.object({
  serviceSlug: z.string().trim().min(1).max(96).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
}).strict();

const submitWebsiteReview = z.object({
  scope: z.enum(["COMPANY", "SERVICE"]),
  serviceSlug: z.string().trim().min(1).max(96).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  reviewerName: z.string().trim().min(2).max(120),
  reviewerEmail: z.string().trim().email().max(254),
  reviewerPhone: z.string().trim().min(5).max(40).optional(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().min(3).max(5000),
  // Optional honeypot. publicWebsiteSpamGuard rejects a non-empty value before
  // this strict schema runs, while allowing clients to submit an empty trap.
  companyWebsite: z.string().max(0).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.scope === "SERVICE" && !value.serviceSlug) {
    ctx.addIssue({ code: "custom", path: ["serviceSlug"], message: "Service is required" });
  }
  if (value.scope === "COMPANY" && value.serviceSlug) {
    ctx.addIssue({ code: "custom", path: ["serviceSlug"], message: "Company reviews cannot specify a service" });
  }
});

const reviewLinkOptionsQuery = z.object({
  jobSearch: z.string().trim().max(120).optional(),
  jobLimit: z.coerce.number().int().min(1).max(50).optional(),
}).strict();

const createReviewShareLink = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("COMPANY") }).strict(),
  z.object({
    kind: z.literal("SERVICE"),
    serviceCatalogId: z.string().uuid(),
  }).strict(),
  z.object({
    kind: z.literal("JOB"),
    jobId: z.string().uuid(),
  }).strict(),
]);

const reviewFilters = z.object({
  page: z.coerce.number().int().min(1).max(100000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  searchTerm: z.string().trim().max(200).optional(),
  status: z.enum(["pending", "published", "unpublished", "flagged"]).optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  staffId: z.union([z.literal("not-null"), z.string().uuid()]).optional(),
  jobId: z.string().uuid().optional(),
  dateFrom: reviewDateInput.optional(),
  dateTo: reviewDateInput.optional(),
  scope: z.enum(["COMPANY", "SERVICE", "JOB", "STAFF"]).optional(),
  source: z.enum(["WEBSITE", "JOB_TOKEN"]).optional(),
  serviceCatalogId: z.string().uuid().optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.dateFrom || !value.dateTo) return;
  if (Date.parse(value.dateFrom) > Date.parse(value.dateTo)) {
    ctx.addIssue({
      code: "custom",
      path: ["dateTo"],
      message: "End date must be on or after the start date.",
    });
  }
});

const updateReview = z.object({
  status: z.enum(["pending", "published", "unpublished", "flagged"]).optional(),
  // Deprecated compatibility input. The service always stores `status` as
  // the source of truth and derives isPublished from it.
  isPublished: z.boolean().optional(),
  adminReply: z.string().trim().max(5000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === undefined && value.isPublished === undefined && value.adminReply === undefined) {
    ctx.addIssue({
      code: "custom",
      path: [],
      message: "Provide at least one review field to update.",
    });
  }
  if (value.status !== undefined && value.isPublished !== undefined) {
    const expected = value.status === "published";
    if (expected !== value.isPublished) {
      ctx.addIssue({
        code: "custom",
        path: ["isPublished"],
        message: "isPublished conflicts with review status",
      });
    }
  }
});

export const reviewValidation = {
  reviewTokenParams,
  reviewIdParams,
  reviewJobIdParams,
  submitPublicReview,
  reviewContextQuery,
  submitWebsiteReview,
  reviewLinkOptionsQuery,
  createReviewShareLink,
  reviewFilters,
  updateReview,
};
