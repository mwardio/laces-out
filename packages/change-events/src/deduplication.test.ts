import { describe, expect, it } from "vitest";

import { changeEventDeduplicationKey } from "./deduplication.js";

const PLAYER_ID = "40000000-0000-4000-8000-000000000001";
const TEAM_ID = "30000000-0000-4000-8000-000000000001";
const SEASON_ID = "60000000-0000-4000-8000-000000000001";
const LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const HEALTHY = "a".repeat(64);
const QUESTIONABLE = "b".repeat(64);
const QUESTIONABLE_AGAIN = "c".repeat(64);

describe("changeEventDeduplicationKey", () => {
  it("keeps a legible prefix and a bounded length", () => {
    const key = changeEventDeduplicationKey({
      kind: "league.sync.completed",
      provider: "espn",
      leagueSeasonId: SEASON_ID,
      artifactId: HEALTHY,
    });

    expect(key.startsWith("league.sync.completed:")).toBe(true);
    expect(key.length).toBeLessThanOrEqual(200);
    expect(key).toMatch(/^[a-z.]+:[a-f0-9]{64}$/u);
  });

  it("collapses a replay of the same transition", () => {
    const parts = {
      kind: "roster.changed" as const,
      teamId: TEAM_ID,
      season: 2026,
      week: 4,
      priorRosterChecksum: HEALTHY,
      nextRosterChecksum: QUESTIONABLE,
      artifactId: "d".repeat(64),
    };

    expect(changeEventDeduplicationKey(parts)).toBe(changeEventDeduplicationKey({ ...parts }));
  });

  it("does not swallow a later genuine recurrence of the same status", () => {
    const base = {
      kind: "player.injury.changed" as const,
      playerId: PLAYER_ID,
      leagueId: LEAGUE_ID,
      season: 2026,
      week: 4,
    };
    const first = changeEventDeduplicationKey({
      ...base,
      priorStateKey: null,
      nextStateKey: QUESTIONABLE,
    });
    const recovered = changeEventDeduplicationKey({
      ...base,
      priorStateKey: QUESTIONABLE,
      nextStateKey: HEALTHY,
    });
    // The state key hashes `dateModified`, so a second questionable report is a distinct state.
    const relapsed = changeEventDeduplicationKey({
      ...base,
      priorStateKey: HEALTHY,
      nextStateKey: QUESTIONABLE_AGAIN,
    });

    expect(new Set([first, recovered, relapsed]).size).toBe(3);
  });

  it("separates one player's injury transition per rostering league", () => {
    const base = {
      kind: "player.injury.changed" as const,
      playerId: PLAYER_ID,
      season: 2026,
      week: 4,
      priorStateKey: HEALTHY,
      nextStateKey: QUESTIONABLE,
    };

    expect(changeEventDeduplicationKey({ ...base, leagueId: LEAGUE_ID })).not.toBe(
      changeEventDeduplicationKey({ ...base, leagueId: "20000000-0000-4000-8000-00000000000f" }),
    );
  });

  it("separates a repeated roster transition by the sync artifact that produced it", () => {
    const base = {
      kind: "roster.changed" as const,
      teamId: TEAM_ID,
      season: 2026,
      week: 4,
      priorRosterChecksum: HEALTHY,
      nextRosterChecksum: QUESTIONABLE,
    };

    expect(changeEventDeduplicationKey({ ...base, artifactId: "1".repeat(64) })).not.toBe(
      changeEventDeduplicationKey({ ...base, artifactId: "2".repeat(64) }),
    );
  });

  it("is stable under key ordering and distinct across users", () => {
    const a = changeEventDeduplicationKey({
      kind: "recommendation.changed",
      leagueSeasonId: SEASON_ID,
      fantasyTeamId: TEAM_ID,
      userId: USER_ID,
      priorFingerprint: null,
      nextFingerprint: HEALTHY,
      inputChecksum: QUESTIONABLE,
    });
    const b = changeEventDeduplicationKey({
      inputChecksum: QUESTIONABLE,
      nextFingerprint: HEALTHY,
      priorFingerprint: null,
      userId: USER_ID,
      fantasyTeamId: TEAM_ID,
      leagueSeasonId: SEASON_ID,
      kind: "recommendation.changed",
    });
    const other = changeEventDeduplicationKey({
      kind: "recommendation.changed",
      leagueSeasonId: SEASON_ID,
      fantasyTeamId: TEAM_ID,
      userId: "10000000-0000-4000-8000-00000000000f",
      priorFingerprint: null,
      nextFingerprint: HEALTHY,
      inputChecksum: QUESTIONABLE,
    });

    expect(a).toBe(b);
    expect(a).not.toBe(other);
  });
});
