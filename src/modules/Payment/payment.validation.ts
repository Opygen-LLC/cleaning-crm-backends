import { z } from "zod";
import { PaymentMethod, PaymentStatus } from "../../generated/prisma/enums";

const createPaymentSchema = z.object({
  invoiceId: z.string().uuid("Invalid invoice ID").optional(),
  amount: z.number().positive("Amount must be positive"),
  method: z.nativeEnum(PaymentMethod),
  note: z.string().optional(),
  transactionId: z.string().optional(),
  paidAt: z.string().optional(),
});

const updatePaymentSchema = z.object({
  amount: z.number().positive().optional(),
  method: z.nativeEnum(PaymentMethod).optional(),
  status: z.nativeEnum(PaymentStatus).optional(),
  note: z.string().optional(),
  transactionId: z.string().optional(),
  paidAt: z.string().optional(),
});

export const paymentValidation = {
  createPayment: createPaymentSchema,
  updatePayment: updatePaymentSchema,
};
