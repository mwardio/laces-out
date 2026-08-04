import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import postgres from "postgres";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://fantasy:fantasy@localhost:5432/fantasy";
const sql = postgres(connectionString, { max: 1, prepare: false });

const expectedTables = [
  "ai_provider_credentials",
  "ai_usage_ledger",
  "bridge_device_leagues",
  "bridge_devices",
  "bridge_pairing_sessions",
  "browser_handoff_tokens",
  "change_event_receipts",
  "change_events",
  "data_sources",
  "adp_observations",
  "espn_league_sync_states",
  "espn_refresh_attempts",
  "import_runs",
  "invitations",
  "league_memberships",
  "matchup_snapshots",
  "nfl_schedule_observations",
  "player_injury_report_observations",
  "player_ros_projection_summaries",
  "player_snap_count_observations",
  "player_weekly_roster_observations",
  "player_weekly_stat_observations",
  "projection_model_runs",
  "projection_observations",
  "ranking_entries",
  "ranking_list_versions",
  "ranking_lists",
  "refresh_requests",
  "share_links",
  "standings_entries",
  "standings_snapshots",
  "team_weekly_stat_observations",
  "user_preferences",
  "weekly_matchups",
] as const;

const expectedTriggers = [
  "ai_usage_ledger_append_only_trigger",
  "adp_observations_append_only_trigger",
  "bridge_device_leagues_grant_trigger",
  "change_events_append_only_trigger",
  "invitations_single_use_trigger",
  "league_memberships_integrity_trigger",
  "leagues_sync_owner_membership_trigger",
  "nfl_schedule_observations_append_only_trigger",
  "player_injury_reports_append_only_trigger",
  "player_ros_projection_summaries_append_only_trigger",
  "player_ros_projection_summaries_scope_trigger",
  "player_snap_counts_append_only_trigger",
  "player_weekly_rosters_append_only_trigger",
  "player_weekly_stats_append_only_trigger",
  "projection_model_runs_append_only_trigger",
  "projection_model_runs_weekly_identity_trigger",
  "projection_observations_append_only_trigger",
  "projection_sets_ros_identity_immutable_trigger",
  "projection_sets_weekly_identity_trigger",
  "ranking_entries_immutable_trigger",
  "ranking_list_versions_10_scope_trigger",
  "ranking_list_versions_20_immutable_trigger",
  "ranking_lists_version_pointers_trigger",
  "team_weekly_stats_append_only_trigger",
] as const;

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    assert.fail(`${label} was not returned as a string`);
  }
  return value;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    assert.fail(`${label} was not returned as a record`);
  }
  return value as Record<string, unknown>;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    assert.fail(`${label} was not returned as a finite number`);
  }
  return value;
}

let savepointSequence = 0;

async function expectDatabaseRejection(
  label: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  savepointSequence += 1;
  const savepoint = `schema_smoke_${savepointSequence}`;
  await sql.unsafe(`SAVEPOINT ${savepoint}`);

  let rejected = false;
  try {
    await operation();
  } catch {
    rejected = true;
  }

  await sql.unsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await sql.unsafe(`RELEASE SAVEPOINT ${savepoint}`);
  assert.ok(rejected, `${label} should have been rejected by the database`);
}

let transactionStarted = false;

try {
  const tableRows = await sql`
    select tablename
    from pg_catalog.pg_tables
    where schemaname = 'public'
  `;
  const tableNames = new Set(tableRows.map((row) => String(row.tablename)));
  for (const tableName of expectedTables) {
    assert.ok(tableNames.has(tableName), `missing migrated table ${tableName}`);
  }

  const triggerRows = await sql`
    select tgname
    from pg_catalog.pg_trigger
    where not tgisinternal
  `;
  const triggerNames = new Set(triggerRows.map((row) => String(row.tgname)));
  for (const triggerName of expectedTriggers) {
    assert.ok(triggerNames.has(triggerName), `missing invariant trigger ${triggerName}`);
  }

  // Migration 0026. Asserted by name so a missing migration fails here rather than at the
  // first live league sync or recommendation recompute.
  const columnRows = await sql`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name in (
        'bridge_devices', 'browser_handoff_tokens', 'provider_connections',
        'recommendation_runs', 'refresh_requests'
      )
  `;
  const columnNames = new Set(columnRows.map((row) => `${row.table_name}.${row.column_name}`));
  for (const column of [
    "browser_handoff_tokens.source_session_id",
    "browser_handoff_tokens.confirmed_at",
    "bridge_devices.client_kind",
    "bridge_devices.agent_capable",
    "provider_connections.consecutive_failures",
    "provider_connections.circuit_open_until",
    "provider_connections.last_error_detail",
    "recommendation_runs.fantasy_team_id",
    "refresh_requests.expires_at",
    "refresh_requests.minimum_capture_at",
    "refresh_requests.required_artifacts",
    "refresh_requests.fulfillment_mode",
    "refresh_requests.fulfilled_by_bridge_device_id",
  ]) {
    assert.ok(columnNames.has(column), `missing migrated column ${column}`);
  }

  const indexRows = await sql`
    select indexname from pg_catalog.pg_indexes where schemaname = 'public'
  `;
  const indexNames = new Set(indexRows.map((row) => String(row.indexname)));
  assert.ok(
    indexNames.has("recommendation_runs_identity_unique"),
    "missing recommendation run replay identity index",
  );
  for (const indexName of [
    "refresh_requests_live_league_unique",
    "league_supplemental_artifact_lookup_idx",
    "espn_league_sync_states_due_idx",
    "espn_refresh_attempts_request_idx",
    "espn_refresh_attempts_device_idx",
  ]) {
    assert.ok(indexNames.has(indexName), `missing ESPN automated-sync index ${indexName}`);
  }

  const cascadeRows = await sql`
    select conname, confdeltype
    from pg_catalog.pg_constraint
    where conname in (
      'refresh_requests_league_season_id_league_seasons_id_fk',
      'espn_refresh_attempts_bridge_device_id_bridge_devices_id_fk'
    )
  `;
  const cascadeActions = new Map(
    cascadeRows.map((row) => [String(row.conname), String(row.confdeltype)]),
  );
  for (const constraintName of [
    "refresh_requests_league_season_id_league_seasons_id_fk",
    "espn_refresh_attempts_bridge_device_id_bridge_devices_id_fk",
  ]) {
    assert.equal(cascadeActions.get(constraintName), "c", `${constraintName} must cascade deletes`);
  }

  await sql.unsafe("BEGIN");
  transactionStarted = true;

  const suffix = randomUUID();
  const [owner] = await sql`
    insert into users (email, display_name)
    values (${`owner-${suffix}@example.test`}, 'Schema Owner')
    returning id
  `;
  const [friend] = await sql`
    insert into users (email, display_name)
    values (${`friend-${suffix}@example.test`}, 'Schema Friend')
    returning id
  `;
  const [outsider] = await sql`
    insert into users (email, display_name)
    values (${`outsider-${suffix}@example.test`}, 'Schema Outsider')
    returning id
  `;
  const ownerId = requiredString(owner?.id, "owner id");
  const friendId = requiredString(friend?.id, "friend id");
  const outsiderId = requiredString(outsider?.id, "outsider id");

  const [handoffSourceSession] = await sql`
    insert into sessions (user_id, token_hash, expires_at)
    values (${ownerId}, ${`source-${suffix}`}, now() + interval '30 days')
    returning id
  `;
  const handoffSourceSessionId = requiredString(
    handoffSourceSession?.id,
    "browser handoff source session id",
  );
  await sql`
    insert into browser_handoff_tokens (
      user_id, source_session_id, token_hash, destination, expires_at, staged_at, confirmed_at
    ) values (
      ${ownerId}, ${handoffSourceSessionId}, ${"H".repeat(43)}, '/settings',
      now() + interval '1 minute', now(), now()
    )
  `;
  await sql`delete from sessions where id = ${handoffSourceSessionId}`;
  const remainingBoundHandoffs = await sql`
    select id from browser_handoff_tokens where user_id = ${ownerId}
  `;
  assert.equal(
    remainingBoundHandoffs.length,
    0,
    "deleting a source session did not cascade its browser handoff",
  );

  const [league] = await sql`
    insert into leagues (user_id, name)
    values (${ownerId}, 'Schema League')
    returning id
  `;
  const leagueId = requiredString(league?.id, "league id");
  const ownerMembership = await sql`
    select role
    from league_memberships
    where league_id = ${leagueId} and user_id = ${ownerId}
  `;
  assert.equal(ownerMembership[0]?.role, "owner", "league insert did not create owner membership");

  const [otherLeague] = await sql`
    insert into leagues (user_id, name)
    values (${outsiderId}, 'Other Schema League')
    returning id
  `;
  const otherLeagueId = requiredString(otherLeague?.id, "other league id");

  const [season] = await sql`
    insert into league_seasons (
      league_id, provider, external_key, season, team_count, draft_type
    ) values (
      ${leagueId}, 'manual', ${`schema-league-${suffix}`}, 2026, 10, 'auction'
    )
    returning id
  `;
  const [otherSeason] = await sql`
    insert into league_seasons (
      league_id, provider, external_key, season, team_count, draft_type
    ) values (
      ${otherLeagueId}, 'manual', ${`other-schema-league-${suffix}`}, 2026, 10, 'snake'
    )
    returning id
  `;
  const seasonId = requiredString(season?.id, "league season id");
  const otherSeasonId = requiredString(otherSeason?.id, "other league season id");

  const [team] = await sql`
    insert into fantasy_teams (league_season_id, external_key, name)
    values (${seasonId}, ${`schema-team-${suffix}`}, 'Schema Team')
    returning id
  `;
  const [otherTeam] = await sql`
    insert into fantasy_teams (league_season_id, external_key, name)
    values (${otherSeasonId}, ${`other-schema-team-${suffix}`}, 'Other Schema Team')
    returning id
  `;
  const teamId = requiredString(team?.id, "team id");
  const otherTeamId = requiredString(otherTeam?.id, "other team id");

  await expectDatabaseRejection(
    "cross-league fantasy team claim",
    () => sql`
    insert into league_memberships (league_id, user_id, role, claimed_fantasy_team_id)
    values (${leagueId}, ${friendId}, 'manager', ${otherTeamId})
  `,
  );
  await sql`
    insert into league_memberships (
      league_id, user_id, role, claimed_fantasy_team_id, claimed_at
    ) values (${leagueId}, ${friendId}, 'manager', ${teamId}, now())
  `;
  await expectDatabaseRejection(
    "duplicate fantasy team claim",
    () => sql`
    insert into league_memberships (league_id, user_id, role, claimed_fantasy_team_id)
    values (${leagueId}, ${outsiderId}, 'viewer', ${teamId})
  `,
  );

  const tokenHash = "t".repeat(64);
  const [invitation] = await sql`
    insert into invitations (
      token_hash, email, email_hash, invited_by_user_id, role, expires_at
    ) values (
      ${tokenHash}, ${`invitee-${suffix}@example.test`}, ${"e".repeat(64)},
      ${ownerId}, 'member', now() + interval '1 day'
    )
    returning id
  `;
  const invitationId = requiredString(invitation?.id, "invitation id");
  await sql`
    update invitations
    set accepted_at = now(), accepted_by_user_id = ${friendId}
    where id = ${invitationId}
  `;
  await expectDatabaseRejection(
    "accepted invitation restoration",
    () => sql`
    update invitations
    set accepted_at = null, accepted_by_user_id = null
    where id = ${invitationId}
  `,
  );

  const [player] = await sql`
    insert into players (full_name, primary_position, eligible_positions)
    values ('Schema Player', 'WR', ${["WR"]})
    returning id
  `;
  const playerId = requiredString(player?.id, "player id");
  const [automatedSource] = await sql`
    insert into data_sources (key, name, kind)
    values (${`schema-source-${suffix}`}, 'Schema Source', 'projection')
    returning id
  `;
  const automatedSourceId = requiredString(automatedSource?.id, "automated source id");
  const [automatedSyncRun] = await sql`
    insert into sync_runs (
      kind, state, idempotency_key, started_at, finished_at, records_read, records_written,
      artifact_checksum
    ) values (
      'schema-observations', 'succeeded', ${`schema-observations-${suffix}`}, now(), now(),
      4, 4, ${"a".repeat(64)}
    )
    returning id
  `;
  const automatedSyncRunId = requiredString(automatedSyncRun?.id, "automated sync run id");
  const observationChecksum = "a".repeat(64);
  const [adpObservation] = await sql`
    insert into adp_observations (
      source_id, source_sync_run_id, external_player_id, player_id, season, scoring_format, team_count,
      roster_format, overall_adp, source_as_of, fetched_at, input_checksum
    ) values (
      ${automatedSourceId}, ${automatedSyncRunId}, ${`adp-${suffix}`}, ${playerId}, 2026, 'ppr', 12,
      'one-qb', 12.5, now(), now(), ${observationChecksum}
    )
    returning id
  `;
  const adpObservationId = requiredString(adpObservation?.id, "ADP observation id");
  await expectDatabaseRejection(
    "ADP observation mutation",
    () => sql`update adp_observations set overall_adp = 13 where id = ${adpObservationId}`,
  );
  const [projectionObservation] = await sql`
    insert into projection_observations (
      source_id, source_sync_run_id, external_player_id, player_id, kind, source_version, independence_key,
      season, week, horizon, components, source_as_of, fetched_at, input_checksum
    ) values (
      ${automatedSourceId}, ${automatedSyncRunId}, ${`projection-${suffix}`}, ${playerId}, 'stat-components',
      'schema-v1', 'schema-independent-source', 2026, 1, 'week',
      ${sql.json({ passing_yards: 250 })}, now(), now(), ${observationChecksum}
    )
    returning id
  `;
  const projectionObservationId = requiredString(
    projectionObservation?.id,
    "projection observation id",
  );
  await expectDatabaseRejection(
    "duplicate projection observation for the same week",
    () => sql`
      insert into projection_observations (
        source_id, source_sync_run_id, external_player_id, player_id, kind, source_version,
        independence_key, season, week, horizon, components, source_as_of, fetched_at,
        input_checksum
      ) values (
        ${automatedSourceId}, ${automatedSyncRunId}, ${`projection-${suffix}`}, ${playerId},
        'stat-components', 'schema-v1', 'schema-independent-source', 2026, 1, 'week',
        ${sql.json({ passing_yards: 250 })}, now(), now(), ${observationChecksum}
      )
    `,
  );
  await sql`
    insert into projection_observations (
      source_id, source_sync_run_id, external_player_id, player_id, kind, source_version,
      independence_key, season, week, horizon, components, source_as_of, fetched_at,
      input_checksum
    ) values (
      ${automatedSourceId}, ${automatedSyncRunId}, ${`projection-${suffix}`}, ${playerId},
      'stat-components', 'schema-v1', 'schema-independent-source', 2026, 2, 'week',
      ${sql.json({ passing_yards: 245 })}, now(), now(), ${observationChecksum}
    )
  `;
  await expectDatabaseRejection(
    "projection observation mutation",
    () => sql`
      update projection_observations
      set components = ${sql.json({ passing_yards: 251 })}
      where id = ${projectionObservationId}
    `,
  );
  const [weeklyStatObservation] = await sql`
    insert into player_weekly_stat_observations (
      source_id, source_sync_run_id, external_player_id, player_id, season, week, season_type, game_id,
      team, opponent_team, components, advanced, source_fantasy_points, fetched_at,
      input_checksum
    ) values (
      ${automatedSourceId}, ${automatedSyncRunId}, '00-0000001', ${playerId}, 2026, 1, 'REG',
      ${`2026_01_SCHEMA_${suffix}`}, 'CHI', 'DET', ${sql.json({ targets: 8 })},
      ${sql.json({ targetShare: 0.25 })}, ${sql.json({ standard: 10, ppr: 15 })},
      now(), ${observationChecksum}
    )
    returning id
  `;
  const weeklyStatObservationId = requiredString(
    weeklyStatObservation?.id,
    "weekly stat observation id",
  );
  await expectDatabaseRejection(
    "weekly stat observation mutation",
    () => sql`
      update player_weekly_stat_observations
      set week = 2
      where id = ${weeklyStatObservationId}
    `,
  );
  const [weeklyRosterObservation] = await sql`
    insert into player_weekly_roster_observations (
      source_id, source_sync_run_id, external_player_id, player_id, season, week, team,
      position, roster_status, status_description, fetched_at, input_checksum
    ) values (
      ${automatedSourceId}, ${automatedSyncRunId}, '00-0000001', ${playerId}, 2026, 1,
      'CHI', 'WR', 'ACT', 'Active', now(), ${observationChecksum}
    )
    returning id
  `;
  const weeklyRosterObservationId = requiredString(
    weeklyRosterObservation?.id,
    "weekly roster observation id",
  );
  await expectDatabaseRejection(
    "weekly roster observation mutation",
    () => sql`
      update player_weekly_roster_observations
      set week = 2
      where id = ${weeklyRosterObservationId}
    `,
  );
  const [injuryReportObservation] = await sql`
    insert into player_injury_report_observations (
      source_id, source_sync_run_id, external_player_id, player_id, season, week,
      season_type, game_type, team, position, report_primary_injury, report_status,
      practice_primary_injury, practice_status, state_key, fetched_at, input_checksum
    ) values (
      ${automatedSourceId}, ${automatedSyncRunId}, '00-0000001', ${playerId}, 2026, 1,
      'REG', 'REG', 'CHI', 'WR', 'Knee', 'questionable', 'Knee', 'limited',
      ${"b".repeat(64)}, now(), ${observationChecksum}
    )
    returning id
  `;
  const injuryReportObservationId = requiredString(
    injuryReportObservation?.id,
    "injury report observation id",
  );
  await expectDatabaseRejection(
    "injury report observation mutation",
    () => sql`
      update player_injury_report_observations
      set report_status = 'out'
      where id = ${injuryReportObservationId}
    `,
  );
  const [snapCountObservation] = await sql`
    insert into player_snap_count_observations (
      source_id, source_sync_run_id, external_player_id, player_id, season, week, season_type,
      game_type, game_id,
      pfr_game_id, team, opponent_team, offense_snaps, offense_share, defense_snaps,
      defense_share, special_teams_snaps, special_teams_share, fetched_at, input_checksum
    ) values (
      ${automatedSourceId}, ${automatedSyncRunId}, 'PlaySc00', ${playerId}, 2026, 1, 'REG', 'REG',
      ${`2026_01_SCHEMA_${suffix}`}, '202609130chi', 'CHI', 'DET',
      50, 0.75, 0, 0, 2, 0.1, now(), ${observationChecksum}
    )
    returning id
  `;
  const snapCountObservationId = requiredString(
    snapCountObservation?.id,
    "snap-count observation id",
  );
  await expectDatabaseRejection(
    "snap-count observation mutation",
    () => sql`
      delete from player_snap_count_observations where id = ${snapCountObservationId}
    `,
  );
  const observationGameId = `2026_01_DET_CHI_${suffix}`;
  const [scheduleObservation] = await sql`
    insert into nfl_schedule_observations (
      source_id, source_sync_run_id, external_game_id, season, week, season_type,
      game_date, start_time_eastern, time_tbd, kickoff_at, away_team, home_team,
      status, neutral_site, away_rest_days, home_rest_days, source_as_of, fetched_at,
      input_checksum
    ) values (
      ${automatedSourceId}, ${automatedSyncRunId}, ${observationGameId}, 2026, 1, 'REG',
      '2026-09-13', '12:00', false, '2026-09-13T17:00:00Z', 'DET', 'CHI',
      'scheduled', false, 7, 7, now(), now(), ${observationChecksum}
    )
    returning id
  `;
  const scheduleObservationId = requiredString(scheduleObservation?.id, "schedule observation id");
  await expectDatabaseRejection(
    "schedule observation update",
    () => sql`
      update nfl_schedule_observations
      set status = 'postponed'
      where id = ${scheduleObservationId}
    `,
  );
  await expectDatabaseRejection(
    "schedule observation deletion",
    () => sql`delete from nfl_schedule_observations where id = ${scheduleObservationId}`,
  );

  const [teamWeeklyObservation] = await sql`
    insert into team_weekly_stat_observations (
      source_id, source_sync_run_id, external_team_id, season, week, season_type,
      game_id, team, opponent_team, components, fetched_at, input_checksum
    ) values (
      ${automatedSourceId}, ${automatedSyncRunId}, 'CHI', 2026, 1, 'REG',
      ${observationGameId}, 'CHI', 'DET',
      ${sql.json({ passing_yards: 250, defensive_sacks: 3 })}, now(),
      ${observationChecksum}
    )
    returning id
  `;
  const teamWeeklyObservationId = requiredString(
    teamWeeklyObservation?.id,
    "team weekly observation id",
  );
  await expectDatabaseRejection(
    "team weekly observation update",
    () => sql`
      update team_weekly_stat_observations
      set components = ${sql.json({ passing_yards: 251, defensive_sacks: 3 })}
      where id = ${teamWeeklyObservationId}
    `,
  );
  await expectDatabaseRejection(
    "team weekly observation deletion",
    () => sql`delete from team_weekly_stat_observations where id = ${teamWeeklyObservationId}`,
  );

  const [projectionModelRun] = await sql`
    insert into projection_model_runs (
      source_sync_run_id, source_id, season, target_week, model_version,
      training_window_start_season, trained_through_season, trained_through_week,
      quality_state, players_evaluated, players_published, input_checksum,
      configuration, calibration, metrics, source_as_of
    ) values (
      ${automatedSyncRunId}, ${automatedSourceId}, 2026, 1, 'schema-v1',
      2023, 2025, 18, 'publishable', 1, 1, ${observationChecksum},
      ${sql.json({ historySeasons: 3 })}, ${sql.json({ sampleSize: 200 })},
      ${sql.json({ mae: 2.5 })}, now()
    )
    returning source_sync_run_id, horizon, target_week, window_start_week, window_end_week,
      as_of_week
  `;
  const projectionModelRunRecord = requiredRecord(projectionModelRun, "projection model run");
  const projectionModelRunId = requiredString(
    projectionModelRunRecord.source_sync_run_id,
    "projection model run id",
  );
  assert.deepEqual(
    {
      horizon: requiredString(projectionModelRunRecord.horizon, "projection model run horizon"),
      targetWeek: requiredNumber(
        projectionModelRunRecord.target_week,
        "projection model run target week",
      ),
      windowStartWeek: requiredNumber(
        projectionModelRunRecord.window_start_week,
        "projection model run window start week",
      ),
      windowEndWeek: requiredNumber(
        projectionModelRunRecord.window_end_week,
        "projection model run window end week",
      ),
      asOfWeek: requiredNumber(
        projectionModelRunRecord.as_of_week,
        "projection model run as-of week",
      ),
    },
    { horizon: "week", targetWeek: 1, windowStartWeek: 1, windowEndWeek: 1, asOfWeek: 0 },
    "legacy weekly model-run insert did not receive an isolated weekly identity",
  );
  await expectDatabaseRejection(
    "projection model run update",
    () => sql`
      update projection_model_runs
      set quality_state = 'degraded'
      where source_sync_run_id = ${projectionModelRunId}
    `,
  );
  await expectDatabaseRejection(
    "projection model run deletion",
    () => sql`
      delete from projection_model_runs where source_sync_run_id = ${projectionModelRunId}
    `,
  );

  const [managedWeeklyProjectionSet] = await sql`
    insert into projection_sets (
      league_season_id, visibility, source, version, season, week, horizon,
      fetched_at, input_checksum, metadata
    ) values (
      ${seasonId}, 'league', 'laces-out-first-party', ${`schema-managed-${suffix}`},
      2026, 1, 'week', now(), ${observationChecksum}, ${sql.json({ managed: true })}
    )
    returning id, window_start_week, window_end_week, as_of_week
  `;
  const managedWeeklyProjectionSetRecord = requiredRecord(
    managedWeeklyProjectionSet,
    "managed weekly projection set",
  );
  const managedWeeklyProjectionSetId = requiredString(
    managedWeeklyProjectionSetRecord.id,
    "managed weekly projection set id",
  );
  assert.deepEqual(
    {
      windowStartWeek: requiredNumber(
        managedWeeklyProjectionSetRecord.window_start_week,
        "managed weekly projection set window start week",
      ),
      windowEndWeek: requiredNumber(
        managedWeeklyProjectionSetRecord.window_end_week,
        "managed weekly projection set window end week",
      ),
      asOfWeek: requiredNumber(
        managedWeeklyProjectionSetRecord.as_of_week,
        "managed weekly projection set as-of week",
      ),
    },
    { windowStartWeek: 1, windowEndWeek: 1, asOfWeek: 0 },
    "legacy weekly projection-set insert did not receive an isolated weekly identity",
  );
  await expectDatabaseRejection(
    "private projection set without a creator",
    () => sql`
      insert into projection_sets (
        league_season_id, visibility, source, version, season, week, horizon,
        fetched_at, input_checksum
      ) values (
        ${seasonId}, 'private', 'schema-private', ${`schema-private-${suffix}`},
        2026, 1, 'week', now(), ${observationChecksum}
      )
    `,
  );

  const rosInputChecksum = "b".repeat(64);
  const rosSeedHash = "c".repeat(64);
  const rosCalibrationChecksum = "5".repeat(64);
  const rosConvergenceChecksum = "6".repeat(64);
  const rosIntervalCalibration = {
    schemaVersion: 1,
    state: "calibrated",
    method: "season-locked-conformal-v1",
    evidenceChecksum: rosCalibrationChecksum,
    heldOutSeasons: 3,
    batches: 30,
    samples: 300,
    nominalCoverage: 0.7,
    empiricalCoverage: 0.69,
    maximumAllowedCoverageError: 0.05,
  } as const;
  const rosConvergence = {
    schemaVersion: 1,
    state: "converged",
    method: "nested-prefix-512-vs-4096-v1",
    evidenceChecksum: rosConvergenceChecksum,
    lowerScenarioCount: 512,
    referenceScenarioCount: 4096,
    maxToleranceRatio: 0.8,
  } as const;
  const rosAvailability = {
    schemaVersion: 1,
    semantics: "unconditional-active-probability",
    weeks: Array.from({ length: 17 }, (_, index) => {
      const week = index + 2;
      const bye = week === 18;
      return {
        week,
        scheduled: !bye,
        bye,
        availabilityProbability: bye ? 0 : week === 17 ? 0.75 : 0.9,
      };
    }),
  } as const;
  const inactiveRosAvailability = {
    schemaVersion: 1 as const,
    semantics: "unconditional-active-probability" as const,
    weeks: rosAvailability.weeks.map((week) => ({
      ...week,
      availabilityProbability: 0,
    })),
  };
  const rosAsOfAt = new Date(Date.now() - 1_000);
  const rosFetchedAt = new Date();
  const [rosSyncRun] = await sql`
    insert into sync_runs (
      kind, state, idempotency_key, started_at, finished_at, records_read, records_written,
      artifact_checksum
    ) values (
      'schema-ros-projection', 'succeeded', ${`schema-ros-${suffix}`}, now(), now(),
      1, 1, ${rosInputChecksum}
    )
    returning id
  `;
  const rosSyncRunId = requiredString(rosSyncRun?.id, "ROS sync run id");
  await sql`
    insert into projection_model_runs (
      source_sync_run_id, source_id, season, horizon, window_start_week, window_end_week,
      as_of_week, as_of_at, model_version, training_window_start_season,
      trained_through_season, trained_through_week, quality_state, players_evaluated,
      players_published, input_checksum, configuration, calibration, metrics, source_as_of
    ) values (
      ${rosSyncRunId}, ${automatedSourceId}, 2026, 'rest-of-season', 2, 18,
      1, ${rosAsOfAt}, 'schema-ros-v1', 2023, 2026, 1, 'publishable', 1, 1,
      ${rosInputChecksum},
      ${sql.json({
        scenarios: 2_048,
        simulationModelVersion: "schema-ros-v1",
        orchestrationVersion: "schema-ros-orchestration-v1",
      })},
      ${sql.json({ rosIntervals: rosIntervalCalibration })},
      ${sql.json({ mae: 12.5, rosConvergence })}, ${rosAsOfAt}
    )
  `;
  const [rosProjectionSet] = await sql`
    insert into projection_sets (
      league_season_id, visibility, source, version, season, horizon, window_start_week,
      window_end_week, as_of_week, as_of_at, fetched_at, input_checksum, metadata
    ) values (
      ${seasonId}, 'league', 'laces-out-first-party-ros', ${`schema-ros-v1-${suffix}`},
      2026, 'rest-of-season', 2, 18, 1, ${rosAsOfAt}, ${rosFetchedAt},
      ${rosInputChecksum}, ${sql.json({ managed: true, methodVersion: "schema-ros-v1" })}
    )
    returning id
  `;
  const rosProjectionSetId = requiredString(rosProjectionSet?.id, "ROS projection set id");
  await sql`
    insert into player_projections (
      projection_set_id, player_id, mean_points, floor_points, ceiling_points, confidence,
      components
    ) values (
      ${rosProjectionSetId}, ${playerId}, 210, 150, 275, 0.82,
      ${sql.json({ expected_games: 14 })}
    )
  `;
  const rosPublicationGateCases = [
    {
      label: "degraded ROS model run",
      modelVersion: "schema-ros-degraded-v1",
      qualityState: "degraded",
      configuration: {
        simulationModelVersion: "schema-ros-degraded-v1",
        orchestrationVersion: "schema-ros-orchestration-v1",
      },
      calibration: { rosIntervals: rosIntervalCalibration },
      metrics: { rosConvergence },
    },
    {
      label: "uncalibrated ROS intervals",
      modelVersion: "schema-ros-uncalibrated-v1",
      qualityState: "publishable",
      configuration: {
        simulationModelVersion: "schema-ros-uncalibrated-v1",
        orchestrationVersion: "schema-ros-orchestration-v1",
      },
      calibration: {
        rosIntervals: { ...rosIntervalCalibration, state: "uncalibrated" },
      },
      metrics: { rosConvergence },
    },
    {
      label: "unconverged ROS simulation",
      modelVersion: "schema-ros-unconverged-v1",
      qualityState: "publishable",
      configuration: {
        simulationModelVersion: "schema-ros-unconverged-v1",
        orchestrationVersion: "schema-ros-orchestration-v1",
      },
      calibration: { rosIntervals: rosIntervalCalibration },
      metrics: {
        rosConvergence: { ...rosConvergence, state: "unstable" },
      },
    },
    {
      label: "mixed ROS simulation and model versions",
      modelVersion: "schema-ros-wrapper-v1",
      qualityState: "publishable",
      configuration: {
        simulationModelVersion: "schema-ros-v1",
        orchestrationVersion: "schema-ros-orchestration-v1",
      },
      calibration: { rosIntervals: rosIntervalCalibration },
      metrics: { rosConvergence },
    },
  ] as const;
  for (const gateCase of rosPublicationGateCases) {
    const [gateSyncRun] = await sql`
      insert into sync_runs (
        kind, state, idempotency_key, started_at, finished_at, records_read, records_written,
        artifact_checksum
      ) values (
        'schema-ros-projection', 'succeeded',
        ${`schema-ros-${gateCase.modelVersion}-${suffix}`}, now(), now(), 1, 1,
        ${rosInputChecksum}
      )
      returning id
    `;
    const gateSyncRunId = requiredString(gateSyncRun?.id, `${gateCase.label} sync run id`);
    await sql`
      insert into projection_model_runs (
        source_sync_run_id, source_id, season, horizon, window_start_week, window_end_week,
        as_of_week, as_of_at, model_version, training_window_start_season,
        trained_through_season, trained_through_week, quality_state, players_evaluated,
        players_published, input_checksum, configuration, calibration, metrics, source_as_of
      ) values (
        ${gateSyncRunId}, ${automatedSourceId}, 2026, 'rest-of-season', 2, 18,
        1, ${rosAsOfAt}, ${gateCase.modelVersion}, 2023, 2026, 1,
        ${gateCase.qualityState}, 1, 1, ${rosInputChecksum},
        ${sql.json(gateCase.configuration)}, ${sql.json(gateCase.calibration)},
        ${sql.json(gateCase.metrics)}, ${rosAsOfAt}
      )
    `;
    await expectDatabaseRejection(
      gateCase.label,
      () => sql`
      insert into player_ros_projection_summaries (
        projection_set_id, source_sync_run_id, player_id, season, window_start_week,
        window_end_week, as_of_week, as_of_at, scheduled_games, expected_games,
        aggregate_mean_points, p15_points, p50_points, p85_points,
        mean_points_per_expected_game, points_stddev, availability, scenario_count,
        method_version, seed_hash, input_checksum
      ) values (
        ${rosProjectionSetId}, ${gateSyncRunId}, ${playerId}, 2026, 2, 18, 1, ${rosAsOfAt},
        16, 14.25, 210, 150, 205, 275, 14.736842, 22.5,
        ${sql.json(rosAvailability)}, 2048, ${gateCase.modelVersion}, ${rosSeedHash},
        ${rosInputChecksum}
      )
    `,
    );
  }
  await expectDatabaseRejection(
    "ROS availability using an unversioned probability field",
    () => sql`
      insert into player_ros_projection_summaries (
        projection_set_id, source_sync_run_id, player_id, season, window_start_week,
        window_end_week, as_of_week, as_of_at, scheduled_games, expected_games,
        aggregate_mean_points, p15_points, p50_points, p85_points,
        mean_points_per_expected_game, points_stddev, availability, scenario_count,
        method_version, seed_hash, input_checksum
      ) values (
        ${rosProjectionSetId}, ${rosSyncRunId}, ${playerId}, 2026, 2, 18, 1, ${rosAsOfAt},
        16, 14.25, 210, 150, 205, 275, 14.736842, 22.5,
        ${sql.json({
          schemaVersion: 1,
          semantics: "unconditional-active-probability",
          weeks: rosAvailability.weeks.map(({ availabilityProbability, ...week }) => ({
            ...week,
            activeProbability: availabilityProbability,
          })),
        })},
        2048, 'schema-ros-v1', ${rosSeedHash}, ${rosInputChecksum}
      )
    `,
  );
  await expectDatabaseRejection(
    "ROS availability missing a window week",
    () => sql`
      insert into player_ros_projection_summaries (
        projection_set_id, source_sync_run_id, player_id, season, window_start_week,
        window_end_week, as_of_week, as_of_at, scheduled_games, expected_games,
        aggregate_mean_points, p15_points, p50_points, p85_points,
        mean_points_per_expected_game, points_stddev, availability, scenario_count,
        method_version, seed_hash, input_checksum
      ) values (
        ${rosProjectionSetId}, ${rosSyncRunId}, ${playerId}, 2026, 2, 18, 1, ${rosAsOfAt},
        16, 14.25, 210, 150, 205, 275, 14.736842, 22.5,
        ${sql.json({ ...rosAvailability, weeks: rosAvailability.weeks.slice(0, -1) })},
        2048, 'schema-ros-v1', ${rosSeedHash}, ${rosInputChecksum}
      )
    `,
  );
  await expectDatabaseRejection(
    "ROS availability probabilities do not reconcile",
    () => sql`
      insert into player_ros_projection_summaries (
        projection_set_id, source_sync_run_id, player_id, season, window_start_week,
        window_end_week, as_of_week, as_of_at, scheduled_games, expected_games,
        aggregate_mean_points, p15_points, p50_points, p85_points,
        mean_points_per_expected_game, points_stddev, availability, scenario_count,
        method_version, seed_hash, input_checksum
      ) values (
        ${rosProjectionSetId}, ${rosSyncRunId}, ${playerId}, 2026, 2, 18, 1, ${rosAsOfAt},
        16, 14.25, 210, 150, 205, 275, 14.736842, 22.5,
        ${sql.json({
          ...rosAvailability,
          weeks: rosAvailability.weeks.map((week) =>
            week.week === 2 ? { ...week, availabilityProbability: 0.8 } : week,
          ),
        })},
        2048, 'schema-ros-v1', ${rosSeedHash}, ${rosInputChecksum}
      )
    `,
  );
  await expectDatabaseRejection(
    "ROS summary checksum mismatch",
    () => sql`
      insert into player_ros_projection_summaries (
        projection_set_id, source_sync_run_id, player_id, season, window_start_week,
        window_end_week, as_of_week, as_of_at, scheduled_games, expected_games,
        aggregate_mean_points, p15_points, p50_points, p85_points, mean_points_per_expected_game,
        points_stddev, availability, scenario_count, method_version, seed_hash, input_checksum
      ) values (
        ${rosProjectionSetId}, ${rosSyncRunId}, ${playerId}, 2026, 2, 18, 1, ${rosAsOfAt},
        16, 14.25, 210, 150, 205, 275, 14.736842, 22.5, ${sql.json(rosAvailability)},
        2048, 'schema-ros-v1', ${rosSeedHash}, ${"d".repeat(64)}
      )
    `,
  );
  await expectDatabaseRejection(
    "ROS summary method/model version mismatch",
    () => sql`
      insert into player_ros_projection_summaries (
        projection_set_id, source_sync_run_id, player_id, season, window_start_week,
        window_end_week, as_of_week, as_of_at, scheduled_games, expected_games,
        aggregate_mean_points, p15_points, p50_points, p85_points, mean_points_per_expected_game,
        points_stddev, availability, scenario_count, method_version, seed_hash, input_checksum
      ) values (
        ${rosProjectionSetId}, ${rosSyncRunId}, ${playerId}, 2026, 2, 18, 1, ${rosAsOfAt},
        16, 14.25, 210, 150, 205, 275, 14.736842, 22.5, ${sql.json(rosAvailability)},
        2048, 'schema-ros-v2', ${rosSeedHash}, ${rosInputChecksum}
      )
    `,
  );
  await expectDatabaseRejection(
    "ROS summary aggregate mean mismatch",
    () => sql`
      insert into player_ros_projection_summaries (
        projection_set_id, source_sync_run_id, player_id, season, window_start_week,
        window_end_week, as_of_week, as_of_at, scheduled_games, expected_games,
        aggregate_mean_points, p15_points, p50_points, p85_points, mean_points_per_expected_game,
        points_stddev, availability, scenario_count, method_version, seed_hash, input_checksum
      ) values (
        ${rosProjectionSetId}, ${rosSyncRunId}, ${playerId}, 2026, 2, 18, 1, ${rosAsOfAt},
        16, 14.25, 211, 150, 205, 275, 14.807018, 22.5, ${sql.json(rosAvailability)},
        2048, 'schema-ros-v1', ${rosSeedHash}, ${rosInputChecksum}
      )
    `,
  );
  await expectDatabaseRejection(
    "ROS percentile ordering",
    () => sql`
      insert into player_ros_projection_summaries (
        projection_set_id, source_sync_run_id, player_id, season, window_start_week,
        window_end_week, as_of_week, as_of_at, scheduled_games, expected_games,
        aggregate_mean_points, p15_points, p50_points, p85_points, mean_points_per_expected_game,
        points_stddev, availability, scenario_count, method_version, seed_hash, input_checksum
      ) values (
        ${rosProjectionSetId}, ${rosSyncRunId}, ${playerId}, 2026, 2, 18, 1, ${rosAsOfAt},
        16, 14.25, 210, 150, 300, 275, 14.736842, 22.5, ${sql.json(rosAvailability)},
        2048, 'schema-ros-v1', ${rosSeedHash}, ${rosInputChecksum}
      )
    `,
  );
  await expectDatabaseRejection(
    "ROS scenario count below calibrated bounds",
    () => sql`
      insert into player_ros_projection_summaries (
        projection_set_id, source_sync_run_id, player_id, season, window_start_week,
        window_end_week, as_of_week, as_of_at, scheduled_games, expected_games,
        aggregate_mean_points, p15_points, p50_points, p85_points, mean_points_per_expected_game,
        points_stddev, availability, scenario_count, method_version, seed_hash, input_checksum
      ) values (
        ${rosProjectionSetId}, ${rosSyncRunId}, ${playerId}, 2026, 2, 18, 1, ${rosAsOfAt},
        16, 14.25, 210, 150, 205, 275, 14.736842, 22.5, ${sql.json(rosAvailability)},
        127, 'schema-ros-v1', ${rosSeedHash}, ${rosInputChecksum}
      )
    `,
  );
  await sql`
    insert into player_ros_projection_summaries (
      projection_set_id, source_sync_run_id, player_id, season, window_start_week,
      window_end_week, as_of_week, as_of_at, scheduled_games, expected_games,
      aggregate_mean_points, p15_points, p50_points, p85_points, mean_points_per_expected_game,
      points_stddev, availability, scenario_count, method_version, seed_hash, input_checksum
    ) values (
      ${rosProjectionSetId}, ${rosSyncRunId}, ${playerId}, 2026, 2, 18, 1, ${rosAsOfAt},
      16, 14.25, 210, 150, 205, 275, 14.736842, 22.5,
      ${sql.json(rosAvailability)}, 2048,
      'schema-ros-v1', ${rosSeedHash}, ${rosInputChecksum}
    )
  `;
  const [inactivePlayer] = await sql`
    insert into players (full_name, primary_position, eligible_positions)
    values ('Schema Inactive Player', 'RB', ${["RB"]})
    returning id
  `;
  const inactivePlayerId = requiredString(inactivePlayer?.id, "inactive player id");
  await sql`
    insert into player_projections (
      projection_set_id, player_id, mean_points, floor_points, ceiling_points, confidence,
      components
    ) values (
      ${rosProjectionSetId}, ${inactivePlayerId}, 0, 0, 0, 1,
      ${sql.json({ expected_games: 0 })}
    )
  `;
  await expectDatabaseRejection(
    "zero-game ROS summary with points per expected game",
    () => sql`
      insert into player_ros_projection_summaries (
        projection_set_id, source_sync_run_id, player_id, season, window_start_week,
        window_end_week, as_of_week, as_of_at, scheduled_games, expected_games,
        aggregate_mean_points, p15_points, p50_points, p85_points, mean_points_per_expected_game,
        points_stddev, availability, scenario_count, method_version, seed_hash, input_checksum
      ) values (
        ${rosProjectionSetId}, ${rosSyncRunId}, ${inactivePlayerId}, 2026, 2, 18, 1,
        ${rosAsOfAt}, 16, 0, 0, 0, 0, 0, 0, 0, ${sql.json(inactiveRosAvailability)},
        2048, 'schema-ros-v1', ${rosSeedHash}, ${rosInputChecksum}
      )
    `,
  );
  await sql`
    insert into player_ros_projection_summaries (
      projection_set_id, source_sync_run_id, player_id, season, window_start_week,
      window_end_week, as_of_week, as_of_at, scheduled_games, expected_games,
      aggregate_mean_points, p15_points, p50_points, p85_points, mean_points_per_expected_game,
      points_stddev, availability, scenario_count, method_version, seed_hash, input_checksum
    ) values (
      ${rosProjectionSetId}, ${rosSyncRunId}, ${inactivePlayerId}, 2026, 2, 18, 1,
      ${rosAsOfAt}, 16, 0, 0, 0, 0, 0, null, 0, ${sql.json(inactiveRosAvailability)},
      2048, 'schema-ros-v1', ${rosSeedHash}, ${rosInputChecksum}
    )
  `;
  await expectDatabaseRejection(
    "duplicate ROS distribution summary",
    () => sql`
      insert into player_ros_projection_summaries (
        projection_set_id, source_sync_run_id, player_id, season, window_start_week,
        window_end_week, as_of_week, as_of_at, scheduled_games, expected_games,
        aggregate_mean_points, p15_points, p50_points, p85_points, mean_points_per_expected_game,
        points_stddev, availability, scenario_count, method_version, seed_hash, input_checksum
      ) values (
        ${rosProjectionSetId}, ${rosSyncRunId}, ${playerId}, 2026, 2, 18, 1, ${rosAsOfAt},
        16, 14.25, 210, 150, 205, 275, 14.736842, 22.5, ${sql.json(rosAvailability)}, 2048,
        'schema-ros-v1', ${rosSeedHash}, ${rosInputChecksum}
      )
    `,
  );
  await expectDatabaseRejection(
    "ROS distribution summary update",
    () => sql`
      update player_ros_projection_summaries
      set expected_games = 14
      where projection_set_id = ${rosProjectionSetId} and player_id = ${playerId}
    `,
  );
  await expectDatabaseRejection(
    "ROS distribution summary deletion",
    () => sql`
      delete from player_ros_projection_summaries
      where projection_set_id = ${rosProjectionSetId} and player_id = ${playerId}
    `,
  );
  await expectDatabaseRejection(
    "weekly projection set used for a ROS summary",
    () => sql`
      insert into player_ros_projection_summaries (
        projection_set_id, source_sync_run_id, player_id, season, window_start_week,
        window_end_week, as_of_week, as_of_at, scheduled_games, expected_games,
        aggregate_mean_points, p15_points, p50_points, p85_points, mean_points_per_expected_game,
        points_stddev, availability, scenario_count, method_version, seed_hash, input_checksum
      ) values (
        ${managedWeeklyProjectionSetId}, ${rosSyncRunId}, ${playerId}, 2026, 1, 1, 0,
        ${rosAsOfAt}, 1, 1, 14.736842, 10, 14, 20, 14.736842, 2.5,
        ${sql.json(rosAvailability)}, 2048,
        'schema-ros-v1', ${rosSeedHash}, ${rosInputChecksum}
      )
    `,
  );
  await expectDatabaseRejection(
    "ROS projection-set identity mutation",
    () => sql`
      update projection_sets set as_of_week = 0 where id = ${rosProjectionSetId}
    `,
  );
  await expectDatabaseRejection(
    "duplicate managed ROS projection set identity",
    () => sql`
      insert into projection_sets (
        league_season_id, visibility, source, version, season, horizon, window_start_week,
        window_end_week, as_of_week, as_of_at, fetched_at, input_checksum
      ) values (
        ${seasonId}, 'league', 'laces-out-first-party-ros',
        ${`schema-ros-duplicate-${suffix}`}, 2026, 'rest-of-season', 2, 18, 1,
        ${rosAsOfAt}, ${rosFetchedAt}, ${rosInputChecksum}
      )
    `,
  );
  const setChecksumMismatch = "f".repeat(64);
  const [mismatchedChecksumSet] = await sql`
    insert into projection_sets (
      league_season_id, visibility, source, version, season, horizon, window_start_week,
      window_end_week, as_of_week, as_of_at, fetched_at, input_checksum
    ) values (
      ${seasonId}, 'league', 'schema-ros-checksum-mismatch',
      ${`schema-ros-checksum-mismatch-${suffix}`}, 2026, 'rest-of-season', 2, 18, 1,
      ${rosAsOfAt}, ${rosFetchedAt}, ${setChecksumMismatch}
    )
    returning id
  `;
  const mismatchedChecksumSetId = requiredString(
    mismatchedChecksumSet?.id,
    "mismatched-checksum projection set id",
  );
  await sql`
    insert into player_projections (
      projection_set_id, player_id, mean_points, floor_points, ceiling_points, components
    ) values (
      ${mismatchedChecksumSetId}, ${playerId}, 210, 150, 275, ${sql.json({})}
    )
  `;
  await expectDatabaseRejection(
    "ROS projection-set/model-run checksum mismatch",
    () => sql`
      insert into player_ros_projection_summaries (
        projection_set_id, source_sync_run_id, player_id, season, window_start_week,
        window_end_week, as_of_week, as_of_at, scheduled_games, expected_games,
        aggregate_mean_points, p15_points, p50_points, p85_points, mean_points_per_expected_game,
        points_stddev, availability, scenario_count, method_version, seed_hash, input_checksum
      ) values (
        ${mismatchedChecksumSetId}, ${rosSyncRunId}, ${playerId}, 2026, 2, 18, 1,
        ${rosAsOfAt}, 16, 14.25, 210, 150, 205, 275, 14.736842, 22.5,
        ${sql.json(rosAvailability)}, 2048, 'schema-ros-v1', ${rosSeedHash},
        ${setChecksumMismatch}
      )
    `,
  );

  const [duplicateRosSyncRun] = await sql`
    insert into sync_runs (kind, state, idempotency_key, started_at, finished_at)
    values ('schema-ros-projection', 'succeeded', ${`schema-ros-duplicate-${suffix}`}, now(), now())
    returning id
  `;
  const duplicateRosSyncRunId = requiredString(
    duplicateRosSyncRun?.id,
    "duplicate ROS sync run id",
  );
  await expectDatabaseRejection(
    "duplicate ROS model-run identity",
    () => sql`
      insert into projection_model_runs (
        source_sync_run_id, source_id, season, horizon, window_start_week, window_end_week,
        as_of_week, as_of_at, model_version, training_window_start_season,
        trained_through_season, trained_through_week, quality_state, players_evaluated,
        players_published, input_checksum, configuration, calibration, metrics, source_as_of
      ) values (
        ${duplicateRosSyncRunId}, ${automatedSourceId}, 2026, 'rest-of-season', 2, 18,
        1, ${rosAsOfAt}, 'schema-ros-v1', 2023, 2026, 1, 'publishable', 1, 1,
        ${rosInputChecksum}, ${sql.json({})}, ${sql.json({})}, ${sql.json({})}, ${rosAsOfAt}
      )
    `,
  );

  const [invalidHorizonSyncRun] = await sql`
    insert into sync_runs (kind, state, idempotency_key, started_at, finished_at)
    values ('schema-ros-projection', 'succeeded', ${`schema-ros-invalid-${suffix}`}, now(), now())
    returning id
  `;
  const invalidHorizonSyncRunId = requiredString(
    invalidHorizonSyncRun?.id,
    "invalid-horizon sync run id",
  );
  await expectDatabaseRejection(
    "ROS model run carrying a weekly target",
    () => sql`
      insert into projection_model_runs (
        source_sync_run_id, source_id, season, horizon, target_week, window_start_week,
        window_end_week, as_of_week, as_of_at, model_version, training_window_start_season,
        trained_through_season, trained_through_week, quality_state, players_evaluated,
        players_published, input_checksum, configuration, calibration, metrics, source_as_of
      ) values (
        ${invalidHorizonSyncRunId}, ${automatedSourceId}, 2026, 'rest-of-season', 2, 2,
        18, 1, ${rosAsOfAt}, 'schema-ros-invalid', 2023, 2026, 1, 'publishable', 1, 1,
        ${"d".repeat(64)}, ${sql.json({})}, ${sql.json({})}, ${sql.json({})}, ${rosAsOfAt}
      )
    `,
  );
  await expectDatabaseRejection(
    "ROS model run without explicit window and as-of identity",
    () => sql`
      insert into projection_model_runs (
        source_sync_run_id, source_id, season, horizon, model_version,
        training_window_start_season, trained_through_season, trained_through_week,
        quality_state, players_evaluated, players_published, input_checksum,
        configuration, calibration, metrics, source_as_of
      ) values (
        ${invalidHorizonSyncRunId}, ${automatedSourceId}, 2026, 'rest-of-season',
        'schema-ros-missing-identity', 2023, 2026, 1, 'publishable', 1, 1,
        ${"e".repeat(64)}, ${sql.json({})}, ${sql.json({})}, ${sql.json({})}, ${rosAsOfAt}
      )
    `,
  );
  await expectDatabaseRejection(
    "ROS projection set without explicit window and as-of identity",
    () => sql`
      insert into projection_sets (
        league_season_id, visibility, source, version, season, horizon, fetched_at,
        input_checksum
      ) values (
        ${seasonId}, 'league', 'schema-ros-missing-identity',
        ${`schema-ros-missing-identity-${suffix}`}, 2026, 'rest-of-season',
        ${rosFetchedAt}, ${"e".repeat(64)}
      )
    `,
  );
  await expectDatabaseRejection(
    "ROS model source newer than its as-of identity",
    () => sql`
      insert into projection_model_runs (
        source_sync_run_id, source_id, season, horizon, window_start_week, window_end_week,
        as_of_week, as_of_at, model_version, training_window_start_season,
        trained_through_season, trained_through_week, quality_state, players_evaluated,
        players_published, input_checksum, configuration, calibration, metrics, source_as_of
      ) values (
        ${invalidHorizonSyncRunId}, ${automatedSourceId}, 2026, 'rest-of-season', 2, 18,
        1, ${rosAsOfAt}, 'schema-ros-future-source', 2023, 2026, 1, 'publishable', 1, 1,
        ${"1".repeat(64)}, ${sql.json({})}, ${sql.json({})}, ${sql.json({})}, ${rosFetchedAt}
      )
    `,
  );
  await expectDatabaseRejection(
    "ROS model same-season training beyond as-of week",
    () => sql`
      insert into projection_model_runs (
        source_sync_run_id, source_id, season, horizon, window_start_week, window_end_week,
        as_of_week, as_of_at, model_version, training_window_start_season,
        trained_through_season, trained_through_week, quality_state, players_evaluated,
        players_published, input_checksum, configuration, calibration, metrics, source_as_of
      ) values (
        ${invalidHorizonSyncRunId}, ${automatedSourceId}, 2026, 'rest-of-season', 2, 18,
        1, ${rosAsOfAt}, 'schema-ros-training-leak', 2023, 2026, 2, 'publishable', 1, 1,
        ${"2".repeat(64)}, ${sql.json({})}, ${sql.json({})}, ${sql.json({})}, ${rosAsOfAt}
      )
    `,
  );
  await expectDatabaseRejection(
    "ROS model as-of week inside its forecast window",
    () => sql`
      insert into projection_model_runs (
        source_sync_run_id, source_id, season, horizon, window_start_week, window_end_week,
        as_of_week, as_of_at, model_version, training_window_start_season,
        trained_through_season, trained_through_week, quality_state, players_evaluated,
        players_published, input_checksum, configuration, calibration, metrics, source_as_of
      ) values (
        ${invalidHorizonSyncRunId}, ${automatedSourceId}, 2026, 'rest-of-season', 2, 18,
        2, ${rosAsOfAt}, 'schema-ros-overlap', 2023, 2026, 1, 'publishable', 1, 1,
        ${"3".repeat(64)}, ${sql.json({})}, ${sql.json({})}, ${sql.json({})}, ${rosAsOfAt}
      )
    `,
  );
  await expectDatabaseRejection(
    "ROS projection-set as-of week inside its forecast window",
    () => sql`
      insert into projection_sets (
        league_season_id, visibility, source, version, season, horizon, window_start_week,
        window_end_week, as_of_week, as_of_at, fetched_at, input_checksum
      ) values (
        ${seasonId}, 'league', 'schema-ros-overlap', ${`schema-ros-overlap-${suffix}`},
        2026, 'rest-of-season', 2, 18, 2, ${rosAsOfAt}, ${rosFetchedAt}, ${"3".repeat(64)}
      )
    `,
  );
  await expectDatabaseRejection(
    "new legacy-unknown projection identity",
    () => sql`
      insert into projection_sets (
        league_season_id, visibility, source, version, season, horizon, identity_state,
        fetched_at, input_checksum
      ) values (
        ${seasonId}, 'league', 'schema-legacy-unknown',
        ${`schema-legacy-unknown-${suffix}`}, 2026, 'rest-of-season', 'legacy-unknown',
        ${rosFetchedAt}, ${"4".repeat(64)}
      )
    `,
  );
  const [lifecycleProjectionSet] = await sql`
    insert into projection_sets (
      league_season_id, visibility, source, version, season, horizon, window_start_week,
      window_end_week, as_of_week, as_of_at, fetched_at, input_checksum
    ) values (
      ${otherSeasonId}, 'league', 'schema-ros-lifecycle',
      ${`schema-ros-lifecycle-${suffix}`}, 2026, 'rest-of-season', 2, 18, 1,
      ${rosAsOfAt}, ${rosFetchedAt}, ${rosInputChecksum}
    )
    returning id
  `;
  const lifecycleProjectionSetId = requiredString(
    lifecycleProjectionSet?.id,
    "lifecycle projection set id",
  );
  await sql`
    insert into player_projections (
      projection_set_id, player_id, mean_points, floor_points, ceiling_points, components
    ) values (
      ${lifecycleProjectionSetId}, ${playerId}, 210, 150, 275, ${sql.json({})}
    )
  `;
  await sql`
    insert into player_ros_projection_summaries (
      projection_set_id, source_sync_run_id, player_id, season, window_start_week,
      window_end_week, as_of_week, as_of_at, scheduled_games, expected_games,
      aggregate_mean_points, p15_points, p50_points, p85_points, mean_points_per_expected_game,
      points_stddev, availability, scenario_count, method_version, seed_hash, input_checksum
    ) values (
      ${lifecycleProjectionSetId}, ${rosSyncRunId}, ${playerId}, 2026, 2, 18, 1,
      ${rosAsOfAt}, 16, 14.25, 210, 150, 205, 275, 14.736842, 22.5,
      ${sql.json(rosAvailability)}, 2048, 'schema-ros-v1', ${rosSeedHash}, ${rosInputChecksum}
    )
  `;
  await sql`delete from league_seasons where id = ${otherSeasonId}`;
  const lifecycleSummaryRows = await sql`
    select 1
    from player_ros_projection_summaries
    where projection_set_id = ${lifecycleProjectionSetId}
  `;
  assert.equal(
    lifecycleSummaryRows.length,
    0,
    "league-season deletion did not cascade retained ROS summaries",
  );
  const [rankingList] = await sql`
    insert into ranking_lists (owner_user_id, name, kind, season)
    values (${ownerId}, 'Schema Rankings', 'cheat-sheet', 2026)
    returning id
  `;
  const rankingListId = requiredString(rankingList?.id, "ranking list id");
  const [rankingVersion] = await sql`
    insert into ranking_list_versions (ranking_list_id, version, created_by_user_id)
    values (${rankingListId}, 1, ${ownerId})
    returning id
  `;
  const rankingVersionId = requiredString(rankingVersion?.id, "ranking version id");
  const rankingAttribution = {
    kind: "user",
    authorUserId: ownerId,
    authoredAt: new Date().toISOString(),
  };
  await sql`
    insert into ranking_entries (
      ranking_list_version_id, player_id, rank, tier, adp, aav, floor, target, ceiling,
      user_fields, field_provenance
    ) values (
      ${rankingVersionId}, ${playerId}, 1, 1, 4.5, 42, 35, 42, 50,
      ${sql.json({ fade: false, personalNote: "target" })},
      ${sql.json({
        overallRank: rankingAttribution,
        tier: rankingAttribution,
        adp: rankingAttribution,
        aav: rankingAttribution,
        floorPrice: rankingAttribution,
        targetPrice: rankingAttribution,
        ceilingPrice: rankingAttribution,
      })}
    )
  `;
  await expectDatabaseRejection(
    "ranking entry snapshot mutation",
    () => sql`
    update ranking_entries
    set floor = 60, target = 40, ceiling = 50
    where ranking_list_version_id = ${rankingVersionId} and player_id = ${playerId}
  `,
  );
  await sql`
    update ranking_list_versions
    set status = 'published', published_at = now(), entry_count = 1,
      content_hash = ${"a".repeat(64)}
    where id = ${rankingVersionId}
  `;
  await sql`
    update ranking_lists
    set current_version_id = ${rankingVersionId},
      latest_published_version_id = ${rankingVersionId}
    where id = ${rankingListId}
  `;
  await expectDatabaseRejection(
    "published ranking version mutation",
    () => sql`
      update ranking_list_versions set notes = 'mutated' where id = ${rankingVersionId}
    `,
  );

  const [otherRankingList] = await sql`
    insert into ranking_lists (owner_user_id, name, kind, season)
    values (${ownerId}, 'Other Schema Rankings', 'rankings', 2026)
    returning id
  `;
  const otherRankingListId = requiredString(otherRankingList?.id, "other ranking list id");
  const [otherRankingVersion] = await sql`
    insert into ranking_list_versions (ranking_list_id, version, created_by_user_id)
    values (${otherRankingListId}, 1, ${ownerId})
    returning id
  `;
  const otherRankingVersionId = requiredString(otherRankingVersion?.id, "other ranking version id");
  await expectDatabaseRejection(
    "cross-list ranking parent",
    () => sql`
      insert into ranking_list_versions (
        ranking_list_id, version, parent_version_id, created_by_user_id
      ) values (${rankingListId}, 2, ${otherRankingVersionId}, ${ownerId})
    `,
  );
  await expectDatabaseRejection(
    "cross-list ranking pointer",
    () => sql`
      update ranking_lists set current_version_id = ${otherRankingVersionId}
      where id = ${rankingListId}
    `,
  );
  const [secondRankingVersion] = await sql`
    insert into ranking_list_versions (
      ranking_list_id, version, parent_version_id, created_by_user_id
    ) values (${rankingListId}, 2, ${rankingVersionId}, ${ownerId})
    returning id
  `;
  const secondRankingVersionId = requiredString(
    secondRankingVersion?.id,
    "second ranking version id",
  );
  await sql`
    insert into ranking_entries (
      ranking_list_version_id, player_id, is_target, field_provenance
    ) values (
      ${secondRankingVersionId}, ${playerId}, true,
      ${sql.json({ target: rankingAttribution })}
    )
  `;
  await sql`
    update ranking_lists set current_version_id = ${secondRankingVersionId}
    where id = ${rankingListId}
  `;
  await expectDatabaseRejection(
    "incorrect published entry count",
    () => sql`
      update ranking_list_versions
      set status = 'published', published_at = now(), entry_count = 2,
        content_hash = ${"c".repeat(64)}
      where id = ${secondRankingVersionId}
    `,
  );
  await sql`
    update ranking_list_versions
    set status = 'published', published_at = now(), entry_count = 1,
      content_hash = ${"c".repeat(64)}
    where id = ${secondRankingVersionId}
  `;
  await sql`
    update ranking_lists set latest_published_version_id = ${secondRankingVersionId}
    where id = ${rankingListId}
  `;

  await expectDatabaseRejection(
    "share link without resource",
    () => sql`
    insert into share_links (token_hash, created_by_user_id)
    values (${"s".repeat(64)}, ${ownerId})
  `,
  );
  await sql`
    insert into share_links (token_hash, created_by_user_id, ranking_list_id)
    values (${"v".repeat(64)}, ${ownerId}, ${rankingListId})
  `;

  const [dataSource] = await sql`
    insert into data_sources (key, name, kind, source_url, attribution)
    values (
      ${`smoke.${suffix}`}, 'Schema Source', 'player_catalog',
      'https://example.test/catalog', 'Schema smoke data'
    )
    returning id
  `;
  const dataSourceId = requiredString(dataSource?.id, "data source id");
  await expectDatabaseRejection(
    "unsafe source cadence",
    () => sql`
    update data_sources set check_interval_minutes = 1 where id = ${dataSourceId}
  `,
  );
  await sql`
    insert into refresh_requests (
      requested_by_user_id, data_source_id, kind, idempotency_key
    ) values (${ownerId}, ${dataSourceId}, 'player_catalog', ${`refresh-${suffix}`})
  `;

  const [connection] = await sql`
    insert into provider_connections (user_id, provider, external_account_id)
    values (${ownerId}, 'yahoo', ${`account-${suffix}`})
    returning id, credential_version
  `;
  const connectionId = requiredString(connection?.id, "provider connection id");
  assert.equal(connection?.credential_version, 1);
  const rotated = await sql`
    update provider_connections
    set credential_version = credential_version + 1
    where id = ${connectionId} and credential_version = 1
    returning credential_version
  `;
  assert.equal(rotated[0]?.credential_version, 2, "credential CAS rotation did not advance");
  const staleRotation = await sql`
    update provider_connections
    set credential_version = credential_version + 1
    where id = ${connectionId} and credential_version = 1
    returning credential_version
  `;
  assert.equal(staleRotation.length, 0, "stale credential CAS unexpectedly succeeded");

  const [bridgeDevice] = await sql`
    insert into bridge_devices (user_id, name, token_hash)
    values (${ownerId}, 'Schema Browser', ${"b".repeat(64)})
    returning id
  `;
  const bridgeDeviceId = requiredString(bridgeDevice?.id, "bridge device id");
  const [bridgeGrant] = await sql`
    insert into bridge_device_leagues (bridge_device_id, external_league_id, season)
    values (${bridgeDeviceId}, '123456789', 2026)
    returning id
  `;
  const bridgeGrantId = requiredString(bridgeGrant?.id, "bridge league grant id");
  const [espnSeason] = await sql`
    insert into league_seasons (
      league_id, provider, external_key, season, team_count, draft_type
    ) values (${leagueId}, 'espn', '123456789', 2026, 10, 'auction')
    returning id
  `;
  const espnSeasonId = requiredString(espnSeason?.id, "ESPN league season id");
  await sql`
    update bridge_device_leagues set league_id = ${leagueId} where id = ${bridgeGrantId}
  `;
  await expectDatabaseRejection(
    "non-numeric ESPN league authorization",
    () => sql`
      insert into bridge_device_leagues (bridge_device_id, external_league_id)
      values (${bridgeDeviceId}, 'espn-league-cookie')
    `,
  );
  await expectDatabaseRejection(
    "overlapping ESPN league authorization",
    () => sql`
      insert into bridge_device_leagues (bridge_device_id, external_league_id)
      values (${bridgeDeviceId}, '123456789')
    `,
  );
  const [unlinkedGrant] = await sql`
    insert into bridge_device_leagues (bridge_device_id, external_league_id, season)
    values (${bridgeDeviceId}, '987654321', 2026)
    returning id
  `;
  const unlinkedGrantId = requiredString(unlinkedGrant?.id, "unlinked bridge grant id");
  await expectDatabaseRejection(
    "unauthorized internal league bridge link",
    () => sql`
      update bridge_device_leagues set league_id = ${otherLeagueId}
      where id = ${unlinkedGrantId}
    `,
  );
  await expectDatabaseRejection(
    "raw/short bridge token",
    () => sql`
    insert into bridge_devices (user_id, name, token_hash)
    values (${ownerId}, 'Unsafe Browser', 'short-token')
  `,
  );

  const [espnSyncState] = await sql`
    insert into espn_league_sync_states (league_season_id)
    values (${espnSeasonId})
    returning direct_core_state, artifact_freshness
  `;
  assert.equal(espnSyncState?.direct_core_state, "unknown");
  assert.deepEqual(espnSyncState?.artifact_freshness, {});
  await expectDatabaseRejection(
    "invalid ESPN direct capability state",
    () => sql`
      update espn_league_sync_states
      set direct_core_state = 'authenticated-only'
      where league_season_id = ${espnSeasonId}
    `,
  );

  const [leagueRefresh] = await sql`
    insert into refresh_requests (
      requested_by_user_id, league_season_id, kind, idempotency_key,
      expires_at, minimum_capture_at, required_artifacts
    ) values (
      ${ownerId}, ${espnSeasonId}, 'league', ${`espn-refresh-${suffix}`},
      now() + interval '24 hours', now(), ${sql.json(["core", "transactions"])}
    )
    returning id
  `;
  const leagueRefreshId = requiredString(leagueRefresh?.id, "ESPN refresh request id");
  await expectDatabaseRejection(
    "second live ESPN league refresh",
    () => sql`
      insert into refresh_requests (
        requested_by_user_id, league_season_id, kind, idempotency_key,
        expires_at, minimum_capture_at, required_artifacts
      ) values (
        ${friendId}, ${espnSeasonId}, 'league', ${`espn-refresh-duplicate-${suffix}`},
        now() + interval '24 hours', now(), ${sql.json(["core"])}
      )
    `,
  );
  await expectDatabaseRejection(
    "incomplete ESPN league refresh scope",
    () => sql`
      insert into refresh_requests (
        requested_by_user_id, league_season_id, kind, idempotency_key
      ) values (
        ${ownerId}, ${espnSeasonId}, 'league', ${`espn-refresh-incomplete-${suffix}`}
      )
    `,
  );
  await sql`
    insert into espn_refresh_attempts (
      refresh_request_id, mode, bridge_device_id, state
    ) values (${leagueRefreshId}, 'chrome-agent', ${bridgeDeviceId}, 'offered')
  `;
  await sql`
    insert into espn_refresh_attempts (
      refresh_request_id, mode, state, finished_at
    ) values (${leagueRefreshId}, 'server-direct', 'accepted', now())
  `;
  await expectDatabaseRejection(
    "server-direct attempt with a bridge device",
    () => sql`
      insert into espn_refresh_attempts (
        refresh_request_id, mode, bridge_device_id, state
      ) values (${leagueRefreshId}, 'server-direct', ${bridgeDeviceId}, 'started')
    `,
  );
  await expectDatabaseRejection(
    "terminal ESPN refresh attempt without a finish time",
    () => sql`
      insert into espn_refresh_attempts (
        refresh_request_id, mode, bridge_device_id, state
      ) values (${leagueRefreshId}, 'chrome-agent', ${bridgeDeviceId}, 'accepted')
    `,
  );
  await expectDatabaseRejection(
    "failed ESPN refresh attempt without an error code",
    () => sql`
      insert into espn_refresh_attempts (
        refresh_request_id, mode, bridge_device_id, state, finished_at
      ) values (
        ${leagueRefreshId}, 'chrome-agent', ${bridgeDeviceId}, 'retryable-error', now()
      )
    `,
  );
  await sql`
    insert into bridge_pairing_sessions (
      user_id, code_hash, device_name, allowed_league_ids, season, expires_at
    ) values (
      ${ownerId}, ${"p".repeat(64)}, 'Self-hosted Browser',
      ${sql.json(["123456789", "987654321"])}, 2026, now() + interval '10 minutes'
    )
  `;
  await expectDatabaseRejection(
    "empty self-hosted pairing scope",
    () => sql`
      insert into bridge_pairing_sessions (
        user_id, code_hash, device_name, allowed_league_ids, season, expires_at
      ) values (
        ${ownerId}, ${"q".repeat(64)}, 'Unsafe Pairing', ${sql.json([])},
        2026, now() + interval '10 minutes'
      )
    `,
  );
  await expectDatabaseRejection(
    "expired self-hosted pairing session",
    () => sql`
      insert into bridge_pairing_sessions (
        user_id, code_hash, device_name, allowed_league_ids, season, expires_at
      ) values (
        ${ownerId}, ${"r".repeat(64)}, 'Expired Pairing', ${sql.json(["123456789"])},
        2026, now() - interval '1 minute'
      )
    `,
  );

  const envelope = {
    version: 1,
    algorithm: "aes-256-gcm",
    keyId: "schema-smoke",
    purpose: "provider:openai",
    createdAt: new Date().toISOString(),
    iv: "base64url-iv",
    ciphertext: "base64url-ciphertext",
    authTag: "base64url-auth-tag",
  };
  const [aiCredential] = await sql`
    insert into ai_provider_credentials (
      user_id, provider, label, credential_fingerprint_hash, credential_envelope,
      envelope_version, encryption_key_id, credential_purpose
    ) values (
      ${ownerId}, 'openai', 'Schema AI', ${"f".repeat(64)}, ${sql.json(envelope)},
      1, 'schema-smoke', 'provider:openai'
    )
    returning id
  `;
  const aiCredentialId = requiredString(aiCredential?.id, "AI credential id");
  await expectDatabaseRejection(
    "non-envelope AI credential",
    () => sql`
    insert into ai_provider_credentials (
      user_id, provider, label, credential_fingerprint_hash, credential_envelope,
      envelope_version, encryption_key_id, credential_purpose
    ) values (
      ${ownerId}, 'openai', 'Unsafe AI', ${"x".repeat(64)},
      ${sql.json({ apiKey: "not-an-envelope" })}, 1, 'schema-smoke', 'provider:openai'
    )
  `,
  );

  const [usage] = await sql`
    insert into ai_usage_ledger (
      user_id, credential_id, provider, model, operation, request_id_hash,
      input_tokens, output_tokens, cost
    ) values (
      ${ownerId}, ${aiCredentialId}, 'openai', 'schema-model', 'recommendation',
      ${"r".repeat(64)}, 100, 25, 0.001
    )
    returning id
  `;
  const usageId = requiredString(usage?.id, "usage ledger id");
  await expectDatabaseRejection(
    "AI usage ledger mutation",
    () => sql`
    update ai_usage_ledger set cost = 0 where id = ${usageId}
  `,
  );

  // Connection-scoped circuit state and recommendation-run replay identity (migration 0026).
  const circuitState = await sql`
    update provider_connections
    set consecutive_failures = 5,
      circuit_open_until = now() + interval '1 minute',
      last_error_code = 'PROVIDER_UNAVAILABLE',
      last_error_detail = 'schema smoke'
    where id = ${connectionId}
    returning consecutive_failures, circuit_open_until, last_error_detail
  `;
  assert.equal(circuitState[0]?.consecutive_failures, 5, "circuit failure counter did not persist");
  assert.ok(circuitState[0]?.circuit_open_until, "circuit open-until did not persist");
  assert.equal(circuitState[0]?.last_error_detail, "schema smoke");
  await expectDatabaseRejection(
    "negative connection failure counter",
    () => sql`
    update provider_connections set consecutive_failures = -1 where id = ${connectionId}
  `,
  );

  const recommendationInputHash = "d".repeat(64);
  const [recommendationRun] = await sql`
    insert into recommendation_runs (
      league_season_id, fantasy_team_id, kind, algorithm_version, input_hash, inputs
    ) values (
      ${seasonId}, ${teamId}, 'lineup', 'in-season-decisions-v1', ${recommendationInputHash},
      ${sql.json({ week: 3 })}
    )
    returning id
  `;
  const recommendationRunId = requiredString(recommendationRun?.id, "recommendation run id");
  await expectDatabaseRejection(
    "unknown recommendation kind",
    () => sql`
    insert into recommendation_runs (
      league_season_id, fantasy_team_id, kind, algorithm_version, input_hash, inputs
    ) values (
      ${seasonId}, ${teamId}, 'playoffs', 'in-season-decisions-v1', ${"e".repeat(64)},
      ${sql.json({})}
    )
  `,
  );
  await expectDatabaseRejection(
    "replayed recommendation run with identical inputs",
    () => sql`
    insert into recommendation_runs (
      league_season_id, fantasy_team_id, kind, algorithm_version, input_hash, inputs
    ) values (
      ${seasonId}, ${teamId}, 'lineup', 'in-season-decisions-v1', ${recommendationInputHash},
      ${sql.json({ week: 3 })}
    )
  `,
  );
  // NULLS NOT DISTINCT: a league-wide run must deduplicate too, rather than insert without limit.
  await sql`
    insert into recommendation_runs (
      league_season_id, fantasy_team_id, kind, algorithm_version, input_hash, inputs
    ) values (
      ${seasonId}, null, 'waiver', 'in-season-decisions-v1', ${"f".repeat(64)}, ${sql.json({})}
    )
  `;
  await expectDatabaseRejection(
    "replayed league-wide recommendation run",
    () => sql`
    insert into recommendation_runs (
      league_season_id, fantasy_team_id, kind, algorithm_version, input_hash, inputs
    ) values (
      ${seasonId}, null, 'waiver', 'in-season-decisions-v1', ${"f".repeat(64)}, ${sql.json({})}
    )
  `,
  );
  await sql`
    insert into recommendations (run_id, rank, action, explanation, warnings)
    values (
      ${recommendationRunId}, 1, ${sql.json({ start: playerId })}, 'Schema smoke recommendation',
      ${["PRIVATE_PROJECTION_SETS_EXCLUDED"]}
    )
  `;

  const [changeEvent] = await sql`
    insert into change_events (
      source, deduplication_key, event_type, aggregate_type, aggregate_id,
      league_id, actor_user_id, payload, occurred_at
    ) values (
      'schema-smoke', ${suffix}, 'roster.changed', 'league', ${leagueId},
      ${leagueId}, ${ownerId}, ${sql.json({ playerId })}, now()
    )
    returning id
  `;
  const changeEventId = requiredString(changeEvent?.id, "change event id");
  await expectDatabaseRejection(
    "change event mutation",
    () => sql`
    update change_events set payload = ${sql.json({ changed: true })}
    where id = ${changeEventId}
  `,
  );
  await expectDatabaseRejection(
    "change event deletion",
    () => sql`
    delete from change_events where id = ${changeEventId}
  `,
  );

  await sql`update leagues set user_id = ${friendId} where id = ${leagueId}`;
  const transferredMemberships = await sql`
    select user_id, role
    from league_memberships
    where league_id = ${leagueId}
  `;
  const transferredRoles = new Map(
    transferredMemberships.map((row) => [String(row.user_id), String(row.role)]),
  );
  assert.equal(transferredRoles.get(friendId), "owner", "new owner was not promoted");
  assert.equal(transferredRoles.get(ownerId), "commissioner", "old owner was not demoted");
  await expectDatabaseRejection(
    "direct owner membership creation",
    () => sql`
    insert into league_memberships (league_id, user_id, role)
    values (${leagueId}, ${outsiderId}, 'owner')
  `,
  );

  await sql.unsafe("ROLLBACK");
  transactionStarted = false;
  process.stdout.write("Database schema smoke checks passed.\n");
} finally {
  if (transactionStarted) {
    await sql.unsafe("ROLLBACK");
  }
  await sql.end({ timeout: 5 });
}
