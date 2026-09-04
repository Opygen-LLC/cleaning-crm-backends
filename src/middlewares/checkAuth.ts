import { NextFunction, Request, Response } from "express";
import AppError from "../errorHelper/AppError";
import status from "http-status";
import { AccountStatus, UserRole } from "../generated/prisma/enums";
import { CookieUtils } from "../lib/utils/cookie";
import { getVerifiedAccessToken } from "../lib/utils/verifiedRequestToken";
import {
    getRuntimeAdminAccessContext,
    getRuntimeSessionValidity,
    getRuntimeStaffAccessContext,
    getRuntimeTenantId,
    getRuntimeTenantLifecycleStatus,
    getRuntimeTenantOwnerStatus,
    getRuntimeUserStatus,
} from "../lib/cache/authRuntimeCache";
import { privateResponseCache } from "./privateResponseCache";
import { enforcePrivateApiRateLimit } from "./privateApiRateLimit";
import { recordTraceSpan } from "../lib/monitoring/requestTrace";
import { AUTH_ERROR_CODES } from "../modules/Auth/auth.codes";
import { SupportModeService } from "../modules/SuperAdmin/supportMode.service";

// Browser authentication is cookie-first. Authorization: Bearer remains
// supported for explicit server-to-server/integration callers, but cannot
// shadow a valid browser cookie when both are present.
const getAccessTokenFromRequest = (req: Request): string | undefined => {
    const cookieToken = CookieUtils.getCookie(req, "accessToken");
    if (cookieToken) return cookieToken;

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
        return authHeader.slice("Bearer ".length).trim();
    }
    return undefined;
};

export const checkAuth =
    (...authRoles: UserRole[]) =>
    async (req: Request, res: Response, next: NextFunction) => {
        const authStarted = process.hrtime.bigint();
        try {
            const accessToken = getAccessTokenFromRequest(req);

            if (!accessToken) {
                throw new AppError(
                    status.UNAUTHORIZED,
                    "Authentication is required.",
                    { code: AUTH_ERROR_CODES.ACCESS_TOKEN_MISSING, retryable: true },
                );
            }

            // ── JWT verification ────────────────────────────────────────────
            // PERF FIX (Phase 1.4): reuses the cached verification result if
            // checkSubscription (which runs earlier, at router level, on
            // gated routes) already verified this exact token for this
            // request — avoids a second jwt.verify() call per request.
            const verifiedToken = getVerifiedAccessToken(req, accessToken);
            if (!verifiedToken.success) {
                if (verifiedToken.reason === "EXPIRED") {
                    throw new AppError(
                        status.UNAUTHORIZED,
                        "The access token has expired.",
                        { code: AUTH_ERROR_CODES.ACCESS_TOKEN_EXPIRED, retryable: true },
                    );
                }

                throw new AppError(
                    status.UNAUTHORIZED,
                    "The access token is invalid.",
                    { code: AUTH_ERROR_CODES.ACCESS_TOKEN_INVALID, retryable: false },
                );
            }

            const tokenData = verifiedToken.data;
            const actualRole = tokenData.role as UserRole;
            const actualUserId = tokenData.userId as string;
            const controlPlaneRequest = req.originalUrl.includes("/super-admin/") || req.originalUrl.endsWith("/super-admin");
            let effectiveRole = actualRole;
            let effectiveUserId = actualUserId;
            let effectiveEmail = tokenData.email as string;

            // A Super Admin may temporarily view one tenant as its owner through
            // a separate short-lived support_mode cookie. The signed Super Admin
            // access token remains the actor identity; writes are blocked below.
            if (actualRole === UserRole.SUPER_ADMIN) {
                const supportMode = req.supportMode ?? await SupportModeService.fromRequest(req, actualUserId);
                if (supportMode) {
                    req.supportMode = supportMode;
                    req.supportActor = { id: actualUserId, role: actualRole, email: effectiveEmail };

                    const supportModeEndRequest =
                        controlPlaneRequest &&
                        req.originalUrl.includes("/super-admin/support-mode/end");

                    // While support mode is active, the only allowed write on
                    // either the tenant plane or control plane is ending that
                    // support session itself. This makes read-only a backend
                    // security property rather than a UI convention.
                    if (!supportModeEndRequest) SupportModeService.assertReadOnly(req);

                    if (!controlPlaneRequest) {
                        effectiveRole = UserRole.ADMIN;
                        effectiveUserId = supportMode.targetUserId;
                        effectiveEmail = supportMode.targetEmail;
                    }
                }
            }

            // ── Role check (effective identity) ─────────────────────────────
            if (authRoles.length > 0 && !authRoles.includes(effectiveRole)) {
                throw new AppError(status.FORBIDDEN, "Forbidden access.", { code: "FORBIDDEN", retryable: false });
            }

            // checkSubscription runs before route-level auth on gated ADMIN
            // routes and already populated this context. STAFF requests skip the
            // subscription gate, so resolve STAFF status + owning tenant with a
            // single cached context instead of two sequential DB lookups.
            const role = effectiveRole;
            let userStatus = req.authRuntime?.userStatus;
            let adminId = req.authRuntime?.adminId;

            if (role === UserRole.ADMIN && (userStatus === undefined || adminId === undefined)) {
                const tenantContext = await getRuntimeAdminAccessContext(effectiveUserId);
                if (userStatus === undefined) userStatus = tenantContext.userStatus;
                if (adminId === undefined) adminId = tenantContext.adminId;
                req.authRuntime = {
                    ...req.authRuntime,
                    userStatus,
                    adminId,
                    subscriptionPlanName: tenantContext.subscription?.planName ?? null,
                    subscriptionFeatures: tenantContext.entitlementSummary,
                    entitlementSummary: tenantContext.entitlementSummary,
                };
            } else if (role === UserRole.STAFF && (userStatus === undefined || adminId === undefined)) {
                const staffContext = await getRuntimeStaffAccessContext(effectiveUserId);
                if (userStatus === undefined) userStatus = staffContext.userStatus;
                if (adminId === undefined) adminId = staffContext.adminId;
                req.authRuntime = { ...req.authRuntime, userStatus, adminId };
            } else if (role === UserRole.SUPER_ADMIN && userStatus === undefined) {
                userStatus = await getRuntimeUserStatus(effectiveUserId);
            } else if (adminId === undefined) {
                adminId = await getRuntimeTenantId(effectiveUserId, role);
            }

            if (role === UserRole.STAFF && !adminId) {
                throw new AppError(
                    status.NOT_FOUND,
                    "Staff profile not found for this account.",
                    { code: "STAFF_PROFILE_MISSING", retryable: false, kind: "TENANT_INVARIANT" },
                );
            }

            if (role === UserRole.ADMIN && !adminId) {
                throw new AppError(
                    status.INTERNAL_SERVER_ERROR,
                    "Authenticated tenant context could not be resolved.",
                    {
                        code: "TENANT_CONTEXT_RESOLUTION_FAILED",
                        retryable: false,
                        kind: "TENANT_INVARIANT",
                    },
                );
            }

            if (!userStatus) {
                throw new AppError(
                    status.UNAUTHORIZED,
                    "Account not found. Please log in again.",
                    { code: AUTH_ERROR_CODES.INVALID_SESSION, retryable: false },
                );
            }

            if (userStatus === AccountStatus.SUSPENDED) {
                throw new AppError(
                    status.FORBIDDEN,
                    "Your account has been suspended. Please contact support.",
                    { code: "ACCOUNT_SUSPENDED", retryable: false },
                );
            }

            if (userStatus === AccountStatus.DELETED) {
                throw new AppError(
                    status.FORBIDDEN,
                    "This account has been deleted.",
                );
            }

            // Tenant lifecycle is authoritative for both owner and staff.
            if ((role === UserRole.ADMIN || role === UserRole.STAFF) && adminId) {
                const lifecycle = await getRuntimeTenantLifecycleStatus(adminId);
                if (lifecycle === "ARCHIVED") {
                    throw new AppError(status.FORBIDDEN, "This business account has been archived.", { code: "TENANT_ARCHIVED", retryable: false });
                }
                if (lifecycle === "SUSPENDED") {
                    throw new AppError(status.FORBIDDEN, "This business account has been suspended. Please contact support.", { code: "ACCOUNT_SUSPENDED", retryable: false });
                }
            }

            // Staff remain separate User rows, so also enforce the owning ADMIN
            // User state as a compatibility guard during lifecycle migration.
            if (role === UserRole.STAFF && adminId) {
                const ownerStatus = await getRuntimeTenantOwnerStatus(adminId);
                if (ownerStatus === AccountStatus.SUSPENDED) {
                    throw new AppError(
                        status.FORBIDDEN,
                        "Your business account has been suspended. Please contact support.",
                        { code: "ACCOUNT_SUSPENDED", retryable: false },
                    );
                }
                if (ownerStatus === AccountStatus.DELETED) {
                    throw new AppError(status.FORBIDDEN, "This business account has been deleted.", {
                        code: "ACCOUNT_DELETED",
                        retryable: false,
                    });
                }
            }

            // ── Optional session bookkeeping ────────────────────────────────
            // If the API-host-only Better Auth session cookie is present, verify it
            // is still valid. We do NOT fail if it's absent —
            // only if it's present but revoked.
            const sessionToken = CookieUtils.getCookie(
                req,
                "better-auth.session_token",
            );
            if (sessionToken) {
                const isSessionValid =
                    await getRuntimeSessionValidity(sessionToken);

                if (!isSessionValid) {
                    throw new AppError(
                        status.UNAUTHORIZED,
                        "Session has been revoked. Please log in again.",
                        { code: AUTH_ERROR_CODES.INVALID_SESSION, retryable: false },
                    );
                }
            }

            req.user = {
                id: effectiveUserId,
                role,
                email: effectiveEmail,
                adminId,
            };

            await enforcePrivateApiRateLimit(req, res);
            await privateResponseCache(req, res, next);
        } catch (error) {
            next(error);
        } finally {
            recordTraceSpan("auth", Number(process.hrtime.bigint() - authStarted) / 1_000_000, "auth.middleware");
        }
    };
