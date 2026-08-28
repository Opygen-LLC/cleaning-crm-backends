import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  getVerifiedAccessToken: vi.fn(),
  getCookie: vi.fn(),
}));

vi.mock("../lib/utils/verifiedRequestToken", () => ({
  getVerifiedAccessToken: mocks.getVerifiedAccessToken,
}));
vi.mock("../lib/utils/cookie", () => ({
  CookieUtils: { getCookie: mocks.getCookie },
}));

import { checkAuthSession } from "./checkAuthSession";

const run = async () => {
  const req = { headers: {} } as Request;
  const next = vi.fn() as unknown as NextFunction;
  await checkAuthSession(req, {} as Response, next);
  return { req, next: next as unknown as ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCookie.mockReturnValue("access-token");
});

describe("checkAuthSession", () => {
  it("maps an expired access token to ACCESS_TOKEN_EXPIRED", async () => {
    mocks.getVerifiedAccessToken.mockReturnValue({ success: false, reason: "EXPIRED" });
    const { next } = await run();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 401,
      code: "ACCESS_TOKEN_EXPIRED",
      retryable: true,
    }));
  });

  it("maps a malformed access token to ACCESS_TOKEN_INVALID", async () => {
    mocks.getVerifiedAccessToken.mockReturnValue({ success: false, reason: "INVALID" });
    const { next } = await run();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 401,
      code: "ACCESS_TOKEN_INVALID",
      retryable: false,
    }));
  });

  it("attaches only JWT identity and performs no tenant/subscription lookup", async () => {
    mocks.getVerifiedAccessToken.mockReturnValue({
      success: true,
      data: { userId: "user-1", email: "jamie@example.com", role: "ADMIN" },
    });
    const { req, next } = await run();
    expect(req.user).toEqual({ id: "user-1", email: "jamie@example.com", role: "ADMIN" });
    expect(next).toHaveBeenCalledWith();
  });
});
