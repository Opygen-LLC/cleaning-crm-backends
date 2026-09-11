import winston from "winston";
import "winston-daily-rotate-file";
import { NODE_ENV } from "../config/ENV";

const REDACTED = "[REDACTED]";
const sensitiveKey = /(?:^|[_-])(authorization|cookie|set-cookie|password|passcode|otp|access[_-]?token|refresh[_-]?token|session[_-]?token|review[_-]?token|secret|api[_-]?key|client[_-]?secret|database[_-]?url|direct[_-]?url|connection[_-]?string)(?:$|[_-])/i;

const isSensitiveKey = (key: string): boolean =>
  sensitiveKey.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));

const sanitizeString = (value: string): string =>
  value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, `Bearer ${REDACTED}`)
    .replace(/\b((?:postgres(?:ql)?|mongodb(?:\+srv)?|rediss?):\/\/[^:\s/@]+:)[^@\s/]+@/gi, `$1${REDACTED}@`)
    .replace(/([?&](?:token|access_token|refresh_token|session_token|review_token|secret|api_key|otp)=)[^&#\s]+/gi, `$1${REDACTED}`)
    .replace(/\b(cookie|set-cookie)\s*:\s*[^\r\n]+/gi, `$1: ${REDACTED}`)
    .replace(/\b(otp|one[- ]time(?: password| code)?|verification code)\s*[:=]\s*[A-Za-z0-9-]{4,16}\b/gi, `$1=${REDACTED}`)
    .replace(/\b(password|passcode|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|session[_ -]?token|review[_ -]?token)\s*[:=]\s*[^\s,;]+/gi, `$1=${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED);

const sanitizeValue = (value: unknown, seen = new WeakSet<object>(), depth = 0): unknown => {
  if (typeof value === "string") return sanitizeString(value);
  if (value === null || typeof value !== "object" || depth > 8) return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, seen, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = isSensitiveKey(key)
      ? REDACTED
      : sanitizeValue(entry, seen, depth + 1);
  }
  return result;
};

const redactSensitiveFormat = winston.format((info) => {
  for (const key of Object.keys(info)) {
    if (isSensitiveKey(key)) {
      info[key] = REDACTED;
      continue;
    }
    if (key === "message" || key === "stack") {
      if (typeof info[key] === "string") info[key] = sanitizeString(info[key] as string);
      continue;
    }
    info[key] = sanitizeValue(info[key]);
  }
  return info;
})();

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
  format: winston.format.combine(
    winston.format.errors({ stack: true }),
    redactSensitiveFormat,
  ),
  transports,
});

export default logger;
