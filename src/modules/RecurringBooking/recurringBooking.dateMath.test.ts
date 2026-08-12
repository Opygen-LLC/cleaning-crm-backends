import { describe, expect, it } from "vitest";
import { RecurringFrequency, WeekDay } from "../../generated/prisma/enums";
import { advanceNextRunAt, computeNextRunAt } from "./recurringBooking.service";

describe("recurring booking date math", () => {
  it("keeps a future occurrence on the same UTC day", () => {
    expect(
      computeNextRunAt(
        new Date("2026-08-10T08:00:00.000Z"),
        WeekDay.MONDAY,
        10,
        30,
        RecurringFrequency.WEEKLY,
      ).toISOString(),
    ).toBe("2026-08-10T10:30:00.000Z");
  });

  it("moves a passed weekly occurrence to the next week", () => {
    expect(
      computeNextRunAt(
        new Date("2026-08-10T11:00:00.000Z"),
        WeekDay.MONDAY,
        10,
        30,
        RecurringFrequency.WEEKLY,
      ).toISOString(),
    ).toBe("2026-08-17T10:30:00.000Z");
  });

  it("advances biweekly schedules by exactly fourteen days", () => {
    expect(
      advanceNextRunAt(
        new Date("2026-08-10T10:30:00.000Z"),
        WeekDay.MONDAY,
        10,
        30,
        RecurringFrequency.BIWEEKLY,
      ).toISOString(),
    ).toBe("2026-08-24T10:30:00.000Z");
  });

  it("clamps month-end schedules instead of overflowing into another month", () => {
    expect(
      advanceNextRunAt(
        new Date("2027-01-31T09:15:00.000Z"),
        WeekDay.SUNDAY,
        9,
        15,
        RecurringFrequency.MONTHLY,
      ).toISOString(),
    ).toBe("2027-02-28T09:15:00.000Z");
  });

  it("handles leap-year month ends", () => {
    expect(
      advanceNextRunAt(
        new Date("2028-01-31T09:15:00.000Z"),
        WeekDay.MONDAY,
        9,
        15,
        RecurringFrequency.MONTHLY,
      ).toISOString(),
    ).toBe("2028-02-29T09:15:00.000Z");
  });
});
