import { AccountStatus } from "../../generated/prisma/enums";

export interface UpdateUserPayload {
    name?: string;
    status?: AccountStatus;
    image?: string; // Cloudinary URL
}
