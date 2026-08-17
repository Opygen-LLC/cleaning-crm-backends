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

  const template = TemplateRegistry.requireTemplate(
    payload.templateId ?? current.templateId,
    payload.templateVersion ?? (payload.templateId ? undefined : current.templateVersion),
  );

  return {
    templateId: template.id,
    templateVersion: template.version,
    schemaVersion: template.schemaVersion,
  };
};
