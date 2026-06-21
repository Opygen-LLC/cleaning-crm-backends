import { Server as SocketIOServer } from "socket.io";
import { Server } from "http";
import { prisma } from "../lib/prisma/prisma";
import { BETTER_AUTH_URL, FRONTEND_URL } from "./ENV";

// Singleton — exported so other modules can emit events (e.g. job status changes)
let io: SocketIOServer;

const setUpSocketIO = (server: Server): SocketIOServer => {
    io = new SocketIOServer(server, {
        cors: {
            // FIX: every socket client in this app connects with
            // `withCredentials: true` (see useSocketJobStatus / useSocketStaffDashboard),
            // and browsers reject a wildcard "*" origin on credentialed
            // requests. Mirror the same allow-list the Express CORS
            // middleware in server.ts already uses, with credentials enabled,
            // so the polling-transport handshake isn't silently blocked.
            origin: [
                FRONTEND_URL,
                BETTER_AUTH_URL,
                "http://localhost:3000",
                "http://localhost:5000",
                "https://cleaning-crm-clients.vercel.app",
            ],
            methods: ["GET", "POST"],
            credentials: true,
        },
    });

    io.on("connection", (socket) => {
        console.log("A New user Connected To Socket");

        /**
         * FIX: joinAdminRoom now requires a valid, unexpired session token and
         * verifies the token belongs to the claimed adminId before joining the room.
         * Without this check any socket caller could join any admin's room simply
         * by guessing a UUID.
         */
        socket.on(
            "joinAdminRoom",
            async (adminId: string, sessionToken: string) => {
                if (!adminId || !sessionToken) {
                    console.warn(
                        "[Socket.IO] joinAdminRoom rejected: missing adminId or sessionToken",
                    );
                    return;
                }

                try {
                    const session = await prisma.session.findFirst({
                        where: {
                            token: sessionToken,
                            expiresAt: { gt: new Date() },
                        },
                        include: {
                            user: {
                                include: { admin: true },
                            },
                        },
                    });

                    if (session?.user?.admin?.id === adminId) {
                        socket.join(`admin:${adminId}`);
                        console.log(
                            `[Socket.IO] Socket joined admin room: admin:${adminId}`,
                        );
                    } else {
                        console.warn(
                            `[Socket.IO] joinAdminRoom rejected: token does not match adminId ${adminId}`,
                        );
                    }
                } catch (err) {
                    console.error("[Socket.IO] joinAdminRoom error:", err);
                }
            },
        );

        /**
         * Staff equivalent of joinAdminRoom — required so that staff members
         * receive real-time events scoped to *them* (e.g. "you've been
         * assigned a new job") rather than only the admin who dispatched it.
         *
         * Validates the session token belongs to a user whose StaffProfile.id
         * matches the claimed staffId before joining the room, for the same
         * reason joinAdminRoom does: prevent any socket from joining another
         * staff member's room just by guessing a UUID.
         */
        socket.on(
            "joinStaffRoom",
            async (staffId: string, sessionToken: string) => {
                if (!staffId || !sessionToken) {
                    console.warn(
                        "[Socket.IO] joinStaffRoom rejected: missing staffId or sessionToken",
                    );
                    return;
                }

                try {
                    const session = await prisma.session.findFirst({
                        where: {
                            token: sessionToken,
                            expiresAt: { gt: new Date() },
                        },
                        include: {
                            user: {
                                include: { staff: true },
                            },
                        },
                    });

                    if (session?.user?.staff?.id === staffId) {
                        socket.join(`staff:${staffId}`);
                        console.log(
                            `[Socket.IO] Socket joined staff room: staff:${staffId}`,
                        );
                    } else {
                        console.warn(
                            `[Socket.IO] joinStaffRoom rejected: token does not match staffId ${staffId}`,
                        );
                    }
                } catch (err) {
                    console.error("[Socket.IO] joinStaffRoom error:", err);
                }
            },
        );

        // Listen for messages
        socket.on("message", (data) => {
            console.log("Message from client:", data);
            io.emit("message", { text: "Hello from the server!" });
        });

        // Handle disconnect
        socket.on("disconnect", () => {
            console.log("A user disconnected");
        });

        // Custom event example
        socket.on("joinRoom", (room) => {
            socket.join(room);
            console.log(`User joined room: ${room}`);
        });

        // Example: send a message to a specific room
        socket.on("sendToRoom", (room, message) => {
            socket.to(room).emit("message", { text: message });
        });
    });

    return io;
};

/** Emit a real-time event to a specific admin's connected clients */
export const emitToAdmin = (
    adminId: string,
    event: string,
    payload: unknown,
): void => {
    if (!io) {
        console.warn("[Socket.IO] emitToAdmin called before io is initialised");
        return;
    }
    io.to(`admin:${adminId}`).emit(event, payload);
};

/** Emit a real-time event to a specific staff member's connected clients */
export const emitToStaff = (
    staffId: string,
    event: string,
    payload: unknown,
): void => {
    if (!io) {
        console.warn("[Socket.IO] emitToStaff called before io is initialised");
        return;
    }
    io.to(`staff:${staffId}`).emit(event, payload);
};

/** Emit a real-time event to all connected clients (broadcast) */
export const emitToAll = (event: string, payload: unknown): void => {
    if (!io) {
        console.warn("[Socket.IO] emitToAll called before io is initialised");
        return;
    }
    io.emit(event, payload);
};

export default setUpSocketIO;
