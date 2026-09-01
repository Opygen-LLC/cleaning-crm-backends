import { describe, expect, it } from "vitest";
import { leadValidation } from "./lead.validation";

const baseLead = {
  name: "Sarah Mitchell",
  email: "sarah@example.com",
  serviceInterest: "Deep Cleaning",
};

describe("lead create stage contract", () => {
  it("defaults new manual leads to NEW", () => {
    expect(leadValidation.createLead.parse(baseLead).stage).toBe("NEW");
  });

  it.each(["NEW", "CONTACTED", "QUOTE_SENT", "WON", "LOST"] as const)(
    "accepts %s as the initial pipeline stage",
    (stage) => {
      expect(leadValidation.createLead.parse({ ...baseLead, stage }).stage).toBe(stage);
    },
  );

  it("keeps pipeline stage separate from the optional follow-up activity", () => {
    const parsed = leadValidation.createLead.parse({
      ...baseLead,
      stage: "CONTACTED",
      initialFollowUp: {
        scheduledAt: "2026-09-03T10:00:00.000Z",
        note: "Call after quote review",
      },
    });

    expect(parsed.stage).toBe("CONTACTED");
    expect(parsed.initialFollowUp?.note).toBe("Call after quote review");
  });
});
