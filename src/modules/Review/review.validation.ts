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
  isPublished: z.boolean().optional(),
  adminReply: z.string().trim().max(5000).optional(),
}).strict();

export const reviewValidation = {
  submitPublicReview,
  updateReview,
};
