import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        index: "src/index.ts",
        worker: "src/processes/worker.ts",
        workerHealthcheck: "src/processes/workerHealthcheck.ts",
        scheduler: "src/processes/scheduler.ts",
        bootstrap: "src/processes/bootstrap.ts",
        backfillBusinessWebsites: "src/scripts/backfillBusinessWebsites.ts",
        migrateWebsiteRelease: "src/scripts/migrateWebsiteRelease.ts",
        reconcileAdminProvisioning: "src/scripts/phase2/reconcileAdminProvisioning.ts",
        reconcilePublicationDelivery: "src/scripts/phase1/reconcilePublicationDelivery.ts",
        websitePreflight: "src/scripts/performance/websitePreflight.ts",
    },
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
