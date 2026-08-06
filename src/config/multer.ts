// @ts-ignore
import { CloudinaryStorage } from "multer-storage-cloudinary";
import { cloudinaryUpload } from "./cloudinary";
import multer from "multer";

const storage = new CloudinaryStorage({
    cloudinary: cloudinaryUpload,
    params: async (req: any, file: any) => {
        const originalName = file.originalname;
        const extension = originalName.split(".").pop()?.toLocaleLowerCase();
        const fileNameWithoutExtension = originalName
            .split(".")
            .slice(0, -1)
            .join(".")
            .toLowerCase()
            .replace(/\s/g, "-")
            .replace(/[^a-zA-Z0-9]/g, "-");
        const uniqueName =
            Math.random().toString(36).substring(2) +
            "-" +
            Date.now() +
            "-" +
            fileNameWithoutExtension;
        const folder = extension === "pdf" ? "pdfs" : "images";

        return {
            folder: `Cleaning-CRM/${folder}`,
            public_id: uniqueName,
            resource_type: "auto",
        };
    },
});

export const multerUpload = multer({ storage });