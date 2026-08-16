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
  website?: WebsiteUpdateInput;
  pages?: WebsiteDraftPageInput[];
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
