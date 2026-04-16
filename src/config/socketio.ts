import { Server as SocketIOServer } from "socket.io";
import { Server } from "http";

const setUpSocketIO = (server: Server) => {
  const io = new SocketIOServer(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log("A New user Connected To Socket");

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

export default setUpSocketIO;
