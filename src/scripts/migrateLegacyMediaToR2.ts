import "dotenv/config";
import { assertRuntimeEnvironment } from "../config/runtimeEnv";
import { runLegacyMediaMigration } from "../modules/Media/legacyMediaMigration.service";

const args = new Set(process.argv.slice(2));
const valueArg = (name: string) => process.argv.slice(2).find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);

const main = async () => {
  assertRuntimeEnvironment();
  const report = await runLegacyMediaMigration({
    dryRun: args.has("--dry-run"),
    verifyOnly: args.has("--verify-only"),
    adminId: valueArg("--admin-id"),
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.mode !== "dry-run" && (report.remainingLegacyReferences > 0 || report.r2VerificationFailures > 0)) process.exitCode = 2;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
