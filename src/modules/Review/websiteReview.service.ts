import { createHash } from "node:crypto";
import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { prisma } from "../../lib/prisma/prisma";
import { acquireExtendedTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { PublicWebsiteService } from "../Website/publicWebsite.service";
import { WebsiteProjectionCacheService } from "../Website/websiteProjectionCache.service";
import { invalidateBookingFormsForAdmin } from "../BookingForm/bookingForm.cache";
import type { ISubmitWebsiteReview } from "./review.interface";

const deriveSentiment = (rating: number): string => {
  if (rating >= 4) return "positive";
  if (rating === 3) return "neutral";
  return "negative";
};

const normalizeSubmissionKey = (key?: string): string | null => {
  const value = key?.trim();
  if (!value) return null;
  if (value.length > 200) {
    throw new AppError(status.BAD_REQUEST, "Invalid idempotency key", {
      code: "PUBLIC_REVIEW_IDEMPOTENCY_INVALID",
      retryable: false,
    });
  }
  return value;
};

const hashSubmissionKey = (websiteId: string, key: string) =>
  createHash("sha256").update(`${websiteId}:${key}`, "utf8").digest("hex");

const getWebsiteReviewContext = async (identifier: string, serviceSlug?: string | null) => {
  const integration = await PublicWebsiteService.resolvePublicReviewIntegration(identifier, serviceSlug);
  return {
    scope: integration.scope,
    businessName: integration.businessName,
    service: integration.service
      ? { slug: integration.service.slug, name: integration.service.serviceName }
      : null,
  };
};

const submitWebsiteReview = async (
  identifier: string,
  payload: ISubmitWebsiteReview,
  idempotencyKey?: string,
) => {
  const requestedServiceSlug = payload.scope === "SERVICE" ? payload.serviceSlug : null;
  const integration = await PublicWebsiteService.resolvePublicReviewIntegration(
    identifier,
    requestedServiceSlug,
  );

  if (payload.scope !== integration.scope) {
    throw new AppError(status.UNPROCESSABLE_ENTITY, "Review scope does not match this page", {
      code: "WEBSITE_REVIEW_SCOPE_MISMATCH",
      retryable: false,
      fieldErrors: { scope: "Use the review form for this page." },
    });
  }

  const key = normalizeSubmissionKey(idempotencyKey);
  const submissionKeyHash = key ? hashSubmissionKey(integration.websiteId, key) : null;

  const result = await prisma.$transaction(async (tx) => {
    if (submissionKeyHash) {
      await acquireExtendedTextTransactionAdvisoryLock(tx, `website-review:${submissionKeyHash}`);
      const existing = await tx.websiteReviewContact.findUnique({
        where: { submissionKeyHash },
        select: {
          websiteId: true,
          adminId: true,
          review: { select: { id: true, status: true } },
        },
      });
      if (existing) {
        if (existing.websiteId !== integration.websiteId || existing.adminId !== integration.adminId) {
          throw new AppError(status.CONFLICT, "Review submission key is already in use", {
            code: "PUBLIC_REVIEW_IDEMPOTENCY_CONFLICT",
            retryable: false,
          });
        }
        return { review: existing.review, duplicate: true };
      }
    }

    const review = await tx.review.create({
      data: {
        adminId: integration.adminId,
        websiteId: integration.websiteId,
        source: "WEBSITE",
        scope: integration.scope,
        serviceCatalogId: integration.service?.id ?? null,
        serviceNameSnapshot: integration.service?.serviceName ?? null,
        reviewTokenId: null,
        jobId: null,
        staffId: null,
        clientName: payload.reviewerName.trim(),
        rating: payload.rating,
        comment: payload.comment.trim(),
        sentiment: deriveSentiment(payload.rating),
        status: "pending",
        isPublished: false,
      },
      select: { id: true, status: true },
    });

    await tx.websiteReviewContact.create({
      data: {
        reviewId: review.id,
        adminId: integration.adminId,
        websiteId: integration.websiteId,
        email: payload.reviewerEmail.trim().toLowerCase(),
        phone: payload.reviewerPhone?.trim() || null,
        submissionKeyHash,
      },
    });

    return { review, duplicate: false };
  });

  // Pending reviews are not publicly projected, but invalidating here keeps a
  // later moderation write from ever observing stale cached relationship data.
  if (!result.duplicate) {
    await Promise.all([
      WebsiteProjectionCacheService.invalidateAdminWebsite(integration.adminId),
      invalidateBookingFormsForAdmin(integration.adminId),
    ]);
  }

  return {
    submitted: true,
    duplicate: result.duplicate,
    moderationStatus: result.review.status,
  };
};

export const websiteReviewService = {
  getWebsiteReviewContext,
  submitWebsiteReview,
};
