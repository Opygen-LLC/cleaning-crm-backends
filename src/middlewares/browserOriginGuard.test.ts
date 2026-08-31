import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

vi.mock("../config/ENV", () => ({ NODE_ENV: "production" }));
vi.mock("../config/authSecurity", () => ({
  getAuthenticatedOrigins: () => ["https://cleaningcrm.opygen.com"],
}));

import { browserOriginGuard } from "./browserOriginGuard";

function makeRequest(input: {
  method?: string;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
}) {
  const normalized = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    method: input.method ?? "POST",
    cookies: input.cookies ?? {},
    get(name: string) {
      return normalized[name.toLowerCase()];
    },
  } as unknown as Request;
}

function makeResponse() {
  const response = { statusCode: 200, body: undefined as unknown, locals: {} as Record<string, unknown> };
  const res = {
    locals: response.locals,
    status(code: number) {
      response.statusCode = code;
      return this;
    },
    json(body: unknown) {
      response.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, response };
}

function run(req: Request) {
  const { res, response } = makeResponse();
  const next = vi.fn() as unknown as NextFunction;
  browserOriginGuard(req, res, next);
  return { response, next };
}

describe("browserOriginGuard Phase 5 CSRF boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows safe methods without a CSRF header", () => {
    const { next } = run(makeRequest({ method: "GET", cookies: { accessToken: "cookie" } }));
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not impose browser CSRF requirements on unauthenticated/public writes", () => {
    const { next } = run(makeRequest({ method: "POST" }));
    expect(next).toHaveBeenCalledOnce();
  });

  it("blocks a cookie-authenticated write from an untrusted Origin", () => {
    const { response, next } = run(makeRequest({
      cookies: { accessToken: "cookie" },
      headers: {
        Origin: "https://attacker.example",
        "Sec-Fetch-Site": "same-site",
        "X-CSRF-Protection": "1",
      },
    }));
    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({ code: "AUTH_ORIGIN_NOT_ALLOWED" });
  });

  it("blocks a cookie-authenticated write that omits the first-party CSRF header", () => {
    const { response, next } = run(makeRequest({
      cookies: { accessToken: "cookie" },
      headers: { Origin: "https://cleaningcrm.opygen.com", "Sec-Fetch-Site": "same-origin" },
    }));
    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({ code: "CSRF_VALIDATION_FAILED" });
  });

  it("blocks cross-site authenticated mutations even when a custom header is present", () => {
    const { response, next } = run(makeRequest({
      cookies: { refreshToken: "cookie" },
      headers: {
        Origin: "https://cleaningcrm.opygen.com",
        "Sec-Fetch-Site": "cross-site",
        "X-CSRF-Protection": "1",
      },
    }));
    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({ code: "CSRF_VALIDATION_FAILED" });
  });

  it("allows a trusted same-origin authenticated mutation with the required header", () => {
    const { response, next } = run(makeRequest({
      method: "PATCH",
      cookies: { "better-auth.session_token": "cookie" },
      headers: {
        Origin: "https://cleaningcrm.opygen.com",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Protection": "1",
      },
    }));
    expect(response.statusCode).toBe(200);
    expect(next).toHaveBeenCalledOnce();
  });
});
