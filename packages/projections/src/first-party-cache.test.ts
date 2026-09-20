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

describe("exact primitive memoization", () => {
  it("preserves frozen inputs and separates replacement components including missing evidence", () => {
    const components = Object.freeze({
      receiving_yards: 42,
      receptions: 4,
      targets: 6,
      receiving_touchdowns: 1,
      receiving_touchdowns_40_plus: 1,
      receiving_touchdowns_50_plus: 0,
    });
    const makeHistory = (value: typeof components | Readonly<Record<string, number>>) =>
      Object.freeze(
        Array.from({ length: 8 }, (_, index) =>
          Object.freeze({
            playerId: "receiver",
            position: "WR",
            season: 2025,
            week: index + 1,
            team: "BUF",
            opponent: "MIA",
            components: value,
          }),
        ),
      );
    const history = makeHistory(components);
    const before = JSON.stringify(history);
    const target = Object.freeze({
      playerId: "receiver",
      position: "WR",
      season: 2025,
      week: 9,
      team: "BUF",
      opponent: "MIA",
    });
    const original = projectFirstPartyWeeklyComponents({ history, target });
    projectFirstPartyRecencyBaselineComponents({ history, target });
    expect(projectFirstPartyWeeklyComponents({ history, target })).toEqual(original);
    expect(JSON.stringify(history)).toBe(before);
    expect(() => Object.assign(components, { receiving_yards: 0 })).toThrow(TypeError);
    const replaced = Object.freeze({ ...components, receiving_yards: 0 });
    const changed = projectFirstPartyWeeklyComponents({ history: makeHistory(replaced), target });
    expect(changed.components.receiving_yards).not.toBe(original.components.receiving_yards);
    const missing = Object.freeze({
      receiving_yards: 42,
      receptions: 4,
      targets: 6,
      receiving_touchdowns: 1,
    });
    expect(
      projectFirstPartyWeeklyComponents({ history: makeHistory(missing), target }).components,
    ).not.toHaveProperty("receiving_touchdowns_40_plus");
    expect(projectFirstPartyWeeklyComponents({ history, target })).toEqual(original);
  });

  it("preserves exact results after bounded half-life and distance caches cycle", () => {
    const history = Object.freeze(
      Array.from({ length: 3 }, (_, index) =>
        Object.freeze({
          playerId: "receiver",
          position: "WR",
          season: 2025,
          week: index + 1,
          team: "BUF",
          opponent: "MIA",
          components: Object.freeze({ receiving_yards: 23 + index, targets: 5, receptions: 3 }),
        }),
      ),
    );
    const target = {
      playerId: "receiver",
      position: "WR",
      season: 2025,
      week: 4,
      team: "BUF",
      opponent: "MIA",
    };
    const original = projectFirstPartyWeeklyComponents({ history, target });
    for (let index = 0; index < 12; index += 1)
      projectFirstPartyWeeklyComponents({
        history,
        target,
        config: { recencyHalfLifeWeeks: index + 0.125 },
      });
    for (let distance = 4; distance < 1_034; distance += 1)
      projectFirstPartyRecencyBaselineComponents({
        history,
        target: { ...target, week: distance },
      });
    expect(projectFirstPartyWeeklyComponents({ history, target })).toEqual(original);
  });
});
