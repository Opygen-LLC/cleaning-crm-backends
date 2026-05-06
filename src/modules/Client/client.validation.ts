import z from "zod";

const createClientSchema = z.object({
	name: z.string().min(1, "Name is required"),
	email: z.string().email("Invalid email address"),
	phone: z.string(),
	servicePreference: z.string(),

	addressLine1: z.string(),
	addressLine2: z.string().optional(),
	city: z.string(),
	zipcode: z.string(),
	country: z.string(),
	notes: z.string().optional(),
});

export const clientValidation = {
	createClient: createClientSchema,
};