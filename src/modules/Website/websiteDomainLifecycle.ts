import { isWebsiteDomainRoutingReady, WEBSITE_READY_TLS_STATUSES } from "./websiteDomainReadiness";

export type WebsiteCustomDomainLifecycleStatus =
  | "PENDING_VERIFICATION"
  | "OWNERSHIP_VERIFIED"
  | "DNS_PENDING"
  | "SSL_PROVISIONING"
  | "ACTIVE"
  | "FAILED";

export type WebsiteCustomDomainStepStatus = "PENDING" | "COMPLETE" | "FAILED";

export interface WebsiteCustomDomainLifecycleStep {
  key: "ownership" | "dns" | "ssl";
  label: string;
  status: WebsiteCustomDomainStepStatus;
  description: string;
}

export interface WebsiteCustomDomainLifecycle {
  status: WebsiteCustomDomainLifecycleStatus;
  label: string;
  active: boolean;
  canSetPrimary: boolean;
  publicUrl: string;
  steps: WebsiteCustomDomainLifecycleStep[];
}

export interface WebsiteDomainLifecycleInput {
  domain: string;
  status: string;
  ownershipVerified: boolean;
  providerVerified: boolean;
  routingVerified: boolean;
  tlsStatus: string;
  lastProviderSyncAt?: Date | string | null;
}

const readyTls = (value: string) =>
  WEBSITE_READY_TLS_STATUSES.includes(value as (typeof WEBSITE_READY_TLS_STATUSES)[number]);

const lifecycleStatus = (domain: WebsiteDomainLifecycleInput): WebsiteCustomDomainLifecycleStatus => {
  if (domain.status === "FAILED" || domain.tlsStatus === "ERROR") return "FAILED";
  if (isWebsiteDomainRoutingReady(domain)) return "ACTIVE";
  if (!domain.ownershipVerified) return "PENDING_VERIFICATION";

  // There is a short but useful state after our independent ownership TXT has
  // passed and before the hosting-provider inspection has produced routing
  // instructions. Keep it explicit so the UI never pretends DNS is already the
  // blocker when provider attachment has not happened yet.
  if (!domain.lastProviderSyncAt) return "OWNERSHIP_VERIFIED";
  if (!domain.providerVerified || !domain.routingVerified) return "DNS_PENDING";
  return "SSL_PROVISIONING";
};

const labelFor = (value: WebsiteCustomDomainLifecycleStatus): string => {
  switch (value) {
    case "PENDING_VERIFICATION": return "Pending verification";
    case "OWNERSHIP_VERIFIED": return "Ownership verified";
    case "DNS_PENDING": return "DNS pending";
    case "SSL_PROVISIONING": return "SSL provisioning";
    case "ACTIVE": return "Active";
    case "FAILED": return "Failed";
  }
};

const buildSteps = (domain: WebsiteDomainLifecycleInput): WebsiteCustomDomainLifecycleStep[] => {
  const failed = domain.status === "FAILED" || domain.tlsStatus === "ERROR";
  const dnsReady = domain.providerVerified && domain.routingVerified;
  const tlsReady = readyTls(domain.tlsStatus);

  return [
    {
      key: "ownership",
      label: "Domain ownership",
      status: domain.ownershipVerified ? "COMPLETE" : failed ? "FAILED" : "PENDING",
      description: domain.ownershipVerified
        ? "The platform ownership TXT record is verified."
        : "Add the platform TXT record to prove that you control this hostname.",
    },
    {
      key: "dns",
      label: "DNS routing",
      status: dnsReady ? "COMPLETE" : failed && domain.ownershipVerified ? "FAILED" : "PENDING",
      description: dnsReady
        ? "The hostname points to the configured website hosting provider."
        : "Add the provider verification and routing records shown below, then check again.",
    },
    {
      key: "ssl",
      label: "HTTPS / SSL",
      status: tlsReady ? "COMPLETE" : domain.tlsStatus === "ERROR" ? "FAILED" : "PENDING",
      description: tlsReady
        ? "HTTPS is active for this hostname."
        : dnsReady
          ? "DNS is ready. The hosting provider is provisioning HTTPS."
          : "HTTPS begins after domain ownership and routing are verified.",
    },
  ];
};

export const buildWebsiteDomainLifecycle = (
  domain: WebsiteDomainLifecycleInput,
): WebsiteCustomDomainLifecycle => {
  const status = lifecycleStatus(domain);
  const active = status === "ACTIVE";
  return {
    status,
    label: labelFor(status),
    active,
    canSetPrimary: active,
    publicUrl: `https://${domain.domain}`,
    steps: buildSteps(domain),
  };
};

/**
 * API-safe presentation of a WebsiteDomain row. The raw verification token is
 * intentionally omitted; the DNS challenge is exposed only through
 * requiredDns. This keeps one canonical public shape for Website Studio,
 * domain list, add, verify and primary-domain mutation responses.
 */
export const presentWebsiteDomain = <T extends WebsiteDomainLifecycleInput & Record<string, unknown>>(
  domain: T,
) => {
  const {
    verificationToken: _verificationToken,
    verificationStartedAt: _verificationStartedAt,
    ...safe
  } = domain as T & { verificationToken?: unknown; verificationStartedAt?: unknown };
  return {
    ...safe,
    lifecycle: buildWebsiteDomainLifecycle(domain),
  };
};
