import { describe, expect, it } from "vitest";
import {
  projectFirstPartyRecencyBaselineComponents,
  projectFirstPartyWeeklyComponents,
  type FirstPartyWeeklyStatLine,
} from "./first-party.js";

describe("shared contextual projection means", () => {
  it("preserves cold-cache forecasts across opponents, teams, positions, weeks, and half-lives", () => {
    const history: FirstPartyWeeklyStatLine[] = Array.from({ length: 48 }, (_, index) => ({
      playerId: `player-${index % 6}`,
      position: index % 3 === 0 ? "RB" : "WR",
      season: 2025,
      week: Math.floor(index / 6) + 1,
      team: `TEAM-${index % 3}`,
      opponent: `TEAM-${(index + 1) % 3}`,
      components: {
        receiving_yards: index % 5 === 0 ? -2 : 15 + index,
        receptions: 1 + (index % 7),
        targets: 3 + (index % 7),
        receiving_touchdowns: index % 9 === 0 ? 1 : 0,
        carries: index % 3 === 0 ? 12 : 0,
        rushing_yards: index % 3 === 0 ? 40 + index : 0,
      },
    }));
    for (const position of ["WR", "RB"] as const) {
      for (const week of [9, 10]) {
        for (const recencyHalfLifeWeeks of [1, 6]) {
          for (const teamIndex of [0, 2, 1]) {
            const target = {
              playerId: "rookie",
              position,
              season: 2025,
              week,
              team: `TEAM-${teamIndex}`,
              opponent: `TEAM-${(teamIndex + 1) % 3}`,
            };
            const config = { recencyHalfLifeWeeks };
            // The recency and contextual models share the league mean. Warm either order;
            // each comparison uses a new immutable history object for an independent result.
            if (teamIndex % 2 === 0) {
              projectFirstPartyRecencyBaselineComponents({ history, target, config });
            }
            const warmed = projectFirstPartyWeeklyComponents({ history, target, config });
            expect(warmed).toEqual(
              projectFirstPartyWeeklyComponents({ history: [...history], target, config }),
            );
            const priorRows = history.filter((row) => row.week < 4);
            expect(
              projectFirstPartyWeeklyComponents({
                history,
                target: { ...target, week: 4 },
                config,
              }),
            ).toEqual(
              projectFirstPartyWeeklyComponents({
                history: priorRows,
                target: { ...target, week: 4 },
                config,
              }),
            );
          }
        }
      }
    }
  });
});
