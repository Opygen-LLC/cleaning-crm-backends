import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import tls from "node:tls";
import { domainToASCII } from "node:url";
import {
  NEXT_REVALIDATE_SECRET,
  NEXT_REVALIDATE_URL,
  NODE_ENV,
  VERCEL_ACCESS_TOKEN,
  VERCEL_PROJECT_ID,
  WEBSITE_BASE_DOMAIN,
  WEBSITE_CNAME_TARGET,
  WEBSITE_CUSTOM_DOMAINS_ENABLED,
  WEBSITE_DOMAIN_PROVIDER,
  WEBSITE_TLS_PROBE_TIMEOUT_MS,
} from "../../config/ENV";

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const normalizePublicHost = (value: string | undefined): string | null => {
  if (!value) return null;
  const ascii = domainToASCII(value.trim().replace(/\.$/, "")).toLowerCase();
  if (!ascii || ascii === "localhost" || isIP(ascii) || ascii.length > 253) return null;
  const labels = ascii.split(".");
  if (labels.length < 2 || labels.some((label) => !HOST_LABEL.test(label))) return null;
  return ascii;
};

/**
 * Phase 7 is a production routing feature, not an optional UI decoration.
 * Fail fast when a deployment advertises tenant/custom domains but cannot
 * safely route them. Development keeps the existing local /site/:tenant path.
 */
export const assertWebsitePlatformConfiguration = () => {
  if (NODE_ENV !== "production") return;

  const baseDomain = normalizePublicHost(WEBSITE_BASE_DOMAIN);
  if (!baseDomain) {
    throw new Error(
      "WEBSITE_BASE_DOMAIN must be a valid public hostname in production (for example cleaningcrm.com).",
    );
  }

  if (!NEXT_REVALIDATE_SECRET || NEXT_REVALIDATE_SECRET.length < 32) {
    throw new Error("NEXT_REVALIDATE_SECRET must be configured with at least 32 characters in production.");
  }
  try {
    const revalidateUrl = new URL(NEXT_REVALIDATE_URL || "");
    if (revalidateUrl.protocol !== "https:" && revalidateUrl.protocol !== "http:") throw new Error("invalid protocol");
  } catch {
    throw new Error("NEXT_REVALIDATE_URL must be a valid absolute HTTP(S) URL in production.");
  }

  if (!WEBSITE_CUSTOM_DOMAINS_ENABLED) return;

  if (WEBSITE_DOMAIN_PROVIDER === "vercel") {
    if (!VERCEL_ACCESS_TOKEN || !VERCEL_PROJECT_ID) {
      throw new Error(
        "Custom domains are enabled with WEBSITE_DOMAIN_PROVIDER=vercel, but VERCEL_ACCESS_TOKEN/VERCEL_PROJECT_ID are missing.",
      );
    }
    return;
  }

  const cnameTarget = normalizePublicHost(WEBSITE_CNAME_TARGET);
  if (!cnameTarget) {
    throw new Error(
      "Custom domains are enabled with WEBSITE_DOMAIN_PROVIDER=manual, but WEBSITE_CNAME_TARGET is not a valid public hostname.",
    );
  }
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const probeWildcardTls = async (host: string) => new Promise<{
  authorized: boolean;
  protocol: string | null;
  validTo: string | null;
}>((resolve, reject) => {
  const socket = tls.connect({
    host,
    port: 443,
    servername: host,
    rejectUnauthorized: true,
  });
  const timer = setTimeout(() => {
    socket.destroy(new Error(`TLS probe timed out after ${WEBSITE_TLS_PROBE_TIMEOUT_MS}ms`));
  }, WEBSITE_TLS_PROBE_TIMEOUT_MS);
  timer.unref?.();

  socket.once("secureConnect", () => {
    clearTimeout(timer);
    const certificate = socket.getPeerCertificate();
    const result = {
      authorized: socket.authorized,
      protocol: socket.getProtocol(),
      validTo: certificate.valid_to || null,
    };
    socket.end();
    resolve(result);
  });
  socket.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
});

/**
 * Operational proof that the configured wildcard namespace actually resolves
 * and presents a trusted certificate. Any HTTP status from the frontend is
 * irrelevant here: DNS + TLS are the infrastructure requirements checked by
 * this probe. The endpoint exposing this result is monitoring-token protected.
 */
export const inspectWebsiteWildcardInfrastructure = async () => {
  const baseDomain = normalizePublicHost(WEBSITE_BASE_DOMAIN);
  if (!baseDomain) {
    return {
      ok: false,
      baseDomain: null,
      wildcardHost: null,
      probeHost: null,
      dns: { ok: false, addresses: [] as Array<{ address: string; family: number }>, error: "WEBSITE_BASE_DOMAIN is not configured" },
      tls: { ok: false, authorized: false, protocol: null as string | null, validTo: null as string | null, error: "DNS/TLS probe skipped" },
    };
  }

  const probeHost = `phase1-routing-check-${Date.now().toString(36)}.${baseDomain}`;
  let addresses: Array<{ address: string; family: number }> = [];
  let dnsError: string | null = null;
  try {
    addresses = await withTimeout(
      dns.lookup(probeHost, { all: true }),
      WEBSITE_TLS_PROBE_TIMEOUT_MS,
      "Wildcard DNS lookup",
    );
    if (!addresses.length) dnsError = "Wildcard DNS returned no addresses";
  } catch (error) {
    dnsError = error instanceof Error ? error.message : String(error);
  }

  let tlsResult: { authorized: boolean; protocol: string | null; validTo: string | null } | null = null;
  let tlsError: string | null = null;
  if (!dnsError) {
    try {
      tlsResult = await probeWildcardTls(probeHost);
    } catch (error) {
      tlsError = error instanceof Error ? error.message : String(error);
    }
  } else {
    tlsError = "TLS probe skipped because wildcard DNS is unavailable";
  }

  const dnsOk = !dnsError && addresses.length > 0;
  const tlsOk = Boolean(tlsResult?.authorized) && !tlsError;
  return {
    ok: dnsOk && tlsOk,
    baseDomain,
    wildcardHost: `*.${baseDomain}`,
    probeHost,
    dns: { ok: dnsOk, addresses, error: dnsError },
    tls: {
      ok: tlsOk,
      authorized: tlsResult?.authorized ?? false,
      protocol: tlsResult?.protocol ?? null,
      validTo: tlsResult?.validTo ?? null,
      error: tlsError,
    },
  };
};

