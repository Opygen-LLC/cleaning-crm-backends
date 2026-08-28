import winston from "winston";
import "winston-daily-rotate-file";
import { NODE_ENV } from "../config/ENV";

const consoleTransport = new winston.transports.Console({
  format: NODE_ENV === "production"
    ? winston.format.combine(winston.format.timestamp(), winston.format.json())
    : winston.format.combine(winston.format.colorize(), winston.format.simple()),
});

const transports: winston.transport[] = [consoleTransport];

// Google Compute Engine/Cloud Ops Agent collects stdout/stderr. Avoid local
// rotating files in production containers; they are ephemeral and duplicate
// log ingestion. Keep a small rotating file only for local development.
if (NODE_ENV !== "production") {
  transports.push(new winston.transports.DailyRotateFile({
    filename: "logs/server-%DATE%.log",
    datePattern: "YYYY-MM-DD",
    zippedArchive: true,
    maxSize: "20m",
    maxFiles: "7d",
    level: "info",
  }));
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports,
});

export default logger;
