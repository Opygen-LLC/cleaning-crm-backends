/**
 * checkPortalAuth.ts
 *
 * Auth for the client self-service portal. The portal has no login/session —
 * access is gated purely by the opaque `portalAccessToken` (see
 * Client.portalAccessToken, generated in client.service.ts). The token is
 * sent by the frontend as the `x-portal-token` header (falls back to a
 * `portalToken` query param so it's easy to test with a plain browser/GET).
 *
 * Two middlewares are exported:
 *
 *  - resolvePortalClient: hard-requires a valid portal token. Attaches
 *    `req.portalClient` and calls next(). Used for routes that are
 *    exclusively client-portal actions (e.g. creating a reschedule request).
 *
 *  - checkAuthOrPortalClient(...adminRoles): lets a route serve BOTH the
 *    existing admin/staff session-based auth AND the client portal token,
 *    without duplicating the route. If a session/JWT is present it defers to
 *    the normal `checkAuth`; otherwise it falls back to the portal token.
 *    This is what lets e.g. POST /invoice/:id/payments/:paymentId/proof stay
 *    a single route usable by both admins (on the client's behalf) and
 *    clients themselves.
 */

import { NextFunction, Request, Response } from "express";
import status from "http-status";
import AppError from "../errorHelper/AppError";
import { prisma } from "../lib/prisma/prisma";
import { checkAuth } from "./checkAuth";
import { UserRole } from "../generated/prisma/enums";
import { IPortalClient } from "../types";

const getPortalTokenFromRequest = (req: Request): string | undefined => {
    const header = req.headers["x-portal-token"];
    if (typeof header === "string" && header.trim()) return header.trim();
    const query = req.query["portalToken"];
    if (typeof query === "string" && query.trim()) return query.trim();
    const param = req.params["portalToken"];
    if (typeof param === "string" && param.trim()) return param.trim();
    return undefined;
};

const loadPortalClient = async (
    portalAccessToken: string,
): Promise<IPortalClient> => {
    const client = await prisma.client.findUnique({
        where: { portalAccessToken },
        select: { id: true, adminId: true },
    });

    if (!client) {
        throw new AppError(status.UNAUTHORIZED, "Invalid or expired portal link.");
    }

    return client;
};

// ── Portal-only routes ────────────────────────────────────────────────────────
export const resolvePortalClient = async (
    req: Request,
    _res: Response,
    next: NextFunction,
) => {
    try {
        const token = getPortalTokenFromRequest(req);
        if (!token) {
            throw new AppError(
                status.UNAUTHORIZED,
                "Portal access token is required.",
            );
        }

        req.portalClient = await loadPortalClient(token);
        next();
    } catch (error) {
        next(error);
    }
};

// ── Shared routes (admin/staff session OR client portal token) ────────────────
export const checkAuthOrPortalClient =
    (...adminRoles: UserRole[]) =>
    async (req: Request, res: Response, next: NextFunction) => {
        const hasSessionAuth =
            !!req.headers.authorization?.startsWith("Bearer ") ||
            !!req.headers.cookie?.includes("accessToken=");

        if (hasSessionAuth) {
            return checkAuth(...adminRoles)(req, res, next);
        }

        try {
            const token = getPortalTokenFromRequest(req);
            if (!token) {
                throw new AppError(
                    status.UNAUTHORIZED,
                    "Unauthorized. Provide admin credentials or a portal access token.",
                );
            }

            req.portalClient = await loadPortalClient(token);
            next();
        } catch (error) {
            next(error);
        }
    };
