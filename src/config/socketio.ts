import { Server as SocketIOServer } from "socket.io";
import { Server } from "http";

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

    // Client joins their own admin room so targeted events can be sent
    socket.on("joinAdminRoom", (adminId: string) => {
      socket.join(`admin:${adminId}`);
      console.log(`Socket joined admin room: admin:${adminId}`);
    });

    // Listen for messages
    socket.on("message", (data) => {
      console.log("Message from client:", data);
      io.emit("message", { text: "Hello from the server!" }); // Broadcast to all clients
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
export const emitToAdmin = (adminId: string, event: string, payload: unknown): void => {
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
