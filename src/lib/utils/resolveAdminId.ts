import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { IRequestUser } from "../../types/requestUser.interface";
import { getRuntimeTenantId } from "../cache/authRuntimeCache";

/**
 * getAdminId — PERF FIX (Phase 2)
 * ─────────────────────────────────────────────────────────────────────────
 * Replaces the `resolveAdminId(userId)` helper that used to be duplicated
 * in 12 service files (107 call sites total — confirmed via
 * `grep -rln resolveAdminId src/modules/*\/*.service.ts`), each one paying
 * for an uncached `prisma.adminProfile.findUnique()` round-trip on almost
 * every authenticated API call, just to translate `userId -> adminId`.
 *
 * checkAuth.ts now resolves `adminId` once per request (Redis-cached, 5 min
 * TTL) and attaches it to `req.user.adminId` for ADMIN-role requests. This
 * function is a plain property read on the fast path:
 *
 *   const adminId = await getAdminId(user);   // no query, 99% of the time
 *
 * It only falls back to a live DB lookup when `user.adminId` isn't already
 * present — e.g. a cron job or test that constructs an IRequestUser by hand
 * without going through checkAuth. This keeps every existing call site
 * correct even outside a real request, while removing the DB round-trip
 * from the hot path where it actually matters.
 */
export const getAdminId = async (user: IRequestUser): Promise<string> => {
    if (user.adminId) return user.adminId;

    const adminId = await getRuntimeTenantId(user.id, user.role);
    if (!adminId) {
        throw new AppError(status.INTERNAL_SERVER_ERROR, "Authenticated tenant context could not be resolved.", {
            code: "TENANT_CONTEXT_RESOLUTION_FAILED",
            retryable: false,
            kind: "TENANT_INVARIANT",
        });
    }
    return adminId;
};
