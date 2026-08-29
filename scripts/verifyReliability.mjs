import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const fail = (message) => { console.error(`[reliability] ${message}`); process.exitCode = 1; };
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(full) : [full];
});

for (const file of walk(path.join(root, "src"))) {
  if (!/\.ts$/.test(file)) continue;
  const source = fs.readFileSync(file, "utf8");
  if (/\$queryRawUnsafe|\$executeRawUnsafe/.test(source)) {
    fail(`unsafe raw SQL helper remains: ${path.relative(root, file)}`);
  }
}

for (const entrypoint of ["src/index.ts", "src/processes/worker.ts", "src/processes/scheduler.ts", "src/processes/bootstrap.ts"]) {
  const source = read(entrypoint);
  if (!source.includes("assertRuntimeEnvironment")) fail(`${entrypoint} does not run production environment validation`);
}

const booking = read("src/modules/Booking/booking.service.ts");
if (/sendBookingEmail\([^;]+\.catch\(\(\)\s*=>\s*\{?\}?\)/s.test(booking)) {
  fail("booking email failures are still swallowed");
}
if (!booking.includes("observeBackgroundTask")) fail("booking non-critical tasks are not observable");

for (const required of ["src/config/runtimeEnv.ts", "src/scripts/phase4/reconcileData.ts", "src/lib/monitoring/observeBackgroundTask.ts"]) {
  if (!fs.existsSync(path.join(root, required))) fail(`missing required Phase 4 file: ${required}`);
}

if (!process.exitCode) console.log("[reliability] PASS");
