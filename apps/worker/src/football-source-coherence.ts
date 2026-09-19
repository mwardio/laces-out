import {
  NFLVERSE_DEFENSE_SCORING_EVENTS_VERSION,
  NFLVERSE_TEAM_WEEKLY_STATS_COMPONENT_SCHEMA,
  NFLVERSE_WEEKLY_STATS_COMPONENT_SCHEMA,
} from "@laces-out/source-nflverse";

interface FootballSourceSnapshot {
  readonly key: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Current component contracts must describe the same complete football-event capture. */
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
    const team = byKey.get(`nflverse.stats-team-week.${season}`);
    const teamChecksum = team?.metadata?.playByPlayChecksumSha256;
    if (
      team?.metadata?.teamWeeklyComponentSchema !== NFLVERSE_TEAM_WEEKLY_STATS_COMPONENT_SCHEMA ||
      team?.metadata?.teamWeeklyScoringEventsVersion !== NFLVERSE_DEFENSE_SCORING_EVENTS_VERSION ||
      typeof playerChecksum !== "string" ||
      !/^[a-f0-9]{64}$/.test(playerChecksum) ||
      typeof teamChecksum !== "string" ||
      !/^[a-f0-9]{64}$/.test(teamChecksum) ||
      playerChecksum !== teamChecksum
    ) {
      throw new Error(
        `Player and team projection inputs for ${season} do not share a verified play-by-play capture with current component contracts; refresh both sources together`,
      );
    }
  }
}
