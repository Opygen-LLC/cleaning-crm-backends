import type { WebsiteUpdateInput } from "./website.interface";
import { TemplateRegistry } from "./templateRegistry";

export interface PersistedTemplateSelection {
  templateId: string;
  templateVersion: string;
}

/**
 * Resolve template identity without touching any tenant-owned website/CRM data.
 * Keeping this patch deliberately narrow makes template changes presentation
 * only: services, forms, pages, branding, business details and domains remain
 * in their existing stores/relations.
 */
export const buildTemplateSelectionPatch = (
  payload: Pick<WebsiteUpdateInput, "templateId" | "templateVersion">,
  current: PersistedTemplateSelection,
): Record<string, never> | { templateId: string; templateVersion: string; schemaVersion: number } => {
  if (payload.templateId === undefined && payload.templateVersion === undefined) return {};

  const template = TemplateRegistry.requireSelectable(
    payload.templateId ?? current.templateId,
    // Legacy versionless writes must not upgrade a tenant merely because a
    // newer renderer was registered. Current Studio always sends both fields.
    payload.templateVersion ?? (!payload.templateId || payload.templateId === current.templateId ? current.templateVersion : "1.0.0"),
    current,
  );

  return {
    templateId: template.id,
    templateVersion: template.version,
    schemaVersion: template.schemaVersion,
  };
};
