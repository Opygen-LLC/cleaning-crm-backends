import { Router } from "express";
import {
  publicMutationRateLimit,
  publicReadRateLimit,
  publicHostResolveRateLimit,
  publicResourceMutationRateLimit,
} from "../../middlewares/publicApiSecurity";
import { ValidationProperty, zodValidate } from "../../middlewares/validations/zodValidation.middleware";
import { bookingFormValidation } from "../BookingForm/bookingForm.validation";
import { websiteController } from "./website.controller";

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

router.get("/:identifier", publicReadRateLimit, websiteController.getPublicWebsite);

export const publicWebsiteRoutes = router;
