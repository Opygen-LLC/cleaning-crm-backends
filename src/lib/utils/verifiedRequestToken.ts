import { Request } from "express";
import { JwtPayload } from "jsonwebtoken";
import { jwtUtils } from "./jwt";
import { ACCESS_TOKEN_SECRET } from "../../config/ENV";

// ─── Shared per-request JWT verification cache ────────────────────────────────
//
// PERF FIX (Phase 1.4): checkSubscription (router-level, runs on every gated
// route before the route's own handlers) and checkAuth / checkFeature
// (route-level) each independently called jwtUtils.verifyToken() on the same
// access token for the same request — up to three signature verifications
// per request for a single token that never changes mid-request.
//
// This helper verifies the token once and caches the result on `req`, so
// every middleware in the chain that needs the decoded payload reuses the
// same result instead of re-running jwt.verify().
export type VerifiedTokenResult =
    | { success: true; data: JwtPayload }
    | { success: false };

export function getVerifiedAccessToken(
    req: Request,
    accessToken: string | undefined,
): VerifiedTokenResult {
    if (req.verifiedAccessToken !== undefined) {
        return req.verifiedAccessToken;
    }

    if (!accessToken) {
        const result: VerifiedTokenResult = { success: false };
        req.verifiedAccessToken = result;
        return result;
    }

    const verified = jwtUtils.verifyToken(accessToken, ACCESS_TOKEN_SECRET);
    const result: VerifiedTokenResult =
        verified.success && verified.data
            ? { success: true, data: verified.data }
            : { success: false };

    req.verifiedAccessToken = result;
    return result;
}
