#!/usr/bin/env node
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const required = [
  "generate",
  "typecheck",
  "test:phase4:super-admin",
  "data:audit:super-admin:ci",
  "build",
  "release:phase4",
];
for (const name of required) {
  if (!pkg.scripts?.[name]) throw new Error(`Missing required Phase 4 gate script: ${name}`);
}
const release = pkg.scripts["release:phase4"];
for (const needle of ["prisma validate", "typecheck", "test:phase4:super-admin", "data:audit:super-admin:ci", "build"]) {
  if (!release.includes(needle)) throw new Error(`release:phase4 is missing ${needle}`);
}
console.log("Phase 4 backend production gate contract OK");
