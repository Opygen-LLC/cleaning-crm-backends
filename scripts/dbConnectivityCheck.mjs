import dns from "node:dns/promises";
import net from "node:net";
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
const timeoutMs = Math.min(
  30_000,
  Math.max(1_000, Number(process.env.DB_POOL_CONNECTION_TIMEOUT_MS) || 10_000),
);

console.log(`Database target: host=${host} port=${port} database=${database} sslmode=${sslMode}`);
console.log(`Connection timeout: ${timeoutMs}ms`);
console.log(`Neon endpoint mode: ${host.includes("-pooler.") ? "pooled" : "direct"}`);

try {
  const addresses = await dns.lookup(host, { all: true });
  console.log(`DNS: ${addresses.map(({ address, family }) => `${address} (IPv${family})`).join(", ")}`);
} catch (error) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "DNS_ERROR";
  console.error(`DNS lookup failed: ${code}`);
  console.error("Action: verify the Neon hostname and the VM DNS configuration.");
  process.exit(1);
}

try {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      const error = new Error("TCP connection timed out");
      error.code = "ETIMEDOUT";
      reject(error);
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  console.log(`TCP ${host}:${port}: OK`);
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code).toUpperCase() : "TCP_FAILED";
  console.error(`TCP ${host}:${port}: FAILED (${code})`);
  console.error("Action: fix GCP outbound routing/firewall/Cloud NAT or Neon's IP Allow before changing Prisma code.");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: raw,
  max: 1,
  min: 0,
  idleTimeoutMillis: 1_000,
  connectionTimeoutMillis: timeoutMs,
  keepAlive: true,
});

try {
  const started = process.hrtime.bigint();
  const result = await pool.query("SELECT 1 AS ok, current_database() AS database");
  const latencyMs = Math.round((Number(process.hrtime.bigint() - started) / 1_000_000) * 10) / 10;
  console.log(`PostgreSQL connectivity: OK (${latencyMs}ms, database=${result.rows[0]?.database ?? database})`);
} catch (error) {
  const record = error && typeof error === "object" ? error : {};
  const code = typeof record.code === "string" ? record.code.toUpperCase() : "DATABASE_CONNECTION_FAILED";
  console.error(`PostgreSQL connectivity: FAILED (${code})`);

  if (["ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) {
    console.error("Action: allow the GCP VM/NAT egress IP in Neon IP Allow and verify routing to port 5432.");
  } else if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) {
    console.error("Action: correct the Neon hostname/DNS configuration.");
  } else if (code === "ECONNREFUSED") {
    console.error("Action: verify the Neon endpoint/port and provider status.");
  } else if (code === "28P01") {
    console.error("Action: rotate/correct the Neon username or password in .env.runtime / Secret Manager.");
  } else if (code === "3D000") {
    console.error("Action: correct the database name in DATABASE_URL.");
  } else if (code === "53300") {
    console.error("Action: use the Neon pooled endpoint for DATABASE_URL and lower DB_POOL_MAX.");
  } else if (code.startsWith("08") || ["57P01", "57P02", "57P03"].includes(code)) {
    console.error("Action: check Neon availability and network policy.");
  } else {
    console.error("Action: inspect Neon logs/status and verify DATABASE_URL, TLS mode and credentials.");
  }

  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
