import { Router } from "express";
import { checklistController } from "./checklist.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";

const router = Router();

// All checklist endpoints require admin auth
router.use(checkAuth(UserRole.ADMIN, UserRole.SUPER_ADMIN));

// ── Checklist Templates ────────────────────────────────────────────────────────

// GET    /api/v1/checklist/templates          — list all templates
router.get("/templates", checklistController.getAllTemplates);

// POST   /api/v1/checklist/templates          — create a template
router.post("/templates", checklistController.createTemplate);

// GET    /api/v1/checklist/templates/:id      — get single template
router.get("/templates/:id", checklistController.getTemplateById);

// PATCH  /api/v1/checklist/templates/:id      — update template + tasks
router.patch("/templates/:id", checklistController.updateTemplate);

// DELETE /api/v1/checklist/templates/:id      — delete template
router.delete("/templates/:id", checklistController.deleteTemplate);

// ── Job Checklists ────────────────────────────────────────────────────────────

// GET    /api/v1/checklist/job/:jobId          — get all checklists on a job
router.get("/job/:jobId", checklistController.getJobChecklists);

// POST   /api/v1/checklist/job/:jobId          — attach a template to a job
//        body: { templateId: string }
router.post("/job/:jobId", checklistController.attachToJob);

// DELETE /api/v1/checklist/:checklistId        — detach checklist from job
router.delete("/:checklistId", checklistController.detachFromJob);

// PATCH  /api/v1/checklist/:checklistId/items/:itemId — tick / untick an item
//        body: { completed: boolean }
router.patch("/:checklistId/items/:itemId", checklistController.updateItemCompletion);

export const checklistRoutes = router;
