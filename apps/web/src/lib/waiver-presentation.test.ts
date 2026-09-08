import { describe, expect, it } from "vitest";

import {
  resolveWaiverDropId,
  visibleWaiverNotes,
  waiverComparisonRationale,
} from "./waiver-presentation.js";

describe("waiver presentation", () => {
  it("hides ESPN candidate-pool provenance while retaining waiver guidance", () => {
    expect(
      visibleWaiverNotes([
        "Evaluated 24 projected players confirmed in ESPN's latest available-player feeds.",
        "FAAB ranges are heuristic budget guidance, not bid guarantees.",
        "Sleeper add/drop momentum informs likely waiver competition, never whether a player clears the roster-value bar.",
      ]),
    ).toEqual([
      "FAAB ranges are heuristic budget guidance, not bid guarantees.",
      "Sleeper add/drop momentum informs likely waiver competition, never whether a player clears the roster-value bar.",
    ]);
  });

  it("preserves non-ESPN candidate-pool provenance", () => {
    expect(
      visibleWaiverNotes([
        "Evaluated the top 24 projected players not rostered in any latest team snapshot.",
        "No current cross-platform waiver momentum was available, so bid competition uses league-size heuristics only.",
      ]),
    ).toEqual([
      "Evaluated the top 24 projected players not rostered in any latest team snapshot.",
      "No current cross-platform waiver momentum was available, so bid competition uses league-size heuristics only.",
    ]);
  });

  it("preserves unrelated notes", () => {
    expect(
      visibleWaiverNotes(["FAAB is scaled to the sample team's remaining $67 budget."]),
    ).toEqual(["FAAB is scaled to the sample team's remaining $67 budget."]);
  });

  it("carries a legal shared drop selection into another horizon", () => {
    expect(
      resolveWaiverDropId(
        [{ id: "shared" }, { id: "recommended" }],
        [{ drop: { id: "recommended" } }],
        "shared",
      ),
    ).toBe("shared");
  });

  it("falls back to the active horizon recommendation when the shared drop is absent", () => {
    expect(
      resolveWaiverDropId(
        [{ id: "recommended" }, { id: "other" }],
        [{ drop: { id: "recommended" } }],
        "not-in-this-horizon",
      ),
    ).toBe("recommended");
  });

  it("carries a committed horizon fallback back instead of reviving the older choice", () => {
    const rosSelection = resolveWaiverDropId(
      [{ id: "ros-recommended" }],
      [{ drop: { id: "ros-recommended" } }],
      "week-only",
    );

    expect(
      resolveWaiverDropId(
        [{ id: "week-only" }, { id: "ros-recommended" }],
        [{ drop: { id: "week-only" } }],
        rosSelection,
      ),
    ).toBe("ros-recommended");
  });

  it("falls back to the first candidate and then to no selection", () => {
    expect(resolveWaiverDropId([{ id: "first" }], [], "removed")).toBe("first");
    expect(resolveWaiverDropId([], [], "removed")).toBeNull();
  });

  it("describes the selected drop with complete directional horizon copy", () => {
    expect(
      waiverComparisonRationale({
        addName: "Incoming Player",
        dropName: "Outgoing Player",
        weightedGain: 4.24,
        lineupGain: -1.25,
        horizon: { kind: "week", label: "Week 3" },
      }),
    ).toBe(
      "Adding Incoming Player while dropping Outgoing Player improves Week 3 weighted roster value by 4.2 points but reduces the projected starting lineup by 1.3 points.",
    );

    expect(
      waiverComparisonRationale({
        addName: "Incoming Player",
        dropName: "Outgoing Player",
        weightedGain: 0,
        lineupGain: 2,
        horizon: { kind: "ros" },
      }),
    ).toBe(
      "Adding Incoming Player while dropping Outgoing Player leaves rest-of-season weighted roster value unchanged and improves the projected starting core by 2.0 points.",
    );
  });
});
