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

router.post(
  "/bulk",
  checkAuth(UserRole.ADMIN),
  zodValidate(
    serviceCatalogValidation.bulkCreateServiceCatalog,
    ValidationProperty.BODY,
  ),
  serviceCatalogController.bulkUpsertServiceCatalogs,
);

router.get(
  "/",
  checkAuth(UserRole.ADMIN, UserRole.STAFF),
  zodValidate(
    serviceCatalogValidation.serviceCatalogFilters,
    ValidationProperty.QUERY,
  ),
  serviceCatalogController.getAllServiceCatalogs,
);

// Keep literal routes before /:id so "recommended" can never be interpreted
// as a catalogue identifier.
router.get(
  "/recommended",
  checkAuth(UserRole.ADMIN),
  serviceCatalogController.getRecommendedServices,
);

router.post(
  "/recommended/import",
  checkAuth(UserRole.ADMIN),
  serviceCatalogController.importRecommendedServices,
);

router.get(
  "/:id",
  checkAuth(UserRole.ADMIN, UserRole.STAFF),
  zodValidate(
    serviceCatalogValidation.serviceCatalogIdParams,
    ValidationProperty.PARAMS,
  ),
  serviceCatalogController.getServiceCatalogById,
);

router.patch(
  "/:id",
  checkAuth(UserRole.ADMIN),
  zodValidate(
    serviceCatalogValidation.serviceCatalogIdParams,
    ValidationProperty.PARAMS,
  ),
  zodValidate(
    serviceCatalogValidation.updateServiceCatalog,
    ValidationProperty.BODY,
  ),
  serviceCatalogController.updateServiceCatalog,
);

router.delete(
  "/:id",
  checkAuth(UserRole.ADMIN),
  zodValidate(
    serviceCatalogValidation.serviceCatalogIdParams,
    ValidationProperty.PARAMS,
  ),
  serviceCatalogController.deleteServiceCatalog,
);

export const serviceCatalogRoutes = router;
