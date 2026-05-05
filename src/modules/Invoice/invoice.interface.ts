import { InvoiceStatus } from "../../generated/prisma/enums";

export interface IInvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface IInvoiceCreate {
  clientDetails: {
    clientName: string;
    email: string;
    serviceAddress: string;
    linkedBookingRef?: string;
  };
  serviceCatalogId: string;
  lineItems: IInvoiceLineItem[];
  notes?: string;
  dates: {
    issueDate: string | Date;
    dueDate: string | Date;
  };
  summary: {
    subtotal: number;
    taxRate: number;
    taxAmount: number;
    total: number;
  };
}

export interface IInvoiceUpdate {
  clientDetails?: {
    clientName?: string;
    email?: string;
    serviceAddress?: string;
    linkedBookingRef?: string;
  };
  serviceCatalogId?: string;
  lineItems?: IInvoiceLineItem[];
  notes?: string;
  dates?: {
    issueDate?: string | Date;
    dueDate?: string | Date;
  };
  summary?: {
    subtotal?: number;
    taxRate?: number;
    taxAmount?: number;
    total?: number;
  };
  status?: InvoiceStatus;
}

export interface IInvoiceFilters {
  searchTerm?: string;
  status?: InvoiceStatus;
  adminId?: string;
}
