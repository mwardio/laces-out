import { describe, expect, it } from "vitest";

import { preferNewerDraftSnapshot } from "./draft-session-refresh.js";

function snapshot(id: string, sequence: number, updatedAt: string) {
  return { id, sequence, updatedAt, marker: [id, sequence, updatedAt].join("-") };
}

describe("draft session background refresh", () => {
  it("accepts only a provably newer response for the same room", () => {
    const current = snapshot("room", 4, "2026-07-16T12:00:00.000Z");
    const newerEvent = snapshot("room", 5, "2026-07-16T11:59:00.000Z");
    const newerTimestamp = snapshot("room", 4, "2026-07-16T08:00:01.000-04:00");

    expect(preferNewerDraftSnapshot(current, newerEvent)).toBe(newerEvent);
    expect(preferNewerDraftSnapshot(current, newerTimestamp)).toBe(newerTimestamp);
  });

  it("cannot replace a post-mutation snapshot or a different room", () => {
    const current = snapshot("room", 5, "2026-07-16T12:00:01.000Z");
    const stale = snapshot("room", 4, "2026-07-16T12:00:02.000Z");
    const otherRoom = snapshot("other", 6, "2026-07-16T12:00:03.000Z");

    expect(preferNewerDraftSnapshot(current, stale)).toBe(current);
    expect(preferNewerDraftSnapshot(current, otherRoom)).toBe(current);
    expect(preferNewerDraftSnapshot(null, otherRoom)).toBeNull();
  });
});
