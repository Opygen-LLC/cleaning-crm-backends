import { defineConfig } from "tsup";

export default defineConfig({
    entry: [
        "src/index.ts",
        "src/processes/worker.ts",
        "src/processes/scheduler.ts",
        "src/processes/bootstrap.ts",
        "src/scripts/backfillBusinessWebsites.ts",
        "src/scripts/migrateWebsiteRelease.ts",
        "src/scripts/phase2/reconcileAdminProvisioning.ts",
        "src/scripts/phase1/reconcilePublicationDelivery.ts",
    ],
    format: ["esm"],
    target: "esnext",
    outDir: "dist",
    clean: true,
    bundle: true,
    splitting: false,
    sourcemap: true,
    external: ["pg"],
    // Add this banner to shim require() for CJS dependencies
    banner: {
        js: `
			import { createRequire } from 'module';
			const require = createRequire(import.meta.url);
		`,
    },
});
