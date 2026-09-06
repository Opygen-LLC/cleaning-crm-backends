/** Deployment gate, not a per-tenant migration. Keep disabled until the
 * matching frontend runtime and immutable catalog assets are deployed. */
export const readWebsiteTemplateRelease = (env: Record<string, string | undefined> = process.env) => {
  const enabled = env.WEBSITE_TEMPLATE_V2_ENABLED ?? "false";
  if (enabled !== "true" && enabled !== "false") {
    throw new Error("WEBSITE_TEMPLATE_V2_ENABLED must be true or false");
  }
  const defaultVersion = env.WEBSITE_DEFAULT_TEMPLATE_VERSION ?? "1.0.0";
  if (defaultVersion !== "1.0.0" && defaultVersion !== "2.0.0") {
    throw new Error("WEBSITE_DEFAULT_TEMPLATE_VERSION must be 1.0.0 or 2.0.0");
  }
  if (defaultVersion === "2.0.0" && enabled !== "true") {
    throw new Error("Enable WEBSITE_TEMPLATE_V2_ENABLED after deploying the frontend before selecting the new default");
  }
  return { refreshedEnabled: enabled === "true", defaultVersion } as const;
};
