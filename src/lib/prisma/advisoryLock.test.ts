import { describe, expect, it } from "vitest";
import {
  acquireExtendedTextTransactionAdvisoryLock,
  acquireTextTransactionAdvisoryLock,
} from "./advisoryLock";

const captureRawQuery = () => {
  let sql = "";
  let params: unknown[] = [];

  const db = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      sql = strings.join("?");
      params = values;
      return [{ lockAcquired: 1 }];
    },
  };

  return {
    db,
    read: () => ({ sql, params }),
  };
};

describe("transaction advisory lock helpers", () => {
  it("acquires hashtext locks without projecting PostgreSQL void", async () => {
    const query = captureRawQuery();

    await acquireTextTransactionAdvisoryLock(query.db, "website:tenant-1");

    const captured = query.read();
    expect(captured.sql).toContain('SELECT 1::int AS "lockAcquired"');
    expect(captured.sql).toContain("FROM pg_advisory_xact_lock(hashtext(?))");
    expect(captured.sql).not.toContain("SELECT pg_advisory_xact_lock");
    expect(captured.params).toEqual(["website:tenant-1"]);
  });

  it("acquires hashtextextended locks without projecting PostgreSQL void", async () => {
    const query = captureRawQuery();

    await acquireExtendedTextTransactionAdvisoryLock(query.db, "booking:slot-1");

    const captured = query.read();
    expect(captured.sql).toContain('SELECT 1::int AS "lockAcquired"');
    expect(captured.sql).toContain(
      "FROM pg_advisory_xact_lock(hashtextextended(?, 0::bigint))",
    );
    expect(captured.sql).not.toContain("SELECT pg_advisory_xact_lock");
    expect(captured.params).toEqual(["booking:slot-1"]);
  });
});
