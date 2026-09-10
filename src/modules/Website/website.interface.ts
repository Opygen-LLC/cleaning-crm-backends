import type { WebsiteDesignContract } from "./websiteDesignContract";

export const WEBSITE_EDITOR_SURFACES = [
  "content",
  "templates",
  "branding",
  "booking",
  "seo",
  "domain",
  "analytics",
  "history",
] as const;

export type WebsiteEditorSurface = (typeof WEBSITE_EDITOR_SURFACES)[number];

export interface WebsiteCreateInput {
  subdomain: string;
  templateId?: string;
  templateVersion?: string;
  primaryBookingFormId?: string | null;
  primaryEstimateFormId?: string | null;
}

export interface WebsiteUpdateInput {
  templateId?: string;
  templateVersion?: string;
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
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
  indexSite?: boolean;
  googleAnalyticsEnabled?: boolean;
  googleAnalyticsMeasurementId?: string | null;
  websiteDesign?: WebsiteDesignContract;
}

export interface WebsitePageUpdateInput {
  title?: string;
  content?: unknown;
  seoTitle?: string | null;
  seoDescription?: string | null;
  seoKeywords?: string[];
  socialImageUrl?: string | null;
  showInNavigation?: boolean;
  isEnabled?: boolean;
  sortOrder?: number;
}

export interface WebsiteDraftPageInput extends WebsitePageUpdateInput {
  id: string;
}

export interface WebsiteEditorStateInput {
  /**
   * Optimistic concurrency guard used by Website Studio. Legacy callers may
   * omit it; Studio always sends the revision it loaded.
   */
  expectedRevisionNumber?: number;
  website?: WebsiteUpdateInput;
  pages?: WebsiteDraftPageInput[];
}

export interface WebsitePublishInput extends WebsiteEditorStateInput {
  /**
   * Optimistic guard against a publish based on an older confirmed server
   * revision. Website Studio first persists configured editor state through
   * PUT /website/editor, then publishes that confirmed server revision. Legacy
   * callers may still send website/pages during a rolling deployment.
   */
  expectedRevisionNumber?: number;
}

export interface WebsiteRevisionRestoreInput {
  /**
   * Optimistic concurrency guard. A restore is a destructive draft mutation,
   * so never apply it over edits made in another tab/session.
   */
  expectedRevisionNumber?: number;
}

export interface WebsiteAssetCreateInput {
  publicId: string;
  mediaAssetId?: string;
  url: string;
  mimeType: string;
  width?: number | null;
  height?: number | null;
  bytes?: number | null;
  altText?: string | null;
  folder: string;
  metadata?: unknown;
}

export interface WebsiteDomainCreateInput {
  domain: string;
}

export type WebsiteBrandAssetKind = "logo" | "favicon" | "social";

export interface WebsiteBrandUploadSignatureInput {
  kind: WebsiteBrandAssetKind;
  fileName: string;
  mimeType: string;
  bytes: number;
}

export interface WebsiteBrandUploadFinalizeInput {
  kind: WebsiteBrandAssetKind;
  mediaAssetId: string;
}

export interface WebsiteManagedBrandAssetInput {
  kind: WebsiteBrandAssetKind;
  publicId: string;
  /** Authoritative R2 MediaAsset reference for newly uploaded managed assets. */
  mediaAssetId?: string;
  url: string;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  folder: string;
  metadata: Record<string, unknown>;
}
