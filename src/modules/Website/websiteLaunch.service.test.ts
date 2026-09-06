import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// Share the executable behavioral fixture with the dependency-light regression
// suite. Production TS is transpiled; only PostgreSQL/Redis/network I/O is fake.
const require = createRequire(import.meta.url);
const { fixture } = require("../../../tests/helpers/launch-fixture.cjs");

describe("first website launch", () => {
  it("commits booking, snapshot, revision, review, completion and outbox together", async () => {
    const f = fixture();
    const result = await f.launch({ expectedRevisionNumber: 5 });
    const { website, owner, revisions, events } = f.state();
    expect(f.controls.bookingCalls).toBe(1);
    expect(website.primaryBookingFormId).toBe("booking-1");
    expect(website.publishedSnapshot.website.primaryBookingFormId).toBe("booking-1");
    expect(website.status).toBe("PUBLISHED");
    expect(revisions).toHaveLength(1);
    expect(owner.onboardingCompletedAt).toBeInstanceOf(Date);
    expect(owner.onboardingCompletedSteps).toContain("review_launch");
    expect(events.size).toBe(1);
    expect(f.operations.indexOf("outbox.write")).toBeLessThan(f.operations.indexOf("commit"));
    expect(result.publicationDelivery.ready).toBe(true);
  });

  it("accepts the original expected revision on a lost-response retry", async () => {
    const f = fixture();
    await f.launch({ expectedRevisionNumber: 5 });
    const retry = await f.launch({ expectedRevisionNumber: 5 });
    expect(retry.alreadyLive).toBe(true);
    expect(f.state().revisions).toHaveLength(1);
    expect(f.controls.bookingCalls).toBe(1);
  });

  it("does not provision a booking form when booking was explicitly disabled", async () => {
    const f = fixture();
    f.state().website.bookingEnabled = false;
    const result = await f.launch();
    expect(f.controls.bookingCalls).toBe(0);
    expect(result.website.status).toBe("PUBLISHED");
    expect(result.publicationDelivery.ready).toBe(true);
  });

  it("keeps compatibility with a separately completed review", async () => {
    const f = fixture();
    f.state().owner.onboardingCompletedSteps.push("review_launch");
    await f.launch();
    expect(f.state().owner.onboardingCompletedSteps.filter((s: string) => s === "review_launch")).toHaveLength(1);
  });

  it("rolls back completion and snapshot if durable delivery cannot be recorded", async () => {
    const f = fixture();
    f.controls.failEnqueue = true;
    await expect(f.launch()).rejects.toThrow("outbox insert failed");
    expect(f.state().owner.onboardingCompletedAt).toBeNull();
    expect(f.state().website.publishedSnapshot).toBeNull();
    expect(f.state().revisions).toHaveLength(0);
  });
});
