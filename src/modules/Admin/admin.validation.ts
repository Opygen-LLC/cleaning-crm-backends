import { z } from "zod";
import { Country, Currency } from "../../generated/prisma/enums";

export const createAdminSchema = z.object({
    businessName: z.string().min(1, "Business name is required"),
});

const workLocationSchema = z
    .object({
        city: z.string().min(1, "City is required"),
        postcode: z.string().optional(),
        notes: z.string().optional(),
    })
    .strict();

const updateAdminSchema = z
    .object({
        businessName: z.string().optional(),
        brandColor: z.string().optional(),
        currency: z.enum(Currency).optional(),
        mobileNumber: z.string().optional(),

        address: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zipcode: z.string().optional(),
        country: z.enum(Country).optional(),

        workLocations: z.array(workLocationSchema).optional(),
    })
    .strict()
    .refine(
        (data) => Object.keys(data).length > 0 || true,
        {
            message: "At least one field must be provided to update",
        },
    );

export const adminValidation = {
	createAdmin: createAdminSchema,
	updateAdmin: updateAdminSchema,
};