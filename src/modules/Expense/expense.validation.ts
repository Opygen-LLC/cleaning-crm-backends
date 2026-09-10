import { z } from "zod";
import { ExpenseCategory } from "../../generated/prisma/enums";

const createExpenseSchema = z.object({
  description: z.string().min(1, "Description is required"),
  category: z.nativeEnum(ExpenseCategory),
  amount: z.number().positive("Amount must be positive"),
  date: z.string().or(z.date()),
  paidBy: z.string().min(1, "Paid by is required"),
  isRecurring: z.boolean().optional(),
  notes: z.string().optional(),
  receiptMediaAssetId: z.string().uuid("Upload a valid receipt first.").optional(),
}).strict();

const updateExpenseSchema = z.object({
  description: z.string().optional(),
  category: z.nativeEnum(ExpenseCategory).optional(),
  amount: z.number().positive().optional(),
  date: z.string().or(z.date()).optional(),
  paidBy: z.string().optional(),
  isRecurring: z.boolean().optional(),
  notes: z.string().optional(),
  receiptMediaAssetId: z.string().uuid("Upload a valid receipt first.").nullable().optional(),
}).strict();

export const expenseValidation = {
  createExpense: createExpenseSchema,
  updateExpense: updateExpenseSchema,
};
