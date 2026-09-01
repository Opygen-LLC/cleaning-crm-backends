#!/usr/bin/env node
/**
 * Release-parity smoke for routes that must exist in every deployed API/BFF.
 *
 * The staff probe is intentionally unauthenticated and body-less. Any normal
 * auth/subscription/validation response proves the router exists; HTTP 404
 * proves the running release (or the BFF upstream) does not match the source.
 */
const apiBase = (process.env.ROUTE_SMOKE_API_URL || "").replace(/\/+$/, "");
const frontendBase = (process.env.ROUTE_SMOKE_FRONTEND_URL || "").replace(/\/+$/, "");
const expectedRelease = (process.env.ROUTE_SMOKE_EXPECT_RELEASE_SHA || "").trim();

if (!apiBase) {
  console.error("ROUTE_SMOKE_API_URL is required (for example https://api.example.com/api/v1)");
  process.exit(2);
}

const probeStaff = async (url, label) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: "{}",
    redirect: "manual",
    cache: "no-store",
  });

  if (response.status === 404) {
    throw new Error(`${label} returned 404; deployed route surface is stale or misrouted`);
  }
  if (response.status >= 500) {
    throw new Error(`${label} returned ${response.status}; route exists but deployment is unhealthy`);
  }

  const releaseSha = response.headers.get("x-release-sha") || "";
  if (expectedRelease && releaseSha && releaseSha !== expectedRelease) {
    throw new Error(`${label} release mismatch: expected ${expectedRelease}, got ${releaseSha}`);
  }

  console.log(`[route-surface] ${label}: ${response.status}${releaseSha ? ` release=${releaseSha}` : ""}`);
  return releaseSha;
};

try {
  const directRelease = await probeStaff(`${apiBase}/staff`, "direct POST /api/v1/staff");
  if (frontendBase) {
    const bffRelease = await probeStaff(`${frontendBase}/backend-api/staff`, "BFF POST /backend-api/staff");
    if (directRelease && bffRelease && directRelease !== bffRelease) {
      throw new Error(`BFF backend release mismatch: direct=${directRelease}, bff=${bffRelease}`);
    }
  }
  console.log("Route surface smoke: OK");
} catch (error) {
  console.error(`Route surface smoke FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
