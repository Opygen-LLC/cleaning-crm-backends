import { Router } from "express";
import { clientValidation } from "./client.validation";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { clientController } from "./client.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import { resolvePortalClient } from "../../middlewares/checkPortalAuth";
import { bookingChangeRequestController } from "../BookingChangeRequest/bookingChangeRequest.controller";
import { bookingChangeRequestValidation } from "../BookingChangeRequest/bookingChangeRequest.validation";

const router = Router();

// ── Booking change requests (client reschedule/cancellation asks) ────────────
// Must be registered BEFORE "/:adminId" below — otherwise Express's
// single-segment ":adminId" param route would shadow "/booking-requests".
router.get(
    "/booking-requests",
    checkAuth(UserRole.ADMIN),
    bookingChangeRequestController.getRequests,
);

router.patch(
    "/booking-requests/:id/decision",
    checkAuth(UserRole.ADMIN),
    zodValidate(
        bookingChangeRequestValidation.decideBookingChangeRequest,
        ValidationProperty.BODY,
    ),
    bookingChangeRequestController.decideRequest,
);

// ── Public client portal — no auth session required. ────────────────────────
// Access is gated by the opaque portalAccessToken (a random UUID), NOT the
// plain client id. The token is what makes the URL unguessable.
router.get("/portal/:portalToken", clientController.getClientPortal);

// Client (portal): request a reschedule or cancellation on an upcoming
// booking. Creates a pending BookingChangeRequest for the admin to review —
// the booking itself is untouched until approved.
router.post(
    "/portal/:portalToken/booking-requests",
    resolvePortalClient,
    zodValidate(
        bookingChangeRequestValidation.createBookingChangeRequest,
        ValidationProperty.BODY,
    ),
    bookingChangeRequestController.createRequest,
);

// ── Admin routes ─────────────────────────────────────────────────────────────

// Lightweight typeahead projection for selectors; never returns portal/security fields.
router.get(
    "/lookup",
    checkAuth(UserRole.ADMIN),
    clientController.getClientLookup,
);

// Lightweight projection used when starting a booking from an existing client.
router.get(
    "/detail/:id/booking-prefill",
    checkAuth(UserRole.ADMIN),
    clientController.getClientBookingPrefill,
);

// Get client by id
router.get(
    "/detail/:id",
    checkAuth(UserRole.ADMIN),
    clientController.getClientById,
);

// Admin: rotate the portal access token — invalidates previously shared links.
// Must be authenticated as ADMIN and must own the client record.
router.post(
    "/:id/regenerate-portal-token",
    checkAuth(UserRole.ADMIN),
    clientController.regeneratePortalToken,
);

// Create client
router.post(
    "/",
    checkAuth(UserRole.ADMIN),
    zodValidate(clientValidation.createClient, ValidationProperty.BODY),
    clientController.createClient,
);

// Get all clients for authenticated admin
router.get("/", checkAuth(UserRole.ADMIN), clientController.getClients);

// Update client
router.patch(
    "/:id",
    checkAuth(UserRole.ADMIN),
    zodValidate(clientValidation.updateClient, ValidationProperty.BODY),
    clientController.updateClient,
);

// Delete client
router.delete("/:id", checkAuth(UserRole.ADMIN), clientController.deleteClient);

// Get all clients for an admin (legacy path with explicit adminId param)
router.get("/:adminId", checkAuth(UserRole.ADMIN), clientController.getClients);

export const clientRoutes = router;
