import "dotenv/config";
import { Client } from "pg";
import { mkdir, writeFile, rm, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { TemplateRegistry } from "../../modules/Website/templateRegistry";
import { WebsiteComponentRegistry } from "../../modules/Website/websiteComponentRegistry";
import { websiteDesignContractSchema } from "../../modules/Website/websiteDesignContract";
import { parsePublishedSnapshot, parseRevisionSnapshotAsPublished } from "../../modules/Website/websiteSnapshot";
import type { RegistryView } from "./websiteReleaseChecks";
import { readAuditOptions, reconcileWebsiteRelease } from "./websiteReleaseAudit";

const registry: RegistryView = {
  templates: TemplateRegistry.list(), components: WebsiteComponentRegistry.list(),
  parseSnapshot: value => parsePublishedSnapshot(value) ?? parseRevisionSnapshotAsPublished(value),
  validDesign: value => websiteDesignContractSchema.safeParse(value).success,
};


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let client: Client | undefined;
  (async () => {
    const options=readAuditOptions(process.argv.slice(2));
    await mkdir(dirname(options.output),{recursive:true});
    // Do not leave yesterday's successful report at today's output path.
    await rm(options.output,{force:true});
    const connectionString=process.env.RELEASE_AUDIT_DATABASE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("RELEASE_AUDIT_DATABASE_URL is required");
    // Prefer a SELECT-only database role. Never fall back to an admin profile
    // fixture when the connection or migrations are missing.
    client=new Client({connectionString,application_name:"website-phase6-readonly-audit",connectionTimeoutMillis:10000});
    await client.connect();
    const report=await reconcileWebsiteRelease(client,options,registry);
    const pending = `${options.output}.pending`;
    await writeFile(pending,JSON.stringify(report,null,2)+"\n",{mode:0o600});
    await rename(pending,options.output);
    console.log(`Website reconciliation: ${report.websites.scanned} websites; ${report.summary.errors} errors; ${report.summary.warnings} warnings. Report: ${options.output}`);
    if (options.ci && !report.safeToProceed) process.exitCode=2;
  })().catch(()=>{console.error("Read-only website reconciliation failed or configuration was rejected. Check database permissions/schema/timeouts. No success report or repair was produced.");process.exitCode=1;})
    .finally(async()=>{await client?.end();});
}
