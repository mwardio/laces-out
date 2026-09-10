import {
  playerExposureResponseSchema,
  type Freshness,
  type PlayerExposureLeague,
  type PlayerExposurePlayer,
  type PlayerExposureResponse,
  type Provider,
} from "@laces-out/contracts";
import type { Database } from "@laces-out/db";
import { sql } from "drizzle-orm";

export interface PlayerExposureRow {
  leagueId: string;
  leagueName: string;
  archived: boolean;
  provider: Provider | null;
  season: number | null;
  currentSeason: number | null;
  teamId: string | null;
  teamName: string | null;
  snapshotId: string | null;
  rosterUpdatedAt: Date | string | null;
  week: number | null;
  playerId: string | null;
  playerName: string | null;
  position: string | null;
  nflTeam: string | null;
  isStarter: boolean | null;
}

export interface PlayerExposureRepository {
  listRosterRows(userId: string): Promise<readonly PlayerExposureRow[]>;
}

export class DrizzlePlayerExposureRepository implements PlayerExposureRepository {
  constructor(private readonly db: Database) {}

  async listRosterRows(userId: string): Promise<PlayerExposureRow[]> {
    // One statement keeps membership, claims and roster selection on one database snapshot.
    // LEFT joins retain missing and explicitly empty rosters for honest coverage/denominators.
    const rows = await this.db.execute<PlayerExposureRow & Record<string, unknown>>(sql`
      with accessible as (
        select l.id as "leagueId", l.name as "leagueName", l.archived,
          season.provider, season.season,
          team.id as "teamId", team.name as "teamName"
        from league_memberships membership
        join leagues l on l.id = membership.league_id
        left join lateral (
          select id, provider, season
          from league_seasons
          where league_id = l.id
          order by season desc, updated_at desc, id desc
          limit 1
        ) season on true
        left join fantasy_teams team on team.id = membership.claimed_fantasy_team_id
          and team.league_season_id = season.id
        where membership.user_id = ${userId}::uuid
      ), coverage as (
        select accessible.*,
          max(season) filter (where not archived) over () as "currentSeason"
        from accessible
      )
      select coverage.*, snapshot.id as "snapshotId",
        snapshot.effective_at as "rosterUpdatedAt", snapshot.week,
        player.id as "playerId", player.full_name as "playerName",
        player.primary_position as position, player.nfl_team as "nflTeam",
        entry.is_starter as "isStarter"
      from coverage
      left join lateral (
        select id, effective_at, week
        from roster_snapshots
        where team_id = coverage."teamId" and season = coverage.season
          and not coverage.archived and coverage.season = coverage."currentSeason"
        order by effective_at desc, created_at desc, id desc
        limit 1
      ) snapshot on true
      left join roster_entries entry on entry.snapshot_id = snapshot.id
      left join players player on player.id = entry.player_id
      order by coverage."leagueName", coverage."leagueId", player.full_name, player.id
    `);
    return [...rows];
  }
}

function rosterFreshness(observedAt: Date, now: Date): Freshness {
  const minutes = Math.max(0, Math.floor((now.getTime() - observedAt.getTime()) / 60_000));
  const hours = minutes / 60;
  const age =
    minutes < 1
      ? "just now"
      : minutes < 60
        ? `${minutes}m ago`
        : hours < 48
          ? `${Math.floor(hours)}h ago`
          : `${Math.floor(hours / 24)}d ago`;
  return {
    state: hours <= 6 ? "fresh" : hours <= 24 ? "aging" : "stale",
    observedAt: observedAt.toISOString(),
    label: `Roster synced ${age}`,
  };
}

export function buildPlayerExposureSummary(
  rows: readonly PlayerExposureRow[],
  now: Date,
): PlayerExposureResponse {
  const leagues = new Map<string, PlayerExposureLeague>();
  const players = new Map<string, PlayerExposurePlayer>();
  const season = rows[0]?.currentSeason ?? null;

  for (const row of rows) {
    const status: PlayerExposureLeague["status"] = row.archived
      ? "archived"
      : row.season === null
        ? "no-season"
        : row.season !== season
          ? "other-season"
          : row.teamId === null
            ? "team-unclaimed"
            : row.snapshotId === null
              ? "roster-missing"
              : "included";
    const observedAt = row.rosterUpdatedAt ? new Date(row.rosterUpdatedAt) : null;
    if (!leagues.has(row.leagueId)) {
      leagues.set(row.leagueId, {
        id: row.leagueId,
        name: row.leagueName,
        provider: row.provider,
        season: row.season,
        teamId: row.teamId,
        teamName: row.teamName,
        status,
        rosterUpdatedAt: observedAt?.toISOString() ?? null,
        week: row.week,
        freshness: observedAt ? rosterFreshness(observedAt, now) : null,
      });
    }
    if (status !== "included" || !row.playerId) continue;
    let player = players.get(row.playerId);
    if (!player) {
      player = {
        id: row.playerId,
        name: row.playerName!,
        position: row.position!,
        nflTeam: row.nflTeam,
        leagueIds: [],
        starterLeagueIds: [],
        rosterPercentage: 0,
      };
      players.set(row.playerId, player);
    }
    if (!player.leagueIds.includes(row.leagueId)) player.leagueIds.push(row.leagueId);
    if (row.isStarter && !player.starterLeagueIds.includes(row.leagueId)) {
      player.starterLeagueIds.push(row.leagueId);
    }
  }

  const includedCount = [...leagues.values()].filter(
    (league) => league.status === "included",
  ).length;
  for (const player of players.values()) {
    player.leagueIds.sort();
    player.starterLeagueIds.sort();
    player.rosterPercentage = Math.round((player.leagueIds.length / includedCount) * 100);
  }
  return playerExposureResponseSchema.parse({
    generatedAt: now.toISOString(),
    season,
    leagues: [...leagues.values()].sort(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    ),
    players: [...players.values()].sort(
      (left, right) =>
        right.leagueIds.length - left.leagueIds.length ||
        right.starterLeagueIds.length - left.starterLeagueIds.length ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    ),
  });
}

export class PlayerExposureService {
  constructor(
    private readonly repository: PlayerExposureRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getExposure(userId: string): Promise<PlayerExposureResponse> {
    return buildPlayerExposureSummary(await this.repository.listRosterRows(userId), this.now());
  }
}
