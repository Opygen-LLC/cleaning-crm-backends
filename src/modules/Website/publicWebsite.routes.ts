import { Router } from "express";
import {
  publicMutationRateLimit,
  publicReadRateLimit,
  publicHostResolveRateLimit,
  publicResourceMutationRateLimit,
} from "../../middlewares/publicApiSecurity";
import { ValidationProperty, zodValidate } from "../../middlewares/validations/zodValidation.middleware";
import { bookingFormValidation } from "../BookingForm/bookingForm.validation";
import { estimateFormValidation } from "../EstimateForm/estimateForm.validation";
import { websiteController } from "./website.controller";
import { websiteValidation } from "./website.validation";

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
  zodValidate(estimateFormValidation.publicSubmission, ValidationProperty.BODY),
  websiteController.submitPublicWebsiteEstimate,
);

// Public website acquisition. Contact enquiries enter the tenant's native CRM
// Lead pipeline and are deduplicated by normalized email inside the service.
router.post(
  "/:identifier/contact",
  publicMutationRateLimit,
  publicResourceMutationRateLimit,
  zodValidate(websiteValidation.publicContact, ValidationProperty.BODY),
  websiteController.submitPublicWebsiteContact,
);

router.get("/:identifier", publicReadRateLimit, websiteController.getPublicWebsite);

export const publicWebsiteRoutes = router;
