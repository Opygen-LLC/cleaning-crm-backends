import type { NextFunction, Request, Response } from "express";
import type { IncomingMessage } from "node:http";

export const isInternalRoutingHeader = (name: string): boolean => {
  const key = name.toLowerCase();
  return key.startsWith("x-website-") || key.startsWith("x-middleware-") ||
    key.startsWith("x-invoke-") || key === "x-matched-path" ||
    key === "x-now-route-matches" || key === "x-nextjs-rewritten-path" ||
    key === "x-nextjs-rewritten-query";
};

/** Applies before parsers, CORS, static files, auth and every mounted router.
 * Express has its own authenticated tenant context; frontend hints are not it.
 */
export function stripIncomingRoutingHeaders(req: Pick<IncomingMessage, "headers" | "rawHeaders">): void {
  for (const name of Object.keys(req.headers)) {
    if (isInternalRoutingHeader(name)) delete req.headers[name];
  }
  // Do not leave an alternate representation for middleware to accidentally read.
  for (let index = req.rawHeaders.length - 2; index >= 0; index -= 2) {
    if (isInternalRoutingHeader(req.rawHeaders[index])) req.rawHeaders.splice(index, 2);
  }
}

export function stripInternalRoutingHeaders(req: Request, _res: Response, next: NextFunction): void {
  stripIncomingRoutingHeaders(req);
  next();
}
