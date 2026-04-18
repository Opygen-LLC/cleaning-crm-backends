import { UserRole } from "../generated/prisma/enums";

export interface IRequestUser {
    id: string;
    email: string;
    role: UserRole;
}
