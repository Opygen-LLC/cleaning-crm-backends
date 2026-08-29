import fs from "node:fs";

const [currentFile, baselineFile] = process.argv.slice(2);
if (!currentFile) throw new Error("usage: node evaluateReleaseGate.mjs <current.json> [baseline.json]");

const read = (file) => file && fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, "utf8")).map((row) => row.jsonPayload || {}).filter(Boolean)
  : [];
const pct = (n, d) => d ? n / d : 0;
const percentile = (rows, p) => {
  const values = rows.map((row) => Number(row.totalDurationMs)).filter(Number.isFinite).sort((a, b) => a - b);
  return values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] : 0;
};

const reliabilityCounts = (payloads) => {
  const counts = {
    onboardingRenderErrors: 0,
    chunkLoadErrors: 0,
    contractMismatches: 0,
    onboardingTransactionFailures: 0,
    websitePreviewFailures: 0,
    authRefreshLoops: 0,
  };

  for (const payload of payloads) {
    if (payload.event === "product_reliability_signal") {
      const signal = String(payload.signal || "");
      if (signal === "ONBOARDING_TRANSACTION_FAILURE") counts.onboardingTransactionFailures += 1;
      if (signal === "WEBSITE_PREVIEW_FAILURE") counts.websitePreviewFailures += 1;
      if (signal === "AUTH_REFRESH_LOOP") counts.authRefreshLoops += 1;
    }
    if (payload.event !== "dashboard_client_error") continue;
    const section = String(payload.section || "");
    const errorKind = String(payload.errorKind || "");
    const message = String(payload.errorMessage || "");
    if (section === "active-step" || section === "preview") counts.onboardingRenderErrors += 1;
    if (errorKind === "chunk-load") counts.chunkLoadErrors += 1;
    if (/BOOTSTRAP_SCHEMA_MISMATCH|SERVICE(?:_CATALOG)?_SCHEMA_MISMATCH|WEBSITE_BOOKING_SETUP_SCHEMA_MISMATCH|BOOKING_SETUP_SCHEMA_MISMATCH/i.test(message)) {
      counts.contractMismatches += 1;
    }
    if (section === "auth-refresh-loop") counts.authRefreshLoops += 1;
  }
  return counts;
};

const summarize = (payloads) => {
  const http = payloads.filter((payload) => payload.event === "http_request" && Number.isFinite(Number(payload.totalDurationMs)));
  const auth = http.filter((payload) => String(payload.route || "").includes("/auth/"));
  const codes = (code) => auth.filter((payload) => payload.authErrorCode === code).length;
  return {
    http,
    p95: percentile(http, 0.95),
    error5xx: pct(http.filter((payload) => Number(payload.statusCode) >= 500).length, http.length),
    badGateway: pct(http.filter((payload) => [502, 503].includes(Number(payload.statusCode))).length, http.length),
    auth401: pct(auth.filter((payload) => Number(payload.statusCode) === 401).length, auth.length),
    redisErrors: http.reduce((total, payload) => total + Number(payload.redisErrors || 0), 0),
    refreshFailures: auth.filter((payload) => String(payload.route || "").includes("/auth/refresh-token") && Number(payload.statusCode) >= 400).length,
    otpFailures: auth.filter((payload) => /\/auth\/(verify|verify-email|resend)/.test(String(payload.route || "")) && Number(payload.statusCode) >= 400).length,
    verificationSessionFailed: codes("AUTH_VERIFICATION_SESSION_FAILED"),
    accessTokenMissing: codes("ACCESS_TOKEN_MISSING"),
    reliability: reliabilityCounts(payloads),
  };
};

const current = summarize(read(currentFile));
const baseline = summarize(read(baselineFile));
const minimum = Number(process.env.MIN_RELEASE_REQUESTS || 50);
if (current.http.length < minimum) throw new Error(`insufficient canary samples: ${current.http.length}/${minimum}`);

const failures = [];
if (current.p95 > Number(process.env.MAX_P95_MS || 750)) failures.push(`p95 ${current.p95}ms`);
if (current.error5xx > Number(process.env.MAX_5XX_RATE || 0.02)) failures.push(`5xx ${(current.error5xx * 100).toFixed(2)}%`);
if (current.badGateway > Number(process.env.MAX_502_503_RATE || 0.01)) failures.push(`502/503 ${(current.badGateway * 100).toFixed(2)}%`);
if (current.auth401 > Number(process.env.MAX_AUTH_401_RATE || 0.08)) failures.push(`auth 401 ${(current.auth401 * 100).toFixed(2)}%`);
if (current.redisErrors > Number(process.env.MAX_REDIS_ERRORS || 0)) failures.push(`redis errors ${current.redisErrors}`);
if (current.verificationSessionFailed > 0) failures.push(`AUTH_VERIFICATION_SESSION_FAILED ${current.verificationSessionFailed}`);
if (current.accessTokenMissing > Number(process.env.MAX_ACCESS_TOKEN_MISSING || 2)) failures.push(`ACCESS_TOKEN_MISSING ${current.accessTokenMissing}`);
if (current.refreshFailures > Number(process.env.MAX_REFRESH_FAILURES || 2)) failures.push(`refresh failures ${current.refreshFailures}`);
if (baseline.http.length >= minimum && current.p95 > baseline.p95 * (1 + Number(process.env.MAX_P95_REGRESSION_RATIO || 0.25))) {
  failures.push(`p95 regression ${baseline.p95}->${current.p95}ms`);
}

const r = current.reliability;
if (r.onboardingRenderErrors > Number(process.env.MAX_ONBOARDING_RENDER_ERRORS || 0)) failures.push(`onboarding render errors ${r.onboardingRenderErrors}`);
if (r.chunkLoadErrors > Number(process.env.MAX_CHUNK_LOAD_ERRORS || 0)) failures.push(`chunk load errors ${r.chunkLoadErrors}`);
if (r.contractMismatches > Number(process.env.MAX_CONTRACT_MISMATCHES || 0)) failures.push(`contract mismatches ${r.contractMismatches}`);
if (r.onboardingTransactionFailures > Number(process.env.MAX_ONBOARDING_TRANSACTION_FAILURES || 0)) failures.push(`onboarding transaction failures ${r.onboardingTransactionFailures}`);
if (r.websitePreviewFailures > Number(process.env.MAX_WEBSITE_PREVIEW_FAILURES || 0)) failures.push(`website preview failures ${r.websitePreviewFailures}`);
if (r.authRefreshLoops > Number(process.env.MAX_AUTH_REFRESH_LOOPS || 0)) failures.push(`auth refresh loops ${r.authRefreshLoops}`);

console.log(JSON.stringify({
  current: {
    requests: current.http.length,
    p95: current.p95,
    error5xx: current.error5xx,
    badGateway: current.badGateway,
    auth401: current.auth401,
    redisErrors: current.redisErrors,
    refreshFailures: current.refreshFailures,
    otpFailures: current.otpFailures,
    verificationSessionFailed: current.verificationSessionFailed,
    accessTokenMissing: current.accessTokenMissing,
    reliability: current.reliability,
  },
  baseline: { requests: baseline.http.length, p95: baseline.p95, error5xx: baseline.error5xx },
  failures,
}, null, 2));
if (failures.length) process.exit(42);
