import { describe, expect, it } from "vitest";
import { providerLineupComparison } from "./provider-lineup-comparison.js";
const now = new Date("2026-09-16T12:00:00Z");
const snapshot = {
  asOfWeek: 2,
  effectiveAt: now,
  artifact: {
    kind: "weekly-box-scores",
    provider: "espn",
    providerLeagueId: "123",
    season: 2026,
    week: 2,
    playerScores: [
      { providerPlayerId: "1", projectedPoints: 8.5 },
      { providerPlayerId: "-2", projectedPoints: -1 },
    ],
  },
};
const input = {
  snapshot,
  now,
  season: 2026,
  week: 2,
  leagueSeasonId: "league",
  providerLeagueId: "123",
  identities: [
    { playerId: "receiver", source: "espn", externalId: "1" },
    { playerId: "defense", source: "espn-self-asserted", externalId: "league:-2" },
  ],
};
describe("saved ESPN projection comparison", () => {
  it("retains the current league's already-scored totals, including negative defense points", () => {
    expect([...providerLineupComparison(input)!.points]).toEqual([
      ["receiver", 8.5],
      ["defense", -1],
    ]);
  });
  it("rejects stale, future, wrong-week, wrong-season, and wrong-league evidence", () => {
    for (const changed of [
      { ...snapshot, effectiveAt: new Date(now.getTime() - 24 * 3_600_000 - 1) },
      { ...snapshot, effectiveAt: new Date(now.getTime() + 1) },
      { ...snapshot, asOfWeek: 1 },
      ...[{ week: 1 }, { season: 2025 }, { providerLeagueId: "other" }, { provider: "yahoo" }].map(
        (change) => ({ ...snapshot, artifact: { ...snapshot.artifact, ...change } }),
      ),
    ])
      expect(providerLineupComparison({ ...input, snapshot: changed })).toBeNull();
  });
  it("does not guess across ambiguous or foreign-scope player identities", () => {
    const additional = [
      { playerId: "receiver", source: "espn", externalId: "3" },
      { playerId: "duplicate", source: "espn", externalId: "1" },
    ];
    for (const identity of additional)
      expect(
        providerLineupComparison({
          ...input,
          identities: [...input.identities, identity],
        })?.points.has("receiver"),
      ).toBe(false);
    expect(
      providerLineupComparison({
        ...input,
        identities: [
          { playerId: "receiver", source: "espn-self-asserted", externalId: "another-league:1" },
        ],
      }),
    ).toBeNull();
  });
  it("ignores missing/non-finite totals and duplicate provider rows", () => {
    for (const playerScores of [
      [{ providerPlayerId: "1", projectedPoints: null }],
      [{ providerPlayerId: "1", projectedPoints: Infinity }],
      [
        { providerPlayerId: "1", projectedPoints: 8 },
        { providerPlayerId: "1", projectedPoints: 8 },
      ],
    ])
      expect(
        providerLineupComparison({
          ...input,
          snapshot: { ...snapshot, artifact: { ...snapshot.artifact, playerScores } },
        }),
      ).toBeNull();
  });
});
