import { Router } from "express";
import { subscriptionPlanController } from "./subscriptionPlan.controller";

const router = Router();

router.get("/", subscriptionPlanController.getAllSubscriptionPlans);

export const subscriptionPlanRoutes = router;
