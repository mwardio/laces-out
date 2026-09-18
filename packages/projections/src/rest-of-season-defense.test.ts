import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  firstPartyRosSeedHash,
  projectFirstPartyRestOfSeason,
  projectFirstPartyRestOfSeasonProfiles,
} from "./rest-of-season.js";
import { projectionScoringProfileKey, scoreProjectionStatComponents } from "./scoring.js";
import { firstPartyRosDefenseInputFixture } from "./rest-of-season-defense.test-fixtures.js";
import { simulateFirstPartyRosOutcomes } from "./ros-outcomes.js";

describe("ROS discrete defense integration", () => {
  it.each([
    [
      "contextual",
      "defense-integration",
      "cf212883465a5af0940105e908fc205e716502137e20d7cf82c6c0c9f2b14e6a",
    ],
    [
      "contextual",
      "defense-alternate",
      "17ab26764064d154841b3a182272f83070698d6498965aca08ed09b0c4344fbb",
    ],
    [
      "availability-aware-recency",
      "defense-integration",
      "c655251c8c07162a4d0af60d0370c6f0a3b7abdc4bbab421ee0b4c22fd6a8a55",
    ],
    [
      "availability-aware-recency",
      "defense-alternate",
      "43e4a6bfb284cb3d4fa0adbf8300d0b2058d71a479fd679b437d4666e3e25cea",
    ],
  ] as const)(
    "preserves physical and scored path bytes for %s / %s",
    (strategy, seed, expected) => {
      // Captured from the pre-allocation-optimization engine: includes every physical column,
      // bye, scored distribution, expected component, seed, and provenance field.
      const input = { ...firstPartyRosDefenseInputFixture(), strategy, seed };
      const result = {
        projection: projectFirstPartyRestOfSeason(input),
        outcomes: simulateFirstPartyRosOutcomes(input),
      };
      expect(createHash("sha256").update(JSON.stringify(result)).digest("hex")).toBe(expected);
    },
  );

  it("uses realized brackets, preserves bye zeroes, and aggregates per-game scoring", () => {
    const source = firstPartyRosDefenseInputFixture();
    const totals = Array<number>(source.scenarioCount!).fill(0);
    const pointBuckets = new Set<number>();
    let illegalOutcome = false;
    let byeOutcomes = 0;
    const projection = projectFirstPartyRestOfSeason(source, undefined, (week) => {
      if (!week.available) {
        byeOutcomes += 1;
        if (Object.keys(week.components).length !== 0) illegalOutcome = true;
        return;
      }
      pointBuckets.add(week.components.points_allowed_0_probability!);
      for (const value of Object.values(week.components)) {
        if (!Number.isInteger(value)) illegalOutcome = true;
      }
      totals[week.index]! += scoreProjectionStatComponents(week.components, source.scoringProfile);
    });
    expect(illegalOutcome).toBe(false);
    expect(pointBuckets).toEqual(new Set([0, 1]));
    expect(byeOutcomes).toBe(512);
    expect(projection.expectedGames).toBe(3);
    expect(projection.weekly[1]).toMatchObject({ meanPoints: 0, p15Points: 0, p85Points: 0 });
    expect(projection.meanPoints).toBe(
      totals.reduce((sum, value) => sum + value, 0) / totals.length,
    );
    expect(projection.p85Points - projection.p15Points).toBeGreaterThan(10);
    expect(projection.provenance.seedHash).toBe(firstPartyRosSeedHash(source));
  });

  it("reuses identical physical draws across profiles and scenario-count prefixes", () => {
    const source = firstPartyRosDefenseInputFixture();
    const bonus = {
      id: "defense-custom",
      rules: [
        { statId: "defensive_sacks", points: -1, bonuses: [{ atLeast: 4, points: 7 }] },
        { statId: "yards_allowed_500_plus_probability", points: -4 },
      ],
    };
    const first = projectFirstPartyRestOfSeasonProfiles(source, [source.scoringProfile, bonus]);
    const reversed = projectFirstPartyRestOfSeasonProfiles(source, [bonus, source.scoringProfile]);
    for (const profile of [source.scoringProfile, bonus]) {
      const key = projectionScoringProfileKey(profile);
      expect(first.get(key)).toEqual(reversed.get(key));
      expect(first.get(key)).toEqual(
        projectFirstPartyRestOfSeason({ ...source, scoringProfile: profile }),
      );
    }
    const small: unknown[] = [];
    const prefix: unknown[] = [];
    projectFirstPartyRestOfSeason({ ...source, scenarioCount: 128 }, (outcome) =>
      small.push(outcome),
    );
    projectFirstPartyRestOfSeason({ ...source, scenarioCount: 256 }, (outcome) => {
      if (outcome.index < 128) prefix.push(outcome);
    });
    expect(small).toEqual(prefix);
  });

  it("rejects old fractional-input defenses and unintended duplicate production noise", () => {
    const source = firstPartyRosDefenseInputFixture();
    const { defense, ...withoutDefense } = source;
    void defense;
    expect(() => projectFirstPartyRestOfSeason(withoutDefense)).toThrow("process input");
    expect(() =>
      projectFirstPartyRestOfSeason({
        ...source,
        weeks: source.weeks.map((week) => {
          const { defenseDistributions, ...withoutDistributions } = week;
          void defenseDistributions;
          return withoutDistributions;
        }),
      }),
    ).toThrow("every scheduled week");
    expect(() =>
      projectFirstPartyRestOfSeason({
        ...source,
        role: { ...source.role, weeklyProductionVolatility: 0.15 },
      }),
    ).toThrow("production shocks");
  });
});
