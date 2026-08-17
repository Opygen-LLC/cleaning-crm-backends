import { promises as dns } from "node:dns";
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
    const response = await fetch(`https://api.vercel.com${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${VERCEL_ACCESS_TOKEN}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    let body: any = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (allow404 && response.status === 404) return null;
    if (!response.ok) {
      const providerMessage = body?.error?.message ?? body?.message ?? `Vercel domain API returned HTTP ${response.status}`;
      throw new ProviderHttpError(response.status, providerMessage, body?.error?.code ?? body?.code);
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

const getVercelProjectDomain = async (domain: string): Promise<any | null> =>
  vercelRequest<any>(`${projectBase()}/${encodeURIComponent(domain)}${vercelQuery()}`, { method: "GET" }, true);

const addVercelProjectDomain = async (domain: string): Promise<any> => {
  assertVercelConfig();
  return vercelRequest<any>(
    `/v9/projects/${encodeURIComponent(VERCEL_PROJECT_ID as string)}/domains${vercelQuery()}`,
    { method: "POST", body: JSON.stringify({ name: domain }) },
  );
};

const getVercelDomainConfig = async (domain: string): Promise<any> => {
  assertVercelConfig();
  const params = new URLSearchParams({ projectId: VERCEL_PROJECT_ID as string });
  if (VERCEL_TEAM_ID) params.set("teamId", VERCEL_TEAM_ID);
  return vercelRequest<any>(`/v6/domains/${encodeURIComponent(domain)}/config?${params.toString()}`, { method: "GET" });
};

const verifyVercelProjectDomain = async (domain: string): Promise<any | null> => {
  try {
    return await vercelRequest<any>(
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

const rankValue = (entry: any) => {
  const value = Number(entry?.rank);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
};

const firstRecommendedValue = (entries: any): string | null => {
  if (!Array.isArray(entries) || !entries.length) return null;
  const sorted = [...entries].sort((a, b) => rankValue(a) - rankValue(b));
  const value = sorted[0]?.value;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string" && item.trim());
    return typeof first === "string" ? first.trim() : null;
  }
  return null;
};

const normalizeVercelChallenge = (challenge: any): ProviderDnsRecord | null => {
  const type = String(challenge?.type ?? "").toUpperCase();
  const host = typeof challenge?.domain === "string" ? challenge.domain.trim() : "";
  const value = typeof challenge?.value === "string" ? challenge.value.trim() : "";
  if (type !== "TXT" || !host || !value) return null;
  return { type: "TXT", host, value, purpose: "provider_verification" };
};

const probeManagedHttps = async (domain: string): Promise<boolean> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBSITE_TLS_PROBE_TIMEOUT_MS);
  try {
    // This probe is only called after Vercel reports `misconfigured === false`,
    // so DNS already points at the provider. Any HTTP response proves that the
    // TLS handshake/certificate for this hostname is valid; the application
    // may legitimately answer 404 while the DB row is still pending.
    await fetch(`https://${domain}/__cleancrm_tls_probe__`, {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal,
      headers: { "User-Agent": "CleaningCRM-DomainVerifier/1.0" },
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
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
  const tlsReady = verified && routingConfigured ? await probeManagedHttps(domain) : false;
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
  await vercelRequest<any>(
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
