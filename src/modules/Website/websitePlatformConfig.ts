import { isIP } from "node:net";
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
