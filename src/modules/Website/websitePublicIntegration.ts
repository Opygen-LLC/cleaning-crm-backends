export type WebsitePublicIntegrationKind = "booking" | "estimate";

const DEFAULT_INTEGRATION_HEADLINE: Record<WebsitePublicIntegrationKind, string> = {
  booking: "Online booking",
  estimate: "Request an estimate",
};

export const publicIntegrationHeadline = (
  kind: WebsitePublicIntegrationKind,
  headline: string | null | undefined,
) => headline?.trim() || DEFAULT_INTEGRATION_HEADLINE[kind];
