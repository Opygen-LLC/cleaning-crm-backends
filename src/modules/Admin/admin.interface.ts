import { Currency } from "../../generated/prisma/enums";

export interface UpdateAdminPayload {
  businessName?: string;
  businessLogo?: string;
  businessType?: string;
  businessEmail?: string;
  businessDescription?: string;
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
  | "services"
  | "branding"
  | "website_address"
  | "template";

export type GettingStartedStepKey =
  | OnboardingStepKey
  | "service_area"
  | "team"
  | "client"
  | "booking"
  | "online_booking";

export type LegacySkippableOnboardingStepKey = "team" | "client" | "booking";

export interface SkipOnboardingStepPayload {
  step: LegacySkippableOnboardingStepKey;
}

export type OnboardingStepStatus = "completed" | "pending";

export interface CompleteOnboardingStepPayload {
  step: OnboardingStepKey;
}
