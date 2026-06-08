/**
 * job.notes.service.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Phase 1 — previously missing: job notes & file attachment backend
 *
 * Endpoints surfaced:
 *   GET    /job/:id/notes                  list all notes for a job
 *   POST   /job/:id/notes                  create a note
 *   PATCH  /job/:id/notes/:noteId          update body / type / pinned
 *   DELETE /job/:id/notes/:noteId          delete a note
 *
 *   POST   /job/:id/attachments            upload a file (multipart/form-data)
 *   GET    /job/:id/attachments            list attachments for a job
 *   DELETE /job/:id/attachments/:attachId  delete a file (removes from Cloudinary)
 */

import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { NoteType } from "../../generated/prisma/enums";
import { IRequestUser } from "../../types/requestUser.interface";
import {
    uploadFileToCloudinary,
    deleteFileFromCloudinary,
} from "../../config/cloudinary";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ICreateNote {
    type?: NoteType;
    body: string;
    pinned?: boolean;
    authorName: string;
}

export interface IUpdateNote {
    type?: NoteType;
    body?: string;
    pinned?: boolean;
}

export type PhotoType = "BEFORE" | "AFTER" | "ISSUE";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const resolveAdminId = async (userId: string): Promise<string> => {
    const admin = await prisma.adminProfile.findUnique({ where: { userId } });
    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");
    return admin.id;
};

/**
 * For notes/attachments endpoints that are now accessible to STAFF,
 * resolve the adminId that owns the job (for ownership checks) and
 * determine the uploader role string.
 */
const resolveAdminIdForJob = async (
    userId: string,
    jobId: string,
    userRole: string,
): Promise<{ adminId: string; uploaderRole: string }> => {
    if (userRole === "STAFF") {
        // Staff → look up which job this is and get its adminId
        const job = await prisma.job.findUnique({
            where: { id: jobId },
            select: { adminId: true },
        });
        if (!job) throw new AppError(status.NOT_FOUND, "Job not found");
        return { adminId: job.adminId, uploaderRole: "STAFF" };
    }
    const adminId = await resolveAdminId(userId);
    return { adminId, uploaderRole: "ADMIN" };
};

/**
 * Verify the job belongs to this admin and return its id.
 * Throws 404 if the job doesn't exist or belongs to a different admin.
 */
const assertJobOwnership = async (
    jobId: string,
    adminId: string,
): Promise<void> => {
    const job = await prisma.job.findFirst({ where: { id: jobId, adminId } });
    if (!job) throw new AppError(status.NOT_FOUND, "Job not found");
};

// ─── Notes ────────────────────────────────────────────────────────────────────

const getNotes = async (jobId: string, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);
    await assertJobOwnership(jobId, adminId);

    return prisma.jobNote.findMany({
        where: { jobId, adminId },
        orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
    });
};

const createNote = async (
    jobId: string,
    payload: ICreateNote,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);
    await assertJobOwnership(jobId, adminId);

    if (!payload.body?.trim()) {
        throw new AppError(status.BAD_REQUEST, "Note body cannot be empty");
    }

    return prisma.jobNote.create({
        data: {
            jobId,
            adminId,
            type: payload.type ?? NoteType.GENERAL,
            body: payload.body.trim(),
            pinned: payload.pinned ?? false,
            authorName: payload.authorName,
        },
    });
};

const updateNote = async (
    jobId: string,
    noteId: string,
    payload: IUpdateNote,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);
    await assertJobOwnership(jobId, adminId);

    const note = await prisma.jobNote.findFirst({
        where: { id: noteId, jobId, adminId },
    });
    if (!note) throw new AppError(status.NOT_FOUND, "Note not found");

    const data: Record<string, unknown> = {};
    if (payload.type !== undefined) data.type = payload.type;
    if (payload.body !== undefined) data.body = payload.body.trim();
    if (payload.pinned !== undefined) data.pinned = payload.pinned;

    if (Object.keys(data).length === 0) {
        throw new AppError(status.BAD_REQUEST, "No fields to update");
    }

    return prisma.jobNote.update({ where: { id: noteId }, data });
};

const deleteNote = async (
    jobId: string,
    noteId: string,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);
    await assertJobOwnership(jobId, adminId);

    const note = await prisma.jobNote.findFirst({
        where: { id: noteId, jobId, adminId },
    });
    if (!note) throw new AppError(status.NOT_FOUND, "Note not found");

    await prisma.jobNote.delete({ where: { id: noteId } });
    return { deleted: true };
};

// ─── Attachments ──────────────────────────────────────────────────────────────

/** Allowed MIME types for job attachments */
const ALLOWED_MIMES = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "application/pdf",
]);

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

const getAttachments = async (jobId: string, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id).catch(async () => {
        // STAFF role: fetch adminId via job
        const job = await prisma.job.findUnique({
            where: { id: jobId },
            select: { adminId: true },
        });
        if (!job) throw new AppError(status.NOT_FOUND, "Job not found");
        return job.adminId;
    });
    await assertJobOwnership(jobId, adminId);

    return prisma.jobAttachment.findMany({
        where: { jobId, adminId },
        orderBy: { createdAt: "desc" },
    });
};

const uploadAttachment = async (
    jobId: string,
    file: Express.Multer.File,
    user: IRequestUser,
    photoType?: PhotoType,
) => {
    const { adminId, uploaderRole } = await resolveAdminIdForJob(
        user.id,
        jobId,
        user.role,
    );
    await assertJobOwnership(jobId, adminId);

    if (!file) {
        throw new AppError(status.BAD_REQUEST, "No file provided");
    }
    if (!ALLOWED_MIMES.has(file.mimetype)) {
        throw new AppError(
            status.BAD_REQUEST,
            `File type '${file.mimetype}' is not allowed. Allowed types: JPEG, PNG, WEBP, GIF, PDF`,
        );
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
        throw new AppError(
            status.BAD_REQUEST,
            `File is too large. Maximum size is ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB`,
        );
    }

    // Count existing attachments (cap at 20 per job)
    const existingCount = await prisma.jobAttachment.count({
        where: { jobId, adminId },
    });
    if (existingCount >= 20) {
        throw new AppError(
            status.BAD_REQUEST,
            "A job may have at most 20 attachments",
        );
    }

    // Upload to Cloudinary
    const uploadResult = await uploadFileToCloudinary(
        file.buffer,
        file.originalname,
    );

    return prisma.jobAttachment.create({
        data: {
            jobId,
            adminId,
            fileName: file.originalname,
            fileUrl: uploadResult.secure_url,
            cloudinaryId: uploadResult.public_id,
            mimeType: file.mimetype,
            fileSizeBytes: file.size,
            uploadedByRole: uploaderRole,
            photoType: photoType ?? null,
        },
    });
};

const deleteAttachment = async (
    jobId: string,
    attachId: string,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);
    await assertJobOwnership(jobId, adminId);

    const attachment = await prisma.jobAttachment.findFirst({
        where: { id: attachId, jobId, adminId },
    });
    if (!attachment)
        throw new AppError(status.NOT_FOUND, "Attachment not found");

    // Delete from Cloudinary first — if this fails we don't touch the DB record
    // so the admin can retry without losing the reference.
    await deleteFileFromCloudinary(attachment.fileUrl);

    await prisma.jobAttachment.delete({ where: { id: attachId } });
    return { deleted: true };
};

export const jobNotesService = {
    getNotes,
    createNote,
    updateNote,
    deleteNote,
    getAttachments,
    uploadAttachment,
    deleteAttachment,
};
