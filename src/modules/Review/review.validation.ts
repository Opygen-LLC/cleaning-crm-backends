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
  updateReview,
};
