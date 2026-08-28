import { Router, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import { RedisRateLimitStore } from "../../lib/rateLimit/redisRateLimitStore";
import { UserRole } from "../../generated/prisma/enums";
import { checkAuth } from "../../middlewares/checkAuth";
import { ValidationProperty, zodValidate } from "../../middlewares/validations/zodValidation.middleware";
import { TelemetryController } from "./telemetry.controller";
import { clientErrorSchema } from "./telemetry.validation";

const router = Router();

const telemetryRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  store: new RedisRateLimitStore({
    prefix: "dashboard-client-telemetry",
    windowMs: 60_000,
    maxFallbackEntries: 10_000,
  }),
  keyGenerator: (req: Request) => `user:${req.user.id}`,
  message: {
    success: false,
    message: "Too many telemetry events",
    error: { code: "TELEMETRY_RATE_LIMITED", retryable: true },
  },
});

router.post(
  "/client-errors",
  checkAuth(UserRole.ADMIN, UserRole.STAFF, UserRole.SUPER_ADMIN),
  telemetryRateLimit,
  zodValidate(clientErrorSchema, ValidationProperty.BODY),
  TelemetryController.reportClientError,
);

export { router as telemetryRoutes };
