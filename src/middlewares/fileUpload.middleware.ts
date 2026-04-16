import multer from "multer";
import path from "path";
import { v2 as cloudinary } from "cloudinary";
import {
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
} from "../config/ENV";

// Configure Cloudinary
cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
});

// Middleware for local file upload
const userFileUploadMiddleware = (uploadFolder: string) => {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadFolder); // Set the destination folder
    },
    filename: (req, file, cb) => {
      const extname = path.extname(file.originalname);
      const filename = Date.now() + "-" + file.fieldname + extname; // Unique file name
      cb(null, filename);
    },
  });

  return multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // Max file size: 10MB
    fileFilter: (req, file, cb) => {
      const fileTypes = /jpeg|jpg|png/;
      const extname = fileTypes.test(
        path.extname(file.originalname).toLowerCase()
      );
      const mimetype = fileTypes.test(file.mimetype);

      if (extname && mimetype) {
        return cb(null, true); // If file is valid, allow it
      } else {
        const error: any = new Error("Only image files are allowed!");
        error.code = "INVALID_FILE_TYPE";
        return cb(error, false);
      }
    },
  });
};

// Middleware for Cloudinary file upload
const cloudinaryFileUploadMiddleware = () => {
  return multer({
    limits: { fileSize: 10 * 1024 * 1024 }, // Max file size: 10MB
    fileFilter: (req, file, cb) => {
      const fileTypes = /jpeg|jpg|png/;
      const extname = fileTypes.test(
        path.extname(file.originalname).toLowerCase()
      );
      const mimetype = fileTypes.test(file.mimetype);

      if (extname && mimetype) {
        return cb(null, true); // If file is valid, allow it
      } else {
        const error: any = new Error("Only image files are allowed!");
        error.code = "INVALID_FILE_TYPE";
        return cb(error, false);
      }
    },
  });
};

export { cloudinaryFileUploadMiddleware };
export default userFileUploadMiddleware;
