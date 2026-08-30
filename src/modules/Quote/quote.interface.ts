import { QuoteStatus } from "../../generated/prisma/enums";

export interface IQuoteLineItemInput {
    description: string;
    quantity: number;
    unitPrice: number;
}

export interface IQuoteCreate {
    clientId?: string;
    clientName?: string;
    clientEmail?: string;
    clientPhone?: string;
    serviceCatalogId?: string;
    serviceType?: string; // legacy rolling-client compatibility
    address: string;
    lineItems: IQuoteLineItemInput[];
    taxRate: number;
    validUntil: string;
    notes?: string;
    internalNotes?: string;
    templateId?: string;
}

export interface IQuoteUpdate {
    serviceCatalogId?: string | null;
    serviceType?: string; // legacy rolling-client compatibility
    address?: string;
    lineItems?: IQuoteLineItemInput[];
    taxRate?: number;
    validUntil?: string;
    notes?: string;
    internalNotes?: string;
}

export interface IQuoteStatusUpdate {
    status: QuoteStatus;
}

export interface IQuoteConvertToBooking {
    scheduledDate: string;
    durationMins: number;
    staffIds?: string[];
    notes?: string;
}

export interface IQuoteConvertToJob {
    scheduledDate: string;
    durationMins: number;
    staffIds?: string[];
    notes?: string;
}

export interface IPublicQuoteAction {
    action: "accept" | "decline";
    note?: string;
}
