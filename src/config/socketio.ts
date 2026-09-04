import { Server as SocketIOServer, type Socket } from "socket.io";
import type { Server } from "http";
import { prisma } from "../lib/prisma/prisma";
import { ACCESS_TOKEN_SECRET } from "./ENV";
import { getAuthenticatedOrigins } from "./authSecurity";
import { jwtUtils } from "../lib/utils/jwt";
import logger from "../lib/logger";
import { publishRealtimeEvent, publishTenantSocketDisconnect, publishUserSocketDisconnect, startRealtimeSubscriber } from "../lib/realtime/realtimeBus";

let io: SocketIOServer | undefined;

type SocketAuthContext = {
    userId: string;
    role: string;
    adminId?: string;
    staffId?: string;
};

const parseCookieHeader = (header: string | undefined): Record<string, string> => {
    if (!header) return {};
    const out: Record<string, string> = {};
    for (const part of header.split(";")) {
        const index = part.indexOf("=");
        if (index <= 0) continue;
        const name = part.slice(0, index).trim();
        const raw = part.slice(index + 1).trim();
        try { out[name] = decodeURIComponent(raw); } catch { out[name] = raw; }
    }
    return out;
};

const authenticateSocket = async (socket: Socket): Promise<SocketAuthContext> => {
    const cookies = parseCookieHeader(socket.handshake.headers.cookie);
    const accessToken = cookies.accessToken;
    const sessionToken = cookies["better-auth.session_token"];
    if (!accessToken || !sessionToken) throw new Error("Authentication cookies are missing");

    const verified = jwtUtils.verifyToken(accessToken, ACCESS_TOKEN_SECRET);
    if (!verified.success || !verified.data?.userId || !verified.data?.role) {
        throw new Error("Invalid access token");
    }

    const session = await prisma.session.findFirst({
        where: {
            token: sessionToken,
            userId: String(verified.data.userId),
            expiresAt: { gt: new Date() },
        },
        select: {
            userId: true,
            user: {
                select: {
                    role: true,
                    status: true,
                    admin: { select: { id: true, lifecycleStatus: true } },
                    staff: {
                        select: {
                            id: true,
                            adminId: true,
                            admin: { select: { lifecycleStatus: true, user: { select: { status: true } } } },
                        },
                    },
                },
            },
        },
    });

    if (!session || session.user.status !== "ACTIVE" || session.user.role !== verified.data.role) {
        throw new Error("Session is invalid or inactive");
    }

    const tenantLifecycle = session.user.admin?.lifecycleStatus ?? session.user.staff?.admin.lifecycleStatus;
    const tenantOwnerStatus = session.user.staff?.admin.user.status;
    if ((session.user.role === "ADMIN" || session.user.role === "STAFF") && tenantLifecycle !== "ACTIVE") {
        throw new Error("Tenant is suspended or archived");
    }
    if (session.user.role === "STAFF" && tenantOwnerStatus !== "ACTIVE") {
        throw new Error("Tenant owner is inactive");
    }

    return {
        userId: session.userId,
        role: session.user.role,
        adminId: session.user.admin?.id ?? session.user.staff?.adminId,
        staffId: session.user.staff?.id,
    };
};

const joinCanonicalRooms = (socket: Socket, auth: SocketAuthContext) => {
    socket.join(`user:${auth.userId}`);
    if ((auth.role === "ADMIN" || auth.role === "STAFF") && auth.adminId) socket.join(`admin:${auth.adminId}`);
    if (auth.role === "STAFF" && auth.staffId) socket.join(`staff:${auth.staffId}`);
    if (auth.role === "SUPER_ADMIN") socket.join("super-admins");
};

const setUpSocketIO = (server: Server): SocketIOServer => {
    io = new SocketIOServer(server, {
        cors: {
            origin: getAuthenticatedOrigins(),
            methods: ["GET", "POST"],
            credentials: true,
        },
    });

    io.use(async (socket, next) => {
        try {
            socket.data.auth = await authenticateSocket(socket);
            next();
        } catch (error) {
            logger.warn(`[Socket.IO] rejected connection: ${error instanceof Error ? error.message : String(error)}`);
            next(new Error("unauthorized"));
        }
    });

    io.on("connection", (socket) => {
        const auth = socket.data.auth as SocketAuthContext;
        joinCanonicalRooms(socket, auth);
        logger.debug(`[Socket.IO] authenticated ${auth.role} socket connected`);

        // Backward-compatible room events no longer accept browser-readable
        // session tokens. The authenticated handshake is the authority.
        socket.on("joinAdminRoom", (adminId: string) => {
            if (auth.role === "ADMIN" && auth.adminId === adminId) socket.join(`admin:${adminId}`);
        });
        socket.on("joinStaffRoom", (staffId: string) => {
            if (auth.role === "STAFF" && auth.staffId === staffId) socket.join(`staff:${staffId}`);
        });
        socket.on("joinSuperAdminRoom", (userId: string) => {
            if (auth.role === "SUPER_ADMIN" && auth.userId === userId) socket.join("super-admins");
        });

        socket.on("disconnect", () => logger.debug("[Socket.IO] authenticated client disconnected"));
    });

    startRealtimeSubscriber(io);
    return io;
};

const localEmit = (target: "admin" | "staff" | "super-admins" | "all", id: string | undefined, event: string, payload: unknown) => {
    if (!io) return;
    if (target === "admin" && id) io.to(`admin:${id}`).emit(event, payload);
    else if (target === "staff" && id) io.to(`staff:${id}`).emit(event, payload);
    else if (target === "super-admins") io.to("super-admins").emit(event, payload);
    else if (target === "all") io.emit(event, payload);
};

export const emitToAdmin = (adminId: string, event: string, payload: unknown): void => {
    localEmit("admin", adminId, event, payload);
    void publishRealtimeEvent({ scope: "admin", id: adminId }, event, payload);
};

export const emitToStaff = (staffId: string, event: string, payload: unknown): void => {
    localEmit("staff", staffId, event, payload);
    void publishRealtimeEvent({ scope: "staff", id: staffId }, event, payload);
};

export const emitToAll = (event: string, payload: unknown): void => {
    localEmit("all", undefined, event, payload);
    void publishRealtimeEvent({ scope: "all" }, event, payload);
};

export const emitToSuperAdmins = (event: string, payload: unknown): void => {
    localEmit("super-admins", undefined, event, payload);
    void publishRealtimeEvent({ scope: "super-admins" }, event, payload);
};

export const disconnectTenantSockets = async (adminId: string): Promise<void> => {
    if (io) io.in(`admin:${adminId}`).disconnectSockets(true);
    await publishTenantSocketDisconnect(adminId);
};

export const disconnectUserSockets = async (userId: string): Promise<void> => {
    if (io) io.in(`user:${userId}`).disconnectSockets(true);
    await publishUserSocketDisconnect(userId);
};

export default setUpSocketIO;
