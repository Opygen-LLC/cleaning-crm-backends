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

const router = Router();

const routes: { path: string; route: Router }[] = [
    {
        path: "/auth",
        route: authRoutes,
    },
    {
        path: "/user",
        route: userRoutes,
    },
    {
        path: "/session",
        route: sessionRoutes,
    },
    {
        path: "/admin",
        route: adminRoutes,
    },
    {
        path: "/staff",
        route: staffRoutes,
    },
    {
        path: "/client",
        route: clientRoutes,
    },
    {
        path: "/subscription",
        route: subscriptionRoutes,
    },
    {
        path: "/subscription-plan",
        route: subscriptionPlanRoutes,
    },
    {
        path: "/service-catalog",
        route: serviceCatalogRoutes,
    },
    {
        path: "/invoice",
        route: invoiceRoutes,
    },
    {
        path: "/expense",
        route: expenseRoutes,
    },
];

routes.forEach((route) => {
    router.use(route.path, route.route);
});

export default router;
