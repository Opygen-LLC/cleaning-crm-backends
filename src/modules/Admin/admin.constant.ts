import { API_CONTRACT } from "../../contracts/apiContract";

export const adminSearchableFields = [
  "businessName",
  "mobileNumber",
];

export const adminFilterableFields = [
  "city",
  "country",
];

// Website-first onboarding. Defaults are provisioned at registration, but each
// step must still be explicitly completed so the wizard can resume safely.
export const ACCOUNT_SETUP_STEPS = [
  { key: API_CONTRACT.onboardingStep[0], label: "Business" },
  { key: API_CONTRACT.onboardingStep[1], label: "Brand" },
  { key: API_CONTRACT.onboardingStep[2], label: "Services + Booking" },
  { key: API_CONTRACT.onboardingStep[3], label: "Website Address" },
  { key: API_CONTRACT.onboardingStep[4], label: "Review + Launch" },
] as const;

export const ONBOARDING_STEPS = ACCOUNT_SETUP_STEPS;

export const GETTING_STARTED_STEPS = [
  ...ACCOUNT_SETUP_STEPS,
  { key: "service_area", label: "Add a service area" },
  { key: "team", label: "Invite your team" },
  { key: "client", label: "Add your first client" },
  { key: "booking", label: "Create your first booking" },
  { key: "online_booking", label: "Publish online booking" },
] as const;

// Legacy API compatibility only.
export const SKIPPABLE_ONBOARDING_STEPS = ["team", "client", "booking"] as const;
