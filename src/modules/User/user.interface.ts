import { AccountStatus } from "../../generated/prisma/enums";

export interface UpdateUserPayload {
    name?: string;
    status?: AccountStatus;
}

export interface UploadAvatarResult {
    /** Public R2 URL for the newly uploaded avatar. */
    avatarUrl: string;
}
