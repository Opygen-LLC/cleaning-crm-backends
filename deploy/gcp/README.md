# Cleaning CRM — Google Compute Engine production deployment

This deployment keeps the CRM as a modular monolith while isolating HTTP, workers, and scheduled workloads into separate processes.

## Required topology

- `cleaningcrm.opygen.com`: frontend.
- `api.opygen.com`: this backend through Caddy.
- Google Compute Engine VM in the selected production region.
- Google Cloud SQL PostgreSQL using **private IP in the same region/VPC**.
- Redis on the VM private Docker network for this single-VM topology. Use Memorystore in the same region when moving to multiple API VMs.
- Google Secret Manager secret `cleaning-crm-backend-env` containing the runtime environment file.

Only ports 80/443 should be Internet-accessible on the VM. Do not expose API port 3000, Redis 6379, or Cloud SQL publicly. `TRUST_PROXY_HOPS=1` assumes Caddy is the single reverse-proxy hop; increase it only if you intentionally add a Google Cloud load balancer in front and verify the exact proxy chain.

## Runtime secret requirements

At minimum configure `DATABASE_URL`, `DIRECT_URL`, `BETTER_AUTH_SECRET`, JWT secrets, SMTP/provider secrets, Cloudinary secrets, `APP_REGION`, `DATABASE_REGION`, and the other application values from `.env.example`. Production auth must use:

```env
NODE_ENV=production
FRONTEND_URL=https://cleaningcrm.opygen.com
APP_URL=https://cleaningcrm.opygen.com
BETTER_AUTH_URL=https://api.opygen.com
COOKIE_DOMAIN=.opygen.com
AUTH_ALLOWED_ORIGINS=https://cleaningcrm.opygen.com,https://api.opygen.com
ACCESS_TOKEN_EXPIRES_IN=15m
APP_REGION=<gcp-region>
DATABASE_REGION=<same-gcp-region>
REDIS_REGION=local
REQUIRE_COLOCATED_INFRA=true
TRUST_PROXY_HOPS=1
```

Never commit `.env.runtime`. Load it on the VM using:

```bash
./scripts/gcp/load-secrets.sh
```

## Release order

```bash
# 1. Load/refresh runtime secrets
./scripts/gcp/load-secrets.sh

# 2. Build and run the one-shot migration before application rollout
docker compose --env-file .env.runtime --profile release build migrate
docker compose --env-file .env.runtime --profile release run --rm migrate

# 3. First installation only (or when an explicit bootstrap is required)
docker compose --env-file .env.runtime --profile bootstrap run --rm bootstrap

# 4. Run isolated long-lived processes
docker compose --env-file .env.runtime up -d --build redis api worker scheduler caddy

# 5. Verify readiness
curl -fsS https://api.opygen.com/livez
curl -fsS https://api.opygen.com/readyz
```

The API container never runs migrations, seeds, cron schedules, or the email outbox worker. Worker/scheduler roles fail startup if launched with the wrong `PROCESS_ROLE`.

## Credential rotation

The historical project archive contained a populated `.env`. If that archive was shared outside the trusted deployment environment, rotate database, JWT/auth, SMTP, Cloudinary and third-party credentials before this release and store the new values only in Google Secret Manager.


## Phase 6 observability

Use [`deploy/gcp/OBSERVABILITY.md`](./OBSERVABILITY.md) for Cloud Logging field contracts, p50/p95/p99 dashboards, trace correlation, protected diagnostic endpoints, and alert policies. Set `RELEASE_VERSION` to the deployed Git SHA and keep `PERFORMANCE_METRICS_TOKEN` in Google Secret Manager. Load balancers/uptime checks should use only `/livez` and `/readyz`.
