import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";

const apply = process.argv.includes("--fix");

type CountRow = { count: bigint | number | string };
const count = async (sql: Prisma.Sql) => {
  const rows = await prisma.$queryRaw<CountRow[]>(sql);
  return Number(rows[0]?.count ?? 0);
};

const audit = async () => ({
  missingBooking: await count(Prisma.sql`
    SELECT COUNT(*) AS count
    FROM "booking_form_submission" b
    JOIN "booking_form" f ON f.id = b."formId"
    JOIN "business_website" w ON w.id = b."sourceWebsiteId" AND w."adminId" = f."adminId"
    LEFT JOIN "website_submission" ws ON ws."bookingFormSubmissionId" = b.id
    WHERE b."sourceWebsiteId" IS NOT NULL AND ws.id IS NULL
  `),
  missingEstimate: await count(Prisma.sql`
    SELECT COUNT(*) AS count
    FROM "estimate_form_submission" e
    JOIN "estimate_form" f ON f.id = e."formId"
    JOIN "business_website" w ON w.id = e."sourceWebsiteId" AND w."adminId" = f."adminId"
    LEFT JOIN "website_submission" ws ON ws."estimateFormSubmissionId" = e.id
    WHERE e."sourceWebsiteId" IS NOT NULL AND ws.id IS NULL
  `),
  historicalContactLeadsWithoutEnvelope: await count(Prisma.sql`
    SELECT COUNT(*) AS count
    FROM "lead" l
    JOIN "business_website" w ON w.id = l."sourceWebsiteId" AND w."adminId" = l."adminId"
    WHERE l."sourceWebsiteId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "website_submission" ws
        WHERE ws."kind" = 'CONTACT'::"WebsiteSubmissionKind" AND ws."leadId" = l.id
      )
  `),
  tenantMismatches: await count(Prisma.sql`
    SELECT COUNT(*) AS count FROM (
      SELECT ws.id FROM "website_submission" ws JOIN "business_website" w ON w.id=ws."websiteId" WHERE ws."adminId"<>w."adminId"
      UNION ALL
      SELECT ws.id FROM "website_submission" ws JOIN "service_catalog" s ON s.id=ws."serviceCatalogId" WHERE ws."adminId"<>s."adminId"
      UNION ALL
      SELECT ws.id FROM "website_submission" ws JOIN "lead" l ON l.id=ws."leadId" WHERE ws."adminId"<>l."adminId"
      UNION ALL
      SELECT ws.id FROM "website_submission" ws JOIN "booking_form_submission" b ON b.id=ws."bookingFormSubmissionId" JOIN "booking_form" f ON f.id=b."formId" WHERE ws."adminId"<>f."adminId"
      UNION ALL
      SELECT ws.id FROM "website_submission" ws JOIN "estimate_form_submission" e ON e.id=ws."estimateFormSubmissionId" JOIN "estimate_form" f ON f.id=e."formId" WHERE ws."adminId"<>f."adminId"
    ) mismatch
  `),
  staleConvertedStatus: await count(Prisma.sql`
    SELECT COUNT(*) AS count
    FROM "website_submission" ws
    LEFT JOIN "booking_form_submission" b ON b.id = ws."bookingFormSubmissionId"
    LEFT JOIN "estimate_form_submission" e ON e.id = ws."estimateFormSubmissionId"
    LEFT JOIN "lead" l ON l.id = ws."leadId"
    WHERE ws."status" <> 'CONVERTED'::"WebsiteSubmissionStatus"
      AND (
        b."status" = 'CONVERTED'::"FormSubmissionStatus"
        OR e."status" = 'CONVERTED'::"EstimateSubmissionStatus"
        OR l."convertedClientId" IS NOT NULL
      )
  `),
});

const fixDeterministic = async () => {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "website_submission" (
        "id", "ref", "kind", "status", "adminId", "websiteId", "serviceCatalogId",
        "serviceNameSnapshot", "name", "email", "phone", "summary",
        "bookingFormSubmissionId", "createdAt", "updatedAt"
      )
      SELECT gen_random_uuid()::text,
        'WS-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 20)),
        'BOOKING'::"WebsiteSubmissionKind",
        CASE b."status"::text WHEN 'CONVERTED' THEN 'CONVERTED'::"WebsiteSubmissionStatus"
          WHEN 'REVIEWED' THEN 'REVIEWED'::"WebsiteSubmissionStatus"
          WHEN 'DECLINED' THEN 'DISMISSED'::"WebsiteSubmissionStatus"
          ELSE 'NEW'::"WebsiteSubmissionStatus" END,
        f."adminId", b."sourceWebsiteId", b."serviceCatalogId", b."serviceNameSnapshot",
        b."name", lower(b."email"), b."phone",
        COALESCE(NULLIF(btrim(b."notes"), ''), 'Booking request for ' || COALESCE(b."serviceNameSnapshot", 'service')),
        b.id, b."createdAt", b."createdAt"
      FROM "booking_form_submission" b
      JOIN "booking_form" f ON f.id=b."formId"
      JOIN "business_website" w ON w.id=b."sourceWebsiteId" AND w."adminId"=f."adminId"
      WHERE b."sourceWebsiteId" IS NOT NULL
      ON CONFLICT ("bookingFormSubmissionId") DO NOTHING
    `);

    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "website_submission" (
        "id", "ref", "kind", "status", "adminId", "websiteId", "serviceCatalogId",
        "serviceNameSnapshot", "name", "email", "phone", "summary",
        "estimateFormSubmissionId", "createdAt", "updatedAt"
      )
      SELECT gen_random_uuid()::text,
        'WS-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 20)),
        'ESTIMATE'::"WebsiteSubmissionKind",
        CASE e."status"::text WHEN 'CONVERTED' THEN 'CONVERTED'::"WebsiteSubmissionStatus"
          WHEN 'QUOTED' THEN 'REVIEWED'::"WebsiteSubmissionStatus"
          WHEN 'DISMISSED' THEN 'DISMISSED'::"WebsiteSubmissionStatus"
          ELSE 'NEW'::"WebsiteSubmissionStatus" END,
        f."adminId", e."sourceWebsiteId", e."serviceCatalogId", e."serviceNameSnapshot",
        e."name", lower(e."email"), e."phone",
        COALESCE(NULLIF(btrim(e."notes"), ''), 'Estimate request for ' || COALESCE(e."serviceNameSnapshot", 'service')),
        e.id, e."createdAt", e."createdAt"
      FROM "estimate_form_submission" e
      JOIN "estimate_form" f ON f.id=e."formId"
      JOIN "business_website" w ON w.id=e."sourceWebsiteId" AND w."adminId"=f."adminId"
      WHERE e."sourceWebsiteId" IS NOT NULL
      ON CONFLICT ("estimateFormSubmissionId") DO NOTHING
    `);

    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "website_submission" (
        "id", "ref", "kind", "status", "adminId", "websiteId", "serviceCatalogId",
        "serviceNameSnapshot", "name", "email", "phone", "summary", "leadId", "createdAt", "updatedAt"
      )
      SELECT gen_random_uuid()::text,
        'WS-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 20)),
        'CONTACT'::"WebsiteSubmissionKind",
        CASE WHEN l."convertedClientId" IS NOT NULL THEN 'CONVERTED'::"WebsiteSubmissionStatus" ELSE 'REVIEWED'::"WebsiteSubmissionStatus" END,
        l."adminId", l."sourceWebsiteId", l."serviceCatalogId", l."serviceInterest",
        l."name", lower(l."email"), l."phone",
        COALESCE(NULLIF(btrim(l."notes"), ''), 'Historical website contact'), l.id, l."createdAt", l."updatedAt"
      FROM "lead" l
      JOIN "business_website" w ON w.id=l."sourceWebsiteId" AND w."adminId"=l."adminId"
      WHERE l."sourceWebsiteId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "website_submission" ws WHERE ws."kind"='CONTACT'::"WebsiteSubmissionKind" AND ws."leadId"=l.id)
    `);

    await tx.$executeRaw(Prisma.sql`
      UPDATE "website_submission" ws SET "status"='CONVERTED'::"WebsiteSubmissionStatus", "updatedAt"=CURRENT_TIMESTAMP
      WHERE ws."status"<>'CONVERTED'::"WebsiteSubmissionStatus" AND (
        EXISTS (SELECT 1 FROM "booking_form_submission" b WHERE b.id=ws."bookingFormSubmissionId" AND b."status"='CONVERTED'::"FormSubmissionStatus")
        OR EXISTS (SELECT 1 FROM "estimate_form_submission" e WHERE e.id=ws."estimateFormSubmissionId" AND e."status"='CONVERTED'::"EstimateSubmissionStatus")
        OR EXISTS (SELECT 1 FROM "lead" l WHERE l.id=ws."leadId" AND l."convertedClientId" IS NOT NULL)
      )
    `);
  });
};

const main = async () => {
  const before = await audit();
  console.log(JSON.stringify({ mode: apply ? "fix" : "report", before }, null, 2));
  if (before.tenantMismatches > 0) {
    throw new Error("Cross-tenant WebsiteSubmission rows detected. Automatic repair is intentionally disabled.");
  }
  if (!apply) return;
  await fixDeterministic();
  const after = await audit();
  console.log(JSON.stringify({ after }, null, 2));
  if (after.missingBooking || after.missingEstimate || after.historicalContactLeadsWithoutEnvelope || after.staleConvertedStatus || after.tenantMismatches) {
    throw new Error("WebsiteSubmission reconciliation did not converge cleanly.");
  }
};

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
