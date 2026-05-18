import { FormFieldType, ServiceType } from "../../generated/prisma/enums";

export interface IEstimateFormCreate {
    headline:            string;
    subheading?:         string;
    accentColor?:        string;
    showReviews?:        boolean;
    ctaLabel?:           string;
    confirmationMessage?: string;
    coveredPostcodes?:   string[];
    coveredCities?:      string[];
    showLiveEstimate?:   boolean;
    services?: {
        serviceType: ServiceType;
        enabled?:    boolean;
        basePrice?:  number;
    }[];
    addOns?: {
        label:   string;
        price:   number;
        enabled?: boolean;
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