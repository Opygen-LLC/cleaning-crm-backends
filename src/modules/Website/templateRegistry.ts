import AppError from "../../errorHelper/AppError";
import status from "http-status";

export type WebsiteTemplateTier = "FREE" | "PRO";

export interface WebsiteTemplateDefinition {
  id: string;
  version: string;
  name: string;
  description: string;
  tier: WebsiteTemplateTier;
  schemaVersion: number;
  thumbnail: string | null;
  capabilities: {
    booking: boolean;
    estimate: boolean;
    reviews: boolean;
    serviceAreas: boolean;
    customDomain: boolean;
  };
}

const rawDefinitions: WebsiteTemplateDefinition[] = [
  {
    id: "clean-modern", version: "1.0.0", name: "Clean Modern",
    description: "Bright, conversion-focused design for residential cleaning businesses.",
    tier: "FREE", schemaVersion: 1, thumbnail: null,
    capabilities: { booking: true, estimate: true, reviews: true, serviceAreas: true, customDomain: true },
  },
  {
    id: "premium-home", version: "1.0.0", name: "Premium Home",
    description: "A polished, premium presentation for high-end home cleaning services.",
    tier: "FREE", schemaVersion: 1, thumbnail: null,
    capabilities: { booking: true, estimate: true, reviews: true, serviceAreas: true, customDomain: true },
  },
  {
    id: "commercial-pro", version: "1.0.0", name: "Commercial Pro",
    description: "A confident business-first layout for office and commercial cleaning providers.",
    tier: "FREE", schemaVersion: 1, thumbnail: null,
    capabilities: { booking: true, estimate: true, reviews: true, serviceAreas: true, customDomain: true },
  },
  {
    id: "local-cleaning", version: "1.0.0", name: "Local Cleaning",
    description: "A simple local-services layout focused on trust, service areas and fast booking.",
    tier: "FREE", schemaVersion: 1, thumbnail: null,
    capabilities: { booking: true, estimate: true, reviews: true, serviceAreas: true, customDomain: true },
  },
];

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

const freezeDefinition = (definition: WebsiteTemplateDefinition): Readonly<WebsiteTemplateDefinition> =>
  Object.freeze({
    ...definition,
    capabilities: Object.freeze({ ...definition.capabilities }),
  });

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
  const key = `${definition.id}@${definition.version}`;
  if (byKey.has(key)) throw new Error(`Duplicate website template registry entry: ${key}`);
  byKey.set(key, definition);

  const currentLatest = latestById.get(definition.id);
  if (!currentLatest || compareVersions(definition.version, currentLatest.version) > 0) {
    latestById.set(definition.id, definition);
  }
}

const cloneDefinition = (item: Readonly<WebsiteTemplateDefinition>): WebsiteTemplateDefinition => ({
  ...item,
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

export const TemplateRegistry = {
  list,
  get,
  requireTemplate,
};
