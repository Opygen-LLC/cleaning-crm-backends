import { Router } from "express";
import { clientValidation } from "./client.validation";
import { ValidationProperty, zodValidate } from "../../middlewares/validations/zodValidation.middleware";
import { clientController } from "./client.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";

const router = Router();

// Create client
router.post(
    "/",
    checkAuth(UserRole.ADMIN),
    zodValidate(clientValidation.createClient, ValidationProperty.BODY),
    clientController.createClient,
);

// Get all clients for an admin
router.get(
    "/:adminId",
    checkAuth(UserRole.ADMIN),
    clientController.getClients,
);

// Get client by id
router.get(
    "/detail/:id",
    checkAuth(UserRole.ADMIN),
    clientController.getClientById,
);

// Update client
router.patch(
    "/:id",
    checkAuth(UserRole.ADMIN),
    zodValidate(clientValidation.updateClient, ValidationProperty.BODY),
    clientController.updateClient,
);

// Delete client
router.delete(
    "/:id",
    checkAuth(UserRole.ADMIN),
    clientController.deleteClient,
);

export const clientRoutes = router;
