import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { prisma } from "../../lib/prisma/prisma";
import { IRequestUser } from "../../types/requestUser.interface";
import {
    revokeOtherSessionsForUser,
    revokeSessionByIdForUser,
} from "../Auth/sessionSecurity.service";
import { invalidateRuntimeAuth } from "../../lib/cache/authRuntimeCache";
import { invalidatePrivateResponseCacheForUser } from "../../middlewares/privateResponseCache";

const getMySessions = async (user: IRequestUser, currentSessionToken?: string) => {
    type SessionRow = {
        id: string;
        userId: string;
        expiresAt: Date;
        createdAt: Date;
        updatedAt: Date;
        lastUsedAt: Date;
        ipAddress: string | null;
        userAgent: string | null;
        isCurrentDevice: boolean;
    };

    // Never expose the opaque Better Auth token. Current-device comparison is
    // performed inside PostgreSQL and only the resulting boolean is returned.
    return prisma.$queryRaw<SessionRow[]>`
        SELECT
            id,
            "userId",
            "expiresAt",
            "createdAt",
            "updatedAt",
            COALESCE("lastUsedAt", "updatedAt", "createdAt") AS "lastUsedAt",
            "ipAddress",
            "userAgent",
            CASE WHEN token = ${currentSessionToken ?? ""} THEN TRUE ELSE FALSE END AS "isCurrentDevice"
        FROM "session"
        WHERE "userId" = ${user.id}
          AND "expiresAt" > NOW()
        ORDER BY "lastUsedAt" DESC NULLS LAST, "createdAt" DESC
        LIMIT 20
    `;
};

const deleteMySession = async (
    user: IRequestUser,
    sessionId: string,
    currentSessionToken?: string,
) => {
    const result = await revokeSessionByIdForUser(user.id, sessionId, currentSessionToken);

    // Idempotent by design: an expired/already-revoked session (or an id that
    // does not belong to this user) returns the same safe success shape instead
    // of leaking existence information or making repeat clicks fail with 404.
    if (!result.found) {
        return {
            id: sessionId,
            revoked: false,
            alreadyRevoked: true,
            revokedCurrent: false,
        };
    }

    if (result.revokedCurrent) {
        invalidateRuntimeAuth(user.id);
        await invalidatePrivateResponseCacheForUser(user.id);
    }

    return {
        id: sessionId,
        revoked: true,
        alreadyRevoked: false,
        revokedCurrent: result.revokedCurrent,
    };
};

const revokeOtherSessions = async (user: IRequestUser, currentSessionToken?: string) => {
    if (!currentSessionToken) throw new AppError(status.UNAUTHORIZED, "Current session is missing");

    const result = await revokeOtherSessionsForUser(user.id, currentSessionToken);
    if (!result.currentValid) {
        throw new AppError(status.UNAUTHORIZED, "Current session is invalid");
    }
    return result;
};

export const sessionService = { getMySessions, deleteMySession, revokeOtherSessions };
