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
  "change_event_receipts",
  "change_events",
  "data_sources",
  "import_runs",
  "invitations",
  "league_memberships",
  "matchup_snapshots",
  "ranking_entries",
  "ranking_list_versions",
  "ranking_lists",
  "refresh_requests",
  "share_links",
  "standings_entries",
  "standings_snapshots",
  "user_preferences",
  "weekly_matchups",
] as const;

const expectedTriggers = [
  "ai_usage_ledger_append_only_trigger",
  "bridge_device_leagues_grant_trigger",
  "change_events_append_only_trigger",
  "invitations_single_use_trigger",
  "league_memberships_integrity_trigger",
  "leagues_sync_owner_membership_trigger",
  "ranking_entries_immutable_trigger",
  "ranking_list_versions_10_scope_trigger",
  "ranking_list_versions_20_immutable_trigger",
  "ranking_lists_version_pointers_trigger",
] as const;

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    assert.fail(`${label} was not returned as a string`);
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
  await sql`
    insert into league_seasons (
      league_id, provider, external_key, season, team_count, draft_type
    ) values (${leagueId}, 'espn', '123456789', 2026, 10, 'auction')
  `;
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
