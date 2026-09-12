import { prisma } from "../../lib/prisma/prisma";
import { WebsiteBookingProvisioningService } from "../../modules/Website/websiteBookingProvisioning.service";
import { WebsiteProjectionCacheService } from "../../modules/Website/websiteProjectionCache.service";
import { WebsiteService } from "../../modules/Website/website.service";
import { parsePublishedSnapshot } from "../../modules/Website/websiteSnapshot";
import { ServiceStatus } from "../../generated/prisma/enums";

const applyFixes = process.argv.includes("--fix");
const ci = process.argv.includes("--ci");
const batchSizeArg = process.argv.find((arg) => arg.startsWith("--batch-size="));
const batchSize = Math.min(Math.max(Number(batchSizeArg?.split("=")[1] ?? 100) || 100, 1), 500);

const main = async () => {
  let cursor: string | undefined;
  const summary = {
    scanned: 0,
    alreadyReady: 0,
    needsReconciliation: 0,
    reconciled: 0,
    selectionRequired: 0,
    liveSnapshotUpdated: 0,
    safelyStagedUntilServiceSetup: 0,
    errors: 0,
    criticalUnresolved: 0,
  };

  do {
    const rows = await prisma.adminProfile.findMany({
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      where: { businessWebsite: { isNot: null } },
      select: {
        id: true,
        businessWebsite: {
          select: {
            id: true,
            status: true,
            publishedSnapshot: true,
            bookingEnabled: true,
            primaryBookingFormId: true,
            primaryBookingForm: { select: { id: true, published: true, websiteManaged: true } },
            pages: {
              where: { kind: "BOOK" },
              select: { isEnabled: true, showInNavigation: true },
              take: 1,
            },
          },
        },
      },
      orderBy: { id: "asc" },
      take: batchSize,
    });

    if (rows.length === 0) break;
    cursor = rows.at(-1)?.id;

    for (const row of rows) {
      summary.scanned += 1;
      const website = row.businessWebsite;
      if (!website) continue;
      const bookPage = website.pages[0];
      const draftReady = Boolean(
        website.bookingEnabled &&
          website.primaryBookingFormId &&
          website.primaryBookingForm?.published &&
          bookPage?.isEnabled &&
          bookPage.showInNavigation,
      );

      let liveReady = website.status !== "PUBLISHED";
      if (!liveReady && website.primaryBookingFormId) {
        const published = parsePublishedSnapshot(website.publishedSnapshot);
        liveReady = Boolean(
          published?.website.bookingEnabled &&
            published.website.primaryBookingFormId === website.primaryBookingFormId &&
            published.website.bookingShowNavigation &&
            published.pages.some(
              (page) => page.kind === "BOOK" && page.isEnabled && page.showInNavigation,
            ),
        );
      }

      // A published site with no valid service must stay fail-closed publicly.
      // Treat that state as safely staged so repeated --fix runs are idempotent;
      // once a real bookable service is configured the next run promotes only
      // the booking-specific live snapshot fields.
      let safelyStagedUntilServiceSetup = false;
      if (draftReady && website.status === "PUBLISHED" && !liveReady && website.primaryBookingForm) {
        const serviceCount = website.primaryBookingForm.websiteManaged
          ? await prisma.serviceCatalog.count({
              where: {
                adminId: row.id,
                archivedAt: null,
                status: ServiceStatus.ACTIVE,
                onlineBookingEnabled: true,
              },
            })
          : await prisma.bookingFormService.count({
              where: {
                formId: website.primaryBookingForm.id,
                enabled: true,
                serviceCatalog: {
                  is: {
                    adminId: row.id,
                    archivedAt: null,
                    status: ServiceStatus.ACTIVE,
                    onlineBookingEnabled: true,
                  },
                },
              },
            });
        safelyStagedUntilServiceSetup = serviceCount === 0;
      }

      if (draftReady && (liveReady || safelyStagedUntilServiceSetup)) {
        summary.alreadyReady += 1;
        if (safelyStagedUntilServiceSetup) summary.safelyStagedUntilServiceSetup += 1;
        continue;
      }

      summary.needsReconciliation += 1;
      if (!applyFixes) continue;

      try {
        const result = await prisma.$transaction(async (tx) => {
          const reconciled = await WebsiteBookingProvisioningService.reconcileDefaultBookingForExistingTenantTx(tx, row.id);
          if (!reconciled.requiresSelection) {
            await WebsiteService.createRevisionSnapshotTx(
              tx,
              reconciled.websiteId,
              null,
              "Phase 3 online-booking default reconciliation",
            );
          }
          return reconciled;
        });

        if (result.requiresSelection) {
          summary.selectionRequired += 1;
          console.warn(`[selection-required] admin=${row.id}: choose a primary booking form in Website Studio`);
          continue;
        }

        summary.reconciled += 1;
        if (result.liveSnapshotUpdated) summary.liveSnapshotUpdated += 1;
        await WebsiteProjectionCacheService.invalidateAdminWebsite(row.id);
      } catch (error) {
        summary.errors += 1;
        console.error(`[failed] admin=${row.id}`, error);
      }
    }
  } while (cursor);

  summary.criticalUnresolved = summary.errors;
  console.log(JSON.stringify({
    mode: applyFixes ? "fix" : "dry-run",
    ...summary,
  }, null, 2));
  if (summary.criticalUnresolved > 0 || (ci && summary.errors > 0)) process.exitCode = 1;
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
