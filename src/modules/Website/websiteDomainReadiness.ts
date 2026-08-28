/**
 * Custom-domain routing has several independent safety gates. Never treat a
 * row as publicly routable merely because `status` happens to be VERIFIED: a
 * stale/manual database edit must not bypass ownership, provider, DNS routing,
 * or TLS readiness checks.
 */
export const WEBSITE_READY_TLS_STATUSES = ["READY", "EXTERNAL"] as const;

export const readyWebsiteDomainWhere = {
  status: "VERIFIED",
  ownershipVerified: true,
  providerVerified: true,
  routingVerified: true,
  tlsStatus: { in: [...WEBSITE_READY_TLS_STATUSES] },
};

export const isWebsiteDomainRoutingReady = (domain: {
  status: string;
  ownershipVerified: boolean;
  providerVerified: boolean;
  routingVerified: boolean;
  tlsStatus: string;
}): boolean =>
  domain.status === "VERIFIED" &&
  domain.ownershipVerified &&
  domain.providerVerified &&
  domain.routingVerified &&
  WEBSITE_READY_TLS_STATUSES.includes(domain.tlsStatus as (typeof WEBSITE_READY_TLS_STATUSES)[number]);
