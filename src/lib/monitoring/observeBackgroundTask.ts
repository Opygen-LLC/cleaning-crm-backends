import logger from "../logger";

export interface BackgroundTaskContext {
  operation: string;
  adminId?: string;
  entityType?: string;
  entityId?: string;
}

/**
 * Runs a non-critical task without blocking the request while guaranteeing that
 * failures remain visible in structured application logs. Use only when the
 * primary database mutation has already committed and retry can happen later.
 */
export const observeBackgroundTask = (
  task: Promise<unknown>,
  context: BackgroundTaskContext,
): void => {
  void task.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    logger.error("background_task_failed", { ...context, message, stack });
  });
};
