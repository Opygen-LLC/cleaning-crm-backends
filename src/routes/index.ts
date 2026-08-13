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
import { quotePublicRoutes } from "../modules/Quote/quote.public.routes";
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
import { staffLeaveRoutes } from "../modules/StaffLeave/staffLeave.routes";
import { couponRoutes } from "../modules/Coupon/coupon.routes";
import { paymentRoutes } from "../modules/Payment/payment.routes";
import { pushRoutes } from "../modules/Push/push.routes";
import { checkSubscription } from "../middlewares/checkSubscription";
import express from "express";

const router = Router();

// ─── Public / auth routes (no subscription gate) ─────────────────────────────
const openRoutes: { path: string; route: Router }[] = [
    { path: "/auth",            route: authRoutes },
    { path: "/user",            route: userRoutes },
    { path: "/session",         route: sessionRoutes },
    { path: "/subscription",    route: subscriptionRoutes },
    { path: "/subscription-plan", route: subscriptionPlanRoutes },
    { path: "/booking-form",    route: bookingFormRoutes },
    { path: "/estimate-form",   route: estimateFormRoutes },
    { path: "/quote/public",    route: quotePublicRoutes },
    { path: "/super-admin",     route: superAdminRoutes },
];

// ─── Gated routes (subscription required) ────────────────────────────────────
// IMPORTANT: staffLeaveRoutes is mounted at "/staff" (not "/staff-leave").
// staffLeaveRoutes defines paths like /leave, /leave/:id, /leave/all,
// /leave/:id/review — none of which collide with staffRoutes handlers.
// Express matches them in registration order; both routers live under
// the same "/staff" prefix and work correctly side-by-side.
//
// Frontend staffDashboardApi calls:
//   POST   /staff/leave            → staffLeaveRoutes /leave
//   GET    /staff/leave            → staffLeaveRoutes /leave
//   DELETE /staff/leave/:id        → staffLeaveRoutes /leave/:id
//   GET    /staff/leave/all        → staffLeaveRoutes /leave/all
//   PATCH  /staff/leave/:id/review → staffLeaveRoutes /leave/:id/review
const gatedRoutes: { path: string; route: Router }[] = [
    { path: "/admin",             route: adminRoutes },
    // staffRoutes contains /me, /me/avatar, /:id, /:id/availability etc.
    { path: "/staff",             route: staffRoutes },
    // staffLeaveRoutes contains /leave, /leave/all, /leave/:id, /leave/:id/review
    // Mounted at "/staff" so final paths are /staff/leave/* as the frontend expects.
    { path: "/staff",             route: staffLeaveRoutes },
    { path: "/client",            route: clientRoutes },
    { path: "/service-catalog",   route: serviceCatalogRoutes },
    { path: "/invoice",           route: invoiceRoutes },
    { path: "/expense",           route: expenseRoutes },
    { path: "/booking",           route: bookingRoutes },
    { path: "/lead",              route: leadRoutes },
    { path: "/dashboard",         route: dashboardRoutes },
    { path: "/notification",      route: notificationRoutes },
    { path: "/job",               route: jobRoutes },
    { path: "/quote",             route: quoteRoutes },
    { path: "/estimate",          route: estimateRoutes },
    { path: "/review",            route: reviewRoutes },
    { path: "/reports",           route: reportsRoutes },
    { path: "/checklist",         route: checklistRoutes },
    { path: "/recurring-booking", route: recurringBookingRoutes },
    { path: "/pricing-rules",     route: pricingRulesRoutes },
    { path: "/coupon",            route: couponRoutes },
    // Payment module — manual cash/bank/cheque payment recording
    { path: "/payment",           route: paymentRoutes },
    { path: "/push",              route: pushRoutes },
];

openRoutes.forEach(({ path, route }) => {
    router.use(path, route);
});

// checkSubscription short-circuits on non-ADMIN users so staff routes are safe.
gatedRoutes.forEach(({ path, route }) => {
    router.use(path, checkSubscription, route);
});

export default router;
