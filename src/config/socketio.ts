import { Server as SocketIOServer } from "socket.io";
import { Server } from "http";
import { prisma } from "../lib/prisma/prisma";

// Singleton — exported so other modules can emit events (e.g. job status changes)
let io: SocketIOServer;

const setUpSocketIO = (server: Server): SocketIOServer => {
    io = new SocketIOServer(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"],
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

/** Emit a real-time event to all connected clients (broadcast) */
export const emitToAll = (event: string, payload: unknown): void => {
    if (!io) {
        console.warn("[Socket.IO] emitToAll called before io is initialised");
        return;
    }
    io.emit(event, payload);
};

export default setUpSocketIO;
