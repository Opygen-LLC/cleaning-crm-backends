import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([".git", "node_modules", "dist", "src/generated", ".next", "coverage", "release-artifacts"]);
const forbiddenNamePatterns = [
  / copy\.(?:ts|tsx|js|jsx)$/i,
  /\.(?:bak|old|orig|backup)$/i,
  /~$/,
];
const violations = [];

const isIgnored = (path) => {
  const rel = relative(root, path).replaceAll("\\\\", "/");
  return [...ignoredDirectories].some((entry) => rel === entry || rel.startsWith(`${entry}/`));
};

const walk = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (isIgnored(full)) continue;
    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    if (forbiddenNamePatterns.some((pattern) => pattern.test(entry.name))) {
      violations.push(`forbidden backup/copy file: ${relative(root, full)}`);
    }
  }
};

await walk(root);

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
  if (typeof command === "string" && /prisma\s+db\s+push/i.test(command)) {
    violations.push(`package script '${name}' invokes prisma db push`);
  }
}

if (violations.length) {
  console.error("Repository hygiene check failed:\n" + violations.map((v) => ` - ${v}`).join("\n"));
  process.exit(1);
}

console.log("Repository hygiene check passed.");
