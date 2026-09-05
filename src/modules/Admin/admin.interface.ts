import { Currency, ServiceCategory } from "../../generated/prisma/enums";
import type { BusinessHours } from "./businessHours";

export interface UpdateAdminPayload {
  businessName?: string;
  businessLogo?: string;
  businessType?: string | null;
  licenseNumber?: string | null;
  businessEmail?: string | null;
  businessDescription?: string | null;
  businessHours?: BusinessHours | null;
  website?: string | null;
  brandColor?: string;
  currency?: Currency;
  mobileNumber?: string | null;

  address?: string | null;
  city?: string | null;
  postcode?: string | null;
  /** @deprecated Use postcode. Accepted during rolling deployments only. */
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
  | "review_launch";

/** Accepted temporarily for rolling deployments and legacy persisted progress. */
export type LegacyOnboardingStepKey = "template";

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

export interface OnboardingClientErrorPayload {
  message: string;
  errorName: string;
  errorKind: "chunk-load" | "api-contract" | "type-error" | "react-render" | "unknown";
  stack?: string | null;
  digest?: string | null;
  route: string;
  releaseVersion: string;
  apiRequestId?: string | null;
  relatedTraceId?: string | null;
  browser: string;
  bootstrapSchemaVersion: number;
  section: "route" | "active-step" | "preview" | "bootstrap";
  onboardingStep?: OnboardingStepKey | null;
  componentStack?: string | null;
}


export interface SaveOnboardingServicesPayload {
  services: Array<{
    serviceCatalogId?: string;
    serviceName: string;
    description: string;
    basePrice: number;
    duration: string;
    category: ServiceCategory;
    onlineBookingEnabled: boolean;
    addOns?: Array<{ name: string; price: number }>;
  }>;
  booking: {
    enabled: boolean;
    bookingFormId?: string | null;
    showNavigation: boolean;
    showHeaderCta: boolean;
    showServiceCtas: boolean;
    showHomeCta: boolean;
    showAvailableSlots: boolean;
    showPrices: boolean;
    showStartingPrices: boolean;
    showServiceDuration: boolean;
    ctaLabel: string;
  };
}
