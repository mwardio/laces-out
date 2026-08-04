import { describe, expect, it } from "vitest";

import { ESPN_STALE_ON_VIEW_REPEAT_MS, shouldRequestEspnRefreshOnView } from "./espn-refresh";

describe("shouldRequestEspnRefreshOnView", () => {
  const now = 1_000_000;

  it("requests when no valid prior timestamp exists", () => {
    expect(shouldRequestEspnRefreshOnView(null, now)).toBe(true);
    expect(shouldRequestEspnRefreshOnView("requested", now)).toBe(true);
    expect(shouldRequestEspnRefreshOnView("0", now)).toBe(true);
  });

  it("suppresses another request inside the repeat interval", () => {
    expect(shouldRequestEspnRefreshOnView(String(now - 1_000), now)).toBe(false);
  });

  it("allows another request when the repeat interval has elapsed", () => {
    expect(shouldRequestEspnRefreshOnView(String(now - ESPN_STALE_ON_VIEW_REPEAT_MS), now)).toBe(
      true,
    );
  });

  it("recovers from a timestamp later than the current clock", () => {
    expect(shouldRequestEspnRefreshOnView(String(now + 1_000), now)).toBe(true);
  });
});
