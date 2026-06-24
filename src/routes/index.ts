/**
 * src/routes/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Central route registration.
 *
 * KEY CHANGE FROM ORIGINAL:
 *   The staffLeaveRoutes were previously mounted at "/staff-leave" which made
 *   the real paths /api/v1/staff-leave/leave — a mismatch with what the
 *   frontend's staffDashboardApi calls (/staff/leave, /staff/leave/all, etc.).
 *
 *   Fix: staffLeaveRoutes is now REMOVED from gatedRoutes entirely because
 *   staffRoutes (staff.routes.ts) already imports staffLeaveController and
 *   registers all /leave/* handlers directly. Keeping staffLeaveRoutes at
 *   /staff would create duplicate route registrations.
 *
 *   The correct architecture is:
 *     staffRoutes  (mounted at /staff) — owns ALL /staff/* paths including leave
 *     staffLeaveRoutes — no longer mounted separately; left in codebase for
 *                        reference but excluded here.
 */

import { Router } from "express";
import authRoutes from "../modules/Auth/auth.route";
import { userRoutes } from "../modules/User/user.routes";
import { adminRoutes } from "../modules/Admin/admin.routes";
import { staffRoutes } from "../modules/Staff/staff.routes";
import { clientRoutes } from "../modules/Client/client.routes";
import { serviceCatalogRoutes } from "../modules/ServiceCatalog/serviceCatalog.routes";
import { invoiceRoutes } from "../modules/Invoice/invoice.routes";
import { expenseRoutes } from "../modules/Expense/expense.routes";
import { sessionRoutes } from "../modules/Session/session.routes";
import { subscriptionPlanRoutes } from "../modules/SubscriptionPlan/subscriptionPlan.routes";
import { subscriptionRoutes } from "../modules/Subscription/subscription.routes";
import { notificationRoutes } from "../modules/Settings/notification.routes";
import { bookingRoutes } from "../modules/Booking/booking.routes";
import { leadRoutes } from "../modules/Lead/lead.routes";
import { jobRoutes } from "../modules/Job/job.routes";
import { quoteRoutes } from "../modules/Quote/quote.routes";
import { estimateRoutes } from "../modules/Estimate/estimate.routes";
import { estimateFormRoutes } from "../modules/EstimateForm/estimateForm.routes";
import { reviewRoutes } from "../modules/Review/review.routes";
import { reportsRoutes } from "../modules/Reports/reports.routes";
import { bookingFormRoutes } from "../modules/BookingForm/bookingForm.routes";
import { recurringBookingRoutes } from "../modules/RecurringBooking/recurringBooking.routes";
import { superAdminRoutes } from "../modules/SuperAdmin/superAdmin.routes";
import { pricingRulesRoutes } from "../modules/PricingRules/pricingRules.routes";
import { dashboardRoutes } from "../modules/Dashboard/dashboard.routes";
import { checklistRoutes } from "../modules/Checklist/checklist.routes";
// NOTE: staffLeaveRoutes intentionally NOT imported — staffRoutes owns all /staff/* paths.
// See comment block at top of this file.
import { couponRoutes } from "../modules/Coupon/coupon.routes";
import { checkSubscription } from "../middlewares/checkSubscription";

const router = Router();

// ─── Public / auth routes (no subscription gate) ─────────────────────────────
const openRoutes: { path: string; route: Router }[] = [
  { path: "/auth", route: authRoutes },
  { path: "/user", route: userRoutes },
  { path: "/session", route: sessionRoutes },
  { path: "/subscription", route: subscriptionRoutes },
  { path: "/subscription-plan", route: subscriptionPlanRoutes },
  { path: "/booking-form", route: bookingFormRoutes },
  { path: "/estimate-form", route: estimateFormRoutes },
  { path: "/super-admin", route: superAdminRoutes },
];

// ─── Gated routes (subscription required) ────────────────────────────────────
// staffRoutes handles ALL /staff/* paths including:
//   GET  /staff/me             — own profile
//   PATCH /staff/me            — update profile
//   POST /staff/me/avatar      — upload photo
//   POST /staff/leave          — request leave (→ socket to admin)
//   GET  /staff/leave          — own leave list
//   GET  /staff/leave/all      — admin: all leaves
//   DELETE /staff/leave/:id    — cancel leave (→ socket to admin)
//   PATCH /staff/leave/:id/review — admin review (→ socket to staff)
//   GET  /staff/               — admin list staff
//   GET  /staff/:id            — admin get single staff
//   etc.
const gatedRoutes: { path: string; route: Router }[] = [
  { path: "/admin", route: adminRoutes },
  { path: "/staff", route: staffRoutes }, // ← owns leave sub-routes too
  { path: "/client", route: clientRoutes },
  { path: "/service-catalog", route: serviceCatalogRoutes },
  { path: "/invoice", route: invoiceRoutes },
  { path: "/expense", route: expenseRoutes },
  { path: "/booking", route: bookingRoutes },
  { path: "/lead", route: leadRoutes },
  { path: "/dashboard", route: dashboardRoutes }, // GET /dashboard/staff lives here
  { path: "/notification", route: notificationRoutes },
  { path: "/job", route: jobRoutes },
  { path: "/quote", route: quoteRoutes },
  { path: "/estimate", route: estimateRoutes },
  { path: "/review", route: reviewRoutes },
  { path: "/reports", route: reportsRoutes },
  { path: "/checklist", route: checklistRoutes },
  { path: "/recurring-booking", route: recurringBookingRoutes },
  { path: "/pricing-rules", route: pricingRulesRoutes },
  { path: "/coupon", route: couponRoutes },
  // /staff-leave intentionally REMOVED — was causing path mismatch
];

openRoutes.forEach(({ path, route }) => {
  router.use(path, route);
});

gatedRoutes.forEach(({ path, route }) => {
  router.use(path, checkSubscription, route);
});

export default router;
