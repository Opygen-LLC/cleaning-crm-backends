import { Router } from "express";
import authRoutes from "../modules/Auth/auth.route";
import { userRoutes } from "../modules/User/user.routes";
import { adminRoutes } from "../modules/Admin/admin.routes";

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
        path: "/admin",
        route: adminRoutes,
    },
];

routes.forEach((route) => {
    router.use(route.path, route.route);
});

export default router;
