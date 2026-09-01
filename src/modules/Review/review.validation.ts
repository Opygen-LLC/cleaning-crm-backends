import { z } from "zod";

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

const reviewFilters = z.object({
  page: z.coerce.number().int().min(1).max(100000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  searchTerm: z.string().trim().max(200).optional(),
  status: z.enum(["pending", "published", "unpublished", "flagged"]).optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  staffId: z.union([z.literal("not-null"), z.string().uuid()]).optional(),
  jobId: z.string().uuid().optional(),
  dateFrom: z.string().max(40).optional(),
  dateTo: z.string().max(40).optional(),
  scope: z.enum(["COMPANY", "SERVICE", "JOB", "STAFF"]).optional(),
  source: z.enum(["WEBSITE", "JOB_TOKEN"]).optional(),
  serviceCatalogId: z.string().uuid().optional(),
}).strict();

const updateReview = z.object({
  status: z.enum(["pending", "published", "unpublished", "flagged"]).optional(),
  // Deprecated compatibility input. The service always stores `status` as
  // the source of truth and derives isPublished from it.
  isPublished: z.boolean().optional(),
  adminReply: z.string().trim().max(5000).optional(),
}).strict().superRefine((value, ctx) => {
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
  submitPublicReview,
  reviewContextQuery,
  submitWebsiteReview,
  reviewFilters,
  updateReview,
};
