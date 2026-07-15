export const adminSearchableFields = [
    "businessName",
    "mobileNumber",
];

export const adminFilterableFields = [
    "city",
    "country",
];

// ─── Guided setup wizard ────────────────────────────────────────────────────

export const ONBOARDING_STEPS = [
    { key: "business_profile", label: "Business Profile" },
    { key: "service", label: "Add a Service" },
    { key: "service_area", label: "Service Area" },
    { key: "team", label: "Invite Your Team" },
    { key: "client", label: "Add a Client" },
    { key: "booking", label: "Create a Booking" },
] as const;

// Steps 1-3 are mandatory and set up the business itself (profile, what it
// sells, where it operates) — the app can't function meaningfully without
// them, so they can never be skipped, including by hitting the API directly.
// Steps 4-6 (team / client / booking) are usage steps an admin may
// legitimately want to defer, so — and only so — these three may be skipped.
export const SKIPPABLE_ONBOARDING_STEPS = ["team", "client", "booking"] as const;