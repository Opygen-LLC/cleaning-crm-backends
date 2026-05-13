import { Router } from "express";
import { clientValidation } from "./client.validation";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { clientController } from "./client.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";

const router = Router();

router.post(
    "/",
	checkAuth(UserRole.ADMIN),
    zodValidate(clientValidation.createClient, ValidationProperty.BODY),
    clientController.createClient,
);

export const clientRoutes = router;
