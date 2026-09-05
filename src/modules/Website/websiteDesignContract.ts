import { z } from "zod";

const componentId = z.string().trim().min(1).max(160);
const optionalComponentId = componentId.optional();

const sharedOverridesSchema = z.object({
  header: optionalComponentId,
  footer: optionalComponentId,
}).strict().partial();

const homeOverridesSchema = z.object({
  hero: optionalComponentId,
  trustStats: optionalComponentId,
  services: optionalComponentId,
  howItWorks: optionalComponentId,
  whyChooseUs: optionalComponentId,
  reviews: optionalComponentId,
  serviceAreas: optionalComponentId,
  cta: optionalComponentId,
}).strict().partial();

const servicesOverridesSchema = z.object({
  hero: optionalComponentId,
  listing: optionalComponentId,
  card: optionalComponentId,
  cta: optionalComponentId,
}).strict().partial();

const aboutOverridesSchema = z.object({
  hero: optionalComponentId,
  story: optionalComponentId,
  values: optionalComponentId,
  statistics: optionalComponentId,
  cta: optionalComponentId,
}).strict().partial();

const reviewsOverridesSchema = z.object({
  hero: optionalComponentId,
  summary: optionalComponentId,
  listing: optionalComponentId,
  card: optionalComponentId,
  cta: optionalComponentId,
}).strict().partial();

const contactOverridesSchema = z.object({
  hero: optionalComponentId,
  businessInfo: optionalComponentId,
  form: optionalComponentId,
  map: optionalComponentId,
}).strict().partial();

const formPageOverridesSchema = z.object({
  hero: optionalComponentId,
  formWrapper: optionalComponentId,
}).strict().partial();

const componentOverridesSchema = z.object({
  shared: sharedOverridesSchema.optional(),
  home: homeOverridesSchema.optional(),
  services: servicesOverridesSchema.optional(),
  about: aboutOverridesSchema.optional(),
  reviews: reviewsOverridesSchema.optional(),
  contact: contactOverridesSchema.optional(),
  booking: formPageOverridesSchema.optional(),
  estimate: formPageOverridesSchema.optional(),
}).strict();

const animationConfigSchema = z.object({
  enabled: z.boolean().optional(),
  effect: z.enum(["none", "fade-in", "fade-up", "fade-down", "fade-left", "fade-right", "slide-up", "slide-down", "slide-left", "slide-right", "zoom-in", "zoom-out", "blur-in", "reveal-up"]).optional(),
  duration: z.union([
    z.enum(["fast", "normal", "slow"]),
    z.number().int().min(0).max(10_000),
  ]).optional(),
  delayMs: z.number().int().min(0).max(10_000).optional(),
  trigger: z.enum(["load", "viewport"]).optional(),
  replay: z.boolean().optional(),
}).strict();

const sectionStyleSchema = z.object({
  backgroundColor: z.string().trim().max(120).nullable().optional(),
  textColor: z.string().trim().max(120).nullable().optional(),
}).strict();

export const websiteDesignContractSchema = z.object({
  schemaVersion: z.literal(1),
  componentOverrides: componentOverridesSchema.default({}),
  componentAnimations: z.record(z.string().min(1).max(180), animationConfigSchema).default({}),
  sectionStyles: z.record(z.string().min(1).max(180), sectionStyleSchema).default({}),
  animationsEnabled: z.boolean().default(true),
}).strict();

export type WebsiteDesignContract = z.infer<typeof websiteDesignContractSchema>;

export const DEFAULT_WEBSITE_DESIGN: WebsiteDesignContract = Object.freeze({
  schemaVersion: 1,
  componentOverrides: {},
  componentAnimations: {},
  sectionStyles: {},
  animationsEnabled: true,
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Website design JSON is persisted and also embedded into immutable publication
 * snapshots. Treat database JSON as untrusted input and fail safely to the
 * canonical empty V1 contract so a malformed editor configuration can never
 * take a public website offline.
 */
export const parseWebsiteDesignContract = (value: unknown): WebsiteDesignContract => {
  const parsed = websiteDesignContractSchema.safeParse(value);
  return parsed.success ? parsed.data : clone(DEFAULT_WEBSITE_DESIGN);
};

export const cloneDefaultWebsiteDesign = (): WebsiteDesignContract => clone(DEFAULT_WEBSITE_DESIGN);
