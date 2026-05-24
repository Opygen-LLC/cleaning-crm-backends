import { z } from "zod";

const submitPublicReview = z.object({
  serviceRating: z.number().int().min(1).max(5),
  serviceComment: z.string().optional(),
  staffReviews: z.array(
    z.object({
      staffId: z.string().uuid(),
      staffName: z.string(),
      rating: z.number().int().min(1).max(5),
      comment: z.string().optional(),
    })
  ).min(0),
});

const updateReview = z.object({
  status: z.enum(["pending", "published", "unpublished", "flagged"]).optional(),
  isPublished: z.boolean().optional(),
  adminReply: z.string().optional(),
});

export const reviewValidation = {
  submitPublicReview,
  updateReview,
};
