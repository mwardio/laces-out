import { createHash } from "node:crypto";
import type { Database } from "@laces-out/db";
import { sql } from "drizzle-orm";

export type WeeklyInputDatabase = Pick<Database, "select" | "insert" | "execute">;
export const WEEKLY_INPUT_SNAPSHOT_VERSION = "weekly-coherent-inputs-v1";
export const WEEKLY_PUBLICATION_DEADLINE_MS = 8_000;
export const WEEKLY_PUBLICATION_STATEMENT_TIMEOUT_MS = 2_000;
const checksum = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export interface WeeklySourceManifest {
  readonly version: typeof WEEKLY_INPUT_SNAPSHOT_VERSION;
  readonly checksum: string;
  readonly sources: readonly {
    readonly key: string;
    readonly required: boolean;
    readonly selected: boolean;
    readonly id: string | null;
    readonly checksum: string | null;
    readonly asOf: string | null;
  }[];
}

export interface WeeklyInputSnapshot {
  readonly version: typeof WEEKLY_INPUT_SNAPSHOT_VERSION;
  readonly sourceManifest: WeeklySourceManifest;
  readonly mutableChecksum: string;
  readonly historicalRolesChecksum: string;
}

/** Admission has already checked source health. Missing optional inputs are part of the identity. */
export function weeklySourceManifest(
  plan: { readonly required: readonly string[]; readonly optional: readonly string[] },
  selected: readonly {
    readonly id: string;
    readonly key: string;
    readonly checksum: string;
    readonly lastSuccessfulAt: Date;
  }[],
): WeeklySourceManifest {
  const byKey = new Map(selected.map((source) => [source.key, source]));
  const sources = [...new Set([...plan.required, ...plan.optional])].sort().map((key) => {
    const source = byKey.get(key);
    return {
      key,
      required: plan.required.includes(key),
      selected: source !== undefined,
      id: source?.id ?? null,
      checksum: source?.checksum ?? null,
      asOf: source?.lastSuccessfulAt.toISOString() ?? null,
    };
  });
  return {
    version: WEEKLY_INPUT_SNAPSHOT_VERSION,
    // A successful 304/check changes audit timestamps, not the facts consumed by the model.
    checksum: checksum({
      version: WEEKLY_INPUT_SNAPSHOT_VERSION,
      sources: sources.map((source) => ({
        key: source.key,
        required: source.required,
        selected: source.selected,
        id: source.id,
        checksum: source.checksum,
      })),
    }),
    sources,
  };
}

interface HistoricalRole {
  readonly playerId: string;
  readonly season: number;
  readonly week: number;
  readonly gameId: string;
  readonly position: string;
}

/** Current fantasy roles cannot stand in for catalog fallbacks used by historical observations. */
export function weeklyHistoricalRolesChecksum(input: {
  readonly weekly: readonly HistoricalRole[];
  readonly snaps: readonly HistoricalRole[];
}): string {
  const roles = (rows: readonly HistoricalRole[]) =>
    rows
      .map((row) => JSON.stringify([row.playerId, row.season, row.week, row.gameId, row.position]))
      .sort();
  return checksum({
    version: WEEKLY_INPUT_SNAPSHOT_VERSION,
    weekly: roles(input.weekly),
    snaps: roles(input.snaps),
  });
}

export function weeklyInputChangedError(): Error & { readonly code: string } {
  return Object.assign(new Error("Weekly projection inputs changed during refresh"), {
    code: "PROJECTION_INPUT_EPOCH_CHANGED",
  });
}

export interface WeeklyPublicationBudget {
  check(): void;
}

export function weeklyPublicationBudget(
  now: () => number = () => performance.now(),
): WeeklyPublicationBudget {
  const deadline = now() + WEEKLY_PUBLICATION_DEADLINE_MS;
  return {
    check() {
      if (now() >= deadline) {
        throw Object.assign(new Error("Weekly publication exceeded its input-lock budget"), {
          code: "PROJECTION_PUBLICATION_TIMEOUT",
        });
      }
    },
  };
}

/**
 * These are exactly the mutable tables read by weekly input assembly. SHARE also excludes
 * inserted rows (a missing optional source or new roster), which row locks cannot cover.
 * NOWAIT and one canonical order avoid waiting while holding an earlier input-table lock.
 * Acquire only after all model/league calculations; commit/rollback releases every lock.
 * Each statement is cancellable without killing its pooled connection. Callers check the
 * monotonic eight-second budget before/after every query: active database work can extend it by
 * at most one two-second statement. No external waits or model work belong inside this boundary.
 * Do not use PostgreSQL's backend-killing transaction_timeout: postgres-js 3.4.9 cannot reliably
 * reuse that connection after the server terminates it.
 */
export async function lockWeeklyPublicationInputs(
  database: WeeklyInputDatabase,
): Promise<WeeklyPublicationBudget> {
  const budget = weeklyPublicationBudget();
  await database.execute(sql`set local statement_timeout='2s'`);
  await database.execute(sql`lock table
    data_sources, fantasy_teams, league_seasons, player_external_ids,
    player_source_observations, players, roster_entries, roster_snapshots, scoring_rules
    in share mode nowait`);
  budget.check();
  return budget;
}

/**
 * Semantic values only: timestamps, provider refresh IDs and equivalent roster resyncs do not
 * invalidate work. Read inside the assembly snapshot, and again while publication holds SHARE
 * locks. Hashing in PostgreSQL avoids transferring the full catalog again at the write boundary.
 */
export async function readWeeklyMutableInputChecksum(
  database: WeeklyInputDatabase,
  season: number,
  sleeperSourceId: string | null,
): Promise<string> {
  const result = await database.execute<{ checksum: string }>(sql`
    with relevant_leagues as materialized (
      select id,provider,current_week,team_count from league_seasons where season=${season}
    ), relevant_teams as materialized (
      select t.id,t.league_season_id from fantasy_teams t join relevant_leagues l on l.id=t.league_season_id
    ), latest_rosters as materialized (
      select distinct on(r.team_id) r.team_id,r.id
      from roster_snapshots r join relevant_teams t on t.id=r.team_id
      order by r.team_id,r.effective_at desc,r.id
    )
    select encode(sha256(convert_to(jsonb_build_object(
      'version',${WEEKLY_INPUT_SNAPSHOT_VERSION}::text,
      'players',(select coalesce(jsonb_agg(jsonb_build_array(
        id,gsis_id,full_name,nfl_team,primary_position,status,last_season
      ) order by id),'[]'::jsonb) from players),
      'externalIds',(select coalesce(jsonb_agg(jsonb_build_array(player_id,source,external_id)
        order by source,external_id,player_id),'[]'::jsonb) from player_external_ids
        where source in('espn-self-asserted','espn','yahoo','sleeper-espn','sleeper-yahoo')),
      'statuses',(select coalesce(jsonb_agg(jsonb_build_array(player_id,gsis_id,status,injury_status,practice_participation)
        order by player_id,gsis_id,status,injury_status,practice_participation),'[]'::jsonb) from player_source_observations where source_id=${sleeperSourceId}::uuid),
      'leagues',(select coalesce(jsonb_agg(jsonb_build_array(id,provider,current_week,team_count) order by id),'[]'::jsonb) from relevant_leagues),
      'rules',(select coalesce(jsonb_agg(jsonb_build_array(r.league_season_id,r.stat_key,r.operation,r.points,r.threshold_low,r.threshold_high,r.provider_stat_id,r.position_types)
        order by r.league_season_id,r.stat_key,r.operation,r.points,r.threshold_low,r.threshold_high,r.provider_stat_id,r.position_types),'[]'::jsonb) from scoring_rules r join relevant_leagues l on l.id=r.league_season_id),
      'rosters',(select coalesce(jsonb_agg(jsonb_build_array(t.id,t.league_season_id,r.id is not null,
        (select coalesce(jsonb_agg(e.player_id order by e.player_id),'[]'::jsonb) from roster_entries e where e.snapshot_id=r.id)
      ) order by t.id),'[]'::jsonb) from relevant_teams t left join latest_rosters r on r.team_id=t.id)
    )::text,'UTF8')),'hex') as checksum`);
  const value = result[0]?.checksum;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Weekly mutable input identity could not be established");
  }
  return value;
}
