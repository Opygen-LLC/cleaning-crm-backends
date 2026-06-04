/**
 * job.notes.validation.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Zod schemas for job note and attachment endpoints (Phase 1)
 */

import { z }        from "zod";
import { NoteType } from "../../generated/prisma/enums";

// ─── Note schemas ─────────────────────────────────────────────────────────────

const createNoteSchema = z
    .object({
        body:       z.string().min(1, "Note body cannot be empty").max(2000, "Note body too long"),
        type:       z.nativeEnum(NoteType).optional(),
        pinned:     z.boolean().optional(),
        authorName: z.string().min(1).max(100).optional(),
    })
    .strict();

const updateNoteSchema = z
    .object({
        body:   z.string().min(1).max(2000).optional(),
        type:   z.nativeEnum(NoteType).optional(),
        pinned: z.boolean().optional(),
    })
    .strict()
    .refine(
        (data) => Object.values(data).some((v) => v !== undefined),
        { message: "At least one field must be provided" },
    );

export const jobNotesValidation = {
    createNote: createNoteSchema,
    updateNote: updateNoteSchema,
};
