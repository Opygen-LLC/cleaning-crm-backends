import { JobStatus, ServiceType } from "../../generated/prisma/enums";

// ── Create ────────────────────────────────────────────────────────────────────

export interface IJobCreate {
    clientId:      string;
    serviceType:   ServiceType;
    address:       string;
    scheduledDate: string | Date;
    durationMins:  number;
    notes?:        string;
    quoteId?:      string;
    estimateId?:   string;
    bookingId?:    string; // convert an existing booking into a job
    staffIds?:     string[]; // optional initial assignment
}

// ── Update ────────────────────────────────────────────────────────────────────

export interface IJobUpdate {
    serviceType?:   ServiceType;
    address?:       string;
    scheduledDate?: string | Date;
    durationMins?:  number;
    notes?:         string;
}

// ── Filters ───────────────────────────────────────────────────────────────────

export interface IJobFilters {
    searchTerm?:  string;
    status?:      JobStatus;
    serviceType?: ServiceType;
    clientId?:    string;
    staffId?:     string;
    dateFrom?:    string;
    dateTo?:      string;
}

// ── Staff assignment ──────────────────────────────────────────────────────────

export interface IAssignJobStaff {
    staffIds: string[]; // replaces the full assignment list
}

// ── Staff availability ────────────────────────────────────────────────────────

export interface IStaffAvailabilityQuery {
    date:        string; // ISO datetime string (start of window)
    durationMins: number;
}
