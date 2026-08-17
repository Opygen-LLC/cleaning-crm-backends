export interface BookingMarketingAttributionInput {
  utmSource?: string;
  utmCampaign?: string;
}

/**
 * Builds the persisted acquisition fields for a booking submission.
 *
 * WEBSITE identity is never accepted from the public request body. The only
 * trusted signal is sourceWebsiteId, which WebsiteAcquisitionService obtains
 * from the server-side tenant resolver before calling BookingFormService.
 */
export function buildBookingSubmissionAttribution(
  sourceWebsiteId: string | undefined,
  marketing: BookingMarketingAttributionInput,
) {
  const isWebsite = Boolean(sourceWebsiteId);
  return {
    sourceWebsiteId: sourceWebsiteId ?? null,
    source: isWebsite ? "WEBSITE" : "PUBLIC_LINK",
    sourcePage: isWebsite ? "/book" : null,
    utmSource: marketing.utmSource?.trim().slice(0, 120) || null,
    utmCampaign: marketing.utmCampaign?.trim().slice(0, 160) || null,
  } as const;
}
