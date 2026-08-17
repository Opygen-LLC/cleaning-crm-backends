import { Currency } from "../../generated/prisma/enums";
import type { BusinessHours } from "./businessHours";

export interface UpdateAdminPayload {
  businessName?: string;
  businessLogo?: string;
  businessType?: string | null;
  businessEmail?: string | null;
  businessDescription?: string | null;
  businessHours?: BusinessHours | null;
  website?: string | null;
  brandColor?: string;
  currency?: Currency;
  mobileNumber?: string | null;

  address?: string | null;
  city?: string | null;
  zipcode?: string | null;
  country?: string | null;

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
  | "branding"
  | "services"
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
