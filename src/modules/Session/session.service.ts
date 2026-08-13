import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { prisma } from "../../lib/prisma/prisma";
import { IRequestUser } from "../../types/requestUser.interface";

/**
 * GET /session/my-session
 * Returns the caller's own sessions, most recent first, so the frontend
 * can mark the newest one as "this device" when it can't match by token.
 */
const getMySessions = async (
    user: IRequestUser,
    currentOpts?: {
        refreshToken?: string;
        userAgent?: string;
        ipAddress?: string;
    },
) => {
    const sessions = await prisma.session.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
    });

    const currentToken = currentOpts?.refreshToken;
    const currentUA = currentOpts?.userAgent?.trim();

    return sessions.map((s, index) => {
        let isCurrentDevice = false;

        if (currentToken && s.token === currentToken) {
            isCurrentDevice = true;
        } else if (currentUA && s.userAgent?.trim() === currentUA) {
            isCurrentDevice = index === 0;
        } else if (index === 0) {
            isCurrentDevice = true;
        }

        return {
            ...s,
            isCurrentDevice,
        };
    });
};


/**
 * DELETE /session/my-session/:id
 * Scoped to userId + id together so a user can never revoke another
 * user's session, even if they guess a valid session id.
 */
const deleteMySession = async (user: IRequestUser, sessionId: string) => {
    const existing = await prisma.session.findFirst({
        where: { id: sessionId, userId: user.id },
        select: { id: true },
    });

    if (!existing) {
        throw new AppError(status.NOT_FOUND, "Session not found");
    }

    return await prisma.session.delete({
        where: { id: sessionId },
    });
};


/**
 * POST /session/my-session/revoke-others
 * Revokes every session owned by the caller except the explicitly retained
 * current session. One database statement replaces the previous frontend
 * N-request loop, which also avoids repeated cache invalidations/refetches.
 */
const revokeOtherSessions = async (user: IRequestUser, keepSessionId: string) => {
    const keepId = keepSessionId?.trim();
    if (!keepId) {
        throw new AppError(status.BAD_REQUEST, "Current session is required");
    }

    const current = await prisma.session.findFirst({
        where: { id: keepId, userId: user.id },
        select: { id: true },
    });

    if (!current) {
        throw new AppError(status.NOT_FOUND, "Current session not found");
    }

    const result = await prisma.session.deleteMany({
        where: {
            userId: user.id,
            id: { not: keepId },
        },
    });

    return { revokedCount: result.count };
};

export const sessionService = {
    getMySessions,
    deleteMySession,
    revokeOtherSessions,
};
