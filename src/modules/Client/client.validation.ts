import z from "zod";
import { e164PhoneSchema, optionalE164PhoneSchema } from "../../lib/validation/phone";

const createClientSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  phone: e164PhoneSchema(),
  servicePreference: z.string().optional(),

  addressLine1: z.string(),
  addressLine2: z.string().optional(),
  city: z.string(),
  postcode: z.string().optional(),
  zipcode: z.string().optional(),
  country: z.string(),

  totalBookings: z.number().int().min(0).optional(),
  totalSpend: z.number().min(0).optional(),

  notes: z.string().optional(),
}).superRefine((value, ctx) => {
  if (!value.postcode && !value.zipcode) {
    ctx.addIssue({ code: "custom", path: ["postcode"], message: "Postcode is required" });
  }
  if (value.postcode && value.zipcode && value.postcode !== value.zipcode) {
    ctx.addIssue({ code: "custom", path: ["postcode"], message: "postcode conflicts with legacy zipcode" });
  }
});

const updateClientSchema = z.object({
  name: z.string().min(1, "Name is required").optional(),
  phone: optionalE164PhoneSchema(),
  servicePreference: z.string().optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "BLOCKED"]).optional(),

  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  postcode: z.string().optional(),
  zipcode: z.string().optional(),
  country: z.string().optional(),

  totalBookings: z.number().int().min(0).optional(),
  totalSpend: z.number().min(0).optional(),
});

export const clientValidation = {
  createClient: createClientSchema,
  updateClient: updateClientSchema,
};
