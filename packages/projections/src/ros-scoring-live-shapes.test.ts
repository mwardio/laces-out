import { describe, expect, it } from "vitest";

import { normalizeLeagueScoringProfile } from "./league-scoring.js";
import fixtures from "./ros-scoring-live-shapes.fixture.json";
import {
  isRosScoringProfileKey,
  rosAvailableProjectionStatIds,
  rosScoringProfile,
} from "./ros-scoring-profiles.js";
import { projectionScoringProfileKey, scoreProjectionStatComponents } from "./scoring.js";

describe("exact provider scoring shapes observed 2026-09-17", () => {
  it.each(fixtures)("matches normalized provider rules exactly for $key", (fixture) => {
    const normalized = normalizeLeagueScoringProfile({
      id: "provider-shape-regression",
      rows: fixture.rules.map((row) => ({ ...row, provider: fixture.provider })),
      availableStatIds: rosAvailableProjectionStatIds(),
    });
    expect(normalized.state).toBe("available");
    if (normalized.state !== "available") throw new Error("Expected supported provider rules");
    expect(normalized.positions.every((position) => position.supported)).toBe(true);
    if (!isRosScoringProfileKey(fixture.key)) throw new Error("Expected catalog profile");
    const entry = rosScoringProfile(fixture.key);
    expect(entry.scoringProfileKey).toBe(projectionScoringProfileKey(normalized.profile));
    expect(entry.digest).toBe(fixture.digest);
  });

  it("keeps plain ESPN PPR free of yardage bonuses and prices its 60-plus kicker bracket", () => {
    const profile = rosScoringProfile("espn-ppr-4pt-pass").profile;
    expect(scoreProjectionStatComponents({ passing_touchdowns: 1, receptions: 2 }, profile)).toBe(
      6,
    );
    expect(scoreProjectionStatComponents({ passing_yards_300_399_probability: 1 }, profile)).toBe(
      0,
    );
    expect(scoreProjectionStatComponents({ field_goals_made_60_plus: 1 }, profile)).toBe(6);
  });

  it("prices the exact half-PPR 3/5-point yardage tiers", () => {
    const profile = rosScoringProfile("espn-half-ppr-yardage-bonus-4pt-pass").profile;
    expect(
      scoreProjectionStatComponents(
        {
          passing_yards: 400,
          passing_yards_400_plus_probability: 1,
          rushing_yards: 200,
          rushing_yards_200_plus_probability: 1,
          receiving_yards: 100,
          receiving_yards_100_199_probability: 1,
          receptions: 1,
        },
        profile,
      ),
    ).toBe(59.5);
    expect(scoreProjectionStatComponents({ yards_allowed_0_99_probability: 1 }, profile)).toBe(0);
  });

  it("retains Yahoo's interception penalty, aggregate conversions, and native kicker brackets", () => {
    const profile = rosScoringProfile("yahoo-half-ppr").profile;
    expect(scoreProjectionStatComponents({ passing_interceptions: 1 }, profile)).toBe(-1);
    expect(scoreProjectionStatComponents({ two_point_conversions: 1 }, profile)).toBe(2);
    expect(
      scoreProjectionStatComponents(
        { field_goals_made_0_19: 1, field_goals_made_20_29: 1 },
        profile,
      ),
    ).toBe(6);
    expect(scoreProjectionStatComponents({ field_goals_missed: 1 }, profile)).toBe(0);
  });

  it("retains return-yard and field-goal-distance scoring without substituting fixed brackets", () => {
    const profile = rosScoringProfile("yahoo-half-ppr-return-yards-fg-distance").profile;
    expect(
      scoreProjectionStatComponents({ return_yards: 100, field_goals_total_yards: 50 }, profile),
    ).toBeCloseTo(5.67);
    expect(scoreProjectionStatComponents({ field_goals_made_50_plus: 1 }, profile)).toBe(0);
    expect(
      scoreProjectionStatComponents(
        { fourth_down_stops: 1, points_allowed_0_probability: 1 },
        profile,
      ),
    ).toBe(16);
  });
});
