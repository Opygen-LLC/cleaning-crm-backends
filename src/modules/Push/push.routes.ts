import { Router } from "express";
import { UserRole } from "../../generated/prisma/enums";
import { checkAuth } from "../../middlewares/checkAuth";
import { ValidationProperty, zodValidate } from "../../middlewares/validations/zodValidation.middleware";
import { pushController } from "./push.controller";
import { pushValidation } from "./push.validation";

const router = Router();

router.get("/public-key", checkAuth(UserRole.STAFF, UserRole.ADMIN), pushController.getPublicKey);
router.post(
    "/subscribe",
    checkAuth(UserRole.STAFF, UserRole.ADMIN),
    zodValidate(pushValidation.subscription, ValidationProperty.BODY),
    pushController.subscribe,
);
router.delete(
    "/subscribe",
    checkAuth(UserRole.STAFF, UserRole.ADMIN),
    zodValidate(pushValidation.subscription.pick({ endpoint: true }), ValidationProperty.BODY),
    pushController.unsubscribe,
);

export const pushRoutes = router;
