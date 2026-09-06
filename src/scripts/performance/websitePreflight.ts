import { pathToFileURL } from "node:url";
import { prisma } from "../../lib/prisma/prisma";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Read-only reconciliation and measured plans. Run against a representative
 * staging database; EXPLAIN ANALYZE executes only the reviewed SELECTs below.
 * No index is created based on assumptions or on EXPLAIN estimates alone. */
export async function websitePerformancePreflight(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== "--explain" && !arg.startsWith("--admin-id="))) throw new Error("Usage: websitePreflight [--explain --admin-id=UUID]");
  const adminId = args.find(arg => arg.startsWith("--admin-id="))?.slice(11);
  if ((adminId && !uuid.test(adminId)) || (args.includes("--explain") && !adminId)) throw new Error("EXPLAIN requires a representative --admin-id=UUID");
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='30s'");
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout='3s'");
    const counters = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      WITH history AS (SELECT "websiteId", MAX("revisionNumber") AS maximum FROM website_revision GROUP BY "websiteId")
      SELECT COUNT(*)::int AS websites,
        COUNT(*) FILTER (WHERE w."draftRevisionNumber" < GREATEST(COALESCE(h.maximum,0), COALESCE(w."publishedRevisionNumber",0)))::int AS counters_behind,
        COUNT(*) FILTER (WHERE w."draftRevisionNumber" > COALESCE(h.maximum,0))::int AS drafts_ahead_of_history,
        COUNT(*) FILTER (WHERE w.status='PUBLISHED' AND (w."publishedAt" IS NULL OR w."publishedRevisionNumber" IS NULL
          OR jsonb_typeof(w."publishedSnapshot"->'website') IS DISTINCT FROM 'object'))::int AS invalid_publications
      FROM business_website w LEFT JOIN history h ON h."websiteId"=w.id`);
    const columns = await tx.$queryRawUnsafe<Array<{ column_name: string }>>("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='business_website' AND column_name IN ('publishedDesignMetadata','publicationDeliveryEventId','publicationDeliveryReceipt')");
    const triggers = await tx.$queryRawUnsafe<Array<{ tgname: string; tgenabled: string }>>("SELECT tgname, tgenabled FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('website_revision_counter_monotonic','website_revision_counter_advance','website_publication_design_metadata')");
    const constraints = await tx.$queryRawUnsafe<Array<{ conname: string; convalidated: boolean }>>("SELECT conname, convalidated FROM pg_constraint WHERE conname='business_website_revision_counter_valid'");
    const indexes = await tx.$queryRawUnsafe<Array<{ tablename: string; indexname: string; indexdef: string }>>("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename IN ('business_website','website_revision','website_subdomain_alias','website_domain','service_catalog','outbox_event') ORDER BY tablename,indexname");
    const receiptHealth = columns.length === 3 ? await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      SELECT COUNT(*) FILTER (WHERE status='PUBLISHED' AND "publishedDesignMetadata" IS NULL)::int AS missing_design_metadata,
        COUNT(*) FILTER (WHERE status='PUBLISHED' AND ("publicationDeliveryEventId" IS NULL OR "publicationDeliveryReceipt" IS NULL))::int AS missing_delivery_proofs
      FROM business_website`) : null;
    const plans: Array<Record<string, unknown>> = [];
    if (args.includes("--explain")) {
      const rows = await tx.$queryRawUnsafe<Array<{ id: string; subdomain: string }>>('SELECT id,subdomain FROM business_website WHERE "adminId"=$1', adminId);
      if (rows.length !== 1) throw new Error("Representative tenant website not found");
      const website = rows[0]!;
      const queries = [
        { name: "compact-status-row", sql: 'SELECT id,status,subdomain,"publishedRevisionNumber" FROM business_website WHERE "adminId"=$1', value: adminId },
        { name: "host-lookup", sql: 'SELECT id,"adminId",status,"publishedRevisionNumber" FROM business_website WHERE subdomain=$1', value: website.subdomain },
        { name: "revision-counter", sql: 'SELECT "draftRevisionNumber" FROM business_website WHERE id=$1', value: website.id },
        { name: "revision-history-page", sql: 'SELECT id,"revisionNumber",reason,"createdAt" FROM website_revision WHERE "websiteId"=$1 ORDER BY "revisionNumber" DESC LIMIT 100', value: website.id },
        { name: "catalog-page", sql: 'SELECT id,"serviceName",status,"updatedAt" FROM service_catalog WHERE "adminId"=$1 ORDER BY "serviceName" ASC,id ASC LIMIT 100', value: adminId },
      ];
      for (const query of queries) {
        const explained = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING TRUE) ${query.sql}`, query.value);
        const raw = explained[0]?.["QUERY PLAN"] as Array<{ "Execution Time"?: number; "Planning Time"?: number; Plan?: Record<string, unknown> }>;
        const plan = raw?.[0];
        // Parent node buffers include children. Report the root, do not sum them.
        plans.push({ name: query.name, executionMs: plan?.["Execution Time"], planningMs: plan?.["Planning Time"],
          rootSharedHitBlocks: plan?.Plan?.["Shared Hit Blocks"], rootSharedReadBlocks: plan?.Plan?.["Shared Read Blocks"],
          plan: JSON.parse(JSON.stringify(plan ?? null).replaceAll(adminId!, "<tenant>").replaceAll(website.id, "<website>").replaceAll(website.subdomain, "<subdomain>")) });
      }
    }
    return { schemaVersion: 1, generatedAt: new Date().toISOString(), mode: "read-only", counters: counters[0],
      explanation: "Drafts ahead of history are legitimate autosaves. Only counters behind history/publication require monotonic reconciliation. No repair was performed.",
      schema: { columns, triggers, constraints }, indexes, receiptHealth: receiptHealth?.[0] ?? null, plans,
      postMigrationReady: columns.length === 3 && triggers.length === 3 && triggers.every(t => t.tgenabled !== "D") && constraints.some(c => c.convalidated) && Number(counters[0]?.counters_behind) === 0,
    };
  }, { maxWait: 10_000, timeout: 120_000 });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  websitePerformancePreflight().then(report => { console.log(JSON.stringify(report, null, 2)); })
    .catch(() => { console.error("Read-only website preflight failed. Check schema/permissions/timeouts in database logs; no repair was performed."); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });
}
