# Cleaning CRM — Google Cloud observability runbook

Phase 6 uses the existing application logging, timing, Redis, Prisma and error-monitoring infrastructure. It does **not** introduce a second telemetry stack.

## Production signal flow

```text
Browser
  │ X-Trace-Id
  ▼
api.opygen.com
  ├─ auth / subscription gates
  ├─ Prisma
  ├─ Redis + response cache
  ├─ queue/outbox
  └─ external providers
        │
        └─ trace metadata → worker → SMTP / cache revalidation
```

Each completed API request emits one structured `http_request` JSON event to stdout. On Google Compute Engine, collect container stdout/stderr into **Cloud Logging** using the Google Cloud Ops Agent or another approved container-log collector. Keep `LOG_LEVEL=info` for the request distribution stream.

The event contract includes:

- `route`, `method`, `statusCode`
- `totalDurationMs`
- `dbDurationMs`, `dbQueryCount`
- `redisDurationMs`, `redisCommandCount`, `redisHits`, `redisMisses`, `redisErrors`, `redisHitRate`
- `responseCacheHits`, `responseCacheMisses`, `responseCacheHitRate`
- `authDurationMs`, `queueDurationMs`, `externalDurationMs`
- `requestId`, `traceId`
- privacy-preserving `userHash` and `tenantHash`
- `releaseSha`, `processRole`

Raw user IDs, tenant IDs, form values, addresses and credentials must not be added to request telemetry.

## Google Cloud dashboards

Create log-based distribution metrics from `jsonPayload.event="http_request"` using these value fields:

- latency: `jsonPayload.totalDurationMs`
- DB time: `jsonPayload.dbDurationMs`
- Redis time: `jsonPayload.redisDurationMs`
- auth time: `jsonPayload.authDurationMs`

Group/filter by `jsonPayload.route`, `jsonPayload.method`, `jsonPayload.statusCode`, `jsonPayload.releaseSha` and `jsonPayload.processRole`.

For the API SLO dashboard, chart **p50**, **p95** and **p99**, not only averages. Suggested first targets:

```text
/admin/bootstrap
p50 < 30 ms
p95 < 80 ms
p99 < 150 ms
5xx error rate < 0.1%
```

Add a 5xx-rate metric from `statusCode >= 500` and cache-hit metrics from `responseCacheHitRate` / `redisHitRate`.

The protected `/health/performance` endpoint also exposes an in-process rolling p50/p95/p99 snapshot useful for smoke tests and single-instance debugging. Cloud Logging is the fleet-wide source of truth across multiple API replicas.

## Trace correlation

The frontend creates a 128-bit trace id and sends `X-Trace-Id` on API requests. The API also accepts a valid W3C `traceparent` trace id and returns `X-Trace-Id` plus `X-Request-Id`.

Search Cloud Logging by either identifier:

```text
jsonPayload.traceId="<trace-id>"
jsonPayload.requestId="<request-id>"
```

Durable outbox payloads propagate the same `traceId` and `requestId` to worker execution so email/cache-revalidation failures can be connected to the originating request. Client-render exceptions include the preceding API trace/request id when available.

## Error capture

The frontend uses the internal sanitized client-error reporter as the Sentry-equivalent transport. It sends only diagnostic fields (route, section, stack/digest, browser, release version and correlation ids) to authenticated `/api/v1/telemetry/client-errors`; the server derives user/tenant hashes from the session. The endpoint is rate-limited and is outside the subscription gate so an expired tenant can still report a dashboard failure.

Set the existing `ERROR_MONITOR_WEBHOOK_URL` if you want the same sanitized event delivered to an external incident/error platform. Cloud Logging always receives structured `dashboard_client_error` and server-side error events when they are recorded.

## Health endpoint exposure

Public/load-balancer probes:

- `GET /livez` — process alive; no dependency metadata.
- `GET /readyz` — minimal ready/degraded/not-ready state; no provider/region/pool details.
- `GET /health` — minimal status only.

Detailed diagnostics are intentionally hidden in production unless the caller presents `PERFORMANCE_METRICS_TOKEN` via `X-Monitoring-Token` or Bearer authentication:

- `GET /health/details`
- `GET /health/performance`
- `GET /health/website-routing`

Unauthenticated requests receive 404 so detailed operational endpoints are not advertised publicly. Store `PERFORMANCE_METRICS_TOKEN` in Google Secret Manager.

## Google Compute Engine alerts

At minimum configure Cloud Monitoring alert policies for:

1. API p95 latency > 80 ms for 5 minutes on hot simple routes.
2. API p99 latency > 150 ms for 5 minutes.
3. 5xx rate >= 1% for 5 minutes or a sharp release-over-release increase.
4. `/readyz` failing from the load balancer/uptime check.
5. Cloud SQL CPU/connections/storage saturation.
6. Redis/MemoryStore errors or sustained low cache-hit rate.
7. Worker/scheduler container restarts or missing heartbeat/log activity.

Tag deployments with `RELEASE_VERSION=<git-sha>` so regressions can be isolated by `releaseSha` immediately after rollout.
