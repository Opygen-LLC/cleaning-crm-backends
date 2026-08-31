import { describe, expect, it } from "vitest";
import {
  handleDatabaseConnectivityError,
  isDatabaseConnectivityError,
} from "./handlePrismaError";

describe("database connectivity error classification", () => {
  it("recognises a raw ETIMEDOUT pg error", () => {
    const error = Object.assign(new Error("connect ETIMEDOUT 10.0.0.5:5432"), { code: "ETIMEDOUT" });
    expect(isDatabaseConnectivityError(error)).toBe(true);
  });

  it("recognises a wrapped driver cause", () => {
    const error = new Error("authentication service failed", {
      cause: Object.assign(new Error("network unreachable"), { code: "ENETUNREACH" }),
    });
    expect(isDatabaseConnectivityError(error)).toBe(true);
  });

  it("does not classify ordinary application errors as database outages", () => {
    expect(isDatabaseConnectivityError(new Error("Email or password is incorrect"))).toBe(false);
  });

  it("returns a safe retryable 503 contract without leaking driver fields", () => {
    const result = handleDatabaseConnectivityError(
      Object.assign(new Error("connect ETIMEDOUT db.internal:5432"), { code: "ETIMEDOUT" }),
    );

    expect(result.statusCode).toBe(503);
    expect(result.code).toBe("DATABASE_UNAVAILABLE");
    expect(result.retryable).toBe(true);
    expect(result.errorSources).toEqual([]);
    expect(result.fieldErrors).toEqual({});
    expect(result.message).not.toContain("ETIMEDOUT");
    expect(result.message).not.toContain("db.internal");
  });
});
