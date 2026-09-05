import pg from "pg";

const { Client } = pg;
const args = new Set(process.argv.slice(2));
const shouldFix = args.has("--fix");
const ci = args.has("--ci");
const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error("Phase 8 audit requires DIRECT_URL or DATABASE_URL.");
  process.exit(2);
}

const SUPPORTED_TEMPLATES = ["clean-modern", "premium-home", "commercial-pro", "local-cleaning"];
const DEFAULT_DESIGN = {
  schemaVersion: 1,
  componentOverrides: {},
  componentAnimations: {},
  sectionStyles: {},
  animationsEnabled: true,
};

const client = new Client({ connectionString });

const normalizeTopLevelDesign = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_DESIGN };
  return {
    ...DEFAULT_DESIGN,
    ...value,
    componentOverrides: value.componentOverrides && typeof value.componentOverrides === "object" && !Array.isArray(value.componentOverrides) ? value.componentOverrides : {},
    componentAnimations: value.componentAnimations && typeof value.componentAnimations === "object" && !Array.isArray(value.componentAnimations) ? value.componentAnimations : {},
    sectionStyles: value.sectionStyles && typeof value.sectionStyles === "object" && !Array.isArray(value.sectionStyles) ? value.sectionStyles : {},
    animationsEnabled: typeof value.animationsEnabled === "boolean" ? value.animationsEnabled : true,
    schemaVersion: value.schemaVersion === 1 ? 1 : 1,
  };
};

const audit = async () => {
  const websites = await client.query(`
    SELECT id, "adminId", subdomain, status::text AS status, "templateId", "templateVersion",
           "websiteDesign", "publishedSnapshot", "draftRevisionNumber", "publishedRevisionNumber"
    FROM "business_website"
    ORDER BY "createdAt" ASC
  `);
  const legacySteps = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM "AdminProfile"
    WHERE 'template' = ANY("onboardingCompletedSteps")
  `);
  const missingRevisionOne = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM "business_website" w
    WHERE NOT EXISTS (
      SELECT 1 FROM "website_revision" r
      WHERE r."websiteId" = w.id AND r."revisionNumber" = 1
    )
  `);

  const issues = [];
  const templateCounts = Object.fromEntries(SUPPORTED_TEMPLATES.map((id) => [id, 0]));
  for (const website of websites.rows) {
    if (!(website.templateId in templateCounts)) {
      issues.push({ code: "UNSUPPORTED_TEMPLATE", websiteId: website.id, value: `${website.templateId}@${website.templateVersion}` });
    } else {
      templateCounts[website.templateId] += 1;
    }

    const rawDesign = website.websiteDesign;
    const isObject = rawDesign && typeof rawDesign === "object" && !Array.isArray(rawDesign);
    const hasValidShape = isObject
      && rawDesign.schemaVersion === 1
      && rawDesign.componentOverrides && typeof rawDesign.componentOverrides === "object" && !Array.isArray(rawDesign.componentOverrides)
      && rawDesign.componentAnimations && typeof rawDesign.componentAnimations === "object" && !Array.isArray(rawDesign.componentAnimations)
      && rawDesign.sectionStyles && typeof rawDesign.sectionStyles === "object" && !Array.isArray(rawDesign.sectionStyles)
      && typeof rawDesign.animationsEnabled === "boolean";
    if (!hasValidShape) {
      issues.push({ code: "WEBSITE_DESIGN_INVALID_SHAPE", websiteId: website.id });
    } else {
      const normalized = normalizeTopLevelDesign(rawDesign);
      if (JSON.stringify(normalized) !== JSON.stringify(rawDesign)) {
        issues.push({ code: "WEBSITE_DESIGN_NEEDS_NORMALIZATION", websiteId: website.id });
      }
    }

    if (website.status === "PUBLISHED") {
      const snapshot = website.publishedSnapshot;
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !snapshot.website || !Array.isArray(snapshot.pages)) {
        issues.push({ code: "PUBLISHED_SNAPSHOT_MISSING_OR_INVALID", websiteId: website.id });
      }
    }
  }

  const legacyOnboardingCount = Number(legacySteps.rows[0]?.count ?? 0);
  const missingRevisionOneCount = Number(missingRevisionOne.rows[0]?.count ?? 0);
  if (legacyOnboardingCount) issues.push({ code: "LEGACY_TEMPLATE_ONBOARDING_STEPS", count: legacyOnboardingCount });
  if (missingRevisionOneCount) issues.push({ code: "MISSING_REVISION_ONE", count: missingRevisionOneCount });

  return {
    totalWebsites: websites.rowCount ?? websites.rows.length,
    templateCounts,
    legacyOnboardingCount,
    missingRevisionOneCount,
    issues,
  };
};

try {
  await client.connect();

  if (shouldFix) {
    await client.query("BEGIN");
    await client.query(`
      UPDATE "business_website"
      SET "websiteDesign" =
        '{"schemaVersion":1,"componentOverrides":{},"componentAnimations":{},"sectionStyles":{},"animationsEnabled":true}'::jsonb ||
        CASE WHEN jsonb_typeof("websiteDesign") = 'object' THEN "websiteDesign" ELSE '{}'::jsonb END
      WHERE "websiteDesign" IS NULL
         OR jsonb_typeof("websiteDesign") <> 'object'
         OR NOT ("websiteDesign" ? 'schemaVersion')
         OR NOT ("websiteDesign" ? 'componentOverrides')
         OR NOT ("websiteDesign" ? 'componentAnimations')
         OR NOT ("websiteDesign" ? 'sectionStyles')
         OR NOT ("websiteDesign" ? 'animationsEnabled')
    `);
    await client.query(`
      UPDATE "AdminProfile"
      SET "onboardingCompletedSteps" = array_replace("onboardingCompletedSteps", 'template', 'review_launch')
      WHERE 'template' = ANY("onboardingCompletedSteps")
    `);
    await client.query("COMMIT");
    console.log("Applied only Phase 8 safe compatibility repairs.");
  }

  const report = await audit();
  console.log(JSON.stringify(report, null, 2));

  const critical = report.issues.filter((issue) => !["WEBSITE_DESIGN_NEEDS_NORMALIZATION"].includes(issue.code));
  if (ci && critical.length) process.exitCode = 1;
} catch (error) {
  try { await client.query("ROLLBACK"); } catch {}
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
