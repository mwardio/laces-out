import {
  inSeasonDecisionSnapshotSchema,
  leagueAnalyticsSnapshotSchema,
  leagueListResponseSchema,
} from "@laces-out/contracts";
import { describe, expect, it } from "vitest";

import {
  demoAnalyticsSnapshot,
  demoDecisionSnapshot,
  demoLeaguePortfolio,
} from "./demo-contract-data";

/**
 * The signed-out tour renders these literals directly. TypeScript checks their shape but not zod's
 * runtime rules — string bounds, UUID format, array caps, numeric ranges — so a fixture can satisfy
 * the compiler and still be something the API could never return. Parsing them here keeps the demo
 * honest against the published contract instead of drifting into a shape no real league produces.
 */
describe("demo contract fixtures", () => {
  it("parses the demo league portfolio", () => {
    const parsed = leagueListResponseSchema.safeParse(demoLeaguePortfolio);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });

  it("parses the demo decision snapshot", () => {
    const parsed = inSeasonDecisionSnapshotSchema.safeParse(demoDecisionSnapshot);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });

  it("parses the demo analytics snapshot", () => {
    const parsed = leagueAnalyticsSnapshotSchema.safeParse(demoAnalyticsSnapshot);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });
});

describe("demo playoff odds", () => {
  const section = demoAnalyticsSnapshot.playoffOdds;

  it("is available so the signed-out tour shows the feature", () => {
    expect(section.state).toBe("available");
  });

  it("keeps every seed distribution a real distribution", () => {
    if (section.state !== "available") throw new Error("expected an available section");
    for (const team of section.teams) {
      const total = team.seedProbabilities.reduce((sum, entry) => sum + entry.probability, 0);
      expect(total).toBeCloseTo(1, 6);
    }
  });

  it("assigns each seed exactly once across the league", () => {
    if (section.state !== "available") throw new Error("expected an available section");
    const bySeed = new Map<number, number>();
    for (const team of section.teams) {
      for (const entry of team.seedProbabilities) {
        bySeed.set(entry.seed, (bySeed.get(entry.seed) ?? 0) + entry.probability);
      }
    }
    for (const total of bySeed.values()) expect(total).toBeCloseTo(1, 6);
  });

  it("fills exactly the playoff field it declares", () => {
    if (section.state !== "available") throw new Error("expected an available section");
    const total = section.teams.reduce((sum, team) => sum + team.playoffProbability, 0);
    expect(total).toBeCloseTo(section.playoffTeamCount, 6);
  });

  it("derives expected seed from its own distribution", () => {
    if (section.state !== "available") throw new Error("expected an available section");
    for (const team of section.teams) {
      const expected = team.seedProbabilities.reduce(
        (sum, entry) => sum + entry.seed * entry.probability,
        0,
      );
      expect(team.expectedSeed).toBeCloseTo(expected, 6);
    }
  });
});
