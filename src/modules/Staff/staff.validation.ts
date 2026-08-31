import { z } from "zod";
import { WeekDay } from "../../generated/prisma/enums";
import { e164PhoneSchema, optionalE164PhoneSchema } from "../../lib/validation/phone";

const staffAvailabilitySchema = z.object({
    day: z.enum(WeekDay, "Invalid day of the week"),
    startTime: z.string().optional(), // "09:00"
    endTime: z.string().optional(),
    isActive: z.boolean().default(true),
});

export const createStaffSchema = z.object({
    name: z.string().min(1, "Name is required"),
    email: z.string().email("Invalid email address"),

    staffRole: z.string().min(1, "Staff role is required"),
    mobileNumber: e164PhoneSchema(),
    address: z.string().optional(),

    hourlyRate: z.number().optional(),
    startDate: z.string().datetime(),

    specialty: z.array(z.string()).optional(),

    emergencyName: z.string().optional(),
    emergencyMobileNumber: optionalE164PhoneSchema(),
    adminNote: z.string().optional(),

    staffAvailability: z
        .array(staffAvailabilitySchema)
        .length(7, "Must provide all 7 days") // optional but recommended
        .optional(),
});

const updateStaffSchema = z
    .object({
        staffRole: z.string().optional(),
        mobileNumber: optionalE164PhoneSchema(),
        address: z.string().optional(),
    })
    .strict()
    .refine((data) => Object.keys(data).length > 0, {
        message: "At least one field must be provided to update",
    });

const updateAvailabilitySchema = z.object({
    availability: z
        .array(staffAvailabilitySchema)
        .length(7, "Must provide all 7 days"),
});

export const staffValidation = {
    createStaff: createStaffSchema,
    updateStaff: updateStaffSchema,
    updateAvailability: updateAvailabilitySchema,
};
