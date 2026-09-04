import { describe, expect, it } from "vitest";

import { visibleWaiverNotes } from "./waiver-presentation.js";

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
});
