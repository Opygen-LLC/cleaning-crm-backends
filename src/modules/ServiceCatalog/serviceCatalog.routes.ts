import { Router } from "express";
import { serviceCatalogController } from "./serviceCatalog.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
  ValidationProperty,
  zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { serviceCatalogValidation } from "./serviceCatalog.validation";

const router = Router();

router.post(
  "/",
  checkAuth(UserRole.ADMIN),
  zodValidate(
    serviceCatalogValidation.createServiceCatalog,
    ValidationProperty.BODY,
  ),
  serviceCatalogController.createServiceCatalog,
);

router.get(
  "/",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.STAFF),
  serviceCatalogController.getAllServiceCatalogs,
);

router.get(
  "/:id",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.STAFF),
  serviceCatalogController.getServiceCatalogById,
);

router.patch(
  "/:id",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  zodValidate(
    serviceCatalogValidation.updateServiceCatalog,
    ValidationProperty.BODY,
  ),
  serviceCatalogController.updateServiceCatalog,
);

router.delete(
  "/:id",
  checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
  serviceCatalogController.deleteServiceCatalog,
);

export const serviceCatalogRoutes = router;
