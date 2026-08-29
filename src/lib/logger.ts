import winston from "winston";
import "winston-daily-rotate-file";
import { NODE_ENV } from "../config/ENV";

const devFormat = winston.format.printf(({ level, message, stack, ...meta }) => {
  const cleanMeta = { ...meta };
  delete cleanMeta.timestamp;
  delete cleanMeta.service;
  delete cleanMeta.splat;
  const hasMeta = Object.keys(cleanMeta).length > 0;
  const metaStr = hasMeta ? ` ${JSON.stringify(cleanMeta)}` : "";
  const errStack = stack ? `\n${stack}` : "";
  return `${level}: ${message}${metaStr}${errStack}`;
});

const consoleTransport = new winston.transports.Console({
  format: NODE_ENV === "production"
    ? winston.format.combine(winston.format.timestamp(), winston.format.json())
    : winston.format.combine(winston.format.colorize(), devFormat),
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
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json(),
    ),
  }));
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.errors({ stack: true }),
  transports,
});

export default logger;
