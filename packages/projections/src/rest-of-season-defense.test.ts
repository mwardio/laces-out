import { describe, expect, it } from "vitest";
import {
  firstPartyRosSeedHash,
  projectFirstPartyRestOfSeason,
  projectFirstPartyRestOfSeasonProfiles,
} from "./rest-of-season.js";
import { projectionScoringProfileKey, scoreProjectionStatComponents } from "./scoring.js";
import { firstPartyRosDefenseInputFixture } from "./rest-of-season-defense.test-fixtures.js";

describe("ROS discrete defense integration", () => {
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
