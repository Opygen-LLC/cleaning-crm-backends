import status from "http-status";

export type ErrorKind =
  | "AUTH_BOOTSTRAP"
  | "AUTH_EXPIRED"
  | "PERMISSION"
  | "NOT_FOUND"
  | "TENANT_INVARIANT"
  | "LIFECYCLE_CONFLICT"
  | "VALIDATION"
  | "SYSTEM"
  | "REQUEST";

const AUTH_BOOTSTRAP_CODES = new Set(["ACCESS_TOKEN_MISSING", "REFRESH_SESSION_MISSING"]);
const AUTH_EXPIRED_CODES = new Set([
  "ACCESS_TOKEN_EXPIRED",
  "ACCESS_TOKEN_INVALID",
  "INVALID_SESSION",
  "REFRESH_SESSION_EXPIRED",
  "REFRESH_TOKEN_REUSE_DETECTED",
]);
const TENANT_INVARIANT_CODES = new Set(["TENANT_CONTEXT_RESOLUTION_FAILED"]);

export const classifyError = (statusCode: number, code: string): ErrorKind => {
  const normalized = code.trim().toUpperCase();
  if (TENANT_INVARIANT_CODES.has(normalized)) return "TENANT_INVARIANT";
  if (AUTH_BOOTSTRAP_CODES.has(normalized)) return "AUTH_BOOTSTRAP";
  if (AUTH_EXPIRED_CODES.has(normalized)) return "AUTH_EXPIRED";
  if (statusCode === status.FORBIDDEN) return "PERMISSION";
  if (statusCode === status.NOT_FOUND) return "NOT_FOUND";
  if (statusCode === status.CONFLICT) return "LIFECYCLE_CONFLICT";
  if (statusCode === status.BAD_REQUEST || statusCode === status.UNPROCESSABLE_ENTITY) return "VALIDATION";
  if (statusCode >= 500) return "SYSTEM";
  return "REQUEST";
};
