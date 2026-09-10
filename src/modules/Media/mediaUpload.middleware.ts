import multer from "multer";
import { R2_MAX_DOCUMENT_SIZE_MB } from "../../config/ENV";

const BROAD_ALLOWED_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/avif", "image/gif",
  "image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence",
  "application/pdf", "application/octet-stream",
]);

export const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: R2_MAX_DOCUMENT_SIZE_MB * 1024 * 1024, files: 1, fields: 4 },
  fileFilter: (_req, file, callback) => {
    if (BROAD_ALLOWED_TYPES.has(file.mimetype.toLowerCase())) return callback(null, true);
    const error = new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname);
    error.message = "Unsupported file type.";
    callback(error);
  },
});
