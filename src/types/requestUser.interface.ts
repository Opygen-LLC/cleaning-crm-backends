import { UserRole } from "../generated/prisma/enums";

export interface IRequestUser {
    id: string;
    name: string;
    email: string;
    role: UserRole;
}
