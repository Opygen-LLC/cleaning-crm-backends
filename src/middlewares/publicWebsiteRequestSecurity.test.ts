import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const resolveHost = vi.fn();

vi.mock("../config/ENV", () => ({ NODE_ENV: "production" }));
vi.mock("../modules/Website/websiteHostResolver.service", () => ({
  WebsiteHostResolverService: { resolveHost },
}));
vi.mock("../modules/Website/publicWebsite.service", () => ({
  PublicWebsiteService: { resolveIdentifier: vi.fn() },
}));

import { publicDocumentMutationOriginGuard } from "./publicWebsiteRequestSecurity";

const makeRequest = (input: { websiteId?: string; origin?: string }) => ({
  params: { websiteId: input.websiteId ?? "site-1" },
  get(name: string) {
    if (name.toLowerCase() === "origin") return input.origin;
    return undefined;
  },
} as unknown as Request);

const makeResponse = () => {
  const state = { statusCode: 200, body: undefined as unknown, headers: new Map<string, string>() };
  const res = {
    locals: {},
    setHeader(name: string, value: string) { state.headers.set(name.toLowerCase(), String(value)); },
    status(code: number) { state.statusCode = code; return this; },
    json(body: unknown) { state.body = body; return this; },
  } as unknown as Response;
  return { res, state };
};

const run = async (request: Request) => {
  const { res, state } = makeResponse();
  const next = vi.fn() as unknown as NextFunction;
  await publicDocumentMutationOriginGuard(request, res, next);
  return { state, next };
};

describe("publicDocumentMutationOriginGuard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows a live Origin bound to the route websiteId", async () => {
    resolveHost.mockResolvedValue({ websiteId: "site-1", availability: "live" });
    const { state, next } = await run(makeRequest({ origin: "https://softriple-4.cleaningcrm.opygen.com" }));
    expect(state.statusCode).toBe(200);
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects a different tenant Origin even when it is a valid website", async () => {
    resolveHost.mockResolvedValue({ websiteId: "site-2", availability: "live" });
    const { state, next } = await run(makeRequest({ origin: "https://other.cleaningcrm.opygen.com" }));
    expect(next).not.toHaveBeenCalled();
    expect(state.statusCode).toBe(403);
    expect(state.body).toMatchObject({ code: "PUBLIC_DOCUMENT_ORIGIN_MISMATCH" });
  });

  it("rejects missing Origin in production", async () => {
    const { state, next } = await run(makeRequest({}));
    expect(next).not.toHaveBeenCalled();
    expect(state.statusCode).toBe(403);
    expect(state.body).toMatchObject({ code: "PUBLIC_DOCUMENT_ORIGIN_REQUIRED" });
  });
});
