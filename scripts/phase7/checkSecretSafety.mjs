import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const failures = [];
const tracked = (() => {
  try {
    return execFileSync("git", ["ls-files"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return [];
  }
})();

for (const name of [".env", ".env.local", ".env.runtime", ".env.production"]) {
  if (tracked.includes(name)) failures.push(`${name} is tracked by git`);
}

const exampleFiles = [".env.example", ".env.production.example"].filter(existsSync);
const example = exampleFiles.map((file) => readFileSync(file, "utf8")).join("\n");
const assignment = (key, placeholder) => [
  new RegExp(`^(?:#\\s*)?${key}=(?!${placeholder})`, "m"),
  `${key} must be a placeholder`,
];
const suspicious = [
  assignment("DATABASE_URL", "postgresql:\\/\\/user:password@"),
  assignment("DIRECT_URL", "postgresql:\\/\\/user:password@"),
  assignment("REDIS_PASSWORD", "replace-"),
  assignment("BETTER_AUTH_SECRET", "replace-"),
  assignment("ACCESS_TOKEN_SECRET", "replace-"),
  assignment("REFRESH_TOKEN_SECRET", "replace-"),
  assignment("SMTP_PASSWORD", "replace-"),
  assignment("SUPER_ADMIN_PASSWORD", "replace-"),
  assignment("R2_ACCESS_KEY_ID", "replace-"),
  assignment("R2_SECRET_ACCESS_KEY", "replace-"),
  assignment("R2_API_TOKEN", "replace-"),
  assignment("NEXT_REVALIDATE_SECRET", "replace-"),
  assignment("PERFORMANCE_METRICS_TOKEN", "replace-"),
  assignment("GOOGLE_ANALYTICS_OAUTH_CLIENT_SECRET", "replace-"),
  assignment("GOOGLE_ANALYTICS_TOKEN_ENCRYPTION_KEY", "replace-"),
  assignment("GOOGLE_ANALYTICS_OAUTH_STATE_SECRET", "replace-"),
  assignment("VERCEL_ACCESS_TOKEN", "replace-"),
];
for (const [pattern, message] of suspicious) {
  if (pattern.test(example)) failures.push(message);
}

const gitignore = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8") : "";
if (!gitignore.split(/\r?\n/).some((line) => line.trim() === ".env")) {
  failures.push(".gitignore must ignore .env");
}
if (gitignore.split(/\r?\n/).some((line) => line.trim() === ".env.example") &&
    !gitignore.split(/\r?\n/).some((line) => line.trim() === "!.env.example")) {
  failures.push(".env.example must be allowed to remain as sanitized documentation");
}

if (failures.length) {
  console.error("Phase 7 secret safety failed:\n" + failures.map((x) => ` - ${x}`).join("\n"));
  process.exit(1);
}
console.log("Phase 7 secret safety: OK");
