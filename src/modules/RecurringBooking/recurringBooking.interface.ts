import { RecurringFrequency, RecurringStatus, ServiceType, WeekDay } from "../../generated/prisma/enums";

// ── Create ────────────────────────────────────────────────────────────────────

export interface IRecurringScheduleCreate {
    clientId:     string;
    serviceCatalogId?: string;
    serviceType?:  ServiceType;
    address:      string;
    durationMins: number;
    total:        number;
    notes?:       string;

    frequency:    RecurringFrequency;
    dayOfWeek:    WeekDay;
    timeHour:     number; // 0-23 UTC
    timeMinute:   number; // 0-59 UTC
    startDate:    string; // ISO date string (YYYY-MM-DD)

    staffIds?:    string[];
}

// ── Update ────────────────────────────────────────────────────────────────────

export interface IRecurringScheduleUpdate {
    serviceCatalogId?: string;
    serviceType?:  ServiceType;
    address?:      string;
    durationMins?: number;
    total?:        number;
    notes?:        string;
    frequency?:    RecurringFrequency;
    dayOfWeek?:    WeekDay;
    timeHour?:     number;
    timeMinute?:   number;
    staffIds?:     string[];
}

// ── Filters ───────────────────────────────────────────────────────────────────

export interface IRecurringScheduleFilters {
    searchTerm?: string;
    status?:     RecurringStatus;
    frequency?:  RecurringFrequency;
}
