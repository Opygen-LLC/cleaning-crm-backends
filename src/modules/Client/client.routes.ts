import { Router } from "express";
import { clientValidation } from "./client.validation";
import { ValidationProperty, zodValidate } from "../../middlewares/validations/zodValidation.middleware";

const router = Router();

router.post("/:adminId", zodValidate(clientValidation.createClient, ValidationProperty.BODY));

export const clientRoutes = router;