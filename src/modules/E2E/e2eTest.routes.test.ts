import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const TOKEN = "0123456789abcdef0123456789abcdef";

type Guard = (req: Request, res: Response, next: NextFunction) => unknown;

const loadGuard = async (): Promise<Guard> => {
  process.env.E2E_TEST_TOKEN = TOKEN;
  process.env.E2E_TEST_HOOKS_ENABLED = "true";
  vi.resetModules();
  const { e2eTestRoutes } = await import("./e2eTest.routes");
  const layer = e2eTestRoutes.stack[0] as unknown as { handle: Guard };
  return layer.handle;
};

const responseStub = () => {
  const end = vi.fn();
  const status = vi.fn(() => ({ end }));
  return { response: { status } as unknown as Response, status, end };
};

describe("staging-only E2E hook guard", () => {
  beforeEach(() => {
    delete process.env.E2E_TEST_TOKEN;
    delete process.env.E2E_TEST_HOOKS_ENABLED;
    process.env.NODE_ENV = "test";
  });

  it("returns 404 in production even with hooks enabled and a valid token", async () => {
    const guard = await loadGuard();
    process.env.NODE_ENV = "production";
    const next = vi.fn();
    const { response, status, end } = responseStub();
    const request = {
      get: (name: string) => (name.toLowerCase() === "x-e2e-token" ? TOKEN : undefined),
    } as unknown as Request;

    guard(request, response, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(end).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 404 for an invalid token outside production", async () => {
    const guard = await loadGuard();
    process.env.NODE_ENV = "test";
    const next = vi.fn();
    const { response, status } = responseStub();
    const request = { get: () => "wrong-token" } as unknown as Request;

    guard(request, response, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes a valid staging request to the hook routes", async () => {
    const guard = await loadGuard();
    process.env.NODE_ENV = "test";
    const next = vi.fn();
    const { response, status } = responseStub();
    const request = {
      get: (name: string) => (name.toLowerCase() === "x-e2e-token" ? TOKEN : undefined),
    } as unknown as Request;

    guard(request, response, next);

    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});
