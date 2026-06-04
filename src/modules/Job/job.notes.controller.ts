/**
 * job.notes.controller.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * HTTP handlers for job notes & file attachments (Phase 1)
 */

import status               from "http-status";
import { catchAsync }       from "../../shared/catchAsync";
import { sendResponse }     from "../../shared/sendResponse";
import { jobNotesService }  from "./job.notes.service";
import { NoteType }         from "../../generated/prisma/enums";

// ─── Notes ────────────────────────────────────────────────────────────────────

/**
 * GET /job/:id/notes
 * Returns all notes for a job, pinned first then newest first.
 */
const getNotes = catchAsync(async (req, res) => {
    const result = await jobNotesService.getNotes(req.params.id, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success:        true,
        message:        "Job notes retrieved successfully",
        data:           result,
    });
});

/**
 * POST /job/:id/notes
 * Body: { body: string, type?: NoteType, pinned?: boolean, authorName?: string }
 */
const createNote = catchAsync(async (req, res) => {
    const result = await jobNotesService.createNote(
        req.params.id,
        {
            body:       req.body.body,
            type:       req.body.type       as NoteType | undefined,
            pinned:     req.body.pinned,
            // Fall back to the authenticated user's name if authorName not provided
            authorName: req.body.authorName ?? (req.user as any)?.name ?? "Admin",
        },
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success:        true,
        message:        "Note created successfully",
        data:           result,
    });
});

/**
 * PATCH /job/:id/notes/:noteId
 * Body: { body?: string, type?: NoteType, pinned?: boolean }
 */
const updateNote = catchAsync(async (req, res) => {
    const result = await jobNotesService.updateNote(
        req.params.id,
        req.params.noteId,
        {
            body:   req.body.body,
            type:   req.body.type   as NoteType | undefined,
            pinned: req.body.pinned,
        },
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success:        true,
        message:        "Note updated successfully",
        data:           result,
    });
});

/**
 * DELETE /job/:id/notes/:noteId
 */
const deleteNote = catchAsync(async (req, res) => {
    const result = await jobNotesService.deleteNote(
        req.params.id,
        req.params.noteId,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success:        true,
        message:        "Note deleted successfully",
        data:           result,
    });
});

// ─── Attachments ──────────────────────────────────────────────────────────────

/**
 * GET /job/:id/attachments
 */
const getAttachments = catchAsync(async (req, res) => {
    const result = await jobNotesService.getAttachments(req.params.id, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success:        true,
        message:        "Attachments retrieved successfully",
        data:           result,
    });
});

/**
 * POST /job/:id/attachments
 * Expects multipart/form-data with field name "file"
 */
const uploadAttachment = catchAsync(async (req, res) => {
    const file = req.file;
    if (!file) {
        res.status(status.BAD_REQUEST).json({
            success: false,
            message: "No file uploaded — use multipart/form-data with field name 'file'",
        });
        return;
    }

    const result = await jobNotesService.uploadAttachment(
        req.params.id,
        file,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success:        true,
        message:        "Attachment uploaded successfully",
        data:           result,
    });
});

/**
 * DELETE /job/:id/attachments/:attachId
 */
const deleteAttachment = catchAsync(async (req, res) => {
    const result = await jobNotesService.deleteAttachment(
        req.params.id,
        req.params.attachId,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success:        true,
        message:        "Attachment deleted successfully",
        data:           result,
    });
});

export const jobNotesController = {
    getNotes,
    createNote,
    updateNote,
    deleteNote,
    getAttachments,
    uploadAttachment,
    deleteAttachment,
};
