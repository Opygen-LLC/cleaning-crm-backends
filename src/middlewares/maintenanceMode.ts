import { NextFunction, Request, Response } from "express";
import { getPlatformConfig } from "../lib/utils/platformConfig";

// Routes that must keep working even while maintenanceMode is on:
//   - /api/v1/auth/*         so a super-admin (or anyone) can still log in
//   - /api/v1/super-admin/*  so the super-admin can manage the platform and
//                            flip maintenanceMode back off
const EXEMPT_PREFIXES = ["/api/v1/auth", "/api/v1/super-admin"];

/**
 * Blocks all other API traffic with a 503 while the super-admin's
 * "Maintenance Mode" platform setting is enabled.
 *
 * Fails OPEN (lets requests through) if the config lookup itself errors —
 * a DB hiccup here should never be able to take the whole API down.
 */
export const maintenanceModeGate = async (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    if (EXEMPT_PREFIXES.some((prefix) => req.originalUrl.startsWith(prefix))) {
        return next();
    }

    try {
        const config = await getPlatformConfig();
        if (config.maintenanceMode) {
            return res.status(503).json({
                success: false,
                message:
                    "The platform is currently undergoing scheduled maintenance. Please try again shortly.",
            });
        }
    } catch {
        // fail open
    }

    next();
};
