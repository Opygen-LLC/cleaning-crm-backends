import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { prisma } from "../../lib/prisma/prisma";
import { IRequestUser } from "../../types/requestUser.interface";

const getMySessions = async (user: IRequestUser, currentSessionToken?: string) => {
    const sessions = await prisma.session.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            userId: true,
            expiresAt: true,
            createdAt: true,
            updatedAt: true,
            ipAddress: true,
            userAgent: true,
            token: true,
        },
    });

    return sessions.map(({ token, ...session }) => ({
        ...session,
        isCurrentDevice: Boolean(currentSessionToken && token === currentSessionToken),
    }));
};

const deleteMySession = async (user: IRequestUser, sessionId: string) => {
    const existing = await prisma.session.findFirst({
        where: { id: sessionId, userId: user.id },
        select: { id: true },
    });
    if (!existing) throw new AppError(status.NOT_FOUND, "Session not found");
    await prisma.session.delete({ where: { id: sessionId } });
    return { id: sessionId };
};

const revokeOtherSessions = async (user: IRequestUser, currentSessionToken?: string) => {
    if (!currentSessionToken) throw new AppError(status.UNAUTHORIZED, "Current session is missing");

    const current = await prisma.session.findFirst({
        where: { token: currentSessionToken, userId: user.id, expiresAt: { gt: new Date() } },
        select: { id: true },
    });
    if (!current) throw new AppError(status.UNAUTHORIZED, "Current session is invalid");

    const result = await prisma.session.deleteMany({
        where: { userId: user.id, id: { not: current.id } },
    });
    return { revokedCount: result.count };
};

export const sessionService = { getMySessions, deleteMySession, revokeOtherSessions };
