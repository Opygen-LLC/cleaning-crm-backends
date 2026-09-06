import { TemplateRegistry, type WebsiteTemplateDefinition } from "./templateRegistry";

type PublishedTemplateIdentity = {
  templateId: string;
  templateVersion: string;
  schemaVersion: number;
};

/** Compatibility is a read policy, never an implicit migration. A registry's
 * newest release must not replace an old publication or its downgrade view. */
export const resolveCompatibleBackendTemplate = (config: PublishedTemplateIdentity) => {
  const exact = TemplateRegistry.get(config.templateId, config.templateVersion);
  if (exact?.schemaVersion === config.schemaVersion) return exact;
  const originalFamily = TemplateRegistry.get(config.templateId, "1.0.0");
  if (originalFamily?.schemaVersion === config.schemaVersion) return originalFamily;
  const originalDefault = TemplateRegistry.get("clean-modern", "1.0.0");
  return originalDefault?.schemaVersion === config.schemaVersion ? originalDefault : null;
};

/** Downgrade premium presentation within the committed release. The original
 * premium selection stays persisted, so restoring entitlement restores it. */
export const resolveTemplateDowngradeFallback = (
  config: Pick<PublishedTemplateIdentity, "schemaVersion">,
  requested: Pick<WebsiteTemplateDefinition, "version">,
) => {
  const sameRelease = TemplateRegistry.get("clean-modern", requested.version);
  if (sameRelease?.schemaVersion === config.schemaVersion) return sameRelease;
  const original = TemplateRegistry.get("clean-modern", "1.0.0");
  return original?.schemaVersion === config.schemaVersion ? original : null;
};
