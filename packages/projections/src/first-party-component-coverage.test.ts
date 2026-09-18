import { describe, expect, it } from "vitest";

import {
  createFirstPartyWeeklyComponentCoverageInspector,
  firstPartyProjectionComponentsForPosition,
  projectFirstPartyRecencyBaselineComponents,
  projectFirstPartyWeeklyComponents,
  type FirstPartyProjectionPosition,
  type FirstPartyWeeklyStatLine,
} from "./first-party.js";
import { SCORING_LONG_TOUCHDOWN_COMPONENTS } from "./scoring.js";

const eventNames = new Set<string>(
  SCORING_LONG_TOUCHDOWN_COMPONENTS.flatMap(({ fortyPlus, fiftyPlus }) => [fortyPlus, fiftyPlus]),
);
const known = Object.fromEntries(
  SCORING_LONG_TOUCHDOWN_COMPONENTS.flatMap(({ total, fortyPlus, fiftyPlus }) => [
    [total, 0],
    [fortyPlus, 0],
    [fiftyPlus, 0],
  ]),
);
function row(
  position: FirstPartyProjectionPosition,
  week: number,
  components: Readonly<Record<string, number>> = known,
): FirstPartyWeeklyStatLine {
  return {
    playerId: "convert",
    position,
    season: 2024,
    week,
    team: "ATL",
    played: true,
    components,
  };
}

describe("cheap weekly component evidence inspection", () => {
  it.each(["QB", "RB", "WR", "TE", "K"] as const)(
    "matches actual candidate presence for complete, incomplete, and cross-position %s histories",
    (position) => {
      const target = {
        playerId: "convert",
        position,
        season: 2024,
        week: 10,
        team: "ATL",
        scheduled: true,
      };
      for (const history of [
        [row(position, 8), row(position, 9)],
        [row(position, 8, {}), row(position, 9)],
        [
          row(position === "QB" ? "TE" : "QB", 8, {
            passing_touchdowns: 0,
            passing_touchdowns_40_plus: 0,
            passing_touchdowns_50_plus: 0,
            rushing_touchdowns: 0,
            rushing_touchdowns_40_plus: 0,
            rushing_touchdowns_50_plus: 0,
          }),
          row(position, 9),
        ],
      ]) {
        const expectedKeys = firstPartyProjectionComponentsForPosition(position).filter((key) =>
          eventNames.has(key),
        );
        const contextual = projectFirstPartyWeeklyComponents({ target, history });
        const recency = projectFirstPartyRecencyBaselineComponents({ target, history });
        expect(createFirstPartyWeeklyComponentCoverageInspector(history)(target)).toEqual({
          contextualMissing: expectedKeys.filter((key) => contextual.components[key] === undefined),
          recencyMissing: expectedKeys.filter((key) => recency.components[key] === undefined),
        });
      }
    },
  );

  it("honors chronological filtering, observed eligibility, and the configured personal window", () => {
    const target = { playerId: "convert", position: "TE", season: 2024, week: 10, team: "ATL" };
    const history = [
      row("QB", 7, {}),
      row("TE", 8),
      row("TE", 9),
      row("TE", 10, {}),
      { ...row("TE", 6, {}), played: false },
      { ...row("TE", 5, {}), status: "out" as const },
    ];
    const inspect = createFirstPartyWeeklyComponentCoverageInspector(history, {
      maxPlayerGames: 2,
    });
    expect(inspect(target)).toEqual({ contextualMissing: [], recencyMissing: [] });
    const evidence = createFirstPartyWeeklyComponentCoverageInspector(history)(target);
    expect(evidence.contextualMissing).toContain("receiving_touchdowns_40_plus");
    expect(evidence.recencyMissing).toEqual([]);
  });

  it("does not turn a partial event record into known zero", () => {
    const history = [row("TE", 9, { receiving_touchdowns: 0, receiving_touchdowns_40_plus: 0 })];
    const evidence = createFirstPartyWeeklyComponentCoverageInspector(history)({
      playerId: "convert",
      position: "TE",
      season: 2024,
      week: 10,
      team: "ATL",
    });
    expect(evidence.contextualMissing).toContain("receiving_touchdowns_40_plus");
    expect(evidence.recencyMissing).toContain("receiving_touchdowns_50_plus");
  });
});
