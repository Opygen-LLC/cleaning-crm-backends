import { BookingStatus, ServiceType } from "../../generated/prisma/enums";

// ── Create ────────────────────────────────────────────────────────────────────

export interface IBookingCreate {
    // Either an existing client id…
    clientId?:     string;
    // …or new-lead details used to find-or-create the client inline.
    clientName?:   string;
    clientEmail?:  string;
    clientPhone?:  string;
    serviceCatalogId?: string;
    serviceType?:   ServiceType;
    address:       string;
    scheduledDate: string | Date;
    durationMins:  number;
    total:         number;
    notes?:        string;
    quoteId?:      string;
    staffIds?:     string[]; // optional initial assignment
}

// ── Update ────────────────────────────────────────────────────────────────────

export interface IBookingUpdate {
    serviceCatalogId?: string;
    serviceType?:   ServiceType;
    address?:       string;
    scheduledDate?: string | Date;
    durationMins?:  number;
    total?:         number;
    notes?:         string;
}

// ── Booking-form conversion ──────────────────────────────────────────────────

export interface IBookingSubmissionConversion {
    scheduledDate: string | Date;
    durationMins: number;
    total: number;
    notes?: string;
    staffIds?: string[];
}

// ── Filters ───────────────────────────────────────────────────────────────────

export interface IBookingFilters {
    searchTerm?:   string;
    status?:       BookingStatus;
    serviceType?:  ServiceType;
    clientId?:     string;
    staffId?:      string;
    // date range
    dateFrom?:     string;
    dateTo?:       string;
}

// ── Staff assignment ──────────────────────────────────────────────────────────

export interface IAssignStaff {
    staffIds: string[]; // replaces the full assignment list
}

// ── Calendar ─────────────────────────────────────────────────────────────────

export interface ICalendarQuery {
    year:  number;
    month: number; // 1-12
}
