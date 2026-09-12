import { randomUUID } from "node:crypto";
import { DEFAULT_WEBSITE_PAGES } from "./website.constant";

/**
 * Build the initial page records for a newly provisioned website.
 *
 * BOOK is enabled in the draft by default for every tenant; registration also
 * provisions a published tenant-owned booking form and attaches it as primary.
 * Public launch remains fail-closed until at least one real priced service is
 * active for online booking. ESTIMATE remains created but disabled by default.
 */
export const buildInitialWebsitePages = (
  websiteId: string,
  timestamp = new Date(),
  idFactory: () => string = randomUUID,
) => DEFAULT_WEBSITE_PAGES.map((page) => ({
  id: idFactory(),
  websiteId,
  ...page,
  content: JSON.parse(JSON.stringify(page.content ?? {})),
  seoTitle: null,
  seoDescription: null,
  seoKeywords: [],
  socialImageUrl: null,
  isEnabled: "isEnabled" in page ? page.isEnabled : true,
  createdAt: timestamp,
  updatedAt: timestamp,
}));
