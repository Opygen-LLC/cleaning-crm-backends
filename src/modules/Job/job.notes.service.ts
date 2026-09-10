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
 *   DELETE /job/:id/attachments/:attachId  delete a file (R2)
 */

import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { NoteType } from "../../generated/prisma/enums";
import { IRequestUser } from "../../types/requestUser.interface";
import { getAdminId } from "../../lib/utils/resolveAdminId";import { mediaService } from "../Media/media.service";

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

/**
 * [NEW] Pagination options for GET /job/:id/notes.
 * Defaults match the project-wide convention (page 1, 10 per page) used by
 * Expense, Client, and other list endpoints — see expense.service.ts.
 */
export interface IGetNotesOptions {
    page?: number;
    limit?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * For notes/attachments endpoints that are now accessible to STAFF,
 * resolve the adminId that owns the job (for ownership checks) and
 * determine the uploader role string.
 *
 * PERF FIX (Phase 2): the ADMIN branch used to call a locally-duplicated
 * resolveAdminId(userId) that re-queried Postgres on every call. It now
 * goes through the shared getAdminId() helper, which reads the value
 * checkAuth.ts already resolved onto req.user for this request.
 */
const resolveAdminIdForJob = async (
    user: IRequestUser,
    jobId: string,
): Promise<{ adminId: string; uploaderRole: string }> => {
    if (user.role === "STAFF") {
        const staff = await prisma.staffProfile.findUnique({
            where: { userId: user.id },
            select: { id: true, adminId: true },
        });
        if (!staff) throw new AppError(status.NOT_FOUND, "Staff profile not found", { code: "STAFF_PROFILE_MISSING", retryable: false, kind: "TENANT_INVARIANT" });

        const assignment = await prisma.jobStaffAssignment.findFirst({
            where: { jobId, staffId: staff.id },
            select: { jobId: true },
        });
        if (!assignment) {
            throw new AppError(status.FORBIDDEN, "You are not assigned to this job");
        }
        return { adminId: staff.adminId, uploaderRole: "STAFF" };
    }
    return { adminId: await getAdminId(user), uploaderRole: "ADMIN" };
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

/**
 * getNotes
 *
 * [UPDATED] Now paginated to match the project-wide list-endpoint convention.
 * Ordering is preserved exactly as before: pinned notes first, then newest
 * first within each group. Defaults to page=1, limit=10 when the caller
 * passes no pagination options (keeps existing integrations working without
 * a breaking change — they simply get page 1 of up to `limit` results plus
 * a `meta` block instead of the full unbounded array).
 */
const getNotes = async (
    jobId: string,
    user: IRequestUser,
    options: IGetNotesOptions = {},
) => {
    const { adminId } = await resolveAdminIdForJob(user, jobId);
    await assertJobOwnership(jobId, adminId);

    const { page = 1, limit = 10 } = options;
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(Math.max(1, limit), 100); // hard cap at 100/page
    const skip = (safePage - 1) * safeLimit;

    const whereConditions = { jobId, adminId };

    const [data, total] = await Promise.all([
        prisma.jobNote.findMany({
            where: whereConditions,
            orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
            skip,
            take: safeLimit,
        }),
        prisma.jobNote.count({ where: whereConditions }),
    ]);

    return {
        data,
        meta: {
            page: safePage,
            limit: safeLimit,
            total,
            totalPages: Math.ceil(total / safeLimit),
        },
    };
};

const createNote = async (
    jobId: string,
    payload: ICreateNote,
    user: IRequestUser,
) => {
    const { adminId } = await resolveAdminIdForJob(user, jobId);
    await assertJobOwnership(jobId, adminId);

    if (!payload.body?.trim()) {
        throw new AppError(status.BAD_REQUEST, "Note body cannot be empty");
    }

    return prisma.jobNote.create({
        data: {
            jobId,
            adminId,
            type: user.role === "STAFF" ? NoteType.STAFF : (payload.type ?? NoteType.GENERAL),
            body: payload.body.trim(),
            pinned: user.role === "STAFF" ? false : (payload.pinned ?? false),
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
    const adminId = await getAdminId(user);
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
    const adminId = await getAdminId(user);
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
    const { adminId } = await resolveAdminIdForJob(user, jobId);
    await assertJobOwnership(jobId, adminId);

    const rows = await prisma.jobAttachment.findMany({
        where: { jobId, adminId },
        orderBy: { createdAt: "desc" },
    });
    return Promise.all(rows.map(async (row) => {
        if (!row.mediaAssetId) return row;
        const fileUrl = await mediaService.getReadUrlForTenant(row.mediaAssetId, adminId, row.fileName);
        return { ...row, fileUrl };
    }));
};

const createAttachmentFromAsset = async (
    jobId: string,
    assetId: string,
    user: IRequestUser,
    photoType?: PhotoType,
) => {
    const { adminId, uploaderRole } = await resolveAdminIdForJob(user, jobId);
    await assertJobOwnership(jobId, adminId);
    const existingCount = await prisma.jobAttachment.count({ where: { jobId, adminId } });
    if (existingCount >= 20) throw new AppError(status.BAD_REQUEST, "A job may have at most 20 attachments");

    // Images use JOB_PHOTO; PDFs and other allowed documents use JOB_ATTACHMENT.
    const raw = await mediaService.getAssetForTenant(assetId, adminId);
    const purpose = raw.mimeType.startsWith("image/") ? "JOB_PHOTO" : "JOB_ATTACHMENT";
    const asset = await mediaService.bindReadyAsset(assetId, user, purpose, jobId);
    const fileUrl = `r2://${asset.bucket}/${asset.objectKey}`;
    try {
        return await prisma.jobAttachment.create({
            data: {
                jobId, adminId, fileName: asset.originalFilename, fileUrl,
                mediaAssetId: asset.id, storageKey: asset.objectKey, mimeType: asset.mimeType,
                fileSizeBytes: asset.storedBytes ?? asset.originalBytes, uploadedByRole: uploaderRole, photoType: photoType ?? null,
            },
        });
    } catch (error) {
        await mediaService.deleteAssetIfUnreferencedForTenant(asset.id, adminId).catch(() => undefined);
        throw error;
    }
};

const uploadAttachment = async (
    jobId: string,
    file: Express.Multer.File,
    user: IRequestUser,
    photoType?: PhotoType,
) => {
    const { adminId } = await resolveAdminIdForJob(user, jobId);
    await assertJobOwnership(jobId, adminId);
    if (!file) throw new AppError(status.BAD_REQUEST, "No file provided");
    if (!ALLOWED_MIMES.has(file.mimetype)) throw new AppError(status.BAD_REQUEST, `File type '${file.mimetype}' is not allowed. Allowed types: JPEG, PNG, WEBP, GIF, PDF`);
    if (file.size > MAX_FILE_SIZE_BYTES) throw new AppError(status.BAD_REQUEST, `File is too large. Maximum size is ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB`);
    const existingCount = await prisma.jobAttachment.count({ where: { jobId, adminId } });
    if (existingCount >= 20) throw new AppError(status.BAD_REQUEST, "A job may have at most 20 attachments");
    const purpose = file.mimetype.startsWith("image/") ? "JOB_PHOTO" : "JOB_ATTACHMENT";
    const asset = await mediaService.uploadFromServer({
        purpose, entityId: jobId, filename: file.originalname, contentType: file.mimetype, buffer: file.buffer,
    }, user);
    try {
        return await createAttachmentFromAsset(jobId, asset.id, user, photoType);
    } catch (error) {
        await mediaService.deleteAssetIfUnreferencedForTenant(asset.id, adminId).catch(() => undefined);
        throw error;
    }
};

const deleteAttachment = async (
    jobId: string,
    attachId: string,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);
    await assertJobOwnership(jobId, adminId);

    const attachment = await prisma.jobAttachment.findFirst({
        where: { id: attachId, jobId, adminId },
    });
    if (!attachment)
        throw new AppError(status.NOT_FOUND, "Attachment not found");

    await prisma.jobAttachment.delete({ where: { id: attachId } });
    if (attachment.mediaAssetId) {
        await mediaService.deleteAssetForTenant(attachment.mediaAssetId, adminId).catch(() => undefined);
    }
    return { deleted: true };
};

export const jobNotesService = {
    getNotes,
    createNote,
    updateNote,
    deleteNote,
    getAttachments,
    uploadAttachment,
    createAttachmentFromAsset,
    deleteAttachment,
};
