import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { mediaService } from "./media.service";
import type { MediaPurpose } from "./media.types";

const inferServerContentType = (filename: string, contentType: string): string => {
  if (contentType.toLowerCase() !== "application/octet-stream") return contentType.toLowerCase();
  const lower = filename.toLowerCase();
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".avif")) return "image/avif";
  if (lower.endsWith(".gif")) return "image/gif";
  return contentType.toLowerCase();
};

const initiateUpload = catchAsync(async (req, res) => {
  const result = await mediaService.initiateUpload(req.body, req.user);
  sendResponse(res, { httpStatusCode: status.CREATED, success: true, message: "Upload session created", data: result });
});

const finalizeUpload = catchAsync(async (req, res) => {
  const result = await mediaService.finalizeUpload(req.params.uploadId as string, req.user);
  sendResponse(res, { httpStatusCode: status.OK, success: true, message: "Upload finalized", data: result });
});

const uploadFromServer = catchAsync(async (req, res) => {
  if (!req.file) throw new AppError(status.BAD_REQUEST, "No file uploaded", { code: "MEDIA_FILE_REQUIRED", retryable: false, fieldErrors: { file: "Choose a file to upload." } });
  const purpose = String(req.body.purpose || "") as MediaPurpose;
  const result = await mediaService.uploadFromServer({
    purpose,
    entityId: req.body.entityId ? String(req.body.entityId) : undefined,
    filename: req.file.originalname,
    contentType: inferServerContentType(req.file.originalname, req.file.mimetype),
    buffer: req.file.buffer,
  }, req.user);
  sendResponse(res, { httpStatusCode: status.CREATED, success: true, message: "File uploaded", data: result });
});

const getAsset = catchAsync(async (req, res) => {
  const result = await mediaService.getAsset(req.params.assetId as string, req.user);
  sendResponse(res, { httpStatusCode: status.OK, success: true, message: "Media asset retrieved", data: result });
});

const getDownloadUrl = catchAsync(async (req, res) => {
  const result = await mediaService.getDownloadUrl(req.params.assetId as string, req.user);
  sendResponse(res, { httpStatusCode: status.OK, success: true, message: "Download URL created", data: result });
});

const deleteAsset = catchAsync(async (req, res) => {
  const result = await mediaService.deleteAsset(req.params.assetId as string, req.user);
  sendResponse(res, { httpStatusCode: status.OK, success: true, message: "Media asset deleted", data: result });
});

const storageHealth = catchAsync(async (_req, res) => {
  const result = await mediaService.storageHealth();
  if (!result.ok) {
    throw new AppError(status.SERVICE_UNAVAILABLE, "R2 storage is not fully reachable", {
      code: "R2_UNAVAILABLE",
      retryable: true,
    });
  }
  sendResponse(res, { httpStatusCode: status.OK, success: true, message: "R2 storage is reachable", data: result });
});

export const mediaController = { initiateUpload, finalizeUpload, uploadFromServer, getAsset, getDownloadUrl, deleteAsset, storageHealth };
