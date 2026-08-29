import { describe, expect, it } from "vitest";
import { businessHoursInputSchema, businessHoursSchema, normalizeBusinessHours } from "./businessHours";

const weekdays = {
  monday: { isOpen: true, opensAt: "08:00", closesAt: "18:00" },
  tuesday: { isOpen: true, opensAt: "08:00", closesAt: "18:00" },
  wednesday: { isOpen: true, opensAt: "08:00", closesAt: "18:00" },
  thursday: { isOpen: true, opensAt: "08:00", closesAt: "18:00" },
  friday: { isOpen: true, opensAt: "08:00", closesAt: "18:00" },
  saturday: { isOpen: false, opensAt: "09:00", closesAt: "14:00" },
  sunday: { isOpen: false, opensAt: "09:00", closesAt: "14:00" },
};

describe("canonical CRM business hours", () => {
  it("accepts a structured weekly schedule", () => {
    expect(businessHoursSchema.parse({ timezone: "Europe/London", ...weekdays }).monday.isOpen).toBe(true);
  });

  it("hydrates JSON fields sent alongside multipart logo uploads", () => {
    const parsed = businessHoursInputSchema.parse(JSON.stringify({ timezone: "Europe/London", ...weekdays }));
    expect(parsed?.timezone).toBe("Europe/London");
  });

  it("normalizes partial historical schedules into all seven days", () => {
    const parsed = normalizeBusinessHours({ monday: { isOpen: true, opensAt: "9am", closesAt: "5pm" } });
    expect(parsed).toMatchObject({
      monday: { isOpen: true, opensAt: "09:00", closesAt: "17:00" },
      sunday: { isOpen: false, opensAt: "09:00", closesAt: "17:00" },
    });
  });

  it("rejects open days whose closing time is not later than opening time", () => {
    expect(() => businessHoursSchema.parse({
      ...weekdays,
      monday: { isOpen: true, opensAt: "18:00", closesAt: "08:00" },
    })).toThrow();
  });
});
