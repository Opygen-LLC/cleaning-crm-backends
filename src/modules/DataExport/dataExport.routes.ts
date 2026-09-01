import { Router } from "express";
import { UserRole } from "../../generated/prisma/enums";
import { checkAuth } from "../../middlewares/checkAuth";
import { ValidationProperty, zodValidate } from "../../middlewares/validations/zodValidation.middleware";
import { dataExportController } from "./dataExport.controller";
import { dataExportSchema } from "./dataExport.schema";

const router = Router();

router.post(
  "/",
  checkAuth(UserRole.ADMIN),
  zodValidate(dataExportSchema.create, ValidationProperty.BODY),
  dataExportController.createDataExport,
);

export const dataExportRoutes = router;
