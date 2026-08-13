export const adminSearchableFields = [
  "businessName",
  "mobileNumber",
];

export const adminFilterableFields = [
  "city",
  "country",
];

// ─── Account setup ───────────────────────────────────────────────────────────
// A new admin only needs these three steps before entering the workspace.
// Team/client/booking creation belongs in the optional Getting Started
// checklist, not in the registration gate.
export const ACCOUNT_SETUP_STEPS = [
  { key: "business_profile", label: "Business details" },
  { key: "service", label: "Services" },
  { key: "service_area", label: "Service area" },
] as const;

// Backwards-compatible export name for older imports. From Phase 2 onward this
// deliberately contains only the three required account-setup steps.
export const ONBOARDING_STEPS = ACCOUNT_SETUP_STEPS;

export const GETTING_STARTED_STEPS = [
  { key: "business_profile", label: "Complete business profile" },
  { key: "service", label: "Add your first service" },
  { key: "service_area", label: "Add a service area" },
  { key: "team", label: "Invite your team" },
  { key: "client", label: "Add your first client" },
  { key: "booking", label: "Create your first booking" },
  { key: "online_booking", label: "Publish online booking" },
] as const;

// Legacy API compatibility only. These values were skippable in the old
// six-step wizard. The new three-step account setup has no skip action, and
// skippedSteps no longer contributes to account-setup or checklist progress.
export const SKIPPABLE_ONBOARDING_STEPS = ["team", "client", "booking"] as const;
