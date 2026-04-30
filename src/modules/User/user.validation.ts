import { z } from "zod";
import { AccountStatus, UserRole } from "../../generated/prisma/enums";

const updateUserSchema = z.object({
    name: z.string().optional(),
    role: z.enum([UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF]).optional(),
    status: z.enum([AccountStatus.PENDING, AccountStatus.ACTIVE, AccountStatus.SUSPENDED, AccountStatus.DELETED]).optional(),
}).strict().refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided to update",
});

export const userValidation = {
    updateUser: updateUserSchema,
};
