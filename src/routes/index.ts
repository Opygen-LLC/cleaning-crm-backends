import { Router } from "express";
import authRoutes from "../modules/Auth/auth.route";
// Initialize the router
const router = Router();

router.use("/auth", authRoutes);

export default router;
