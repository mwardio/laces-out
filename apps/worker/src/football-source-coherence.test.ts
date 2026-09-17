import { NFLVERSE_WEEKLY_STATS_COMPONENT_SCHEMA } from "@laces-out/source-nflverse";
import { describe, expect, it } from "vitest";

import { assertFootballSourceCoherence } from "./football-source-coherence.js";

const checksum = "a".repeat(64);
const player = {
  key: "nflverse.stats-player-week.2026",
  metadata: {
    playerWeeklyComponentSchema: NFLVERSE_WEEKLY_STATS_COMPONENT_SCHEMA,
    playByPlayChecksumSha256: checksum,
  },
};
const team = {
  key: "nflverse.stats-team-week.2026",
  metadata: { playByPlayChecksumSha256: checksum },
};

describe("football source coherence", () => {
  it("accepts matching captures and ignores unrelated sources", () => {
    expect(() =>
      assertFootballSourceCoherence([player, team, { key: "nflverse.players" }]),
    ).not.toThrow();
  });

  it("rejects independently refreshed player and team captures", () => {
    expect(() =>
      assertFootballSourceCoherence([
        player,
        { ...team, metadata: { playByPlayChecksumSha256: "b".repeat(64) } },
      ]),
    ).toThrow(/2026.*verified play-by-play capture/);
  });

  it.each([undefined, null, "", "a", "x".repeat(64), 12])(
    "rejects missing or malformed capture identity %s",
    (invalid) => {
      expect(() =>
        assertFootballSourceCoherence([
          { ...player, metadata: { ...player.metadata, playByPlayChecksumSha256: invalid } },
          { ...team, metadata: { playByPlayChecksumSha256: invalid } },
        ]),
      ).toThrow(/refresh both sources together/);
    },
  );

  it("does not accept a matching capture from another season", () => {
    expect(() =>
      assertFootballSourceCoherence([player, { ...team, key: "nflverse.stats-team-week.2025" }]),
    ).toThrow(/2026/);
  });

  it("requires the current-schema player's team source and its capture metadata", () => {
    expect(() => assertFootballSourceCoherence([player])).toThrow(/2026/);
    expect(() => assertFootballSourceCoherence([player, { key: team.key }])).toThrow(/2026/);
  });

  it("leaves legacy snapshots to their existing completeness and component coverage gates", () => {
    expect(() =>
      assertFootballSourceCoherence([
        { key: player.key, metadata: { playerWeeklyComponentSchema: "legacy" } },
      ]),
    ).not.toThrow();
  });
});
