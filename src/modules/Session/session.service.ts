import { prisma } from "../../lib/prisma/prisma";
import { IRequestUser } from "../../types/requestUser.interface";

const geMySession = async (user: IRequestUser) => {
    return await prisma.session.findMany({ where: { userId: user.id } });
};

const deleteMySession = async (user: IRequestUser, sessionId: string) => {
    return await prisma.session.delete({
        where: { userId: user.id, id: sessionId },
    });
};

export const sessionService = {
    geMySession,
    deleteMySession,
};
