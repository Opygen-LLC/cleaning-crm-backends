/**
 * convertHeicToPngMiddleware.ts
 *
 * Converts HEIC/HEIF images (uploaded by iOS devices) to PNG in-memory before
 * the file is passed to downstream handlers (Cloudinary upload, etc.).
 *
 * Usage — apply BEFORE any Cloudinary upload on routes that accept image files:
 *
 *   router.post(
 *     "/payment/:id/receipt",
 *     checkAuth(UserRole.ADMIN),
 *     multerMemory.single("receipt"),
 *     convertHeicToPng,            // ← insert here
 *     paymentController.uploadReceipt,
 *   );
 *
 * The middleware is a no-op for non-HEIC files so it is safe to include on
 * every file route without extra guards.
 *
 * Requires the already-installed `heic-convert` package.
 */

import { Request, Response, NextFunction } from "express";
import heicConvert from "heic-convert";

const HEIC_MIMETYPES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

/**
 * Detects whether a buffer starts with the HEIC/HEIF magic bytes.
 * iOS sometimes uploads these files with a generic "application/octet-stream"
 * MIME type, so we also sniff the first 12 bytes.
 */
function isHeicBuffer(buf: Buffer): boolean {
  // HEIF/HEIC files have the ftyp box at offset 4: bytes 4-7 = "ftyp"
  // followed by a brand like "heic", "heix", "mif1", "msf1", "hevc"
  if (buf.length < 12) return false;
  const ftyp = buf.toString("ascii", 4, 8);
  if (ftyp !== "ftyp") return false;
  const brand = buf.toString("ascii", 8, 12).toLowerCase();
  return (
    brand.startsWith("heic") ||
    brand.startsWith("heix") ||
    brand.startsWith("mif1") ||
    brand.startsWith("msf1") ||
    brand.startsWith("hevc") ||
    brand.startsWith("avif")
  );
}

export const convertHeicToPng = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    // multer may have stored one file (single) or several (fields/array).
    const files: Express.Multer.File[] = [];

    if (req.file) {
      files.push(req.file);
    }
    if (req.files) {
      if (Array.isArray(req.files)) {
        files.push(...req.files);
      } else {
        Object.values(req.files).forEach((arr) => files.push(...arr));
      }
    }

    for (const file of files) {
      const mimeIsHeic = HEIC_MIMETYPES.has(file.mimetype.toLowerCase());
      const bufferIsHeic =
        !mimeIsHeic && file.buffer ? isHeicBuffer(file.buffer) : false;

      if (!mimeIsHeic && !bufferIsHeic) continue;

      // Convert HEIC → PNG
      const pngBuffer = await heicConvert({
        buffer: file.buffer as ArrayBuffer,
        format: "PNG",
        quality: 1, // lossless for PNG (ignored but required by typings)
      });

      file.buffer = Buffer.from(pngBuffer);
      file.mimetype = "image/png";
      file.originalname = file.originalname.replace(/\.(heic|heif)$/i, ".png");
      file.size = file.buffer.length;
    }

    next();
  } catch (err) {
    // If conversion fails (corrupted file, unsupported sub-format) we pass the
    // error to Express's global error handler rather than silently dropping it.
    next(err);
  }
};
