-- Phase 5: Better Auth session hardening and refresh-token rotation state.
-- Forward-only/data-preserving. Existing sessions are upgraded lazily on their
-- first successful refresh; no plaintext refresh credential is ever persisted.

ALTER TABLE "session"
  ADD COLUMN IF NOT EXISTS "lastUsedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "refreshTokenHash" TEXT,
  ADD COLUMN IF NOT EXISTS "previousRefreshTokenHash" TEXT,
  ADD COLUMN IF NOT EXISTS "refreshFamilyId" TEXT,
  ADD COLUMN IF NOT EXISTS "refreshRotatedAt" TIMESTAMP(3);

UPDATE "session"
SET "lastUsedAt" = COALESCE("lastUsedAt", "updatedAt", "createdAt")
WHERE "lastUsedAt" IS NULL;

-- Concurrent-session cleanup/listing and refresh-family revocation hot paths.
CREATE INDEX IF NOT EXISTS "session_userId_expiresAt_createdAt_idx"
  ON "session" ("userId", "expiresAt" DESC, "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "session_refreshFamilyId_idx"
  ON "session" ("refreshFamilyId");
