import redis from "../../config/redis";
import { prisma } from "../../lib/prisma/prisma";

const applyFixes = process.argv.includes("--fix");
const ci = process.argv.includes("--ci");
const batchSizeArg = process.argv.find((arg) => arg.startsWith("--batch-size="));
const batchSize = Math.min(Math.max(Number(batchSizeArg?.split("=")[1] ?? 250) || 250, 1), 1000);

const main = async () => {
  let cursor: string | undefined;
  const summary = {
    scanned: 0,
    lockedCountries: 0,
    needsUserCountrySelection: 0,
    markerRepairsNeeded: 0,
    markerRepairsApplied: 0,
    errors: 0,
    criticalUnresolved: 0,
  };

  do {
    const rows = await prisma.adminProfile.findMany({
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        userId: true,
        country: true,
        createdAt: true,
        countryLockedAt: true,
        countrySelectionRequiredAt: true,
      },
      orderBy: { id: "asc" },
      take: batchSize,
    });

    if (rows.length === 0) break;
    cursor = rows.at(-1)?.id;

    for (const row of rows) {
      summary.scanned += 1;
      const hasCountry = row.country !== null;
      if (hasCountry) summary.lockedCountries += 1;
      else summary.needsUserCountrySelection += 1;

      const markerIsValid = hasCountry
        ? Boolean(row.countryLockedAt) && row.countrySelectionRequiredAt === null
        : row.countryLockedAt === null && Boolean(row.countrySelectionRequiredAt);

      if (markerIsValid) {
        if (applyFixes) await redis.del(`admin:profile:${row.userId}`).catch(() => {});
        continue;
      }
      summary.markerRepairsNeeded += 1;
      if (!applyFixes) continue;

      try {
        if (hasCountry) {
          await prisma.adminProfile.update({
            where: { id: row.id },
            data: {
              // Preserve the exact existing country. Never infer or rewrite it.
              countryLockedAt: row.countryLockedAt ?? row.createdAt,
              countrySelectionRequiredAt: null,
            },
          });
        } else {
          await prisma.adminProfile.update({
            where: { id: row.id },
            data: {
              // Missing country remains missing. The tenant must explicitly choose it.
              countryLockedAt: null,
              countrySelectionRequiredAt: row.countrySelectionRequiredAt ?? new Date(),
            },
          });
        }
        summary.markerRepairsApplied += 1;
        await redis.del(`admin:profile:${row.userId}`).catch(() => {});
      } catch (error) {
        summary.errors += 1;
        console.error(`[country-lock-repair-failed] admin=${row.id}`, error);
      }
    }
  } while (cursor);

  const unresolvedMarkerRepairs = applyFixes
    ? Math.max(0, summary.markerRepairsNeeded - summary.markerRepairsApplied)
    : ci
      ? summary.markerRepairsNeeded
      : 0;
  summary.criticalUnresolved = summary.errors + unresolvedMarkerRepairs;

  console.log(JSON.stringify({
    mode: applyFixes ? "fix" : "dry-run",
    policy: "missing country is never inferred; tenant selection is required",
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
