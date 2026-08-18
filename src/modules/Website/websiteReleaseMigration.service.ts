import type { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";
import { acquireTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { PROVISIONING_TRANSACTION_OPTIONS } from "../../lib/prisma/transactionPolicy";
import { DEFAULT_WEBSITE_PAGES, DEFAULT_WEBSITE_SETTINGS } from "./website.constant";
import { WebsiteProvisioningService } from "./websiteProvisioning.service";
import { TemplateRegistry } from "./templateRegistry";
import { validateWebsitePageContent } from "./websiteContent";
import { buildPublishedSnapshot, parsePublishedSnapshot, parseRevisionSnapshotAsPublished } from "./websiteSnapshot";
import { WEBSITE_STATUS } from "./websiteLifecycle";
import { WebsiteHostResolverService } from "./websiteHostResolver.service";
import { WebsiteProjectionCacheService } from "./websiteProjectionCache.service";

export type WebsiteReleaseRepairAction =
  | "WEBSITE_PROVISIONED"
  | "TEMPLATE_REPAIRED"
  | "SYSTEM_PAGE_CREATED"
  | "INITIAL_REVISION_CREATED"
  | "PUBLISHED_SNAPSHOT_REPAIRED";

export interface WebsiteReleaseAudit {
  adminId: string;
  websiteId: string | null;
  healthy: boolean;
  issues: string[];
}

export interface WebsiteReleaseRepairResult extends WebsiteReleaseAudit {
  detectedIssues: string[];
  created: boolean;
  repaired: boolean;
  actions: WebsiteReleaseRepairAction[];
  subdomain: string | null;
}

const releaseLock = (adminId: string) => `phase10-website-release:${adminId}`;
const DEFAULT_TEMPLATE = TemplateRegistry.requireTemplate(DEFAULT_WEBSITE_SETTINGS.templateId);

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const loadReleaseWebsite = async (db: Prisma.TransactionClient, adminId: string) =>
  db.businessWebsite.findUnique({
    where: { adminId },
    include: {
      pages: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      revisions: { select: { id: true, revisionNumber: true, snapshot: true }, orderBy: { revisionNumber: "asc" } },
    },
  });

const supportedTemplate = (templateId: string, templateVersion: string) =>
  Boolean(TemplateRegistry.get(templateId, templateVersion));

const safeSystemSlug = (
  preferred: string,
  used: Set<string>,
  kind: string,
): string => {
  if (!used.has(preferred)) return preferred;
  const base = preferred === "/" ? `/${kind.toLowerCase()}` : `${preferred}-system`;
  if (!used.has(base)) return base;
  for (let index = 2; index <= 10_000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`Unable to allocate a migration-safe slug for ${kind}`);
};

const normalizedDraftForSnapshot = (website: Awaited<ReturnType<typeof loadReleaseWebsite>>) => {
  if (!website) throw new Error("Website not found while building release snapshot");
  return {
    ...website,
    pages: website.pages.map((page) => ({
      ...page,
      content: validateWebsitePageContent(page.kind, page.content),
    })),
  };
};

const inspectLoadedWebsite = (
  adminId: string,
  website: Awaited<ReturnType<typeof loadReleaseWebsite>>,
): WebsiteReleaseAudit => {
  if (!website) {
    return {
      adminId,
      websiteId: null,
      healthy: false,
      issues: ["MISSING_WEBSITE"],
    };
  }

  const issues: string[] = [];
  if (!supportedTemplate(website.templateId, website.templateVersion)) issues.push("UNSUPPORTED_TEMPLATE");

  const kinds = new Set(website.pages.map((page) => page.kind));
  for (const page of DEFAULT_WEBSITE_PAGES) {
    if (!kinds.has(page.kind)) issues.push(`MISSING_PAGE:${page.kind}`);
  }

  if (website.revisions.length === 0) issues.push("MISSING_REVISION");

  if (website.status === WEBSITE_STATUS.PUBLISHED) {
    const parsed = parsePublishedSnapshot(website.publishedSnapshot);
    if (!parsed) issues.push("INVALID_PUBLISHED_SNAPSHOT");
    else if (!supportedTemplate(parsed.website.templateId, parsed.website.templateVersion)) {
      issues.push("UNSUPPORTED_PUBLISHED_TEMPLATE");
    }
    if (!website.publishedAt) issues.push("MISSING_PUBLISHED_AT");
    if (!website.publishedRevisionNumber) issues.push("MISSING_PUBLISHED_REVISION");
  }

  return {
    adminId,
    websiteId: website.id,
    healthy: issues.length === 0,
    issues,
  };
};

export const auditAdminWebsiteForRelease = async (adminId: string): Promise<WebsiteReleaseAudit> => {
  const website = await prisma.$transaction(
    (tx) => loadReleaseWebsite(tx, adminId),
    PROVISIONING_TRANSACTION_OPTIONS,
  );
  return inspectLoadedWebsite(adminId, website);
};

const reconcileAdminWebsiteTx = async (
  db: Prisma.TransactionClient,
  input: { adminId: string; userId: string; businessName: string },
): Promise<WebsiteReleaseRepairResult> => {
  await acquireTextTransactionAdvisoryLock(db, releaseLock(input.adminId));

  const provisioned = await WebsiteProvisioningService.provisionDefaultWebsiteForAdminTx(db, {
    adminId: input.adminId,
    businessName: input.businessName,
    createdByUserId: input.userId,
    initialRevisionReason: "Phase 10 existing customer website provisioned",
  });

  if (provisioned.created) {
    return {
      adminId: input.adminId,
      websiteId: provisioned.website.id,
      subdomain: provisioned.website.subdomain,
      healthy: true,
      issues: [],
      detectedIssues: ["MISSING_WEBSITE"],
      created: true,
      repaired: true,
      actions: ["WEBSITE_PROVISIONED"],
    };
  }

  let website = await loadReleaseWebsite(db, input.adminId);
  if (!website) throw new Error(`Website disappeared during Phase 10 repair for admin ${input.adminId}`);

  const before = inspectLoadedWebsite(input.adminId, website);
  if (before.healthy) {
    return {
      ...before,
      detectedIssues: [],
      subdomain: website.subdomain,
      created: false,
      repaired: false,
      actions: [],
    };
  }

  const actions: WebsiteReleaseRepairAction[] = [];

  if (!supportedTemplate(website.templateId, website.templateVersion)) {
    await db.businessWebsite.update({
      where: { id: website.id },
      data: {
        templateId: DEFAULT_TEMPLATE.id,
        templateVersion: DEFAULT_TEMPLATE.version,
        schemaVersion: DEFAULT_TEMPLATE.schemaVersion,
      },
    });
    actions.push("TEMPLATE_REPAIRED");
  }

  const existingKinds = new Set(website.pages.map((page) => page.kind));
  const usedSlugs = new Set(website.pages.map((page) => page.slug));
  for (const defaultPage of DEFAULT_WEBSITE_PAGES) {
    if (existingKinds.has(defaultPage.kind)) continue;
    const slug = safeSystemSlug(defaultPage.slug, usedSlugs, defaultPage.kind);
    usedSlugs.add(slug);
    await db.websitePage.create({
      data: {
        websiteId: website.id,
        kind: defaultPage.kind,
        slug,
        title: defaultPage.title,
        content: cloneJson(defaultPage.content ?? {}),
        showInNavigation: defaultPage.showInNavigation,
        isEnabled: "isEnabled" in defaultPage ? defaultPage.isEnabled : true,
        sortOrder: defaultPage.sortOrder,
      },
    });
    actions.push("SYSTEM_PAGE_CREATED");
  }

  website = await loadReleaseWebsite(db, input.adminId);
  if (!website) throw new Error(`Website disappeared during Phase 10 repair for admin ${input.adminId}`);

  let latestRevisionNumber = website.revisions.at(-1)?.revisionNumber ?? null;
  const structuralRepair = actions.includes("TEMPLATE_REPAIRED") || actions.includes("SYSTEM_PAGE_CREATED");
  if (latestRevisionNumber === null || structuralRepair) {
    const snapshot = normalizedDraftForSnapshot(website);
    const revisionNumber = (latestRevisionNumber ?? 0) + 1;
    await db.websiteRevision.create({
      data: {
        websiteId: website.id,
        revisionNumber,
        snapshot: cloneJson(snapshot) as unknown as Prisma.InputJsonValue,
        reason: latestRevisionNumber === null
          ? "Phase 10 release baseline repair"
          : "Phase 10 structural website repair",
        createdByUserId: input.userId,
      },
    });
    latestRevisionNumber = revisionNumber;
    if (revisionNumber === 1) actions.push("INITIAL_REVISION_CREATED");
  }

  if (website.status === WEBSITE_STATUS.PUBLISHED) {
    const published = parsePublishedSnapshot(website.publishedSnapshot);
    const publishedTemplateSupported = published
      ? supportedTemplate(published.website.templateId, published.website.templateVersion)
      : false;

    let repairedPublishedSnapshot = published;
    if (published && !publishedTemplateSupported) {
      // Preserve the live snapshot's page copy/branding/integration ids. Only
      // repair the renderer identity; rebuilding from the current draft here
      // could leak unpublished edits into production during migration.
      repairedPublishedSnapshot = {
        ...published,
        website: {
          ...published.website,
          templateId: DEFAULT_TEMPLATE.id,
          templateVersion: DEFAULT_TEMPLATE.version,
          schemaVersion: DEFAULT_TEMPLATE.schemaVersion,
        },
      };
    }

    if (!repairedPublishedSnapshot) {
      // Legacy PUBLISHED rows from before immutable snapshots have no reliable
      // live payload to preserve. Reconstruct once from the sanitized current
      // state; after this migration all future draft edits remain isolated.
      const refreshed = await loadReleaseWebsite(db, input.adminId);
      if (!refreshed) throw new Error(`Website disappeared while repairing published snapshot for ${input.adminId}`);
      repairedPublishedSnapshot = buildPublishedSnapshot(normalizedDraftForSnapshot(refreshed));
    }

    let publishedRevisionNumber = website.publishedRevisionNumber;
    if (!publishedRevisionNumber && published) {
      const canonical = JSON.stringify(published);
      const matchingRevision = [...website.revisions].reverse().find((revision) => {
        const candidate = parseRevisionSnapshotAsPublished(revision.snapshot);
        return candidate ? JSON.stringify(candidate) === canonical : false;
      });
      publishedRevisionNumber = matchingRevision?.revisionNumber ?? null;
    }
    // If no historical revision matches, prefer the earliest known revision
    // rather than the latest draft. That keeps hasUnpublishedChanges fail-safe
    // and avoids claiming a new draft was the live revision.
    publishedRevisionNumber ??= website.revisions[0]?.revisionNumber ?? latestRevisionNumber;

    if (!published || !publishedTemplateSupported || !website.publishedAt || !website.publishedRevisionNumber) {
      await db.businessWebsite.update({
        where: { id: website.id },
        data: {
          publishedSnapshot: cloneJson(repairedPublishedSnapshot) as unknown as Prisma.InputJsonValue,
          publishedRevisionNumber,
          // If a legacy row says PUBLISHED but lost its timestamp, updatedAt is
          // the least-surprising historical proxy. Do not stamp migration time
          // unless no prior row timestamp is available.
          publishedAt: website.publishedAt ?? website.updatedAt ?? new Date(),
        },
      });
      actions.push("PUBLISHED_SNAPSHOT_REPAIRED");
    }
  }

  const repairedWebsite = await loadReleaseWebsite(db, input.adminId);
  const after = inspectLoadedWebsite(input.adminId, repairedWebsite);
  if (!after.healthy) {
    throw new Error(`Phase 10 website repair incomplete for admin ${input.adminId}: ${after.issues.join(", ")}`);
  }
  return {
    ...after,
    detectedIssues: before.issues,
    subdomain: repairedWebsite?.subdomain ?? null,
    created: false,
    repaired: actions.length > 0,
    actions,
  };
};

export const reconcileAdminWebsiteForRelease = async (input: {
  adminId: string;
  userId: string;
  businessName: string;
}): Promise<WebsiteReleaseRepairResult> => {
  const result = await prisma.$transaction(
    (tx) => reconcileAdminWebsiteTx(tx, input),
    PROVISIONING_TRANSACTION_OPTIONS,
  );

  if (result.websiteId && result.repaired) {
    await Promise.all([
      result.subdomain ? WebsiteHostResolverService.invalidateSubdomains([result.subdomain]) : Promise.resolve(),
      WebsiteProjectionCacheService.invalidateWebsite(result.websiteId),
    ]);
  }
  return result;
};

export const WebsiteReleaseMigrationService = {
  auditAdminWebsiteForRelease,
  reconcileAdminWebsiteForRelease,
  reconcileAdminWebsiteTx,
};
