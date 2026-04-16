import { v2 as cloudinary } from "cloudinary";
import { UploadApiOptions } from "cloudinary";

/**
 * Uploads a single file to Cloudinary
 * @param fileBuffer - The file buffer to upload
 * @param options - Cloudinary upload options
 * @returns The result of the upload
 */
export const uploadToCloudinary = async (
  fileBuffer: Buffer,
  options?: UploadApiOptions
): Promise<any> => {
  return new Promise((resolve, reject) => {
    const uploadOptions: UploadApiOptions = {
      resource_type: "image",
      ...options,
    };

    cloudinary.uploader
      .upload_stream(uploadOptions, (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      })
      .end(fileBuffer);
  });
};

/**
 * Uploads multiple files to Cloudinary
 * @param files - Array of file buffers to upload
 * @param options - Cloudinary upload options
 * @returns Array of upload results
 */
export const uploadMultipleToCloudinary = async (
  files: Express.Multer.File[],
  options?: UploadApiOptions
): Promise<any[]> => {
  const uploadPromises = files.map((file) =>
    uploadToCloudinary(file.buffer, options)
  );

  return Promise.all(uploadPromises);
};

/**
 * Deletes a file from Cloudinary
 * @param publicId - The public ID of the file to delete
 * @returns The result of the deletion
 */
export const deleteFromCloudinary = async (publicId: string): Promise<any> => {
  return cloudinary.uploader.destroy(publicId);
};
