import { FormFieldType, ServiceType } from "../../generated/prisma/enums";

export interface IBookingFormCreate {
    headline:              string;
    subheading?:           string;
    accentColor?:          string;
    showReviews?:          boolean;
    ctaLabel?:             string;
    confirmationMessage?:  string;
    availableDays?:        string[];
    blockedDates?:         string[];
    timeSlots?:            string[];
    maxBookingsPerSlot?:   number;
    slotDurationMinutes?:  number;
    bufferTimeMinutes?:    number;
    services?: {
        serviceType: ServiceType;
        enabled?:    boolean;
        priceLabel?: string;
        duration?:   string;
    }[];
    fields?: {
        type:         FormFieldType;
        label:        string;
        placeholder?: string;
        required?:    boolean;
        enabled?:     boolean;
        options?:     string[];
        sortOrder?:   number;
    }[];
}

export interface IBookingFormUpdate extends Partial<IBookingFormCreate> {
    published?: boolean;
}
