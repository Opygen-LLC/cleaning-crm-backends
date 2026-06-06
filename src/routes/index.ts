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
import { paymentGatewayRoutes } from "../modules/Settings/paymentGateway.routes";
import { checklistRoutes } from "../modules/Checklist/checklist.routes";
import { staffLeaveRoutes } from "../modules/StaffLeave/staffLeave.routes";
import { couponRoutes } from "../modules/Coupon/coupon.routes";
// ─── Item 8: subscription enforcement middleware ──────────────────────────────
import { checkSubscription } from "../middlewares/checkSubscription";

const router = Router();

// ─── Public / auth routes (no subscription gate) ─────────────────────────────
// These routes must remain open: auth, session, subscription self-service,
// subscription plans listing, booking-form / estimate-form (public widgets),
// and the super-admin portal.
const openRoutes: { path: string; route: Router }[] = [
  { path: "/auth",             route: authRoutes },
  { path: "/user",             route: userRoutes },
  { path: "/session",          route: sessionRoutes },
  { path: "/subscription",     route: subscriptionRoutes },     // /me, /submit-proof, /change-plan etc.
  { path: "/subscription-plan", route: subscriptionPlanRoutes }, // public plan listing
  { path: "/booking-form",     route: bookingFormRoutes },       // public booking widget
  { path: "/estimate-form",    route: estimateFormRoutes },      // public estimate widget
  { path: "/super-admin",      route: superAdminRoutes },        // SA has its own auth guard
];

// ─── Gated routes (subscription required) ────────────────────────────────────
// checkSubscription reads req.user (set by checkAuth inside each sub-router)
// and returns 402 if the tenant's subscription is blocked.
const gatedRoutes: { path: string; route: Router }[] = [
  { path: "/admin",            route: adminRoutes },
  { path: "/staff",            route: staffRoutes },
  { path: "/client",           route: clientRoutes },
  { path: "/service-catalog",  route: serviceCatalogRoutes },
  { path: "/invoice",          route: invoiceRoutes },
  { path: "/expense",          route: expenseRoutes },
  { path: "/booking",          route: bookingRoutes },
  { path: "/lead",             route: leadRoutes },
  { path: "/dashboard",        route: dashboardRoutes },
  { path: "/notification",     route: notificationRoutes },
  { path: "/payment-gateway",  route: paymentGatewayRoutes },
  { path: "/job",              route: jobRoutes },
  { path: "/quote",            route: quoteRoutes },
  { path: "/estimate",         route: estimateRoutes },
  { path: "/review",           route: reviewRoutes },
  { path: "/reports",          route: reportsRoutes },
  { path: "/checklist",        route: checklistRoutes },
  { path: "/recurring-booking", route: recurringBookingRoutes },
  { path: "/pricing-rules",    route: pricingRulesRoutes },
  { path: "/staff-leave",      route: staffLeaveRoutes },
  // Coupon module has its own per-route checkAuth guards (SUPER_ADMIN / SUPER_ADMIN_OR_ADMIN)
  { path: "/coupon",           route: couponRoutes },
];

// Register open routes first
openRoutes.forEach(({ path, route }) => {
  router.use(path, route);
});

// Register gated routes — checkSubscription fires before each sub-router's
// own checkAuth, but since checkSubscription short-circuits on non-ADMIN
// users (returning next() immediately), it is safe for staff/superadmin too.
gatedRoutes.forEach(({ path, route }) => {
  router.use(path, checkSubscription, route);
});

export default router;
