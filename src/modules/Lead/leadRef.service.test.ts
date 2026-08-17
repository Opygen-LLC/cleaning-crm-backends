import { beforeEach, describe, expect, it, vi } from "vitest";

const { lockMock, txMock } = vi.hoisted(() => ({
  lockMock: vi.fn(),
  txMock: { $queryRaw: vi.fn() },
}));

vi.mock("../../lib/prisma/advisoryLock", () => ({
  acquireExtendedTextTransactionAdvisoryLock: lockMock,
}));

import { allocateLeadRef } from "./leadRef.service";

beforeEach(() => vi.clearAllMocks());

describe("allocateLeadRef", () => {
  it("serializes the shared lead sequence before allocating the next reference", async () => {
    txMock.$queryRaw.mockResolvedValue([{ maxNumber: "99" }]);

    await expect(allocateLeadRef(txMock as any)).resolves.toBe("LEAD-0100");
    expect(lockMock).toHaveBeenCalledWith(txMock, "lead-ref-sequence");
    expect(lockMock.mock.invocationCallOrder[0]).toBeLessThan(txMock.$queryRaw.mock.invocationCallOrder[0]);
  });
});
