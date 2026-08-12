import logger from "../lib/logger";

export const log = (msg: string) => logger.info(`[CRON] ${msg}`);

export const fail = (job: string, err: unknown) =>
    logger.error(`[CRON][${job}] Failed`, err);
