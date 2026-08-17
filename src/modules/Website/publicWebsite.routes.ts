import { Router } from "express";
import {
  publicMutationRateLimit,
  publicReadRateLimit,
  publicHostResolveRateLimit,
  publicResourceMutationRateLimit,
  publicContactMutationRateLimit,
  publicContactResourceRateLimit,
  publicTelemetryRateLimit,
  publicResourceTelemetryRateLimit,
} from "../../middlewares/publicApiSecurity";
import { ValidationProperty, zodValidate } from "../../middlewares/validations/zodValidation.middleware";
import { bookingFormValidation } from "../BookingForm/bookingForm.validation";
import { estimateFormValidation } from "../EstimateForm/estimateForm.validation";
import { websiteController } from "./website.controller";
import { websiteValidation } from "./website.validation";
import { publicWebsiteSpamGuard } from "../../middlewares/publicSpamProtection";

const router = Router();

router.get("/resolve-subdomain/:subdomain", publicHostResolveRateLimit, websiteController.resolvePublicSubdomain);
router.get("/resolve-host/:host", publicHostResolveRateLimit, websiteController.resolvePublicHost);

// Website-scoped booking integration. These routes intentionally resolve the
// published website's primaryBookingFormId on every request, then delegate to
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
  publicMutationRateLimit,
  publicResourceMutationRateLimit,
  publicWebsiteSpamGuard,
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
  publicMutationRateLimit,
  publicResourceMutationRateLimit,
  zodValidate(estimateFormValidation.publicCalculation, ValidationProperty.BODY),
  websiteController.calculatePublicWebsiteEstimate,
);
router.post(
  "/:identifier/estimate",
  publicMutationRateLimit,
  publicResourceMutationRateLimit,
  publicWebsiteSpamGuard,
  zodValidate(estimateFormValidation.publicSubmission, ValidationProperty.BODY),
  websiteController.submitPublicWebsiteEstimate,
);

// Public website acquisition. Contact enquiries enter the tenant's native CRM
// Lead pipeline and are deduplicated by normalized email or phone inside the service.
router.post(
  "/:identifier/contact",
  publicContactMutationRateLimit,
  publicContactResourceRateLimit,
  publicWebsiteSpamGuard,
  zodValidate(websiteValidation.publicContact, ValidationProperty.BODY),
  websiteController.submitPublicWebsiteContact,
);

router.post(
  "/:identifier/analytics",
  publicTelemetryRateLimit,
  publicResourceTelemetryRateLimit,
  zodValidate(websiteValidation.publicAnalytics, ValidationProperty.BODY),
  websiteController.trackPublicWebsiteAnalytics,
);
router.post(
  "/:identifier/error",
  publicTelemetryRateLimit,
  publicResourceTelemetryRateLimit,
  zodValidate(websiteValidation.publicClientError, ValidationProperty.BODY),
  websiteController.reportPublicWebsiteError,
);

router.get("/:identifier", publicReadRateLimit, websiteController.getPublicWebsite);

export const publicWebsiteRoutes = router;
