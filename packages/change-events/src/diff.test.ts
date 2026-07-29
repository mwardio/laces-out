import { describe, expect, it } from "vitest";

import { diffRoster, isEmptyRosterDiff, rosterChecksum } from "./diff.js";

const A = "40000000-0000-4000-8000-00000000000a";
const B = "40000000-0000-4000-8000-00000000000b";
const C = "40000000-0000-4000-8000-00000000000c";

const prior = [
  { playerId: A, slotCode: "RB", isStarter: true },
  { playerId: B, slotCode: "BE", isStarter: false },
];

describe("rosterChecksum", () => {
  it("ignores row order and changes when a slot changes", () => {
    expect(rosterChecksum(prior)).toBe(rosterChecksum([...prior].reverse()));
    expect(rosterChecksum(prior)).not.toBe(
      rosterChecksum([{ playerId: A, slotCode: "BE", isStarter: false }, prior[1]!]),
    );
    expect(rosterChecksum(prior)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("normalizes the slot code the same way the lineup-lock sweep does", () => {
    expect(rosterChecksum([{ playerId: A, slotCode: " rb ", isStarter: true }])).toBe(
      rosterChecksum([{ playerId: A, slotCode: "RB", isStarter: true }]),
    );
  });
});

describe("diffRoster", () => {
  it("reports adds, drops, promotions, and benchings separately", () => {
    const diff = diffRoster(prior, [
      { playerId: A, slotCode: "BE", isStarter: false },
      { playerId: B, slotCode: "WR", isStarter: true },
      { playerId: C, slotCode: "BE", isStarter: false },
    ]);

    expect(diff).toEqual({
      added: [C],
      removed: [],
      promoted: [B],
      benched: [A],
    });
    expect(isEmptyRosterDiff(diff!)).toBe(false);
  });

  it("is empty for an identical roster, so no event is emitted", () => {
    const diff = diffRoster(prior, [...prior].reverse());

    expect(diff).toEqual({ added: [], removed: [], promoted: [], benched: [] });
    expect(isEmptyRosterDiff(diff!)).toBe(true);
  });

  it("treats an absent prior roster as a baseline rather than 15 additions", () => {
    expect(diffRoster(null, prior)).toBeNull();
  });
});
