import { v2 as cloudinary, UploadApiResponse } from "cloudinary";
import AppError from "../errorHelper/AppError";
import status from "http-status";
import {
    CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET,
    CLOUDINARY_CLOUD_NAME,
} from "./ENV";

cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
});

export const uploadFileToCloudinary = async (
    buffer: Buffer,
    fileName: string,
): Promise<UploadApiResponse> => {
    if (!buffer || !fileName) {
        throw new AppError(
            status.BAD_REQUEST,
            "File buffer and file name are required for upload",
        );
    }

    const extension = fileName.split(".").pop()?.toLocaleLowerCase();

    const fileNameWithoutExtension = fileName
        .split(".")
        .slice(0, -1)
        .join(".")
        .toLowerCase()
        .replace(/\s+/g, "-")
        // eslint-disable-next-line no-useless-escape
        .replace(/[^a-z0-9\-]/g, "");

    const uniqueName =
        Math.random().toString(36).substring(2) +
        "-" +
        Date.now() +
        "-" +
        fileNameWithoutExtension;

    const folder = extension === "pdf" ? "pdfs" : "images";

    return new Promise((resolve, reject) => {
        cloudinary.uploader
            .upload_stream(
                {
                    // resource_type: "auto",
                    resource_type: "auto",
                    public_id: `Cleaning-CRM/${folder}/${uniqueName}`,
                    folder: `Cleaning-CRM/${folder}`,
                },
                (error, result) => {
                    if (error) {
                        return reject(
                            new AppError(
                                status.INTERNAL_SERVER_ERROR,
                                "Failed to upload file to Cloudinary",
                            ),
                        );
                    }
                    resolve(result as UploadApiResponse);
                },
            )
            .end(buffer);
    });
};

export const deleteFileFromCloudinary = async (url: string): Promise<void> => {
    try {
        const regex = /\/v\d+\/(.+?)(?:\.[a-zA-Z0-9]+)+$/;
        const match = url.match(regex);

        if (!match?.[1]) {
            console.warn("[Cloudinary] Could not extract public_id from URL:", url);
            return;
        }

        const publicId = match[1];

        // Determine resource type from the URL path
        // Cloudinary stores PDFs under resource_type "raw", images under "image"
        const isPdf = url.toLowerCase().includes("/pdfs/") || url.toLowerCase().endsWith(".pdf");
        const primaryType   = isPdf ? "raw" : "image";
        const fallbackType  = isPdf ? "image" : "raw";

        const result = await cloudinary.uploader.destroy(publicId, {
            resource_type: primaryType as "raw" | "image",
        });

        // If the primary attempt returns "not found", try the fallback type.
        // This handles assets uploaded before the resource_type was correctly set.
        if (result?.result === "not found") {
            await cloudinary.uploader.destroy(publicId, {
                resource_type: fallbackType as "raw" | "image",
            });
        }

        console.log(`[Cloudinary] Deleted asset: ${publicId} (${primaryType})`);
    } catch (error) {
        console.error("[Cloudinary] Error deleting file:", error);
        throw new AppError(
            status.INTERNAL_SERVER_ERROR,
            "Failed to delete file from Cloudinary",
        );
    }
};

export const cloudinaryUpload = cloudinary;
