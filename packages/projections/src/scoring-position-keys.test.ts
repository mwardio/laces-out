import { describe, expect, it } from "vitest";
import {
  projectionScoringProfileKeyForPosition,
  projectionScoringRulesFromProfileKey,
} from "./scoring-position-keys.js";
import {
  projectionScoringProfileKey,
  projectionScoringProfilesAreCompatible,
  type ProjectionDefensePointsAllowedDefinition,
  type ProjectionScoringProfile,
} from "./scoring.js";

function profile(
  statDefinition?: ProjectionDefensePointsAllowedDefinition,
): ProjectionScoringProfile {
  return {
    id: "same-weights",
    rules: [
      { statId: "receiving_yards", points: 0.1 },
      { statId: "passing_yards", points: 0.04 },
      { statId: "rushing_yards", points: 0.1 },
      { statId: "field_goals_made_0_19", points: 3 },
      {
        statId: "points_allowed_0_probability",
        points: 10,
        ...(statDefinition === undefined ? {} : { statDefinition }),
      },
    ],
  };
}

describe("points-allowed semantic scoring keys", () => {
  it("distinguishes equal-weight provider definitions for D/ST while retaining offense compatibility", () => {
    const yahoo = profile("yahoo-2022-v1"),
      espn = profile("espn-2019-v1");
    expect(projectionScoringProfilesAreCompatible(yahoo, espn)).toBe(false);
    expect(projectionScoringProfileKeyForPosition(yahoo, "DST")).not.toBe(
      projectionScoringProfileKeyForPosition(espn, "DST"),
    );
    for (const position of ["QB", "RB", "WR", "TE", "K"] as const) {
      expect(projectionScoringProfileKeyForPosition(yahoo, position)).toBe(
        projectionScoringProfileKeyForPosition(espn, position),
      );
    }
  });

  it("reads legacy keys byte for byte without promoting them to an explicit current definition", () => {
    const legacyKey = '[{"statId":"points_allowed","points":-0.1,"bonuses":[]}]';
    const recovered = { id: "legacy", rules: projectionScoringRulesFromProfileKey(legacyKey) };
    expect(recovered.rules).toEqual([{ statId: "points_allowed", points: -0.1 }]);
    expect(projectionScoringProfileKey(recovered)).toBe(legacyKey);
    for (const statDefinition of ["yahoo-2022-v1", "espn-2019-v1"] as const) {
      const current = { id: "current", rules: [{ ...recovered.rules[0]!, statDefinition }] };
      expect(projectionScoringProfileKeyForPosition(recovered, "DST")).not.toBe(
        projectionScoringProfileKeyForPosition(current, "DST"),
      );
    }
  });

  it.each(["yahoo-2022-v1", "espn-2019-v1"] as const)(
    "retains %s through whole-profile and position key recovery",
    (definition) => {
      const original = profile(definition),
        key = projectionScoringProfileKey(original);
      const recovered = { id: "recovered", rules: projectionScoringRulesFromProfileKey(key) };
      expect(
        recovered.rules.find((rule) => rule.statId === "points_allowed_0_probability")
          ?.statDefinition,
      ).toBe(definition);
      expect(projectionScoringProfileKey(recovered)).toBe(key);
      expect(projectionScoringProfileKeyForPosition(recovered, "DST")).toBe(
        projectionScoringProfileKeyForPosition(original, "DST"),
      );
    },
  );

  it("refuses unknown, misplaced, or silently removable definition metadata in stored keys", () => {
    const key = projectionScoringProfileKey(profile("yahoo-2022-v1"));
    expect(() =>
      projectionScoringRulesFromProfileKey(key.replace("yahoo-2022-v1", "unknown")),
    ).toThrow();
    expect(() =>
      projectionScoringRulesFromProfileKey(
        key.replace("points_allowed_0_probability", "points_allowed_unrecognized"),
      ),
    ).toThrow();
    const legacy = projectionScoringProfileKey(profile());
    expect(() =>
      projectionScoringRulesFromProfileKey(
        legacy.replace('"bonuses":[]', '"bonuses":[],"statDefinition":null'),
      ),
    ).toThrow();
  });
});
