import { PORT } from "./config/ENV";
import setUpSocketIO from "./config/socketio";
import app from "./server";
import http from "http";

const server = http.createServer(app);

// initialize the socket io
const io = setUpSocketIO(server);

//using the post and ip over here
const backendIp = process.env.BACKEND_IP;
const port = process.env.PORT || 5000;

// server.listen(PORT, BACKEND_IP, () => {
//   console.log(`Server is running at http://${BACKEND_IP}:${PORT}`);
// });

server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

// TODO: vercel code running

// import dotenv from "dotenv";
// import http from "http";
// import app from "./server"; // or "./app" if that's your Express app
// import setUpSocketIO from "./config/socketio";

// dotenv.config();

// const PORT = process.env.PORT || 3000;

// async function main() {
//   try {
//     // Connect to MongoDB
//     // await connectionToDb(); // assumes connectionToDb() returns a Promise
//     console.log("Connected to the database");

//     // Create HTTP server
//     const server = http.createServer(app);

//     // Initialize Socket.IO
//     setUpSocketIO(server);

//     // Start server
//     server.listen(PORT, () => {
//       console.log(`Server is running at http://localhost:${PORT}`);
//     });
//   } catch (error) {
//     console.error("Error starting the server:", error);
//   }
// }

// main();
