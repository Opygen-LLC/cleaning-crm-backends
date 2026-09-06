import status from "http-status";
import { readWebsiteTemplateRelease } from "./websiteTemplateRelease";
import AppError from "../../errorHelper/AppError";
import type { WebsiteEntitlements } from "./websiteEntitlement.service";
import {
  websiteDesignContractSchema,
  parseWebsiteDesignContract,
  type WebsiteDesignContract,
} from "./websiteDesignContract";

export const WEBSITE_COMPONENT_SLOTS = [
  "shared.header", "shared.footer",
  "home.hero", "home.trustStats", "home.services", "home.howItWorks", "home.whyChooseUs", "home.reviews", "home.serviceAreas", "home.cta",
  "services.hero", "services.listing", "services.card", "services.cta",
  "about.hero", "about.story", "about.values", "about.statistics", "about.cta",
  "reviews.hero", "reviews.summary", "reviews.listing", "reviews.card", "reviews.cta",
  "contact.hero", "contact.businessInfo", "contact.form", "contact.map",
  "booking.hero", "booking.formWrapper",
  "estimate.hero", "estimate.formWrapper",
] as const;

export type WebsiteComponentSlot = (typeof WEBSITE_COMPONENT_SLOTS)[number];
type ComponentEntitlement = "included" | "premiumTemplates";

type ComponentDefinition = {
  id: string;
  slot: WebsiteComponentSlot;
  status: "ACTIVE" | "INACTIVE";
  entitlement: ComponentEntitlement;
};

const component = (
  id: string,
  slot: WebsiteComponentSlot,
  entitlement: ComponentEntitlement = "included",
): ComponentDefinition => ({ id, slot, status: "ACTIVE", entitlement });

/**
 * Backend mirror of the public component registry. Component IDs are a stored
 * API contract, not display labels, so Publish must validate them server-side
 * even though Website Studio only offers known choices.
 */
const LEGACY_REGISTRY: readonly ComponentDefinition[] = [
  component("shared.header.modern-glass.v1", "shared.header", "premiumTemplates"),
  component("shared.header.minimal.v1", "shared.header"),
  component("shared.header.local-business.v1", "shared.header"),
  component("shared.footer.mega.v1", "shared.footer", "premiumTemplates"),
  component("shared.footer.modern.v1", "shared.footer"),
  component("shared.footer.minimal.v1", "shared.footer"),
  component("home.hero.booking-split.v1", "home.hero"),
  component("home.hero.background-cleaning.v1", "home.hero", "premiumTemplates"),
  component("home.hero.local-cleaning.v1", "home.hero"),
  component("home.services.cards-modern.v1", "home.services"),
  component("home.services.editorial-grid.v1", "home.services", "premiumTemplates"),
  component("home.services.compact-list.v1", "home.services"),
  component("home.why-choose-us.icon-cards.v1", "home.whyChooseUs"),
  component("home.why-choose-us.image-benefits.v1", "home.whyChooseUs", "premiumTemplates"),
  component("home.why-choose-us.numbered-benefits.v1", "home.whyChooseUs", "premiumTemplates"),
  component("home.reviews.card-grid.v1", "home.reviews"),
  component("home.reviews.large-testimonial.v1", "home.reviews", "premiumTemplates"),
  component("home.reviews.rating-summary.v1", "home.reviews"),
  component("home.service-areas.chips.v1", "home.serviceAreas"),
  component("home.service-areas.coverage-cards.v1", "home.serviceAreas"),
  component("home.service-areas.map-layout.v1", "home.serviceAreas", "premiumTemplates"),
  component("home.cta.book-cleaning.v1", "home.cta"),
  component("home.cta.free-estimate.v1", "home.cta"),
  component("home.cta.contact-team.v1", "home.cta"),
];

// Each refreshed component has its own stored ID. No existing design is rewritten.
const REGISTRY: readonly ComponentDefinition[] = [...LEGACY_REGISTRY, ...LEGACY_REGISTRY.map(item => ({ ...item, id: item.id.replace(/\.v1$/, ".v2") }))];

const byId = new Map(REGISTRY.map((definition) => [definition.id, definition]));
const slotSet = new Set<string>(WEBSITE_COMPONENT_SLOTS);

const readOverride = (design: WebsiteDesignContract, slot: WebsiteComponentSlot): string | undefined => {
  const [group, key] = slot.split(".", 2);
  return (design.componentOverrides as Record<string, Record<string, string> | undefined>)[group]?.[key];
};

const assertSlotScopedMaps = (design: WebsiteDesignContract) => {
  for (const key of Object.keys(design.componentAnimations)) {
    if (!slotSet.has(key)) {
      throw new AppError(status.UNPROCESSABLE_ENTITY, `Unknown website animation slot: ${key}`, {
        code: "WEBSITE_DESIGN_SLOT_INVALID",
        retryable: false,
      });
    }
  }
  for (const key of Object.keys(design.sectionStyles)) {
    if (!slotSet.has(key)) {
      throw new AppError(status.UNPROCESSABLE_ENTITY, `Unknown website section style slot: ${key}`, {
        code: "WEBSITE_DESIGN_SLOT_INVALID",
        retryable: false,
      });
    }
  }
};

export const assertWebsiteDesignPublishable = (
  value: unknown,
  entitlements: WebsiteEntitlements,
): void => {
  const design =
    value === null ||
    value === undefined ||
    (typeof value === "object" && !("schemaVersion" in (value as Record<string, unknown>)))
      ? parseWebsiteDesignContract(value)
      : (() => {
          const parsed = websiteDesignContractSchema.safeParse(value);
          if (!parsed.success) {
            throw new AppError(
              status.UNPROCESSABLE_ENTITY,
              "Website design configuration is invalid and cannot be published.",
              {
                code: "WEBSITE_DESIGN_INVALID",
                retryable: false,
              },
            );
          }
          return parsed.data;
        })();
  assertSlotScopedMaps(design);

  for (const slot of WEBSITE_COMPONENT_SLOTS) {
    const componentId = readOverride(design, slot);
    if (!componentId) continue;
    const definition = byId.get(componentId);
    if (!definition) {
      throw new AppError(status.UNPROCESSABLE_ENTITY, `Unknown website component: ${componentId}`, {
        code: "WEBSITE_COMPONENT_UNKNOWN",
        retryable: false,
      });
    }
    if (definition.id.endsWith(".v2") && !readWebsiteTemplateRelease().refreshedEnabled) {
      throw new AppError(status.CONFLICT, "Refreshed sections are not available for publication yet.", { code: "WEBSITE_TEMPLATE_RELEASE_UNAVAILABLE", retryable: false });
    }
    if (definition.status !== "ACTIVE") {
      throw new AppError(status.CONFLICT, `Website component ${componentId} is not currently active`, {
        code: "WEBSITE_COMPONENT_INACTIVE",
        retryable: false,
      });
    }
    if (definition.slot !== slot) {
      throw new AppError(status.UNPROCESSABLE_ENTITY, `Website component ${componentId} cannot be used in ${slot}`, {
        code: "WEBSITE_COMPONENT_SLOT_MISMATCH",
        retryable: false,
      });
    }
    if (definition.entitlement === "premiumTemplates" && !entitlements.premiumTemplates) {
      throw new AppError(status.FORBIDDEN, "Remove premium component overrides or upgrade your plan before publishing.", {
        code: "WEBSITE_PREMIUM_COMPONENT_REQUIRED",
        retryable: false,
      });
    }
  }
};

export const WebsiteComponentRegistry = {
  list: () => REGISTRY.map((definition) => ({ ...definition })),
  find: (id: string) => { const definition = byId.get(id); return definition ? { ...definition } : undefined; },
  assertWebsiteDesignPublishable,
};
