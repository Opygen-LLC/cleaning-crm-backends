import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const service = read("src/modules/Auth/auth.service.ts");
const controller = read("src/modules/Auth/auth.controller.ts");
const route = read("src/modules/Auth/auth.route.ts");
const checks = [
  ["canonical /auth/session route exists", route.includes('"/session"') || route.includes("'/session'")],
  ["session snapshot remains one SQL statement", service.includes("const rows = await prisma.$queryRaw<SessionSnapshotRow[]>")],
  ["session query selects narrow display identity", service.includes("u.image") && service.includes('u."emailVerified"')],
  ["session response is non-cacheable", controller.includes('setHeader("Cache-Control", "private, no-store")')],
  ["session varies on cookie", controller.includes('vary("Cookie")')],
  ["login response is not routing authority", controller.includes("data: { sessionCreated: true }")],
  ["verify response is not routing authority", controller.includes("data: { verified: true }")],
];
for (const [name, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${name}`);
const failed = checks.filter(([, ok]) => !ok);
if (failed.length) process.exit(1);
console.log(`\nPhase 6 backend auth verification passed (${checks.length}/${checks.length}).`);
