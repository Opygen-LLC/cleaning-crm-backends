const url = process.env.MONITORING_ALERTS_URL || `${(process.env.API_URL || "http://127.0.0.1:5000").replace(/\/$/, "")}/health/alerts`;
const token = process.env.PERFORMANCE_METRICS_TOKEN;
if (!token) throw new Error("PERFORMANCE_METRICS_TOKEN is required");
const response = await fetch(url, { headers: { "x-monitoring-token": token, accept: "application/json" } });
const body = await response.json().catch(() => ({}));
console.log(JSON.stringify(body, null, 2));
if (!response.ok || body?.data?.healthy === false) process.exit(44);
