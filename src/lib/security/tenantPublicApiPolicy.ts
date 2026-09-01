/**
 * Browser-callable API surface for published tenant websites.
 *
 * Keep this list intentionally small. A verified tenant origin may use only
 * these unauthenticated/public route families; authenticated CRM endpoints
 * such as /staff, /admin, /client, /invoice, etc. remain first-party only.
 */
export const TENANT_PUBLIC_API_PREFIXES = [
  "/api/v1/website/public",
  "/api/v1/quote/public",
  "/api/v1/estimate/public",
] as const;

/** Match an exact public prefix or a child route, never a look-alike prefix. */
export const isTenantPublicApiPath = (pathname: string): boolean => {
  const path = pathname.split(/[?#]/, 1)[0] || "/";
  return TENANT_PUBLIC_API_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
};
