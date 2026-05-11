import { Router } from "express";
import { subscriptionController } from "./subscription.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";

const router = Router();

router.get("/me", checkAuth(UserRole.ADMIN), subscriptionController.getMySubscription);

export const subscriptionRoutes = router;