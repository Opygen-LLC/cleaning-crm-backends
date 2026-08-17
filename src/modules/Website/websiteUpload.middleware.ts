import multer from "multer";

const WEBSITE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

/** Website uploads are intentionally narrower than the CRM-wide uploader. */
export const websiteImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4 },
  fileFilter: (_req, file, callback) => {
    if (WEBSITE_IMAGE_TYPES.has(file.mimetype.toLowerCase())) {
      callback(null, true);
      return;
    }
    const error = new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname);
    error.message = "Website images must be JPEG, PNG, WEBP, AVIF, HEIC, or HEIF and no larger than 5 MB.";
    callback(error);
  },
});
