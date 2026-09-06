/** Read-only audit rules. Never normalize or repair the input in place. */
export type AuditIssue = {
  code: string; severity: "error" | "warning"; websiteId?: string; adminId?: string; reason: string;
};
export type RegistryView = {
  templates: ReadonlyArray<{ id: string; version: string; schemaVersion: number }>;
  components: ReadonlyArray<{ id: string; slot: string; status: string }>;
  parseSnapshot: (value: unknown) => unknown | null;
  validDesign: (value: unknown) => boolean;
};
type Json = Record<string, any>;
const object = (value: unknown): value is Json => Boolean(value && typeof value === "object" && !Array.isArray(value));
const canonicalJson = (value: unknown): string => JSON.stringify(sortJson(value));
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => [key,sortJson(item)]));
}
const steps = ["business_profile", "branding", "services", "website_address", "review_launch"];

export function inspectWebsiteForRelease(row: Json, registry: RegistryView): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const add = (code: string, reason: string, severity: AuditIssue["severity"] = "error") => {
    issues.push({ code, severity, websiteId: row.id, adminId: row.adminId, reason });
  };
  const config = (value: unknown, surface: string) => {
    if (!object(value)) { add("INVALID_TEMPLATE_CONFIG", `${surface}: configuration is not an object`); return; }
    if (!registry.templates.some(t => t.id === value.templateId && t.version === value.templateVersion && t.schemaVersion === value.schemaVersion)) {
      add("UNKNOWN_TEMPLATE_VERSION", `${surface}: template/version/schema is not registered`);
    }
    if (!registry.validDesign(value.websiteDesign)) add("MALFORMED_WEBSITE_DESIGN", `${surface}: design schema is invalid`);
    const overrides = value.websiteDesign?.componentOverrides;
    if (!object(overrides)) return;
    for (const [page, entries] of Object.entries(overrides)) {
      if (!object(entries)) continue;
      for (const [slot, id] of Object.entries(entries)) {
        const definition = registry.components.find(c => c.id === id);
        if (!definition || definition.slot !== `${page}.${slot}` || definition.status !== "ACTIVE") {
          add("UNKNOWN_OR_MISPLACED_COMPONENT", `${surface}: invalid component in ${page}.${slot}`);
        }
      }
    }
  };
  config(row, "draft");
  const raw = row.publishedSnapshot;
  const snapshot = registry.parseSnapshot(raw);
  const revision = Number(row.publishedRevisionNumber);
  const validPointer = Number.isSafeInteger(revision) && revision > 0 && row.publicationRevisionExists === true;
  const published = row.status === "PUBLISHED";
  if (published && (!snapshot || !validPointer || !row.publishedAt)) {
    add("INVALID_PUBLICATION", "Published row lacks a valid immutable snapshot, publication timestamp or exact revision record");
  }
  if (row.onboardingCompletedAt && (!snapshot || !validPointer || !row.publishedAt)) {
    add("COMPLETED_WITHOUT_PUBLICATION", "Completed onboarding has no valid recorded publication");
  }
  if (object(snapshot)) config(object(raw) ? raw.website : snapshot.website, "published");
  const revisionSnapshot = registry.parseSnapshot(row.publicationRevisionSnapshot);
  if (published && row.publicationRevisionExists && !revisionSnapshot) {
    add("INVALID_PUBLICATION_REVISION", "The exact publication revision cannot be parsed as an immutable snapshot");
  }
  if (published && snapshot && revisionSnapshot && canonicalJson(snapshot) !== canonicalJson(revisionSnapshot)) {
    add("PUBLICATION_REVISION_MISMATCH", "Published content differs from the exact committed revision snapshot");
  }
  const maximum = Math.max(Number(row.maximumRevision || 0), Number(row.publishedRevisionNumber || 0));
  if (!Number.isSafeInteger(row.draftRevisionNumber) || row.draftRevisionNumber < maximum || row.draftRevisionNumber < 0) {
    add("REVISION_COUNTER_BEHIND", "Draft counter is invalid or behind recorded history/publication; never decrement it");
  }
  // An autosaved draft can be ahead of revision history. That is NOT corruption.
  if (!row.revisionCount) add("MISSING_INITIAL_REVISION", "Website has no provisioned revision");
  const progress = row.onboardingCompletedSteps;
  if (!Array.isArray(progress) || progress.some(s => typeof s !== "string" || (!steps.includes(s) && s !== "template"))) {
    add("MALFORMED_ONBOARDING_PROGRESS", "Progress is not an array of recognized current/legacy milestones");
  } else {
    const canonical = progress.map(s => s === "template" ? "review_launch" : s);
    if (new Set(canonical).size !== canonical.length) add("DUPLICATE_ONBOARDING_MILESTONES", "Progress contains duplicate canonical milestones", "warning");
    if (!row.onboardingCompletedAt) {
      const furthest = Math.max(-1, ...canonical.map(s => steps.indexOf(s)));
      if (steps.slice(0, furthest).some(s => !canonical.includes(s))) add("NONCONTIGUOUS_ONBOARDING_PROGRESS", "Resume milestones omit an earlier step", "warning");
    }
    if ((row.onboardingCompletedAt || canonical.includes("services")) && !Number(row.activeServices)) {
      add("MISSING_ACTIVE_SERVICES", "Service setup is completed but the tenant has no active services");
    }
  }
  const forms = Array.isArray(row.forms) ? row.forms : [];
  const assets = Array.isArray(row.assets) ? row.assets : [];
  const pageOwners = Array.isArray(row.pageOwners) ? row.pageOwners : [];
  const refs = (value: unknown, pages: unknown, surface: string) => {
    if (!object(value)) return;
    for (const [field, kind, enabled] of [["primaryBookingFormId", "booking", "bookingEnabled"], ["primaryEstimateFormId", "estimate", "estimateEnabled"]]) {
      const id = value[field!];
      const form = forms.find(f => f.id === id && f.kind === kind);
      if (id && (!form || form.adminId !== row.adminId)) add("INVALID_FORM_OWNERSHIP", `${surface}: ${kind} form is missing or belongs to another tenant`);
      if (surface === "published" && published && value[enabled!] && (!id || !form?.published)) {
        add("UNREADY_PUBLISHED_FORM", `${surface}: enabled ${kind} form is absent or unpublished`);
      }
    }
    const images: Array<{ url: unknown; mustBeOwned: boolean }> = [value.logo, value.favicon].map(url => ({ url, mustBeOwned: true }));
    if (value.socialImageUrl) images.push({ url: value.socialImageUrl, mustBeOwned: false });
    for (const page of Array.isArray(pages) ? pages : []) {
      const owner = pageOwners.find(p => p.id === page.id);
      if (owner && owner.websiteId !== row.id) add("INVALID_PAGE_OWNERSHIP", `${surface}: page identifier belongs to another website`);
      if (page.kind === "HOME") images.push({ url: page.content?.heroImageUrl, mustBeOwned: true });
      // Historical external ABOUT media is supported by the existing API.
      if (page.kind === "ABOUT") images.push({ url: page.content?.imageUrl, mustBeOwned: false });
      if (page.socialImageUrl) images.push({ url: page.socialImageUrl, mustBeOwned: false });
    }
    for (const image of images) {
      if (typeof image.url !== "string" || !image.url.trim()) continue;
      const url = image.url.trim();
      const matches = assets.filter(a => a.url === url);
      if (!matches.some(a => a.websiteId === row.id && a.mimeType?.startsWith("image/")) && (image.mustBeOwned || matches.length)) {
        add("INVALID_ASSET_OWNERSHIP", `${surface}: referenced image is missing, not an image, or belongs to another website`);
      }
    }
  };
  refs(row, row.pages, "draft");
  if (object(snapshot)) refs(snapshot.website, snapshot.pages, "published");
  const receipt = row.publicationDeliveryReceipt;
  if (published && (!row.publicationDeliveryEventId || !object(receipt) || receipt.ready !== true ||
      receipt.delivered !== true || receipt.revision !== row.publishedRevisionNumber ||
      receipt.projectionWarmed !== true || receipt.projectionRevisionVerified !== true ||
      receipt.revalidationDelivered !== true || receipt.canonicalHostVerified !== true)) {
    add("MISSING_DELIVERY_PROOF", "Published website has no confirmed durable delivery receipt; use the existing delivery reconciler after review", "warning");
  }
  return issues;
}

export function auditReferencedValues(row: Json): { urls: string[]; formIds: string[]; pageIds: string[] } {
  const urls = new Set<string>(), formIds = new Set<string>(), pageIds = new Set<string>();
  for (const [value, pages] of [[row, row.pages], [row.publishedSnapshot?.website, row.publishedSnapshot?.pages]]) {
    if (!object(value)) continue;
    for (const url of [value.logo, value.favicon, value.socialImageUrl]) if (typeof url === "string" && url.trim()) urls.add(url.trim());
    for (const id of [value.primaryBookingFormId, value.primaryEstimateFormId]) if (typeof id === "string") formIds.add(id);
    for (const page of Array.isArray(pages) ? pages : []) {
      if (typeof page.id === "string") pageIds.add(page.id);
      for (const url of [page.content?.heroImageUrl, page.content?.imageUrl, page.socialImageUrl]) if (typeof url === "string" && url.trim()) urls.add(url.trim());
    }
  }
  return { urls: [...urls], formIds: [...formIds], pageIds: [...pageIds] };
}
