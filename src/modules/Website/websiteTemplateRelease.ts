/**
 * Deployment gates, not per-tenant migrations. Reads of already-persisted
 * template versions stay available during rollback; these gates only control
 * new selections/publications and the version provisioned for new websites.
 */
export const readWebsiteTemplateRelease = (env: Record<string, string | undefined> = process.env) => {
  const refreshed = env.WEBSITE_TEMPLATE_V2_ENABLED ?? "true";
  const foundation = env.WEBSITE_TEMPLATE_V3_ENABLED ?? "true";

  if (refreshed !== "true" && refreshed !== "false") {
    throw new Error("WEBSITE_TEMPLATE_V2_ENABLED must be true or false");
  }
  if (foundation !== "true" && foundation !== "false") {
    throw new Error("WEBSITE_TEMPLATE_V3_ENABLED must be true or false");
  }

  const defaultVersion = env.WEBSITE_DEFAULT_TEMPLATE_VERSION ?? "3.0.0";
  if (defaultVersion !== "1.0.0" && defaultVersion !== "2.0.0" && defaultVersion !== "3.0.0") {
    throw new Error("WEBSITE_DEFAULT_TEMPLATE_VERSION must be 1.0.0, 2.0.0 or 3.0.0");
  }
  if (defaultVersion === "2.0.0" && refreshed !== "true") {
    throw new Error("Enable WEBSITE_TEMPLATE_V2_ENABLED before selecting 2.0.0 as the website default");
  }
  if (defaultVersion === "3.0.0" && foundation !== "true") {
    throw new Error("Enable WEBSITE_TEMPLATE_V3_ENABLED after deploying the matching frontend before selecting 3.0.0 as the website default");
  }

  return {
    refreshedEnabled: refreshed === "true",
    foundationEnabled: foundation === "true",
    defaultVersion,
  } as const;
};
