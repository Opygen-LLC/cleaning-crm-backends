console.error([
  "ERROR: prisma db push is disabled for this production application.",
  "Create/review a Prisma migration in development and deploy it with `pnpm db:migrate:deploy`.",
  "Phase 2 intentionally makes migration history the only production schema authority.",
].join("\n"));
process.exit(1);
