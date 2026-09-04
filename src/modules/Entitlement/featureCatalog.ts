export const FEATURE_CATALOG = {
  website: {
    label: "Website",
    aliases: ["basic website", "website builder"],
  },
  custom_domain: {
    label: "Custom Domains",
    aliases: ["custom domain", "custom domains"],
  },
  premium_templates: {
    label: "Premium Website Templates",
    aliases: ["premium templates", "website templates"],
  },
  website_analytics: {
    label: "Website Analytics History",
    aliases: ["website analytics", "analytics", "analytics history"],
  },
  advanced_seo: {
    label: "Advanced Website SEO",
    aliases: ["advanced seo", "website seo"],
  },
  online_booking: {
    label: "Online Booking",
    aliases: ["booking forms", "online bookings"],
  },
  pricing_forms: {
    label: "Pricing Forms",
    aliases: ["estimate forms", "pricing form", "estimate form builder"],
  },
  estimate_submissions: {
    label: "Estimate Submissions",
    aliases: ["estimate submission", "website estimate submissions"],
  },
  recurring_bookings: {
    label: "Recurring Bookings",
    aliases: ["recurring booking", "recurring schedules"],
  },
  crm_leads: {
    label: "Leads Pipeline",
    aliases: ["crm leads", "lead pipeline", "leads", "pipeline view"],
  },
  reports: {
    label: "Reports",
    aliases: ["reporting"],
  },
  revenue_reports: {
    label: "Revenue Reports",
    aliases: ["revenue report"],
    parent: "reports",
  },
  client_retention_reports: {
    label: "Client Retention Reports",
    aliases: ["client retention report"],
    parent: "reports",
  },
  job_completion_reports: {
    label: "Job Completion Reports",
    aliases: ["job completion report"],
    parent: "reports",
  },
  staff_performance_reports: {
    label: "Staff Performance Reports",
    aliases: ["staff performance report"],
    parent: "reports",
  },
  reviews: {
    label: "Reviews",
    aliases: ["company reviews", "customer reviews"],
  },
  staff_reviews: {
    label: "Staff Reviews",
    aliases: ["staff review"],
    parent: "reviews",
  },
  coupons: {
    label: "Coupons",
    aliases: ["coupon", "discount coupons"],
  },
  auto_dispatch: {
    label: "Auto-Dispatch",
    aliases: ["auto dispatch", "automatic dispatch"],
  },
  dispatch_board: {
    label: "Dispatch Board",
    aliases: ["dispatch", "job dispatch"],
    parent: "auto_dispatch",
  },
  advanced_pricing_rules: {
    label: "Advanced Pricing Rules",
    aliases: ["pricing rules", "advanced pricing"],
  },
  leave_approvals: {
    label: "Leave Approvals",
    aliases: ["leave approval", "staff leave approvals"],
  },
  team_performance: {
    label: "Team Performance",
    aliases: ["team performance dashboard"],
  },
} as const;

export type FeatureKey = keyof typeof FEATURE_CATALOG;

export const FEATURE_KEYS = Object.freeze(
  Object.keys(FEATURE_CATALOG) as FeatureKey[],
);

export const FEATURE = Object.freeze(
  Object.fromEntries(
    FEATURE_KEYS.map((key) => [key.toUpperCase(), key]),
  ) as Record<Uppercase<FeatureKey>, FeatureKey>,
);

export const normalizeFeatureToken = (value: string) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const FEATURE_ALIAS_INDEX = new Map<string, FeatureKey>();
for (const key of FEATURE_KEYS) {
  const definition = FEATURE_CATALOG[key];
  FEATURE_ALIAS_INDEX.set(normalizeFeatureToken(key), key);
  FEATURE_ALIAS_INDEX.set(normalizeFeatureToken(definition.label), key);
  for (const alias of definition.aliases) {
    FEATURE_ALIAS_INDEX.set(normalizeFeatureToken(alias), key);
  }
}

export const isFeatureKey = (value: unknown): value is FeatureKey =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(FEATURE_CATALOG, value);

export const resolveFeatureKey = (value: unknown): FeatureKey | null => {
  if (typeof value !== "string") return null;
  if (isFeatureKey(value)) return value;
  return FEATURE_ALIAS_INDEX.get(normalizeFeatureToken(value)) ?? null;
};

export const featureLabel = (key: FeatureKey) => FEATURE_CATALOG[key].label;

export const featureParent = (key: FeatureKey): FeatureKey | null => {
  const parent = (FEATURE_CATALOG[key] as { parent?: FeatureKey }).parent;
  return parent ?? null;
};

/**
 * Historical override payloads used camelCase broad keys. They are accepted on
 * read during the rolling deployment, but are never written back in this form.
 */
export const LEGACY_OVERRIDE_KEY_MAP = Object.freeze({
  website: "website",
  customDomain: "custom_domain",
  analytics: "website_analytics",
  bookingForms: "online_booking",
  recurringBookings: "recurring_bookings",
  crmLeads: "crm_leads",
  reports: "reports",
  automations: "auto_dispatch",
} satisfies Record<string, FeatureKey>);
