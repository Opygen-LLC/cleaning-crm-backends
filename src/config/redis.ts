import Redis from "ioredis";
import dotenv from "dotenv";

dotenv.config();

const redis = new Redis({
  host: process.env.REDIS_HOST, // Redis host (e.g., "localhost")
  port: Number(process.env.REDIS_PORT), // Convert the port to a number
  password: process.env.REDIS_PASSWORD || "", // Use default empty string if no password
  db: Number(process.env.REDIS_DB), // Convert db to a number (default is 0)
});

export default redis;
