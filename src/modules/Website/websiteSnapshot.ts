export interface WebsitePublishedPageSnapshot {
  id: string;
  kind: string;
  slug: string;
  title: string;
  content: unknown;
  seoTitle: string | null;
  seoDescription: string | null;
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
    primaryColor: string;
    secondaryColor: string;
    accentColor: string;
    font: string | null;
    logo: string | null;
    favicon: string | null;
    primaryBookingFormId: string | null;
    primaryEstimateFormId: string | null;
    bookingEnabled: boolean;
    bookingShowHeaderCta: boolean;
    bookingShowServiceCtas: boolean;
    bookingShowHomeCta: boolean;
    bookingShowAvailableSlots: boolean;
    bookingShowPrices: boolean;
    metaTitle: string | null;
    metaDescription: string | null;
    socialImageUrl: string | null;
    indexSite: boolean;
  };
  pages: WebsitePublishedPageSnapshot[];
}

interface DraftWebsiteLike {
  templateId: string;
  templateVersion: string;
  schemaVersion: number;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  font?: string | null;
  logo?: string | null;
  favicon?: string | null;
  primaryBookingFormId?: string | null;
  primaryEstimateFormId?: string | null;
  bookingEnabled?: boolean;
  bookingShowHeaderCta?: boolean;
  bookingShowServiceCtas?: boolean;
  bookingShowHomeCta?: boolean;
  bookingShowAvailableSlots?: boolean;
  bookingShowPrices?: boolean;
  metaTitle?: string | null;
  metaDescription?: string | null;
  socialImageUrl?: string | null;
  indexSite: boolean;
  pages?: Array<{
    id: string;
    kind: string;
    slug: string;
    title: string;
    content: unknown;
    seoTitle?: string | null;
    seoDescription?: string | null;
    showInNavigation: boolean;
    isEnabled: boolean;
    sortOrder: number;
  }>;
}

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const buildPublishedSnapshot = (draft: DraftWebsiteLike): WebsitePublishedSnapshotV1 => ({
  version: 1,
  website: {
    templateId: draft.templateId,
    templateVersion: draft.templateVersion,
    schemaVersion: draft.schemaVersion,
    primaryColor: draft.primaryColor,
    secondaryColor: draft.secondaryColor,
    accentColor: draft.accentColor,
    font: draft.font ?? null,
    logo: draft.logo ?? null,
    favicon: draft.favicon ?? null,
    primaryBookingFormId: draft.primaryBookingFormId ?? null,
    primaryEstimateFormId: draft.primaryEstimateFormId ?? null,
    bookingEnabled: draft.bookingEnabled ?? true,
    bookingShowHeaderCta: draft.bookingShowHeaderCta ?? true,
    bookingShowServiceCtas: draft.bookingShowServiceCtas ?? true,
    bookingShowHomeCta: draft.bookingShowHomeCta ?? true,
    bookingShowAvailableSlots: draft.bookingShowAvailableSlots ?? true,
    bookingShowPrices: draft.bookingShowPrices ?? true,
    metaTitle: draft.metaTitle ?? null,
    metaDescription: draft.metaDescription ?? null,
    socialImageUrl: draft.socialImageUrl ?? null,
    indexSite: draft.indexSite,
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
    (site.bookingShowHeaderCta !== undefined && typeof site.bookingShowHeaderCta !== "boolean") ||
    (site.bookingShowServiceCtas !== undefined && typeof site.bookingShowServiceCtas !== "boolean") ||
    (site.bookingShowHomeCta !== undefined && typeof site.bookingShowHomeCta !== "boolean") ||
    (site.bookingShowAvailableSlots !== undefined && typeof site.bookingShowAvailableSlots !== "boolean") ||
    (site.bookingShowPrices !== undefined && typeof site.bookingShowPrices !== "boolean") ||
    !stringOrNull(site.metaTitle) ||
    !stringOrNull(site.metaDescription) ||
    !stringOrNull(site.socialImageUrl) ||
    typeof site.indexSite !== "boolean"
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
      primaryColor: site.primaryColor,
      secondaryColor: site.secondaryColor,
      accentColor: site.accentColor,
      font: site.font,
      logo: site.logo,
      favicon: site.favicon,
      primaryBookingFormId: site.primaryBookingFormId,
      primaryEstimateFormId: site.primaryEstimateFormId,
      bookingEnabled: site.bookingEnabled ?? true,
      bookingShowHeaderCta: site.bookingShowHeaderCta ?? true,
      bookingShowServiceCtas: site.bookingShowServiceCtas ?? true,
      bookingShowHomeCta: site.bookingShowHomeCta ?? true,
      bookingShowAvailableSlots: site.bookingShowAvailableSlots ?? true,
      bookingShowPrices: site.bookingShowPrices ?? true,
      metaTitle: site.metaTitle,
      metaDescription: site.metaDescription,
      socialImageUrl: site.socialImageUrl,
      indexSite: site.indexSite,
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
