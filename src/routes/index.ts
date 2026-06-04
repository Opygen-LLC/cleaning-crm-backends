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
// Phase 1: recurring booking engine
import { recurringBookingRoutes } from "../modules/RecurringBooking/recurringBooking.routes";
// Phase 8: super-admin module
import { superAdminRoutes } from "../modules/SuperAdmin/superAdmin.routes";
import { pricingRulesRoutes } from "../modules/PricingRules/pricingRules.routes";
import { dashboardRoutes } from "../modules/Dashboard/dashboard.routes";
import { paymentGatewayRoutes } from "../modules/Settings/paymentGateway.routes";
import { checklistRoutes } from "../modules/Checklist/checklist.routes";
import { staffLeaveRoutes } from "../modules/StaffLeave/staffLeave.routes";

const router = Router();

const routes: { path: string; route: Router }[] = [
    { path: "/auth", route: authRoutes },
    { path: "/user", route: userRoutes },
    { path: "/session", route: sessionRoutes },
    { path: "/admin", route: adminRoutes },
    { path: "/staff", route: staffRoutes },
    { path: "/client", route: clientRoutes },
    { path: "/subscription", route: subscriptionRoutes },
    { path: "/subscription-plan", route: subscriptionPlanRoutes },
    { path: "/service-catalog", route: serviceCatalogRoutes },
    { path: "/invoice", route: invoiceRoutes },
    { path: "/expense", route: expenseRoutes },
    { path: "/booking", route: bookingRoutes },
    { path: "/lead", route: leadRoutes },
    { path: "/dashboard", route: dashboardRoutes },
    { path: "/notification", route: notificationRoutes },
    { path: "/payment-gateway", route: paymentGatewayRoutes },
    { path: "/job", route: jobRoutes },
    { path: "/quote", route: quoteRoutes },
    { path: "/estimate", route: estimateRoutes },
    { path: "/estimate-form", route: estimateFormRoutes },
    { path: "/review", route: reviewRoutes },
    { path: "/reports", route: reportsRoutes },
    { path: "/booking-form", route: bookingFormRoutes },
    { path: "/checklist", route: checklistRoutes },
    { path: "/recurring-booking", route: recurringBookingRoutes },
    { path: "/super-admin", route: superAdminRoutes },
    { path: "/pricing-rules", route: pricingRulesRoutes },
    { path: "/staff-leave", route: staffLeaveRoutes },
];

routes.forEach((route) => {
    router.use(route.path, route.route);
});

export default router;
