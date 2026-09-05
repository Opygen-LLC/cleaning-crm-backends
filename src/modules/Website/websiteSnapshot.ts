import { createHash } from "crypto";
import { cloneDefaultWebsiteDesign, parseWebsiteDesignContract, type WebsiteDesignContract } from "./websiteDesignContract";

export interface WebsitePublishedPageSnapshot {
  id: string;
  kind: string;
  slug: string;
  title: string;
  content: unknown;
  seoTitle: string | null;
  seoDescription: string | null;
  seoKeywords: string[];
  socialImageUrl: string | null;
  showInNavigation: boolean;
  isEnabled: boolean;
  sortOrder: number;
}

export interface WebsitePublishedSnapshotV1 {
  version: 1;
  website: {
    templateId: string;
    templateVersion: string;
    schemaVersion: number;
    websiteDesign: WebsiteDesignContract;
    primaryColor: string;
    secondaryColor: string;
    accentColor: string;
    font: string | null;
    logo: string | null;
    favicon: string | null;
    primaryBookingFormId: string | null;
    primaryEstimateFormId: string | null;
    bookingEnabled: boolean;
    bookingShowNavigation: boolean;
    bookingShowHeaderCta: boolean;
    bookingShowServiceCtas: boolean;
    bookingShowHomeCta: boolean;
    bookingShowAvailableSlots: boolean;
    bookingShowPrices: boolean;
    bookingShowStartingPrices: boolean;
    bookingShowServiceDuration: boolean;
    bookingCtaLabel: string;
    estimateEnabled: boolean;
    metaTitle: string | null;
    metaDescription: string | null;
    metaKeywords: string[];
    socialImageUrl: string | null;
    indexSite: boolean;
    googleAnalyticsEnabled: boolean;
    googleAnalyticsMeasurementId: string | null;
  };
  pages: WebsitePublishedPageSnapshot[];
}

export interface WebsitePublicationFingerprint {
  websiteId: string;
  draftRevisionNumber: number;
  publishedRevisionNumber: number | null;
  publishedAt: Date | string | null;
  selected: {
    templateId: string;
    templateVersion: string;
    websiteDesignHash: string;
  };
  live: {
    templateId: string;
    templateVersion: string;
    websiteDesignHash: string;
  } | null;
  matchesLive: boolean;
}

interface DraftWebsiteLike {
  templateId: string;
  templateVersion: string;
  schemaVersion: number;
  websiteDesign?: unknown;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  font?: string | null;
  logo?: string | null;
  favicon?: string | null;
  primaryBookingFormId?: string | null;
  primaryEstimateFormId?: string | null;
  bookingEnabled?: boolean;
  bookingShowNavigation?: boolean;
  bookingShowHeaderCta?: boolean;
  bookingShowServiceCtas?: boolean;
  bookingShowHomeCta?: boolean;
  bookingShowAvailableSlots?: boolean;
  bookingShowPrices?: boolean;
  bookingShowStartingPrices?: boolean;
  bookingShowServiceDuration?: boolean;
  bookingCtaLabel?: string;
  estimateEnabled?: boolean;
  metaTitle?: string | null;
  metaDescription?: string | null;
  metaKeywords?: string[];
  socialImageUrl?: string | null;
  indexSite: boolean;
  googleAnalyticsEnabled?: boolean;
  googleAnalyticsMeasurementId?: string | null;
  pages?: Array<{
    id: string;
    kind: string;
    slug: string;
    title: string;
    content: unknown;
    seoTitle?: string | null;
    seoDescription?: string | null;
    seoKeywords?: string[];
    socialImageUrl?: string | null;
    showInNavigation: boolean;
    isEnabled: boolean;
    sortOrder: number;
  }>;
}

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Stable JSON canonicalization for publication diagnostics. Website design
 * records contain maps whose insertion order can differ across browser/server
 * processes even when their semantic value is identical. Sorting object keys
 * before hashing makes the fingerprint deterministic across those boundaries.
 */
const canonicalizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => canonicalizeJson(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonicalizeJson(item)]),
  );
};

export const hashWebsiteDesign = (value: unknown): string => {
  const normalized = parseWebsiteDesignContract(value ?? cloneDefaultWebsiteDesign());
  const canonical = JSON.stringify(canonicalizeJson(normalized));
  return createHash("sha256").update(canonical).digest("hex");
};

export const buildWebsitePublicationFingerprint = (input: {
  websiteId: string;
  draftRevisionNumber: number;
  publishedRevisionNumber: number | null;
  publishedAt: Date | string | null;
  templateId: string;
  templateVersion: string;
  websiteDesign: unknown;
  publishedSnapshot: WebsitePublishedSnapshotV1 | null;
}): WebsitePublicationFingerprint => {
  const selectedHash = hashWebsiteDesign(input.websiteDesign);
  const live = input.publishedSnapshot
    ? {
        templateId: input.publishedSnapshot.website.templateId,
        templateVersion: input.publishedSnapshot.website.templateVersion,
        websiteDesignHash: hashWebsiteDesign(input.publishedSnapshot.website.websiteDesign),
      }
    : null;
  const matchesLive = Boolean(
    live &&
    input.publishedRevisionNumber !== null &&
    input.draftRevisionNumber === input.publishedRevisionNumber &&
    input.templateId === live.templateId &&
    input.templateVersion === live.templateVersion &&
    selectedHash === live.websiteDesignHash,
  );

  return {
    websiteId: input.websiteId,
    draftRevisionNumber: input.draftRevisionNumber,
    publishedRevisionNumber: input.publishedRevisionNumber,
    publishedAt: input.publishedAt,
    selected: {
      templateId: input.templateId,
      templateVersion: input.templateVersion,
      websiteDesignHash: selectedHash,
    },
    live,
    matchesLive,
  };
};

export const buildPublishedSnapshot = (draft: DraftWebsiteLike): WebsitePublishedSnapshotV1 => ({
  version: 1,
  website: {
    templateId: draft.templateId,
    templateVersion: draft.templateVersion,
    schemaVersion: draft.schemaVersion,
    websiteDesign: parseWebsiteDesignContract(draft.websiteDesign ?? cloneDefaultWebsiteDesign()),
    primaryColor: draft.primaryColor,
    secondaryColor: draft.secondaryColor,
    accentColor: draft.accentColor,
    font: draft.font ?? null,
    logo: draft.logo ?? null,
    favicon: draft.favicon ?? null,
    primaryBookingFormId: draft.primaryBookingFormId ?? null,
    primaryEstimateFormId: draft.primaryEstimateFormId ?? null,
    bookingEnabled: draft.bookingEnabled ?? true,
    bookingShowNavigation: draft.bookingShowNavigation ?? true,
    bookingShowHeaderCta: draft.bookingShowHeaderCta ?? true,
    bookingShowServiceCtas: draft.bookingShowServiceCtas ?? true,
    bookingShowHomeCta: draft.bookingShowHomeCta ?? true,
    bookingShowAvailableSlots: draft.bookingShowAvailableSlots ?? true,
    bookingShowPrices: draft.bookingShowPrices ?? true,
    bookingShowStartingPrices: draft.bookingShowStartingPrices ?? true,
    bookingShowServiceDuration: draft.bookingShowServiceDuration ?? true,
    bookingCtaLabel: draft.bookingCtaLabel?.trim() || "Book Now",
    // Before Phase 13, selecting a published estimate form implicitly exposed
    // /estimate. Preserve that behavior for legacy draft objects while new
    // rows use the explicit estimateEnabled database default.
    estimateEnabled: draft.estimateEnabled ?? Boolean(draft.primaryEstimateFormId),
    metaTitle: draft.metaTitle ?? null,
    metaDescription: draft.metaDescription ?? null,
    metaKeywords: [...(draft.metaKeywords ?? [])],
    socialImageUrl: draft.socialImageUrl ?? null,
    indexSite: draft.indexSite,
    googleAnalyticsEnabled: draft.googleAnalyticsEnabled ?? false,
    googleAnalyticsMeasurementId: draft.googleAnalyticsMeasurementId ?? null,
  },
  pages: [...(draft.pages ?? [])]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((page) => ({
      id: page.id,
      kind: page.kind,
      slug: page.slug,
      title: page.title,
      content: cloneJson(page.content ?? {}),
      seoTitle: page.seoTitle ?? null,
      seoDescription: page.seoDescription ?? null,
      seoKeywords: [...(page.seoKeywords ?? [])],
      socialImageUrl: page.socialImageUrl ?? null,
      showInNavigation: page.showInNavigation,
      isEnabled: page.isEnabled,
      sortOrder: page.sortOrder,
    })),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const stringOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";

/**
 * Treat publishedSnapshot as untrusted JSON. Invalid/legacy values are ignored
 * rather than allowing a malformed row to break the public website runtime.
 */
export const parsePublishedSnapshot = (value: unknown): WebsitePublishedSnapshotV1 | null => {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.website) || !Array.isArray(value.pages)) return null;
  const site = value.website;
  if (
    typeof site.templateId !== "string" ||
    typeof site.templateVersion !== "string" ||
    typeof site.schemaVersion !== "number" ||
    typeof site.primaryColor !== "string" ||
    typeof site.secondaryColor !== "string" ||
    typeof site.accentColor !== "string" ||
    !stringOrNull(site.font) ||
    !stringOrNull(site.logo) ||
    !stringOrNull(site.favicon) ||
    !stringOrNull(site.primaryBookingFormId) ||
    !stringOrNull(site.primaryEstimateFormId) ||
    (site.bookingEnabled !== undefined && typeof site.bookingEnabled !== "boolean") ||
    (site.bookingShowNavigation !== undefined && typeof site.bookingShowNavigation !== "boolean") ||
    (site.bookingShowHeaderCta !== undefined && typeof site.bookingShowHeaderCta !== "boolean") ||
    (site.bookingShowServiceCtas !== undefined && typeof site.bookingShowServiceCtas !== "boolean") ||
    (site.bookingShowHomeCta !== undefined && typeof site.bookingShowHomeCta !== "boolean") ||
    (site.bookingShowAvailableSlots !== undefined && typeof site.bookingShowAvailableSlots !== "boolean") ||
    (site.bookingShowPrices !== undefined && typeof site.bookingShowPrices !== "boolean") ||
    (site.bookingShowStartingPrices !== undefined && typeof site.bookingShowStartingPrices !== "boolean") ||
    (site.bookingShowServiceDuration !== undefined && typeof site.bookingShowServiceDuration !== "boolean") ||
    (site.bookingCtaLabel !== undefined && typeof site.bookingCtaLabel !== "string") ||
    (site.estimateEnabled !== undefined && typeof site.estimateEnabled !== "boolean") ||
    !stringOrNull(site.metaTitle) ||
    !stringOrNull(site.metaDescription) ||
    (site.metaKeywords !== undefined && (!Array.isArray(site.metaKeywords) || site.metaKeywords.some((value) => typeof value !== "string"))) ||
    !stringOrNull(site.socialImageUrl) ||
    typeof site.indexSite !== "boolean" ||
    (site.googleAnalyticsEnabled !== undefined && typeof site.googleAnalyticsEnabled !== "boolean") ||
    !stringOrNull(site.googleAnalyticsMeasurementId ?? null)
  ) return null;

  const pages: WebsitePublishedPageSnapshot[] = [];
  for (const raw of value.pages) {
    if (!isRecord(raw)) return null;
    if (
      typeof raw.id !== "string" ||
      typeof raw.kind !== "string" ||
      typeof raw.slug !== "string" ||
      typeof raw.title !== "string" ||
      !stringOrNull(raw.seoTitle) ||
      !stringOrNull(raw.seoDescription) ||
      (raw.seoKeywords !== undefined && (!Array.isArray(raw.seoKeywords) || raw.seoKeywords.some((value) => typeof value !== "string"))) ||
      !stringOrNull(raw.socialImageUrl ?? null) ||
      typeof raw.showInNavigation !== "boolean" ||
      typeof raw.isEnabled !== "boolean" ||
      typeof raw.sortOrder !== "number"
    ) return null;
    pages.push({
      id: raw.id,
      kind: raw.kind,
      slug: raw.slug,
      title: raw.title,
      content: cloneJson(raw.content ?? {}),
      seoTitle: raw.seoTitle,
      seoDescription: raw.seoDescription,
      seoKeywords: Array.isArray(raw.seoKeywords) ? raw.seoKeywords as string[] : [],
      socialImageUrl: typeof raw.socialImageUrl === "string" ? raw.socialImageUrl : null,
      showInNavigation: raw.showInNavigation,
      isEnabled: raw.isEnabled,
      sortOrder: raw.sortOrder,
    });
  }

  return {
    version: 1,
    website: {
      templateId: site.templateId,
      templateVersion: site.templateVersion,
      schemaVersion: site.schemaVersion,
      websiteDesign: parseWebsiteDesignContract(site.websiteDesign),
      primaryColor: site.primaryColor,
      secondaryColor: site.secondaryColor,
      accentColor: site.accentColor,
      font: site.font,
      logo: site.logo,
      favicon: site.favicon,
      primaryBookingFormId: site.primaryBookingFormId,
      primaryEstimateFormId: site.primaryEstimateFormId,
      bookingEnabled: site.bookingEnabled ?? true,
      bookingShowNavigation: site.bookingShowNavigation ?? true,
      bookingShowHeaderCta: site.bookingShowHeaderCta ?? true,
      bookingShowServiceCtas: site.bookingShowServiceCtas ?? true,
      bookingShowHomeCta: site.bookingShowHomeCta ?? true,
      bookingShowAvailableSlots: site.bookingShowAvailableSlots ?? true,
      bookingShowPrices: site.bookingShowPrices ?? true,
      bookingShowStartingPrices: site.bookingShowStartingPrices ?? true,
      bookingShowServiceDuration: site.bookingShowServiceDuration ?? true,
      bookingCtaLabel: typeof site.bookingCtaLabel === "string" && site.bookingCtaLabel.trim() ? site.bookingCtaLabel.trim() : "Book Now",
      // Legacy V1 snapshots had no explicit estimate switch; an attached form
      // meant estimates were enabled. Keep those already-published sites live
      // during rolling deployment/migration.
      estimateEnabled: site.estimateEnabled ?? Boolean(site.primaryEstimateFormId),
      metaTitle: site.metaTitle,
      metaDescription: site.metaDescription,
      metaKeywords: Array.isArray(site.metaKeywords) ? site.metaKeywords as string[] : [],
      socialImageUrl: site.socialImageUrl,
      indexSite: site.indexSite,
      googleAnalyticsEnabled: site.googleAnalyticsEnabled ?? false,
      googleAnalyticsMeasurementId: typeof site.googleAnalyticsMeasurementId === "string" ? site.googleAnalyticsMeasurementId : null,
    },
    pages: pages.sort((a, b) => a.sortOrder - b.sortOrder),
  };
};

/**
 * Select a website integration id without crossing the draft/public boundary.
 * If a published snapshot exists, its value is authoritative even when null.
 * Falling back with `??` would expose an unpublished draft form selection.
 */
export const selectPublishedIntegrationFormId = (
  snapshot: WebsitePublishedSnapshotV1 | null,
  draftFormId: string | null,
  kind: "booking" | "estimate",
): string | null => {
  if (!snapshot) return draftFormId;
  return kind === "booking"
    ? snapshot.website.primaryBookingFormId
    : snapshot.website.primaryEstimateFormId;
};


/**
 * WebsiteRevision.snapshot stores the full draft row shape rather than the
 * compact published snapshot envelope. Convert it through the same canonical
 * V1 builder/parser used by the public runtime so preview/restore never trusts
 * arbitrary JSON from the database.
 */
export const parseRevisionSnapshotAsPublished = (value: unknown): WebsitePublishedSnapshotV1 | null => {
  if (!isRecord(value)) return null;
  try {
    return parsePublishedSnapshot(buildPublishedSnapshot(value as unknown as DraftWebsiteLike));
  } catch {
    return null;
  }
};
