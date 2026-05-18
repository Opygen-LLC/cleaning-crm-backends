import { QuoteStatus } from "../../generated/prisma/enums";

// ── Create ─────────────────────────────────────────────────────────────────────

export interface IQuoteLineItemInput {
    description: string;
    quantity: number;
    unitPrice: number;
}

export interface IQuoteCreate {
    clientId: string;
    serviceType: string;
    address: string;
    lineItems: IQuoteLineItemInput[];
    taxRate: number;
    validUntil: string; // ISO date string
    notes?: string;
    internalNotes?: string;
}

// ── Update ─────────────────────────────────────────────────────────────────────

export interface IQuoteUpdate {
    serviceType?: string;
    address?: string;
    lineItems?: IQuoteLineItemInput[];
    taxRate?: number;
    validUntil?: string;
    notes?: string;
    internalNotes?: string;
}

// ── Status ─────────────────────────────────────────────────────────────────────

export interface IQuoteStatusUpdate {
    status: QuoteStatus;
}

// ── Convert to Booking ─────────────────────────────────────────────────────────

export interface IQuoteConvertToBooking {
    scheduledDate: string; // ISO date string
    durationMins: number;
    staffIds?: string[];
    notes?: string;
}

// ── Public acceptance (unauthenticated) ───────────────────────────────────────

export interface IPublicQuoteAction {
    action: "accept" | "decline";
}
