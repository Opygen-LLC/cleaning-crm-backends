import { EstimateStatus } from "../../generated/prisma/enums";

// ── Line Item Input ─────────────────────────────────────────────────────────

export interface IEstimateLineItemInput {
    description: string;
    quantity: number;
    unitPrice: number;
    taxPercent: number;      // per-line tax (e.g. 20 for 20 %)
    discountPercent: number; // per-line discount (0–100)
}

// ── Create ──────────────────────────────────────────────────────────────────

export interface IEstimateNewClientInput {
    name: string;
    email: string;
    phone: string;
    addressLine1: string;
    city?: string;
    postcode?: string;
    country?: string;
}

export interface IEstimateCreate {
    clientId?: string;
    newClient?: IEstimateNewClientInput;
    serviceCatalogId?: string;
    serviceType?: string; // legacy compatibility
    address: string;
    postcodeArea?: string;
    estimatedDuration?: string;
    numberOfCleaners?: number;
    lineItems: IEstimateLineItemInput[];
    discountType?: "percent" | "fixed";
    discountValue?: number;
    validUntil: string;       // ISO date string
    notes?: string;
    internalNotes?: string;
    terms?: string;
}

// ── Update ──────────────────────────────────────────────────────────────────

export interface IEstimateUpdate {
    serviceCatalogId?: string | null;
    serviceType?: string; // legacy compatibility
    address?: string;
    postcodeArea?: string;
    estimatedDuration?: string;
    numberOfCleaners?: number;
    lineItems?: IEstimateLineItemInput[];
    discountType?: "percent" | "fixed";
    discountValue?: number;
    taxRate?: number;
    validUntil?: string;
    notes?: string;
    internalNotes?: string;
    terms?: string;
}

// ── Status ──────────────────────────────────────────────────────────────────

export interface IEstimateStatusUpdate {
    status: EstimateStatus;
}

// ── Convert to Booking ──────────────────────────────────────────────────────

export interface IEstimateConvertToBooking {
    scheduledDate: string; // ISO datetime string
    durationMins: number;
    staffIds?: string[];
    notes?: string;
}
