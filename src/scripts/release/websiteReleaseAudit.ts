import type { Client } from "pg";
import { auditReferencedValues, inspectWebsiteForRelease, type AuditIssue, type RegistryView } from "./websiteReleaseChecks";

export function readAuditOptions(args: string[]) {
  const values = new Map<string,string>(); let ci = false;
  for (const arg of args) {
    if (arg === "--ci") { ci = true; continue; }
    const match = /^--(output|batch-size|max-websites|sample-limit)=(.+)$/.exec(arg);
    if (!match || values.has(match[1]!)) throw new Error("Usage: reconcileWebsiteRelease [--ci] [--output=path] [--batch-size=100] [--max-websites=500000] [--sample-limit=100]. Repairs are not supported.");
    values.set(match[1]!, match[2]!);
  }
  const integer = (key: string, fallback: number, max: number) => {
    const text=values.get(key), value=text === undefined ? fallback : Number(text);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid --${key}`);
    return value;
  };
  return { ci, output: values.get("output") || "artifacts/phase6/reconciliation.json", batchSize: integer("batch-size",100,500), maxWebsites: integer("max-websites",500000,1000000), sampleLimit: integer("sample-limit",100,1000) };
}

type Reader = Pick<Client, "query">;
/** SQL permissions plus READ ONLY are the boundary, not the command name.
 * Never invokes a backfill, repair, cache operation, worker or external API. */
export async function reconcileWebsiteRelease(db: Reader, options: ReturnType<typeof readAuditOptions>, view: RegistryView) {
  const startedAt = new Date().toISOString();
  const counts: Record<string,number> = {}, samples: AuditIssue[] = [];
  let errors=0, warnings=0, scanned=0;
  const add = (issue: AuditIssue) => {
    counts[issue.code] = (counts[issue.code] || 0) + 1;
    if (issue.severity === "error") errors++; else warnings++;
    if (samples.filter(s=>s.code===issue.code).length < options.sampleLimit) samples.push(issue);
  };
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await db.query("SET LOCAL statement_timeout = '30s'");
    await db.query("SET LOCAL lock_timeout = '3s'");
    await db.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
    const session = (await db.query("SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation, current_schema() AS schema")).rows[0];
    if (session?.read_only !== "on" || session?.isolation !== "repeatable read") throw new Error("Read-only snapshot could not be established");
    const total = Number((await db.query('SELECT COUNT(*)::int AS count FROM business_website')).rows[0]?.count);
    if (!Number.isSafeInteger(total) || total > options.maxWebsites) throw new Error("Inventory exceeds audit limit; rerun with an explicit larger bound. No partial success is allowed.");

    // Cursor-batched diagnostics prevent an unbounded list of private IDs in
    // memory or in the report; query totals remain exact across the snapshot.
    const diagnosticSql = [
      `SELECT 'INCOMPLETE_PROVISIONING' AS code, CASE WHEN u.status='ACTIVE' THEN 'error' ELSE 'warning' END AS severity,
        a.id AS "adminId", w.id AS "websiteId", 'Owner is missing an admin profile or default website' AS reason
        FROM "user" u LEFT JOIN "AdminProfile" a ON a."userId"=u.id LEFT JOIN business_website w ON w."adminId"=a.id
        WHERE u.role='ADMIN' AND u.status IN ('ACTIVE','PENDING') AND (a.id IS NULL OR w.id IS NULL)`,
      `SELECT 'SUBDOMAIN_COLLISION' AS code, 'error' AS severity, MIN("websiteId") AS "websiteId", 'Canonical/alias names collide after normalization' AS reason
        FROM (SELECT id AS "websiteId",lower(trim(subdomain)) AS name FROM business_website UNION ALL SELECT "websiteId",lower(trim(subdomain)) FROM website_subdomain_alias) n GROUP BY name HAVING COUNT(*)>1`,
      `SELECT 'CUSTOM_DOMAIN_COLLISION' AS code, 'error' AS severity, MIN("websiteId") AS "websiteId", 'Custom domains collide after normalization' AS reason
        FROM website_domain GROUP BY lower(trim(domain)) HAVING COUNT(*)>1`,
      `SELECT 'INVALID_FORM_SERVICE_OWNERSHIP' AS code,'error' AS severity,f."adminId",'Booking form references a missing or foreign catalog service' AS reason
        FROM booking_form_service fs JOIN booking_form f ON f.id=fs."formId" LEFT JOIN service_catalog s ON s.id=fs."serviceCatalogId"
        WHERE (fs."serviceCatalogId" IS NOT NULL AND (s.id IS NULL OR s."adminId"<>f."adminId")) OR (fs.enabled AND fs."serviceCatalogId" IS NULL AND fs."serviceType" IS NULL)`,
      `SELECT 'INVALID_FORM_SERVICE_OWNERSHIP' AS code,'error' AS severity,f."adminId",'Estimate form references a missing or foreign catalog service' AS reason
        FROM estimate_form_service fs JOIN estimate_form f ON f.id=fs."formId" LEFT JOIN service_catalog s ON s.id=fs."serviceCatalogId"
        WHERE (fs."serviceCatalogId" IS NOT NULL AND (s.id IS NULL OR s."adminId"<>f."adminId")) OR (fs.enabled AND fs."serviceCatalogId" IS NULL AND fs."serviceType" IS NULL)`,
    ];
    for (let i=0;i<diagnosticSql.length;i++) {
      // Identifiers contain only this loop's numeric index, not user input.
      await db.query(`DECLARE audit_${i} NO SCROLL CURSOR FOR ${diagnosticSql[i]}`);
      while (true) {
        const page = await db.query(`FETCH FORWARD ${options.batchSize} FROM audit_${i}`);
        for (const row of page.rows) add(row as AuditIssue);
        if (page.rows.length < options.batchSize) break;
      }
      await db.query(`CLOSE audit_${i}`);
    }
    let cursor="";
    while (scanned<total) {
      const {rows} = await db.query(`SELECT w.*, a."onboardingCompletedSteps", a."onboardingCompletedAt",
          (SELECT COUNT(*)::int FROM service_catalog s WHERE s."adminId"=w."adminId" AND s.status='ACTIVE') AS "activeServices",
          (SELECT COALESCE(MAX(r."revisionNumber"),0)::int FROM website_revision r WHERE r."websiteId"=w.id) AS "maximumRevision",
          (SELECT COUNT(*)::int FROM website_revision r WHERE r."websiteId"=w.id) AS "revisionCount",
          EXISTS(SELECT 1 FROM website_revision r WHERE r."websiteId"=w.id AND r."revisionNumber"=w."publishedRevisionNumber") AS "publicationRevisionExists",
          (SELECT r.snapshot FROM website_revision r WHERE r."websiteId"=w.id AND r."revisionNumber"=w."publishedRevisionNumber") AS "publicationRevisionSnapshot",
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'kind',p.kind,'content',p.content,'socialImageUrl',p."socialImageUrl")) FROM website_page p WHERE p."websiteId"=w.id),'[]'::jsonb) AS pages
        FROM business_website w JOIN "AdminProfile" a ON a.id=w."adminId" WHERE w.id>$1 ORDER BY w.id LIMIT $2`, [cursor, options.batchSize]);
      if (!rows.length) throw new Error("Website scan ended before the snapshot inventory was exhausted");
      const refs=rows.map(auditReferencedValues);
      const urls=[...new Set(refs.flatMap(r=>r.urls))], forms=[...new Set(refs.flatMap(r=>r.formIds))], pages=[...new Set(refs.flatMap(r=>r.pageIds))];
      const assets = (await db.query('SELECT url,"websiteId","mimeType" FROM website_asset WHERE url=ANY($1::text[])',[urls])).rows;
      const formRows = (await db.query(`SELECT id,"adminId",published,'booking' AS kind FROM booking_form WHERE id=ANY($1::text[])
        UNION ALL SELECT id,"adminId",published,'estimate' AS kind FROM estimate_form WHERE id=ANY($1::text[])`,[forms])).rows;
      const pageOwners = (await db.query('SELECT id,"websiteId" FROM website_page WHERE id=ANY($1::text[])',[pages])).rows;
      for (const row of rows) for (const issue of inspectWebsiteForRelease({...row, assets,forms:formRows,pageOwners},view)) add(issue);
      scanned+=rows.length; cursor=rows[rows.length-1]!.id;
    }
    const migrations=(await db.query('SELECT migration_name,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 100')).rows;
    if (migrations.some(m=>!m.finished_at&&!m.rolled_back_at)) add({code:"UNFINISHED_MIGRATION",severity:"error",reason:"A database migration is unfinished; review deployment status"});
    await db.query("COMMIT");
    return { schemaVersion:1,mode:"read-only",source:"database-snapshot",startedAt,finishedAt:new Date().toISOString(),sourceRevision:process.env.RELEASE_GIT_SHA || process.env.GITHUB_SHA || null,complete:true,
      readOnly:true,isolation:session.isolation,websites:{total,scanned},summary:{errors,warnings,byCode:counts},samples,migrations,
      safeToProceed:errors===0,requiresReview:warnings>0,
      note:"No repairs performed. This report is database integrity evidence, not DNS/TLS, browser, performance or deployment evidence. Draft counters ahead of history are legitimate." };
  } catch (error) { await db.query("ROLLBACK").catch(()=>{}); throw error; }
}
