import type { Database } from "@laces-out/db";
import { sql } from "drizzle-orm";

/** Shared with recommendation persistence so a new saved reference cannot race cleanup. */
export const PROJECTION_RETENTION_LOCK = "laces-out:projection-retention:v1";

/**
 * Only generated weekly publications are disposable here. Keep seven days, the browser's
 * 100-version history per league/scoring profile, and 32 candidates per target week ordered
 * like the decision readers (their largest current limit is 16). Saved runs pin their inputs.
 * ROS packages, immutable model observations, and user imports have separate lifetimes.
 */
export function projectionRetentionCandidates() {
  return sql`
    with ranked as (
      select id, created_at, fetched_at,
        row_number() over (
          partition by league_season_id, season, metadata->>'scoringProfileKey'
          order by created_at desc, id desc
        ) as history_rank,
        row_number() over (
          partition by league_season_id, season, week, metadata->>'scoringProfileKey'
          order by fetched_at desc, created_at desc, id desc
        ) as target_rank
      from projection_sets
      where source = 'laces-out-first-party' and horizon = 'week'
        and created_by_user_id is null and league_season_id is not null
        and visibility = 'league' and identity_state = 'explicit'
    ), pinned as (
      select distinct jsonb_array_elements_text(
        case when jsonb_typeof(inputs->'projectionSetIds') = 'array'
          then inputs->'projectionSetIds' else '[]'::jsonb end
      ) as id from recommendation_runs
    )
    select r.id, r.created_at from ranked r
    where r.created_at < now() - interval '7 days'
      and r.fetched_at < now() - interval '7 days'
      and r.history_rank > 100 and r.target_rank > 32
      and not exists (select 1 from pinned p where p.id = r.id::text)
  `;
}

export async function inspectProjectionRetention(database: Database) {
  const [row] = await database.execute<{ eligibleSets: number }>(sql`
    select count(*)::integer as "eligibleSets" from (${projectionRetentionCandidates()}) candidates
  `);
  return row!;
}

/** One short transaction per batch; never VACUUM FULL or hold a table-wide write lock. */
export async function pruneProjectionHistory(database: Database, signal?: AbortSignal) {
  let deletedSets = 0;
  for (let batch = 0; batch < 20; batch += 1) {
    signal?.throwIfAborted();
    const removed = await database.transaction(async (transaction) => {
      await transaction.execute(sql`set local lock_timeout = '2s'`);
      await transaction.execute(sql`set local statement_timeout = '30s'`);
      const [lock] = await transaction.execute<{ acquired: boolean }>(sql`
        select pg_try_advisory_xact_lock(hashtextextended(${PROJECTION_RETENTION_LOCK}, 0)) as acquired
      `);
      if (!lock?.acquired) return [];
      return transaction.execute<{ id: string }>(sql`
        delete from projection_sets p using (
          ${projectionRetentionCandidates()}
          order by r.created_at, r.id limit 25
        ) candidates where p.id = candidates.id returning p.id
      `);
    });
    deletedSets += removed.length;
    if (removed.length < 25) break;
  }
  return { deletedSets };
}
