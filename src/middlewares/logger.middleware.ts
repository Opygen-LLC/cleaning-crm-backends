import { Request, Response, NextFunction } from "express";
import logger from "../lib/logger";
import {
  NODE_ENV,
  REQUEST_LOG_SAMPLE_RATE,
  SLOW_REQUEST_THRESHOLD_MS,
} from "../config/ENV";

const logRequestResponse = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const start = process.hrtime.bigint();
  const originalSend = res.send;
  res.send = function (body: any) {
    const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
    const rounded = Math.round(duration * 10) / 10;
    res.setHeader("X-Response-Time", `${rounded}ms`);
    res.setHeader("Server-Timing", `app;dur=${rounded}`);

    const shouldLog =
      NODE_ENV !== "production" ||
      duration >= SLOW_REQUEST_THRESHOLD_MS ||
      req.method !== "GET" ||
      Math.random() < REQUEST_LOG_SAMPLE_RATE;
    if (shouldLog) {
      const level = duration >= SLOW_REQUEST_THRESHOLD_MS ? "warn" : "info";
      logger[level](`${req.method} ${req.originalUrl} - ${rounded}ms`);
    }
    res.send = originalSend;
    return res.send(body);
  };

  next();
};

export default logRequestResponse;
