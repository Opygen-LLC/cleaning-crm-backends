import { Router } from "express";
import { subscriptionPlanController } from "./subscriptionPlan.controller";

const router = Router();

router.get("/", subscriptionPlanController.getAllSubscriptionPlans);
router.get("/:id", subscriptionPlanController.getSubscriptionPlanById);

export const subscriptionPlanRoutes = router;
