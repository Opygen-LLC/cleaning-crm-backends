# Cloudflare R2 Phase 1 setup

Create two Standard R2 buckets: `cleaning-crm-public` and `cleaning-crm-private`. Keep the private bucket non-public. Attach a custom domain such as `media.cleaningcrm.opygen.com` to the public bucket.

Create one R2 API token with Object Read & Write scoped only to these two buckets. Store the Access Key ID and Secret Access Key only in the backend secret manager.

Set the backend variables documented in `.env.example`. This patch adds `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, and `sharp`; run `pnpm install --no-frozen-lockfile` once and commit the regenerated `pnpm-lock.yaml`, then run `pnpm prisma migrate deploy` before deploying the API. The media routes are mounted at `/api/v1/media` through the existing router base.

For browser direct uploads, configure CORS on both R2 buckets using `docs/r2-cors.example.json`, replacing the example origins with the real production frontend origin. Temporary browser uploads always land in the private bucket and are finalized into immutable organization-prefixed objects by the backend.

Recommended lifecycle rule: delete objects with prefix `tmp/` after one day. This protects against abandoned direct-upload sessions.

Verification sequence:
1. `GET /media/health` as an authenticated ADMIN returns both buckets reachable.
2. `POST /media/uploads/initiate`, PUT the file to the returned URL using the exact returned `Content-Type`, then `POST /media/uploads/:uploadId/complete`.
3. Public purposes return a custom-domain `publicUrl`.
4. Private purposes have no public URL and require `GET /media/:assetId/download-url`.
5. Cross-tenant entity IDs fail closed.
