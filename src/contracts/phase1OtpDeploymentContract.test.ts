import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("Phase 1 OTP production deployment contract", () => {
  it("runs durable email delivery in a dedicated compose worker and keeps the API enqueue-only", () => {
    const compose = read("docker-compose.yml");

    expect(compose).toContain("container_name: cleaning_crm_worker");
    expect(compose).toContain('command: ["node", "dist/worker.js"]');
    expect(compose).toContain("PROCESS_ROLE: worker");
    expect(compose).toContain('test: ["CMD", "node", "dist/workerHealthcheck.js"]');

    const apiBlock = compose.slice(compose.indexOf("  api:"), compose.indexOf("  # Dedicated durable-outbox consumer"));
    expect(apiBlock).toContain('OUTBOX_WORKER_ENABLED: "false"');
    expect(apiBlock).toContain('OUTBOX_WORKER_REQUIRED: "true"');
    expect(apiBlock).toContain("condition: service_healthy");
  });

  it("ships the worker healthcheck entrypoint and correct STARTTLS example configuration", () => {
    const tsup = read("tsup.config.ts");
    const env = read(".env.example");

    expect(tsup).toContain('"src/processes/workerHealthcheck.ts"');
    expect(env).toContain("SMTP_PORT=587");
    expect(env).toContain("SMTP_SECURE=false");
    expect(env).toContain("SMTP_VERIFY_ON_STARTUP=true");
    expect(env).toContain("OUTBOX_WORKER_REQUIRED=true");
  });

  it("starts the existing scheduler in compose without inheriting the API HTTP healthcheck", () => {
    const compose = read("docker-compose.yml");
    const schedulerBlock = compose.slice(compose.indexOf("  scheduler:"), compose.indexOf("  # Explicit one-shot seed/bootstrap task"));

    expect(schedulerBlock).toContain('command: ["node", "dist/scheduler.js"]');
    expect(schedulerBlock).toContain("PROCESS_ROLE: scheduler");
    expect(schedulerBlock).toContain("disable: true");
  });
});
