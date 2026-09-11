import { spawnSync } from "node:child_process";

const checks = [
  ["secret placeholders", ["node", "scripts/phase7/checkSecretSafety.mjs"]],
  ["repository hygiene", ["node", "scripts/checkRepositoryHygiene.mjs"]],
  ["production cleanup", ["node", "scripts/checkProductionCleanup.mjs"]],
  ["Cleaning CRM Phase 4 contracts", ["node", "--test", "tests/production/phase4-cleaning-crm-production.test.cjs"]],
  ["Phase 1-3 focused regressions", ["node", "--test", "tests/reviews/phase1-review-link-contract.test.cjs", "tests/subscription/phase2-saas-trial-contract.test.cjs", "tests/services/phase3-service-catalog-contract.test.cjs"]],
  ["reliability source gate", ["node", "scripts/verifyReliability.mjs"]],
  ["Phase 3 runtime source gate", ["node", "scripts/verifyPhase3Runtime.mjs"]],
  ["existing Phase 4 production gate", ["node", "scripts/phase4/verifyProductionGate.mjs"]],
  ["existing Phase 5 production gate", ["node", "scripts/phase5/verifyProductionGate.mjs"]],
  ["Phase 8 rollout source gate", ["node", "scripts/phase8/verifyProductionRollout.mjs"]],
  ["Phase 8 rollout contract", ["node", "--test", "tests/security/phase8ProductionRolloutContract.test.mjs"]],
  ["existing security source gate", ["node", "scripts/verifyPhase5Security.mjs"]],
  ["existing observability source gate", ["node", "scripts/verifyPhase6Observability.mjs"]],
  ["existing auth source gate", ["node", "scripts/verifyAuthPhase6.mjs"]],
  ["R2 regressions", ["node", "--test", "tests/r2/phase2-r2-migration.test.mjs", "tests/r2/phase3-r2-hardening.test.mjs"]],
];

for (const [label, command] of checks) {
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit", shell: false });
  if (result.status !== 0) {
    console.error(`[phase4-cleaning-crm] ${label} failed`);
    process.exit(result.status ?? 1);
  }
}
console.log("[phase4-cleaning-crm] dependency-free production readiness checks passed");
