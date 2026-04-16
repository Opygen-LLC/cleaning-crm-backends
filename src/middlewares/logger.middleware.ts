import { Request, Response, NextFunction } from "express";
import logger from "../lib/logger";

const logRequestResponse = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const start = Date.now();
  const originalSend = res.send;
  res.send = function (body: any) {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.originalUrl} - ${duration}ms`);
    res.send = originalSend;
    return res.send(body);
  };

  next();
};

export default logRequestResponse;
