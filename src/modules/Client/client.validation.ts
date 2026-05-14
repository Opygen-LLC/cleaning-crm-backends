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

const updateClientSchema = z.object({
	name: z.string().min(1, "Name is required").optional(),
	phone: z.string().optional(),
	servicePreference: z.string().optional(),
	status: z.enum(["ACTIVE", "INACTIVE", "BLOCKED"]).optional(),

	addressLine1: z.string().optional(),
	addressLine2: z.string().optional(),
	city: z.string().optional(),
	zipcode: z.string().optional(),
	country: z.string().optional(),
});

export const clientValidation = {
	createClient: createClientSchema,
	updateClient: updateClientSchema,
};
