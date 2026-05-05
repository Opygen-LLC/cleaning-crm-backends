import { z } from "zod";
import { InvoiceStatus } from "../../generated/prisma/enums";

const lineItemSchema = z.object({
  description: z.string().min(1, "Description is required"),
  quantity: z.number().int().positive("Quantity must be positive"),
  unitPrice: z.number().nonnegative("Unit price must be non-negative"),
  total: z.number().nonnegative("Total must be non-negative"),
});

const createInvoiceSchema = z.object({
  clientDetails: z.object({
    clientName: z.string().min(1, "Client name is required"),
    email: z.string().email("Invalid email"),
    serviceAddress: z.string().min(1, "Service address is required"),
    linkedBookingRef: z.string().optional(),
  }),
  serviceCatalogId: z.string().uuid("Service Catalog ID is required"),
  lineItems: z.array(lineItemSchema).min(1, "At least one line item is required"),
  notes: z.string().optional(),
  dates: z.object({
    issueDate: z.string().or(z.date()),
    dueDate: z.string().or(z.date()),
  }),
  summary: z.object({
    subtotal: z.number().nonnegative(),
    taxRate: z.number().nonnegative(),
    taxAmount: z.number().nonnegative(),
    total: z.number().nonnegative(),
  }),
});

const updateInvoiceSchema = z.object({
  clientDetails: z.object({
    clientName: z.string().optional(),
    email: z.string().email().optional(),
    serviceAddress: z.string().optional(),
    linkedBookingRef: z.string().optional(),
  }).optional(),
  serviceCatalogId: z.string().uuid().optional(),
  lineItems: z.array(lineItemSchema).optional(),
  notes: z.string().optional(),
  dates: z.object({
    issueDate: z.string().or(z.date()).optional(),
    dueDate: z.string().or(z.date()).optional(),
  }).optional(),
  summary: z.object({
    subtotal: z.number().optional(),
    taxRate: z.number().optional(),
    taxAmount: z.number().optional(),
    total: z.number().optional(),
  }).optional(),
  status: z.nativeEnum(InvoiceStatus).optional(),
});

const updateStatusSchema = z.object({
  status: z.nativeEnum(InvoiceStatus),
});

export const invoiceValidation = {
  createInvoice: createInvoiceSchema,
  updateInvoice: updateInvoiceSchema,
  updateStatus: updateStatusSchema,
};
