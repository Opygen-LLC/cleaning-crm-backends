import {
  WEBSITE_BASE_DOMAIN,
  WEBSITE_CUSTOM_DOMAINS_ENABLED,
} from "../../config/ENV";

/**
 * Canonical-host selection is a shared routing + SEO invariant.
 *
 * The database callers must only pass a custom domain that already satisfies
 * readyWebsiteDomainWhere (ownership + provider routing + TLS). This helper is
 * intentionally pure with respect to database state so the edge resolver and
 * public website projection cannot drift into choosing different canonical
 * hosts.
 */
export const getCanonicalWebsiteHost = (
  subdomain: string,
  primaryCustomHost?: string | null,
): string | null => {
  const cleanSubdomain = subdomain.trim().toLowerCase();
  if (!cleanSubdomain) return null;

  const cleanCustomHost = primaryCustomHost?.trim().toLowerCase() || null;
  if (WEBSITE_CUSTOM_DOMAINS_ENABLED && cleanCustomHost) return cleanCustomHost;

  return WEBSITE_BASE_DOMAIN
    ? `${cleanSubdomain}.${WEBSITE_BASE_DOMAIN}`
    : null;
};

export const getCanonicalWebsiteOrigin = (
  subdomain: string,
  primaryCustomHost?: string | null,
): string | null => {
  const host = getCanonicalWebsiteHost(subdomain, primaryCustomHost);
  return host ? `https://${host}` : null;
};
