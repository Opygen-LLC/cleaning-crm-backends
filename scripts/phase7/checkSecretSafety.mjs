import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const failures = [];
const tracked = (() => {
  try { return execFileSync("git", ["ls-files"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).filter(Boolean); }
  catch { return []; }
})();
for (const name of [".env", ".env.local", ".env.runtime", ".env.production"]) {
  if (tracked.includes(name)) failures.push(`${name} is tracked by git`);
}
const exampleFiles = [".env.example", ".env.production.example"].filter(existsSync);
const example = exampleFiles.map((file) => readFileSync(file, "utf8")).join("\n");
const suspicious = [
  [/^DATABASE_URL=(?!postgresql:\/\/user:password@)/m, "DATABASE_URL must be a placeholder"],
  [/^BETTER_AUTH_SECRET=(?!replace-)/m, "BETTER_AUTH_SECRET must be a placeholder"],
  [/^ACCESS_TOKEN_SECRET=(?!replace-)/m, "ACCESS_TOKEN_SECRET must be a placeholder"],
  [/^REFRESH_TOKEN_SECRET=(?!replace-)/m, "REFRESH_TOKEN_SECRET must be a placeholder"],
  [/^SMTP_PASSWORD=(?!replace-)/m, "SMTP_PASSWORD must be a placeholder"],
  [/^SUPER_ADMIN_PASSWORD=(?!replace-)/m, "SUPER_ADMIN_PASSWORD must be a placeholder"],
  [/^CLOUDINARY_API_SECRET=(?!replace-)/m, "CLOUDINARY_API_SECRET must be a placeholder"],
  [/^NEXT_REVALIDATE_SECRET=(?!replace-)/m, "NEXT_REVALIDATE_SECRET must be a placeholder"],
  [/^PERFORMANCE_METRICS_TOKEN=(?!replace-)/m, "PERFORMANCE_METRICS_TOKEN must be a placeholder"],
  [/^VERCEL_ACCESS_TOKEN=(?!replace-)/m, "VERCEL_ACCESS_TOKEN must be a placeholder"],
];
for (const [pattern, message] of suspicious) if (pattern.test(example)) failures.push(message);
if (!existsSync(".gitignore") || !readFileSync(".gitignore", "utf8").split(/\r?\n/).some((line) => line.trim() === ".env")) failures.push(".gitignore must ignore .env");
if (failures.length) { console.error("Phase 7 secret safety failed:\n" + failures.map((x) => ` - ${x}`).join("\n")); process.exit(1); }
console.log("Phase 7 secret safety: OK");
