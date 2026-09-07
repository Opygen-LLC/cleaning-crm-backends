import { randomUUID } from "node:crypto";
import { DEFAULT_WEBSITE_PAGES } from "./website.constant";

/**
 * Build the initial page records for a newly provisioned website.
 *
 * BOOK and ESTIMATE are intentionally created but disabled. Keeping those rows
 * lets Website Studio enable them later without schema churn, while preventing
 * a new tenant from exposing dead /book or /estimate routes before a published
 * tenant-owned form has been configured.
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
