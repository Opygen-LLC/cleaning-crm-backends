import { z } from "zod";

const createStaffSchema = z.object({
    name: z.string().min(1, "Name is required"),
    email: z.string().email("Invalid email address"),
    password: z.string().min(6, "Password must be at least 6 characters"),
    staffRole: z.string().min(1, "Staff role is required"),
    mobileNumber: z.string().optional(),
});

const updateStaffSchema = z.object({
    staffRole: z.string().optional(),
    mobileNumber: z.string().optional(),
}).strict().refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided to update",
});

export const staffValidation = {
    createStaff: createStaffSchema,
    updateStaff: updateStaffSchema,
};
