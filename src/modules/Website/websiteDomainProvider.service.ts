import { promises as dns } from "node:dns";
import https from "node:https";
import { isIP } from "node:net";
import status from "http-status";
import AppError from "../../errorHelper/AppError";
import {
  VERCEL_ACCESS_TOKEN,
  VERCEL_PROJECT_ID,
  VERCEL_TEAM_ID,
  WEBSITE_CNAME_TARGET,
  WEBSITE_DOMAIN_PROVIDER,
  WEBSITE_TLS_PROBE_TIMEOUT_MS,
} from "../../config/ENV";
import { traceAsyncOperation } from "../../lib/monitoring/requestTrace";

export type WebsiteProviderName = "VERCEL" | "MANUAL";
export type WebsiteTlsStatus = "PENDING" | "PROVISIONING" | "READY" | "EXTERNAL" | "ERROR";

export interface ProviderDnsRecord {
  type: "TXT" | "CNAME" | "A";
  host: string;
  value: string;
  purpose: "provider_verification" | "routing";
}

export interface WebsiteDomainProviderState {
  provider: WebsiteProviderName;
  attached: boolean;
  verified: boolean;
  routingConfigured: boolean;
  tlsStatus: WebsiteTlsStatus;
  dnsRecords: ProviderDnsRecord[];
  message: string | null;
  providerData: Record<string, unknown>;
}

interface VercelProjectDomain {
  verified?: boolean;
  verification?: unknown[];
}

interface VercelDomainConfig {
  misconfigured?: boolean;
  recommendedCNAME?: unknown;
  recommendedIPv4?: unknown;
  configuredBy?: unknown;
  nameservers?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const providerErrorDetails = (body: unknown): { message?: string; code?: string } => {
  if (!isRecord(body)) return {};
  const nested = isRecord(body.error) ? body.error : null;
  const message = typeof nested?.message === "string"
    ? nested.message
    : typeof body.message === "string"
      ? body.message
      : undefined;
  const code = typeof nested?.code === "string"
    ? nested.code
    : typeof body.code === "string"
      ? body.code
      : undefined;
  return { message, code };
};

class ProviderHttpError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

const normalizeDnsValue = (value: string) => value.trim().toLowerCase().replace(/\.$/, "");

const dnsTargetMatches = async (domain: string, target: string): Promise<boolean> => {
  const wanted = normalizeDnsValue(target);
  try {
    const cnames = await dns.resolveCname(domain);
    if (cnames.some((value) => normalizeDnsValue(value) === wanted)) return true;
  } catch {
    // Apex domains commonly cannot expose a CNAME. Compare resolved addresses
    // as a fallback so providers that support ALIAS/flattening can still use
    // the generic/manual adapter.
  }

  try {
    const [domain4, target4] = await Promise.all([dns.resolve4(domain), dns.resolve4(wanted)]);
    if (domain4.length && target4.length && domain4.some((ip) => target4.includes(ip))) return true;
  } catch {
    // IPv4 is optional.
  }
  try {
    const [domain6, target6] = await Promise.all([dns.resolve6(domain), dns.resolve6(wanted)]);
    return Boolean(domain6.length && target6.length && domain6.some((ip) => target6.includes(ip)));
  } catch {
    return false;
  }
};

const inspectManual = async (domain: string): Promise<WebsiteDomainProviderState> => {
  const routingConfigured = WEBSITE_CNAME_TARGET
    ? await dnsTargetMatches(domain, WEBSITE_CNAME_TARGET)
    : false;
  return {
    provider: "MANUAL",
    attached: true,
    // In manual mode there is no hosting-provider ownership state. The app's
    // own TXT challenge remains the ownership authority in DomainService.
    verified: true,
    routingConfigured,
    tlsStatus: routingConfigured ? "EXTERNAL" : "PENDING",
    dnsRecords: WEBSITE_CNAME_TARGET
      ? [{
          type: "CNAME",
          host: domain,
          value: WEBSITE_CNAME_TARGET,
          purpose: "routing",
        }]
      : [],
    message: WEBSITE_CNAME_TARGET
      ? null
      : "WEBSITE_CNAME_TARGET is not configured for manual custom-domain routing",
    providerData: { managedTls: false },
  };
};

const vercelQuery = () => {
  const params = new URLSearchParams();
  if (VERCEL_TEAM_ID) params.set("teamId", VERCEL_TEAM_ID);
  const value = params.toString();
  return value ? `?${value}` : "";
};

const assertVercelConfig = () => {
  if (!VERCEL_ACCESS_TOKEN || !VERCEL_PROJECT_ID) {
    throw new AppError(
      status.SERVICE_UNAVAILABLE,
      "Custom-domain hosting is not configured. Set VERCEL_ACCESS_TOKEN and VERCEL_PROJECT_ID.",
    );
  }
};

const assertConfigured = () => {
  if (WEBSITE_DOMAIN_PROVIDER === "vercel") {
    assertVercelConfig();
    return;
  }
  if (!WEBSITE_CNAME_TARGET) {
    throw new AppError(
      status.SERVICE_UNAVAILABLE,
      "Manual custom-domain hosting requires WEBSITE_CNAME_TARGET before domains can be connected.",
    );
  }
};

const vercelRequest = async <T>(path: string, init: RequestInit = {}, allow404 = false): Promise<T | null> => {
  assertVercelConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await traceAsyncOperation(
      "external",
      "vercel.domain-api",
      () => fetch(`https://api.vercel.com${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${VERCEL_ACCESS_TOKEN}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      }),
    );

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (allow404 && response.status === 404) return null;
    if (!response.ok) {
      const details = providerErrorDetails(body);
      const providerMessage = details.message ?? `Vercel domain API returned HTTP ${response.status}`;
      throw new ProviderHttpError(response.status, providerMessage, details.code);
    }
    return body as T;
  } catch (error) {
    if (error instanceof ProviderHttpError || error instanceof AppError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderHttpError(504, "Vercel domain API timed out");
    }
    throw new ProviderHttpError(502, error instanceof Error ? error.message : "Vercel domain API request failed");
  } finally {
    clearTimeout(timeout);
  }
};

const projectBase = () => {
  assertVercelConfig();
  return `/v9/projects/${encodeURIComponent(VERCEL_PROJECT_ID as string)}/domains`;
};

const getVercelProjectDomain = async (domain: string): Promise<VercelProjectDomain | null> =>
  vercelRequest<VercelProjectDomain>(`${projectBase()}/${encodeURIComponent(domain)}${vercelQuery()}`, { method: "GET" }, true);

const addVercelProjectDomain = async (domain: string): Promise<VercelProjectDomain | null> => {
  assertVercelConfig();
  return vercelRequest<VercelProjectDomain>(
    `/v9/projects/${encodeURIComponent(VERCEL_PROJECT_ID as string)}/domains${vercelQuery()}`,
    { method: "POST", body: JSON.stringify({ name: domain }) },
  );
};

const getVercelDomainConfig = async (domain: string): Promise<VercelDomainConfig | null> => {
  assertVercelConfig();
  const params = new URLSearchParams({ projectId: VERCEL_PROJECT_ID as string });
  if (VERCEL_TEAM_ID) params.set("teamId", VERCEL_TEAM_ID);
  return vercelRequest<VercelDomainConfig>(`/v6/domains/${encodeURIComponent(domain)}/config?${params.toString()}`, { method: "GET" });
};

const verifyVercelProjectDomain = async (domain: string): Promise<VercelProjectDomain | null> => {
  try {
    return await vercelRequest<VercelProjectDomain>(
      `${projectBase()}/${encodeURIComponent(domain)}/verify${vercelQuery()}`,
      { method: "POST" },
    );
  } catch (error) {
    // An incomplete DNS challenge is expected while the customer is editing
    // records. Treat 4xx verification responses as "still pending" and return
    // the fresh project state rather than turning the domain into a hard error.
    if (error instanceof ProviderHttpError && error.httpStatus >= 400 && error.httpStatus < 500) return null;
    throw error;
  }
};

const rankValue = (entry: unknown) => {
  const value = Number(isRecord(entry) ? entry.rank : undefined);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
};

const firstRecommendedValue = (entries: unknown): string | null => {
  if (!Array.isArray(entries) || !entries.length) return null;
  const sorted = [...entries].sort((a, b) => rankValue(a) - rankValue(b));
  const first = sorted[0];
  const value = isRecord(first) ? first.value : undefined;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string" && item.trim());
    return typeof first === "string" ? first.trim() : null;
  }
  return null;
};

const normalizeVercelChallenge = (challenge: unknown): ProviderDnsRecord | null => {
  if (!isRecord(challenge)) return null;
  const type = String(challenge.type ?? "").toUpperCase();
  const host = typeof challenge.domain === "string" ? challenge.domain.trim() : "";
  const value = typeof challenge.value === "string" ? challenge.value.trim() : "";
  if (type !== "TXT" || !host || !value) return null;
  return { type: "TXT", host, value, purpose: "provider_verification" };
};

const isPublicIpv4 = (address: string): boolean => {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 192 && b === 0 && parts[2] === 2) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && parts[2] === 100))) return false;
  if (a === 203 && b === 0 && parts[2] === 113) return false;
  return true;
};

const isPublicIpv6 = (address: string): boolean => {
  const value = address.toLowerCase().split("%")[0];
  if (!value || value === "::" || value === "::1") return false;
  if (value.startsWith("fc") || value.startsWith("fd") || value.startsWith("ff")) return false;
  if (/^fe[89ab]/.test(value)) return false;
  if (value.startsWith("2001:db8:")) return false;
  if (value.startsWith("::ffff:")) {
    const mapped = value.slice("::ffff:".length);
    return isIP(mapped) === 4 && isPublicIpv4(mapped);
  }
  return true;
};

/** Exported for targeted security regression tests. */
export const isPublicProviderAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
};

type ProviderAddress = { address: string; family: 4 | 6 };

const resolveProviderAddresses = async (hostOrIp: string): Promise<ProviderAddress[]> => {
  const normalized = normalizeDnsValue(hostOrIp);
  const family = isIP(normalized);
  if (family === 4 || family === 6) {
    return isPublicProviderAddress(normalized)
      ? [{ address: normalized, family: family as 4 | 6 }]
      : [];
  }

  const [v4, v6] = await Promise.all([
    dns.resolve4(normalized).catch(() => [] as string[]),
    dns.resolve6(normalized).catch(() => [] as string[]),
  ]);
  return [
    ...v4.map((address) => ({ address, family: 4 as const })),
    ...v6.map((address) => ({ address, family: 6 as const })),
  ].filter((entry) => isPublicProviderAddress(entry.address));
};

const findPinnedProviderAddress = async (domain: string, routingTarget: string): Promise<ProviderAddress | null> => {
  const [domainAddresses, providerAddresses] = await Promise.all([
    resolveProviderAddresses(domain),
    resolveProviderAddresses(routingTarget),
  ]);
  const providerSet = new Set(providerAddresses.map((entry) => `${entry.family}:${entry.address}`));
  return domainAddresses.find((entry) => providerSet.has(`${entry.family}:${entry.address}`)) ?? null;
};

/**
 * Verify HTTPS without allowing a customer-controlled hostname to become an
 * SSRF primitive. DNS is first proven to overlap the hosting provider's public
 * routing addresses; the TLS connection is then pinned to that exact address
 * while keeping SNI/certificate verification on the customer's hostname.
 */
const probeManagedHttps = async (domain: string, routingTarget: string | null): Promise<boolean> => {
  if (!routingTarget) return false;
  const pinned = await findPinnedProviderAddress(domain, routingTarget);
  if (!pinned) return false;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const request = https.request({
      protocol: "https:",
      hostname: domain,
      servername: domain,
      port: 443,
      path: "/__cleancrm_tls_probe__",
      method: "HEAD",
      rejectUnauthorized: true,
      timeout: WEBSITE_TLS_PROBE_TIMEOUT_MS,
      headers: { "User-Agent": "CleaningCRM-DomainVerifier/2.0" },
      // Pin transport to the provider address selected above. Do not perform a
      // second attacker-influenced DNS lookup inside https.request.
      lookup: ((_hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
        callback(null, pinned.address, pinned.family);
      }) as any,
    }, (response) => {
      response.resume();
      finish(true); // Any HTTP status proves a valid TLS handshake/certificate.
    });

    request.once("timeout", () => {
      request.destroy();
      finish(false);
    });
    request.once("error", () => finish(false));
    request.end();
  });
};

const inspectVercel = async (domain: string, verify = false): Promise<WebsiteDomainProviderState> => {
  let projectDomain = await getVercelProjectDomain(domain);
  if (!projectDomain) {
    await addVercelProjectDomain(domain);
    projectDomain = await getVercelProjectDomain(domain);
  }
  if (!projectDomain) throw new ProviderHttpError(502, "Vercel did not return the attached project domain");

  if (verify && !projectDomain.verified) {
    await verifyVercelProjectDomain(domain);
    projectDomain = await getVercelProjectDomain(domain) ?? projectDomain;
  }

  const config = await getVercelDomainConfig(domain);
  const dnsRecords: ProviderDnsRecord[] = [];
  const challenges = Array.isArray(projectDomain.verification) ? projectDomain.verification : [];
  for (const challenge of challenges) {
    const record = normalizeVercelChallenge(challenge);
    if (record) dnsRecords.push(record);
  }

  const recommendedCname = firstRecommendedValue(config?.recommendedCNAME);
  const recommendedIpv4 = firstRecommendedValue(config?.recommendedIPv4);
  if (recommendedCname) {
    dnsRecords.push({ type: "CNAME", host: domain, value: recommendedCname, purpose: "routing" });
  } else if (recommendedIpv4) {
    dnsRecords.push({ type: "A", host: domain, value: recommendedIpv4, purpose: "routing" });
  } else if (WEBSITE_CNAME_TARGET) {
    dnsRecords.push({ type: "CNAME", host: domain, value: WEBSITE_CNAME_TARGET, purpose: "routing" });
  }

  const verified = Boolean(projectDomain.verified);
  const routingConfigured = config?.misconfigured === false;
  const routingTarget = recommendedCname ?? recommendedIpv4 ?? WEBSITE_CNAME_TARGET ?? null;
  const tlsReady = verified && routingConfigured ? await probeManagedHttps(domain, routingTarget) : false;
  return {
    provider: "VERCEL",
    attached: true,
    verified,
    routingConfigured,
    // Vercel provisions certificates automatically, but provider verification
    // and DNS correctness can become true before the certificate is actually
    // usable. Confirm a real HTTPS handshake before exposing the hostname.
    tlsStatus: tlsReady ? "READY" : "PROVISIONING",
    dnsRecords,
    message: routingConfigured ? null : "DNS routing is not configured yet",
    providerData: {
      projectDomainVerified: verified,
      misconfigured: config?.misconfigured ?? null,
      configuredBy: config?.configuredBy ?? null,
      nameservers: Array.isArray(config?.nameservers) ? config.nameservers : [],
      tlsProbeOk: tlsReady,
      tlsProbeTarget: routingTarget,
      tlsProbeAt: verified && routingConfigured ? new Date().toISOString() : null,
    },
  };
};

const attach = async (domain: string): Promise<WebsiteDomainProviderState> => {
  if (WEBSITE_DOMAIN_PROVIDER === "vercel") return inspectVercel(domain, false);
  return inspectManual(domain);
};

const verify = async (domain: string): Promise<WebsiteDomainProviderState> => {
  if (WEBSITE_DOMAIN_PROVIDER === "vercel") return inspectVercel(domain, true);
  return inspectManual(domain);
};

const detach = async (domain: string): Promise<void> => {
  if (WEBSITE_DOMAIN_PROVIDER !== "vercel") return;
  const existing = await getVercelProjectDomain(domain);
  if (!existing) return;
  await vercelRequest<Record<string, unknown>>(
    `${projectBase()}/${encodeURIComponent(domain)}${vercelQuery()}`,
    { method: "DELETE" },
  );
};

const describeProviderError = (error: unknown): string => {
  if (error instanceof ProviderHttpError) return error.message;
  if (error instanceof AppError) return error.message;
  return error instanceof Error ? error.message : "Domain provider request failed";
};

export const WebsiteDomainProviderService = {
  assertConfigured,
  attach,
  verify,
  detach,
  describeProviderError,
};
