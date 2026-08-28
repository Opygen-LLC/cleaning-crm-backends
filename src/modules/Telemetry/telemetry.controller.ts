import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { TelemetryService } from "./telemetry.service";

const reportClientError = catchAsync(async (req, res) => {
  await TelemetryService.reportClientError({
    userId: req.user.id,
    tenantId: req.user.adminId ?? req.user.id,
    requestId: typeof res.locals.requestId === "string" ? res.locals.requestId : null,
    traceId: typeof res.locals.traceId === "string" ? res.locals.traceId : null,
    payload: req.body,
  });
  res.status(status.NO_CONTENT).send();
});

export const TelemetryController = { reportClientError };
