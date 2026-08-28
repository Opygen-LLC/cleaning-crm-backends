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
    getRuntimeTenantOwnerStatus,
    getRuntimeUserStatus,
} from "../lib/cache/authRuntimeCache";
import { privateResponseCache } from "./privateResponseCache";
import { recordTraceSpan } from "../lib/monitoring/requestTrace";
import { AUTH_ERROR_CODES } from "../modules/Auth/auth.codes";

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

            // ── Role check (from JWT) ───────────────────────────────────────
            if (
                authRoles.length > 0 &&
                !authRoles.includes(tokenData.role as UserRole)
            ) {
                throw new AppError(status.FORBIDDEN, "Forbidden access.");
            }

            // checkSubscription runs before route-level auth on gated ADMIN
            // routes and already populated this context. STAFF requests skip the
            // subscription gate, so resolve STAFF status + owning tenant with a
            // single cached context instead of two sequential DB lookups.
            const role = tokenData.role as UserRole;
            let userStatus = req.authRuntime?.userStatus;
            let adminId = req.authRuntime?.adminId;

            if (role === UserRole.ADMIN && (userStatus === undefined || adminId === undefined)) {
                const tenantContext = await getRuntimeAdminAccessContext(tokenData.userId as string);
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
                const staffContext = await getRuntimeStaffAccessContext(tokenData.userId as string);
                if (userStatus === undefined) userStatus = staffContext.userStatus;
                if (adminId === undefined) adminId = staffContext.adminId;
                req.authRuntime = { ...req.authRuntime, userStatus, adminId };
            } else if (role === UserRole.SUPER_ADMIN && userStatus === undefined) {
                userStatus = await getRuntimeUserStatus(tokenData.userId as string);
            } else if (adminId === undefined) {
                adminId = await getRuntimeTenantId(tokenData.userId as string, role);
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

            // Suspending a cleaning business must close the tenant, not just
            // the owner's own token. Staff remain separate User rows, so also
            // enforce the owning ADMIN account state for STAFF requests.
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
                id: tokenData.userId as string,
                role: tokenData.role as UserRole,
                email: tokenData.email as string,
                adminId,
            };

            await privateResponseCache(req, res, next);
        } catch (error) {
            next(error);
        } finally {
            recordTraceSpan("auth", Number(process.hrtime.bigint() - authStarted) / 1_000_000, "auth.middleware");
        }
    };
