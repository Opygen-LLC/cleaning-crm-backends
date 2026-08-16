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

const definitions: WebsiteTemplateDefinition[] = [
  {
    id: "clean-modern",
    version: "1.0.0",
    name: "Clean Modern",
    description: "Fast, conversion-focused cleaning business website template.",
    tier: "FREE",
    schemaVersion: 1,
    thumbnail: null,
    capabilities: {
      booking: true,
      estimate: true,
      reviews: true,
      serviceAreas: true,
      customDomain: true,
    },
  },
];

const byKey = new Map(definitions.map((item) => [`${item.id}@${item.version}`, item]));

const list = () => definitions.map((item) => ({ ...item, capabilities: { ...item.capabilities } }));

const get = (templateId: string, version?: string) => {
  if (version) return byKey.get(`${templateId}@${version}`) ?? null;
  return definitions.find((item) => item.id === templateId) ?? null;
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
