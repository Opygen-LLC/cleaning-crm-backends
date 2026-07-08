import { AccountStatus } from "../../generated/prisma/enums";

export interface UpdateUserPayload {
    name?: string;
    status?: AccountStatus;
    image?: string; // Cloudinary URL
}

export interface UploadAvatarResult {
    /** Cloudinary secure_url for the newly uploaded avatar. */
    avatarUrl: string;
}
