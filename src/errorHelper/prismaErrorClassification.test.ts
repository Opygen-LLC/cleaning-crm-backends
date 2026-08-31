import { describe, expect, it } from "vitest";
import type { Prisma } from "../generated/prisma/client";
import {
  getPrismaErrorLogContext,
  getStatusCodeFromPrismaError,
  handlePrismaClientKnownRequestError,
} from "./handlePrismaError";

const knownError = (
  code: string,
  meta: Record<string, unknown> = {},
): Prisma.PrismaClientKnownRequestError => ({ code, meta } as unknown as Prisma.PrismaClientKnownRequestError);

describe("Prisma known request error classification", () => {
  it("maps duplicate and relational conflicts to 409", () => {
    expect(getStatusCodeFromPrismaError("P2002")).toBe(409);
    expect(handlePrismaClientKnownRequestError(knownError("P2002", { target: ["email"] })).code).toBe("DUPLICATE_RESOURCE");

    const relation = handlePrismaClientKnownRequestError(knownError("P2003"));
    expect(relation.statusCode).toBe(409);
    expect(relation.code).toBe("RELATION_CONFLICT");
  });

  it("maps not-found and timeout errors to their real HTTP classes", () => {
    expect(handlePrismaClientKnownRequestError(knownError("P2025")).statusCode).toBe(404);
    const timeout = handlePrismaClientKnownRequestError(knownError("P2024"));
    expect(timeout.statusCode).toBe(504);
    expect(timeout.code).toBe("DATABASE_TIMEOUT");
  });

  it("treats missing tables/columns as retryable 500 system failures, never validation", () => {
    for (const code of ["P2021", "P2022"]) {
      const result = handlePrismaClientKnownRequestError(
        knownError(code, { modelName: "NotificationPreference", column: "notification_preference.emailQuoteSent" }),
      );
      expect(result.statusCode).toBe(500);
      expect(result.code).toBe("DATABASE_SCHEMA_MISMATCH");
      expect(result.retryable).toBe(true);
      expect(result.fieldErrors).toEqual({});
      expect(result.errorSources).toEqual([]);
    }
  });

  it("maps raw-query and unexpected P2 errors to database server errors", () => {
    const rawQuery = handlePrismaClientKnownRequestError(knownError("P2010"));
    expect(rawQuery.statusCode).toBe(500);
    expect(rawQuery.code).toBe("DATABASE_QUERY_ERROR");

    const unexpected = handlePrismaClientKnownRequestError(knownError("P2030"));
    expect(unexpected.statusCode).toBe(500);
    expect(unexpected.code).toBe("DATABASE_ERROR");
  });

  it("extracts only safe identifier metadata for structured logs", () => {
    expect(getPrismaErrorLogContext(knownError("P2022", {
      modelName: "NotificationPreference",
      table: "notification_preference",
      column: "notification_preference.emailQuoteSent",
    }))).toEqual({
      prismaCode: "P2022",
      prismaModel: "NotificationPreference",
      prismaTable: "notification_preference",
      prismaColumn: "notification_preference.emailQuoteSent",
    });

    expect(getPrismaErrorLogContext(knownError("P2010", { column: "SELECT * FROM secrets" })).prismaColumn).toBeUndefined();
  });
});
