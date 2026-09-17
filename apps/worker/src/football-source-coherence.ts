import { NFLVERSE_WEEKLY_STATS_COMPONENT_SCHEMA } from "@laces-out/source-nflverse";

interface FootballSourceSnapshot {
  readonly key: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Player touchdown and team fourth-down observations must describe the same PBP capture. */
export function assertFootballSourceCoherence(sources: readonly FootballSourceSnapshot[]): void {
  const byKey = new Map(sources.map((source) => [source.key, source]));
  for (const source of sources) {
    const match = /^nflverse\.stats-player-week\.(\d{4})$/.exec(source.key);
    if (
      !match ||
      source.metadata?.playerWeeklyComponentSchema !== NFLVERSE_WEEKLY_STATS_COMPONENT_SCHEMA
    ) {
      continue;
    }
    const season = match[1]!;
    const playerChecksum = source.metadata.playByPlayChecksumSha256;
    const teamChecksum = byKey.get(`nflverse.stats-team-week.${season}`)?.metadata
      ?.playByPlayChecksumSha256;
    if (
      typeof playerChecksum !== "string" ||
      !/^[a-f0-9]{64}$/.test(playerChecksum) ||
      typeof teamChecksum !== "string" ||
      !/^[a-f0-9]{64}$/.test(teamChecksum) ||
      playerChecksum !== teamChecksum
    ) {
      throw new Error(
        `Player and team projection inputs for ${season} do not share a verified play-by-play capture; refresh both sources together`,
      );
    }
  }
}
