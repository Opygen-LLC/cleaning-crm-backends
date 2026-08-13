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

// ─── Account setup + Getting Started ─────────────────────────────────────────

export type OnboardingStepKey =
  | "business_profile"
  | "service"
  | "service_area";

export type GettingStartedStepKey =
  | OnboardingStepKey
  | "team"
  | "client"
  | "booking"
  | "online_booking";

export type LegacySkippableOnboardingStepKey = "team" | "client" | "booking";

export interface SkipOnboardingStepPayload {
  step: LegacySkippableOnboardingStepKey;
}

export type OnboardingStepStatus = "completed" | "pending";
