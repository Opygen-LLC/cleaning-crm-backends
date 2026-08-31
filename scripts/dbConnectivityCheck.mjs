import dns from "node:dns/promises";
import pg from "pg";

const raw = process.env.DATABASE_URL?.trim();
if (!raw) {
  console.error("DATABASE_URL is not set in the current process environment.");
  process.exit(2);
}

let parsed;
try {
  parsed = new URL(raw);
} catch {
  console.error("DATABASE_URL is not a valid PostgreSQL URL.");
  process.exit(2);
}

const host = parsed.hostname;
const port = Number(parsed.port || 5432);
const database = parsed.pathname.replace(/^\//, "") || "<default>";
const sslMode = parsed.searchParams.get("sslmode") || "<not-set>";
const timeoutMs = Math.min(30_000, Math.max(1_000, Number(process.env.DB_POOL_CONNECTION_TIMEOUT_MS) || 8_000));

console.log(`Database target: host=${host} port=${port} database=${database} sslmode=${sslMode}`);
console.log(`Connection timeout: ${timeoutMs}ms`);

try {
  const addresses = await dns.lookup(host, { all: true });
  console.log(`DNS: ${addresses.map(({ address, family }) => `${address} (IPv${family})`).join(", ")}`);
} catch (error) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "DNS_ERROR";
  console.error(`DNS lookup failed: ${code}`);
  console.error("Check the database hostname in DATABASE_URL and the VM DNS configuration.");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: raw,
  max: 1,
  idleTimeoutMillis: 1_000,
  connectionTimeoutMillis: timeoutMs,
  keepAlive: true,
});

try {
  const started = process.hrtime.bigint();
  await pool.query("SELECT 1 AS ok");
  const latencyMs = Math.round((Number(process.hrtime.bigint() - started) / 1_000_000) * 10) / 10;
  console.log(`PostgreSQL connectivity: OK (${latencyMs}ms)`);
} catch (error) {
  const record = error && typeof error === "object" ? error : {};
  const code = typeof record.code === "string" ? record.code.toUpperCase() : "DATABASE_CONNECTION_FAILED";
  console.error(`PostgreSQL connectivity: FAILED (${code})`);

  if (["ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) {
    console.error("Action: allow the backend VM/VPC in the database firewall/IP allowlist and verify routing to this host/port.");
  } else if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) {
    console.error("Action: correct the database hostname/DNS configuration.");
  } else if (code === "ECONNREFUSED") {
    console.error("Action: verify PostgreSQL is running and DATABASE_URL uses the provider's correct PostgreSQL or pooler port.");
  } else if (code === "28P01") {
    console.error("Action: rotate/correct the PostgreSQL username or password in the runtime secret.");
  } else if (code === "3D000") {
    console.error("Action: correct the database name in DATABASE_URL.");
  } else if (code.startsWith("08") || ["57P01", "57P02", "57P03", "53300"].includes(code)) {
    console.error("Action: check database availability, connection limits, provider status and network policy.");
  } else {
    console.error("Action: inspect the database provider logs/status and verify DATABASE_URL, TLS mode and network policy.");
  }

  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
