import { z } from "zod";

const updateStaffSchema = z.object({
    staffRole: z.string().optional(),
    mobileNumber: z.string().optional(),
}).strict().refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided to update",
});

export const staffValidation = {
    updateStaff: updateStaffSchema,
};
