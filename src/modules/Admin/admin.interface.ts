import { Currency } from "../../generated/prisma/enums";

export interface UpdateAdminPayload {
    businessName?: string;
	businessLogo?: string;
    businessType?: string;
    businessEmail?: string;
    website?: string;
    brandColor?: string;
    currency?: Currency;
    mobileNumber?: string;

    address?: string;
    city?: string;
    zipcode?: string;
    country?: string;

    workLocations?: {
        city: string;
        postcode?: string;
        notes?: string;
    }[];
}

export interface UpdateWorkLocationPayload {
    city?: string;
    postcode?: string;
    notes?: string;
}

// ─── Guided setup wizard ────────────────────────────────────────────────────

export type OnboardingStepKey =
    | "business_profile"
    | "service"
    | "service_area"
    | "team"
    | "client"
    | "booking";

export interface SkipOnboardingStepPayload {
    step: OnboardingStepKey;
}

export type OnboardingStepStatus = "completed" | "skipped" | "pending";
