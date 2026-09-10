import { ExpenseCategory } from "../../generated/prisma/enums";

export interface IExpenseCreate {
  description: string;
  category: ExpenseCategory;
  amount: number;
  date: string | Date;
  paidBy: string;
  isRecurring?: boolean;
  notes?: string;
  receiptMediaAssetId?: string;
}

export interface IExpenseUpdate {
  description?: string;
  category?: ExpenseCategory;
  amount?: number;
  date?: string | Date;
  paidBy?: string;
  isRecurring?: boolean;
  notes?: string;
  receiptMediaAssetId?: string | null;
}

export interface IExpenseFilters {
  searchTerm?: string;
  category?: ExpenseCategory;
  adminId?: string;
  startDate?: string;
  endDate?: string;
}
