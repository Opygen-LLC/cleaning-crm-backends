import { AccountStatus, UserRole } from "../../generated/prisma/enums";

export interface UpdateUserPayload {
    name?: string;
    role?: UserRole;
    status?: AccountStatus;
}
