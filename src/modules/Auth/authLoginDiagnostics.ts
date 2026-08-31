import logger from "../../lib/logger";
import { getRequestTrace } from "../../lib/monitoring/requestTrace";
import { RELEASE_VERSION } from "../../config/ENV";

export type AuthLoginStage =
  | "AUTH_LOGIN_STARTED"
  | "AUTH_CREDENTIAL_ACCEPTED"
  | "AUTH_SESSION_CREATED"
  | "AUTH_ACCOUNT_VALIDATED"
  | "AUTH_TOKEN_PAIR_CREATED"
  | "AUTH_REFRESH_BOUND"
  | "AUTH_COOKIES_CREATED"
  | "AUTH_LOGIN_COMPLETED"
  | "AUTH_LOGIN_FAILED";

/**
 * Privacy-safe login stage diagnostics.
 *
 * This deliberately accepts only stage/timing/error classification metadata.
 * Credentials, email addresses, OTPs and token values cannot be passed through
 * this API, which prevents accidental secret logging while still allowing one
 * browser X-Request-Id to be followed through the complete login pipeline.
 */
export const logAuthLoginStage = (
  stage: AuthLoginStage,
  details: {
    durationMs?: number;
    errorCode?: string | null;
    errorName?: string | null;
  } = {},
): void => {
  const trace = getRequestTrace();
  logger.info("auth_login_stage", {
    event: "auth_login_stage",
    stage,
    requestId: trace?.requestId ?? "unknown",
    traceId: trace?.traceId ?? "unknown",
    releaseSha: RELEASE_VERSION,
    ...(details.durationMs !== undefined
      ? { durationMs: Math.round(Math.max(0, details.durationMs) * 10) / 10 }
      : {}),
    ...(details.errorCode ? { errorCode: details.errorCode } : {}),
    ...(details.errorName ? { errorName: details.errorName } : {}),
  });
};
