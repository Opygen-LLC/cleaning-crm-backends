import multer from "multer";

const ALLOWED_UPLOAD_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/heic",
    "image/heif",
    "image/heic-sequence",
    "image/heif-sequence",
    "application/pdf",
]);

export const multerMemory = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10 MB
    },
    fileFilter: (_req, file, callback) => {
        if (ALLOWED_UPLOAD_TYPES.has(file.mimetype.toLowerCase())) {
            callback(null, true);
            return;
        }

        const error = new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname);
        error.message = "Unsupported file type. Upload JPEG, PNG, WEBP, GIF, HEIC/HEIF, or PDF files only.";
        callback(error);
    },
});
