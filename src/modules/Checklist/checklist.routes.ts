import { Router } from "express";
import { checklistController } from "./checklist.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";

const router = Router();

// ── Checklist Templates  (ADMIN / SUPER_ADMIN only) ───────────────────────────

router.get(
    "/templates",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    checklistController.getAllTemplates,
);

router.post(
    "/templates",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    checklistController.createTemplate,
);

router.get(
    "/templates/:id",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    checklistController.getTemplateById,
);

router.patch(
    "/templates/:id",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    checklistController.updateTemplate,
);

router.delete(
    "/templates/:id",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    checklistController.deleteTemplate,
);

// ── Job Checklists ─────────────────────────────────────────────────────────────

// Admin attaches / reads checklists on a job
router.get(
    "/job/:jobId",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.STAFF),
    checklistController.getJobChecklists,
);

router.post(
    "/job/:jobId",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    checklistController.attachToJob,
);

router.delete(
    "/:checklistId",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN),
    checklistController.detachFromJob,
);

// PATCH  /api/v1/checklist/:checklistId/items/:itemId
// STAFF can tick/untick items; ADMIN can too (e.g. in job detail view)
router.patch(
    "/:checklistId/items/:itemId",
    checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.STAFF),
    checklistController.updateItemCompletion,
);

export const checklistRoutes = router;
