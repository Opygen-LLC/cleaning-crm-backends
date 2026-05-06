import { Router } from "express";
import authRoutes from "../modules/Auth/auth.route";
import { userRoutes } from "../modules/User/user.routes";
import { adminRoutes } from "../modules/Admin/admin.routes";
import { staffRoutes } from "../modules/Staff/staff.routes";
import { clientRoutes } from "../modules/Client/client.routes";
import { serviceCatalogRoutes } from "../modules/ServiceCatalog/serviceCatalog.routes";
import { invoiceRoutes } from "../modules/Invoice/invoice.routes";
import { sessionRoutes } from "../modules/Session/session.routes";

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
        path: "/service-catalog",
        route: serviceCatalogRoutes,
    },
    {
        path: "/invoice",
        route: invoiceRoutes,
    },
];

routes.forEach((route) => {
    router.use(route.path, route.route);
});

export default router;
