import { Router } from "express";
import {
  publicReadRateLimit,
  publicHostResolveRateLimit,
  publicFormSubmissionRateLimit,
  publicFormResourceRateLimit,
  publicCalculationRateLimit,
  publicCalculationResourceRateLimit,
  publicContactMutationRateLimit,
  publicContactResourceRateLimit,
  publicReviewMutationRateLimit,
  publicReviewResourceRateLimit,
  publicTelemetryRateLimit,
  publicResourceTelemetryRateLimit,
} from "../../middlewares/publicApiSecurity";
import { ValidationProperty, zodValidate } from "../../middlewares/validations/zodValidation.middleware";
import { bookingFormValidation } from "../BookingForm/bookingForm.validation";
import { estimateFormValidation } from "../EstimateForm/estimateForm.validation";
import { websiteController } from "./website.controller";
import { reviewController } from "../Review/review.controller";
import { reviewValidation } from "../Review/review.validation";
import { websiteValidation } from "./website.validation";
import { publicWebsiteSpamGuard } from "../../middlewares/publicSpamProtection";
import {
  publicWebsiteMutationOriginGuard,
  publicJsonOnly,
  publicTelemetryBodyLimit,
  publicContactBodyLimit,
  publicReviewBodyLimit,
  publicEstimateCalculationBodyLimit,
  publicFormSubmissionBodyLimit,
} from "../../middlewares/publicWebsiteRequestSecurity";

const router = Router();

router.get("/resolve-subdomain/:subdomain", publicHostResolveRateLimit, websiteController.resolvePublicSubdomain);
router.get("/resolve-host/:host", publicHostResolveRateLimit, websiteController.resolvePublicHost);

router.get("/preview-session/:token", publicReadRateLimit, websiteController.getPreviewSession);

// Phase 23 hot path: the frontend proxy already resolved host → websiteId.
// Fetch the Redis projection directly instead of resolving the same subdomain
// a second time during the Next.js server render. The service still enforces
// PUBLISHED/account status on cache misses, and UUIDs expose no private data.
router.get("/by-id/:websiteId", publicReadRateLimit, websiteController.getPublicWebsiteById);

// Website-scoped booking integration. Phase 23 resolves feature/form selection
// from the Redis public projection, then delegates live slot/submission work to
// the existing BookingForm engine. Legacy /booking-form/public/:slug routes
// remain available for previously shared links.
router.get(
  "/:identifier/booking/slots",
  publicReadRateLimit,
  zodValidate(
    bookingFormValidation.publicSlotAvailabilityQuerySchema,
    ValidationProperty.QUERY,
  ),
  websiteController.getPublicWebsiteBookingSlots,
);
router.get(
  "/:identifier/booking",
  publicReadRateLimit,
  websiteController.getPublicWebsiteBooking,
);
router.post(
  "/:identifier/booking",
  publicFormSubmissionRateLimit,
  publicFormResourceRateLimit,
  publicJsonOnly,
  publicFormSubmissionBodyLimit,
  publicWebsiteMutationOriginGuard,
  publicWebsiteSpamGuard("website_booking"),
  zodValidate(
    bookingFormValidation.publicBookingSubmissionSchema,
    ValidationProperty.BODY,
  ),
  websiteController.submitPublicWebsiteBooking,
);

// Website-scoped estimate integration. Like booking, the public tenant URL
// resolves the published primaryEstimateFormId and then delegates to the
// existing EstimateForm pricing/submission engine. Legacy slug URLs stay live.
router.get(
  "/:identifier/estimate",
  publicReadRateLimit,
  websiteController.getPublicWebsiteEstimate,
);
router.post(
  "/:identifier/estimate/calculate",
  publicCalculationRateLimit,
  publicCalculationResourceRateLimit,
  publicJsonOnly,
  publicEstimateCalculationBodyLimit,
  publicWebsiteMutationOriginGuard,
  zodValidate(estimateFormValidation.publicCalculation, ValidationProperty.BODY),
  websiteController.calculatePublicWebsiteEstimate,
);
router.post(
  "/:identifier/estimate",
  publicFormSubmissionRateLimit,
  publicFormResourceRateLimit,
  publicJsonOnly,
  publicFormSubmissionBodyLimit,
  publicWebsiteMutationOriginGuard,
  publicWebsiteSpamGuard("website_estimate"),
  zodValidate(estimateFormValidation.publicSubmission, ValidationProperty.BODY),
  websiteController.submitPublicWebsiteEstimate,
);

// Public website acquisition. Contact enquiries enter the tenant's native CRM
// Lead pipeline and are deduplicated by normalized email or phone inside the service.
router.post(
  "/:identifier/contact",
  publicContactMutationRateLimit,
  publicContactResourceRateLimit,
  publicJsonOnly,
  publicContactBodyLimit,
  publicWebsiteMutationOriginGuard,
  publicWebsiteSpamGuard("website_contact"),
  zodValidate(websiteValidation.publicContact, ValidationProperty.BODY),
  websiteController.submitPublicWebsiteContact,
);


// Tenant website review submission. Company reviews live at /review and
// service reviews at /:serviceSlug/review on the frontend; both post through
// this already-secured website public API boundary.
router.get(
  "/:identifier/review-context",
  publicReadRateLimit,
  zodValidate(reviewValidation.reviewContextQuery, ValidationProperty.QUERY),
  reviewController.getWebsiteReviewContext,
);
router.post(
  "/:identifier/reviews",
  publicReviewMutationRateLimit,
  publicReviewResourceRateLimit,
  publicJsonOnly,
  publicReviewBodyLimit,
  publicWebsiteMutationOriginGuard,
  publicWebsiteSpamGuard("website_review"),
  zodValidate(reviewValidation.submitWebsiteReview, ValidationProperty.BODY),
  reviewController.submitWebsiteReview,
);

router.post(
  "/:identifier/error",
  publicTelemetryRateLimit,
  publicResourceTelemetryRateLimit,
  publicJsonOnly,
  publicTelemetryBodyLimit,
  publicWebsiteMutationOriginGuard,
  zodValidate(websiteValidation.publicClientError, ValidationProperty.BODY),
  websiteController.reportPublicWebsiteError,
);

router.get("/:identifier", publicReadRateLimit, websiteController.getPublicWebsite);

export const publicWebsiteRoutes = router;
