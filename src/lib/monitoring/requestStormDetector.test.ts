import { beforeEach, describe, expect, it } from "vitest";
import { observeRequestStorm, REQUEST_STORM_CODE, resetRequestStormDetectorForTests } from "./requestStormDetector";

beforeEach(() => resetRequestStormDetectorForTests());

describe("request storm detector", () => {
  it("detects repeated same-user endpoint/status loops", () => {
    let alert = null;
    for (let index = 0; index < 9; index += 1) {
      alert = observeRequestStorm({
        identity: "user-1",
        method: "GET",
        route: "/api/v1/notification/inbox",
        statusCode: 404,
      }, index * 500);
    }
    expect(alert).toMatchObject({ code: REQUEST_STORM_CODE, count: 9, statusCode: 404 });
  });

  it("does not group different identities", () => {
    for (let index = 0; index < 8; index += 1) {
      expect(observeRequestStorm({ identity: `user-${index}`, method: "GET", route: "/x", statusCode: 404 }, 1_000)).toBeNull();
    }
  });
});
