import { describe, expect, it } from "vitest";

import { projectionLockWindowState } from "./projection-lock-window.js";

describe("projection lock window", () => {
  const now = new Date("2026-09-13T16:00:00.000Z");

  it("activates before the next scheduled kickoff and forces one final close check", () => {
    expect(
      projectionLockWindowState(
        [{ status: "scheduled", kickoffAt: new Date("2026-09-13T18:00:00.000Z") }],
        now,
      ),
    ).toEqual({
      active: true,
      forceFinalCheck: false,
      nextKickoffAt: "2026-09-13T18:00:00.000Z",
    });
    expect(
      projectionLockWindowState(
        [{ status: "scheduled", kickoffAt: new Date("2026-09-13T16:08:00.000Z") }],
        now,
      ),
    ).toMatchObject({ active: true, forceFinalCheck: true });
  });

  it("ignores distant, unknown, postponed, cancelled, and already-started games", () => {
    expect(
      projectionLockWindowState(
        [
          { status: "scheduled", kickoffAt: new Date("2026-09-13T20:00:00.000Z") },
          { status: "scheduled", kickoffAt: null },
          { status: "postponed", kickoffAt: new Date("2026-09-13T16:05:00.000Z") },
          { status: "cancelled", kickoffAt: new Date("2026-09-13T16:05:00.000Z") },
          { status: "in-progress", kickoffAt: new Date("2026-09-13T15:55:00.000Z") },
        ],
        now,
      ),
    ).toEqual({
      active: false,
      forceFinalCheck: false,
      nextKickoffAt: "2026-09-13T20:00:00.000Z",
    });
  });
});
