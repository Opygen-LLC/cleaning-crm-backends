import { FormFieldType, ServiceType } from "../../generated/prisma/enums";

export interface IBookingFormCreate {
    headline: string;
    subheading?: string;
    accentColor?: string;
    showReviews?: boolean;
    ctaLabel?: string;
    confirmationMessage?: string;
    availableDays?: string[];
    blockedDates?: string[];
    timeSlots?: string[];
    maxBookingsPerSlot?: number;
    slotDurationMinutes?: number;
    bufferTimeMinutes?: number;
    services?: {
        /** Canonical identity for new clients. */
        serviceCatalogId?: string;
        /** Legacy compatibility for old forms/clients. */
        serviceType?: ServiceType;
        enabled?: boolean;
        priceLabel?: string;
        duration?: string;
    }[];
    fields?: {
        type: FormFieldType;
        label: string;
        placeholder?: string;
        required?: boolean;
        enabled?: boolean;
        options?: string[];
        sortOrder?: number;
    }[];
}

export interface IBookingFormUpdate extends Partial<IBookingFormCreate> {
    published?: boolean;
}

export interface IPublicBookingSubmission {
    serviceCatalogId?: string;
    serviceType?: ServiceType;
    date: string;
    timeSlot: string;
    name: string;
    email: string;
    phone: string;
    address: string;
    propertyType?: "HOUSE" | "FLAT" | "OFFICE" | "COMMERCIAL" | "OTHER";
    bedrooms?: number;
    bathrooms?: number;
    addOnIds?: string[];
    notes?: string;
    answers?: Record<string, string>;
    // Marketing values may be supplied by the browser, but WEBSITE identity
    // and sourcePage are always derived by the server-side website resolver.
    utmSource?: string;
    utmCampaign?: string;
}
