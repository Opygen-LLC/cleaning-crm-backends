import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { readWebsiteTemplateRelease } from "./websiteTemplateRelease";

export type WebsiteTemplateTier = "FREE" | "PRO";

export interface WebsiteTemplateDefinition {
  /** Stable runtime identifier. Persisted separately from version. */
  id: string;
  /** Immutable semantic version. Existing tenants never auto-upgrade. */
  version: string;
  /** Convenience key used by clients/runtime registries. */
  key: string;
  name: string;
  description: string;
  tier: WebsiteTemplateTier;
  schemaVersion: number;
  thumbnail: string | null;
  bestFor: readonly string[];
  highlights: readonly string[];
  capabilities: {
    booking: boolean;
    estimate: boolean;
    reviews: boolean;
    serviceAreas: boolean;
    customDomain: boolean;
  };
}

type RawWebsiteTemplateDefinition = Omit<WebsiteTemplateDefinition, "key">;

const COMMON_CAPABILITIES = Object.freeze({
  booking: true,
  estimate: true,
  reviews: true,
  serviceAreas: true,
  customDomain: true,
});

const rawDefinitions: RawWebsiteTemplateDefinition[] = [
  {
    id: "clean-modern",
    version: "1.0.0",
    name: "Clean Modern",
    description: "Bright, friendly and conversion-focused for residential cleaning businesses.",
    tier: "FREE",
    schemaVersion: 1,
    thumbnail: null,
    bestFor: ["Residential cleaning", "Small cleaning businesses"],
    highlights: ["Bright service-led layout", "Strong online booking CTA", "Reviews and service areas"],
    capabilities: COMMON_CAPABILITIES,
  },
  {
    id: "premium-home",
    version: "1.0.0",
    name: "Premium Home",
    description: "Editorial, image-forward presentation for premium and luxury home cleaning.",
    tier: "PRO",
    schemaVersion: 1,
    thumbnail: null,
    bestFor: ["Premium home cleaning", "Luxury residential services"],
    highlights: ["Large imagery", "Elegant typography", "Review-led trust"],
    capabilities: COMMON_CAPABILITIES,
  },
  {
    id: "commercial-pro",
    version: "1.0.0",
    name: "Commercial Pro",
    description: "Structured business-first website for office and commercial cleaning providers.",
    tier: "PRO",
    schemaVersion: 1,
    thumbnail: null,
    bestFor: ["Office cleaning", "Schools", "Warehouses", "Commercial buildings"],
    highlights: ["Commercial service focus", "Estimate-first conversion", "Contract-ready presentation"],
    capabilities: COMMON_CAPABILITIES,
  },
  {
    id: "local-cleaning",
    version: "1.0.0",
    name: "Local Cleaning",
    description: "Fast local-services layout focused on prices, trust, coverage and booking.",
    tier: "FREE",
    schemaVersion: 1,
    thumbnail: null,
    bestFor: ["Local cleaning companies", "Owner-operated teams", "High-volume bookings"],
    highlights: ["Visible service prices", "Service-area emphasis", "Persistent booking actions"],
    capabilities: COMMON_CAPABILITIES,
  },
];

// Version 1 remains immutable. Version 2 uses the same projection schema, but
// has independent renderers/assets. Nothing here rewrites an existing tenant.
for (const original of [...rawDefinitions]) {
  original.thumbnail = `/website-catalog/templates/${original.id}/1.0.0/home.webp`;
  const descriptions: Record<string, string> = {
    "clean-modern": "A bright residential layout with a photo-led introduction and clear service cards.",
    "premium-home": "An editorial home-care layout with generous spacing and refined typography.",
    "commercial-pro": "A practical business layout for service scope, sectors, process and enquiries.",
    "local-cleaning": "An approachable local layout with coverage, contact details and easy booking.",
  };
  rawDefinitions.push({
    ...original,
    version: "2.0.0",
    description: descriptions[original.id],
    thumbnail: `/website-catalog/templates/${original.id}/2.0.0/home.webp`,
    highlights: ["Accessible navigation", "Responsive service and contact pages", "Your photos, reviews and brand"],
  });
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const parseVersion = (version: string): readonly [number, number, number] => {
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`Invalid website template version in registry: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
};

const compareVersions = (left: string, right: string): number => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
};

const freezeDefinition = (definition: RawWebsiteTemplateDefinition): Readonly<WebsiteTemplateDefinition> => {
  const key = `${definition.id}@${definition.version}`;
  return Object.freeze({
    ...definition,
    key,
    bestFor: Object.freeze([...definition.bestFor]),
    highlights: Object.freeze([...definition.highlights]),
    capabilities: Object.freeze({ ...definition.capabilities }),
  });
};

const definitions = rawDefinitions.map((definition) => {
  if (!definition.id.trim()) throw new Error("Website template registry contains an empty template id");
  if (!Number.isInteger(definition.schemaVersion) || definition.schemaVersion < 1) {
    throw new Error(`Website template ${definition.id}@${definition.version} has an invalid schemaVersion`);
  }
  parseVersion(definition.version);
  return freezeDefinition(definition);
});

const byKey = new Map<string, Readonly<WebsiteTemplateDefinition>>();
const latestById = new Map<string, Readonly<WebsiteTemplateDefinition>>();

for (const definition of definitions) {
  if (byKey.has(definition.key)) throw new Error(`Duplicate website template registry entry: ${definition.key}`);
  byKey.set(definition.key, definition);

  const currentLatest = latestById.get(definition.id);
  if (!currentLatest || compareVersions(definition.version, currentLatest.version) > 0) {
    latestById.set(definition.id, definition);
  }
}

const cloneDefinition = (item: Readonly<WebsiteTemplateDefinition>): WebsiteTemplateDefinition => ({
  ...item,
  bestFor: [...item.bestFor],
  highlights: [...item.highlights],
  capabilities: { ...item.capabilities },
});

const list = () => definitions
  .slice()
  .sort((a, b) => a.id.localeCompare(b.id) || compareVersions(b.version, a.version))
  .map(cloneDefinition);

/**
 * Versionless resolution is intentionally deterministic: it resolves to the
 * highest registered semantic version. Persisted websites always store the
 * explicit version, so existing tenants are never silently upgraded.
 */
const get = (templateId: string, version?: string) => {
  const template = version
    ? byKey.get(`${templateId}@${version}`) ?? null
    : latestById.get(templateId) ?? null;
  return template ? cloneDefinition(template) : null;
};

const requireTemplate = (templateId: string, version?: string) => {
  const template = get(templateId, version);
  if (!template) {
    throw new AppError(status.BAD_REQUEST, `Unsupported website template: ${templateId}${version ? `@${version}` : ""}`);
  }
  return template;
};

/** Selection is enabled only after all public frontend instances know v2.
 * Reads deliberately ignore the flag: rollback must not remove a live renderer. */
const listSelectable = () => {
  const release = readWebsiteTemplateRelease();
  return list().filter((template) => template.version === "1.0.0" || release.refreshedEnabled);
};

const requireSelectable = (id: string, version: string, current?: { templateId: string; templateVersion: string }) => {
  const template = requireTemplate(id, version);
  const unchanged = current?.templateId === id && current.templateVersion === version;
  if (!unchanged && version === "2.0.0" && !readWebsiteTemplateRelease().refreshedEnabled) {
    throw new AppError(status.CONFLICT, "This template release is not available yet. Reload the template library.", {
      code: "WEBSITE_TEMPLATE_RELEASE_UNAVAILABLE", retryable: false,
    });
  }
  return template;
};

const requirePublishable = (id: string, version: string) => requireSelectable(id, version);
const defaultTemplate = () => requireSelectable("clean-modern", readWebsiteTemplateRelease().defaultVersion);

export const TemplateRegistry = {
  list, listSelectable, get, requireTemplate, requireSelectable, requirePublishable, defaultTemplate,
};
