import { PaymentMethod, PaymentStatus } from "../../generated/prisma/enums";

export interface IPaymentCreate {
  invoiceId?: string;
  amount: number;
  method: PaymentMethod;
  note?: string;
  transactionId?: string;
  paidAt?: string;
}

export interface IPaymentUpdate {
  amount?: number;
  method?: PaymentMethod;
  status?: PaymentStatus;
  note?: string;
  transactionId?: string;
  paidAt?: string;
}

export interface IPaymentFilters {
  searchTerm?: string;
  method?: PaymentMethod;
  status?: PaymentStatus;
  startDate?: string;
  endDate?: string;
  invoiceId?: string;
}
