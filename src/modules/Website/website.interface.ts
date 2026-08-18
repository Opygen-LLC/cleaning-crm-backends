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
  socialImageUrl?: string | null;
  indexSite?: boolean;
}

export interface WebsitePageUpdateInput {
  title?: string;
  content?: unknown;
  seoTitle?: string | null;
  seoDescription?: string | null;
  showInNavigation?: boolean;
  isEnabled?: boolean;
  sortOrder?: number;
}

export interface WebsiteDraftPageInput extends WebsitePageUpdateInput {
  id: string;
}

export interface WebsiteDraftSaveInput {
  /**
   * Optimistic concurrency guard used by Website Studio. Legacy callers may
   * omit it; Studio always sends the revision it loaded.
   */
  expectedRevisionNumber?: number;
  website?: WebsiteUpdateInput;
  pages?: WebsiteDraftPageInput[];
}

export interface WebsitePublishInput {
  /**
   * Prevent publishing a draft that changed in another browser/tab after the
   * editor last saved. Optional for backward compatibility with old clients.
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
  publicId: string;
}

export interface WebsiteManagedBrandAssetInput {
  kind: WebsiteBrandAssetKind;
  publicId: string;
  url: string;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  folder: string;
  metadata: Record<string, unknown>;
}
