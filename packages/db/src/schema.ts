import {
  FIRST_PARTY_ROS_MAXIMUM_SCENARIOS,
  FIRST_PARTY_ROS_MINIMUM_SCENARIOS,
} from "@fantasy/projections";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export type ProviderName = "yahoo" | "espn" | "manual";
export type ConnectionHealth = "pending" | "healthy" | "degraded" | "reauthorize" | "disabled";
export type ApplicationRole = "member" | "admin";
export type LeagueMembershipRole = "owner" | "commissioner" | "manager" | "viewer";
export type RankingListKind = "rankings" | "adp" | "auction-values" | "cheat-sheet";
export type RankingVisibility = "private" | "league" | "shared-link";
export type RankingVersionStatus = "draft" | "published";
export type ImportRunState = "queued" | "processing" | "succeeded" | "failed" | "cancelled";
export type RefreshRequestState = "queued" | "processing" | "succeeded" | "failed" | "cancelled";
export type RefreshRequestKind =
  "player_catalog" | "rankings" | "projections" | "injuries" | "league" | "all";
export type DraftEventSource = "manual" | "espn";
export type DraftProviderFeedState =
  "waiting" | "live" | "paused" | "stale" | "complete" | "degraded";
export type DraftProviderFeedVerification = "pending" | "verified" | "mismatched";
export type DraftProviderObservationResult =
  "accepted" | "idempotent" | "standby" | "held" | "rejected";
export type AiProviderName = "openai" | "anthropic" | "gemini" | "openrouter";
export type AiCredentialStatus = "active" | "invalid" | "revoked";
export type StandingStreakType = "win" | "loss" | "tie" | "none";
export type WeeklyMatchupStatus = "scheduled" | "in-progress" | "final";
export type ProjectionVisibility = "global" | "private" | "league";
export type ProjectionObservationKind = "points" | "stat-components";
export type ProjectionObservationHorizon = "week" | "rest-of-season" | "full-season";
export type ProjectionIdentityState = "explicit" | "legacy-unknown";
export type NflScheduleGameStatus =
  "scheduled" | "in-progress" | "final" | "postponed" | "cancelled";
export type ProjectionModelQualityState = "publishable" | "degraded" | "rejected";
export type AdpScoringFormat = "standard" | "half-ppr" | "ppr";
export type AdpRosterFormat = "one-qb" | "superflex" | "two-qb" | "unknown";
export type LeagueSupplementalKind =
  "available-players" | "weekly-box-scores" | "transactions" | "completed-draft";
/**
 * One outbound notification family. New kinds are additive: a payload builder plus an idempotency
 * key slot, never new delivery plumbing.
 */
/** `change-event` means one digest per member per sweep, never one push per event. */
export type NotificationKind = "lineup-lock" | "change-event";

export interface FirstPartyRosAvailabilityWeek {
  readonly week: number;
  readonly scheduled: boolean;
  readonly bye: boolean;
  readonly availabilityProbability: number;
}

export interface FirstPartyRosAvailabilitySnapshot {
  readonly schemaVersion: 1;
  readonly semantics: "unconditional-active-probability";
  readonly weeks: readonly FirstPartyRosAvailabilityWeek[];
}

/** One pinned upstream input-checksum lineage entry for a ROS champion artifact. */
export interface FirstPartyRosChampionArtifactSourceChecksum {
  readonly key: string;
  readonly checksum: string;
}

export type JsonPrimitive = string | number | boolean | null;
export type RankingEntryUserFields = Record<string, JsonPrimitive>;
export type RankingVisibilityConfig =
  | { scope: "private" }
  | { scope: "league"; leagueIds: string[]; allowClone: boolean }
  | {
      scope: "shared-link";
      shareLinkId: string;
      allowClone: boolean;
      expiresAt: string | null;
      revokedAt: string | null;
    };
export type RankingFieldAttribution =
  | { kind: "user"; authorUserId: string; authoredAt: string }
  | {
      kind: "derived";
      sourceId: string;
      computedAt: string;
      inputChecksumSha256: string;
    };
export type RankingFieldProvenance = Record<string, RankingFieldAttribution>;
export type CredentialEnvelopeMetadata = {
  version: number;
  algorithm: string;
  keyId: string;
  purpose: string;
  createdAt: string;
  iv: string;
  ciphertext: string;
  authTag: string;
};

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash"),
    role: text("role").$type<ApplicationRole>().notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("users_email_unique").on(sql`lower(${table.email})`),
    check("users_role_check", sql`${table.role} in ('member', 'admin')`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_idx").on(table.userId),
  ],
);

export const providerConnections = pgTable(
  "provider_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<ProviderName>().notNull(),
    externalAccountId: text("external_account_id").notNull(),
    displayName: text("display_name"),
    encryptedCredential: jsonb("encrypted_credential").$type<Record<string, unknown>>(),
    // Incremented with every credential rotation for compare-and-swap refresh updates.
    credentialVersion: integer("credential_version").notNull().default(1),
    credentialExpiresAt: timestamp("credential_expires_at", { withTimezone: true }),
    capabilities: jsonb("capabilities")
      .$type<Record<string, boolean | string>>()
      .notNull()
      .default({}),
    health: text("health").$type<ConnectionHealth>().notNull().default("pending"),
    lastSuccessfulAt: timestamp("last_successful_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lastErrorDetail: text("last_error_detail"),
    // Connection-scoped circuit state, named to mirror `data_sources`. `health` records what a user
    // must do about a connection; these record whether the worker should stop calling it for a
    // while. Nothing outside league sync reads them, so an open circuit is structurally incapable
    // of affecting another connection or any unrelated analysis.
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    circuitOpenUntil: timestamp("circuit_open_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_connections_account_unique").on(
      table.userId,
      table.provider,
      table.externalAccountId,
    ),
    index("provider_connections_user_idx").on(table.userId),
    check("provider_connections_failures_check", sql`${table.consecutiveFailures} >= 0`),
    check(
      "provider_connections_provider_check",
      sql`${table.provider} in ('yahoo', 'espn', 'manual')`,
    ),
    check(
      "provider_connections_health_check",
      sql`${table.health} in ('pending', 'healthy', 'degraded', 'reauthorize', 'disabled')`,
    ),
    check("provider_connections_credential_version_check", sql`${table.credentialVersion} > 0`),
  ],
);

export const oauthStates = pgTable(
  "oauth_states",
  {
    stateHash: text("state_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<"yahoo">().notNull(),
    encryptedPkceVerifier: jsonb("encrypted_pkce_verifier")
      .$type<Record<string, unknown>>()
      .notNull(),
    returnTo: text("return_to").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("oauth_states_user_expires_idx").on(table.userId, table.expiresAt)],
);

export const leagues = pgTable(
  "leagues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Kept on the existing SQL column so ownership can be migrated without a table rewrite.
    // Access is modeled by leagueMemberships; ownership transfers update this anchor.
    ownerUserId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("leagues_owner_idx").on(table.ownerUserId)],
);

export const userPreferences = pgTable(
  "user_preferences",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    defaultLeagueId: uuid("default_league_id").references(() => leagues.id, {
      onDelete: "set null",
    }),
    timezone: text("timezone").notNull().default("UTC"),
    theme: text("theme").notNull().default("system"),
    digestCadence: text("digest_cadence").notNull().default("daily"),
    emailNotifications: boolean("email_notifications").notNull().default(true),
    dashboardSettings: jsonb("dashboard_settings")
      .$type<Record<string, JsonPrimitive>>()
      .notNull()
      .default({}),
    recommendationSettings: jsonb("recommendation_settings")
      .$type<Record<string, JsonPrimitive>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("user_preferences_default_league_idx").on(table.defaultLeagueId),
    check("user_preferences_theme_check", sql`${table.theme} in ('system', 'light', 'dark')`),
    check(
      "user_preferences_digest_check",
      sql`${table.digestCadence} in ('off', 'daily', 'weekly')`,
    ),
  ],
);

/**
 * One browser push endpoint a member has registered from a device. The endpoint and its two keys
 * are the entire credential: they are bearer material for that browser's push service, never for
 * this application, so they are stored as opaque values and never logged. The row is the member's
 * own revocable device record, deliberately shaped like `bridge_devices`.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgentLabel: text("user_agent_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("push_subscriptions_endpoint_unique").on(table.endpoint),
    index("push_subscriptions_user_idx").on(table.userId),
    check(
      "push_subscriptions_endpoint_check",
      sql`char_length(btrim(${table.endpoint})) between 1 and 2048`,
    ),
    check(
      "push_subscriptions_keys_check",
      sql`char_length(btrim(${table.p256dh})) between 1 and 256 and char_length(btrim(${table.auth})) between 1 and 256`,
    ),
    check(
      "push_subscriptions_label_check",
      sql`${table.userAgentLabel} is null or char_length(btrim(${table.userAgentLabel})) between 1 and 80`,
    ),
  ],
);

/**
 * The idempotency ledger for outbound notifications. One row per (member, notification kind,
 * occasion); the unique index is the mechanism, so a re-run, a restart, or two overlapping
 * schedules can never double-send. Rows carry no notification content.
 */
export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<NotificationKind>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    deliveredDeviceCount: integer("delivered_device_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("notification_deliveries_key_unique").on(table.idempotencyKey),
    index("notification_deliveries_user_idx").on(table.userId, table.createdAt),
    check(
      "notification_deliveries_kind_check",
      sql`${table.kind} in ('lineup-lock', 'change-event')`,
    ),
    check(
      "notification_deliveries_key_check",
      sql`char_length(btrim(${table.idempotencyKey})) between 1 and 200`,
    ),
    check("notification_deliveries_device_count_check", sql`${table.deliveredDeviceCount} >= 0`),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    email: text("email").notNull(),
    // A keyed hash of the normalized email is used for lookups; raw email is never indexed.
    emailHash: text("email_hash").notNull(),
    invitedByUserId: uuid("invited_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    role: text("role").$type<ApplicationRole>().notNull().default("member"),
    leagueId: uuid("league_id").references(() => leagues.id, { onDelete: "cascade" }),
    leagueRole: text("league_role").$type<Exclude<LeagueMembershipRole, "owner">>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("invitations_token_hash_unique").on(table.tokenHash),
    index("invitations_pending_email_hash_idx")
      .on(table.emailHash, table.expiresAt)
      .where(sql`${table.acceptedAt} is null and ${table.revokedAt} is null`),
    index("invitations_inviter_created_idx").on(table.invitedByUserId, table.createdAt),
    index("invitations_league_idx").on(table.leagueId),
    check("invitations_token_hash_check", sql`char_length(${table.tokenHash}) >= 32`),
    check("invitations_email_hash_check", sql`char_length(${table.emailHash}) >= 32`),
    check("invitations_role_check", sql`${table.role} in ('member', 'admin')`),
    check(
      "invitations_league_role_check",
      sql`${table.leagueRole} is null or ${table.leagueRole} in ('commissioner', 'manager', 'viewer')`,
    ),
    check(
      "invitations_league_scope_check",
      sql`(${table.leagueId} is null) = (${table.leagueRole} is null)`,
    ),
    check("invitations_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      "invitations_acceptance_check",
      sql`(${table.acceptedAt} is null) = (${table.acceptedByUserId} is null)`,
    ),
    check(
      "invitations_terminal_state_check",
      sql`not (${table.acceptedAt} is not null and ${table.revokedAt} is not null)`,
    ),
  ],
);

export const bridgeDevices = pgTable(
  "bridge_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<"espn">().notNull().default("espn"),
    name: text("name").notNull(),
    // Browser bridge bearer material is persisted only as a keyed hash. ESPN cookies never
    // cross this table boundary.
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("bridge_devices_token_hash_unique").on(table.tokenHash),
    index("bridge_devices_user_active_idx")
      .on(table.userId, table.createdAt)
      .where(sql`${table.revokedAt} is null`),
    check("bridge_devices_provider_check", sql`${table.provider} = 'espn'`),
    check("bridge_devices_name_check", sql`char_length(btrim(${table.name})) > 0`),
    check("bridge_devices_token_hash_check", sql`char_length(${table.tokenHash}) >= 32`),
    check(
      "bridge_devices_expiry_check",
      sql`${table.expiresAt} is null or ${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "bridge_devices_last_seen_check",
      sql`${table.lastSeenAt} is null or ${table.lastSeenAt} >= ${table.createdAt}`,
    ),
  ],
);

export const bridgePairingSessions = pgTable(
  "bridge_pairing_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The short-lived code is bearer material, so only its SHA-256 digest reaches the database.
    // Redeeming it creates the real bridge credential in one transaction.
    codeHash: text("code_hash").notNull(),
    deviceName: text("device_name").notNull(),
    allowedLeagueIds: jsonb("allowed_league_ids").$type<readonly string[]>().notNull(),
    season: integer("season").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("bridge_pairing_sessions_code_hash_unique").on(table.codeHash),
    index("bridge_pairing_sessions_user_expiry_idx").on(table.userId, table.expiresAt),
    check("bridge_pairing_sessions_code_hash_check", sql`char_length(${table.codeHash}) >= 32`),
    check(
      "bridge_pairing_sessions_device_name_check",
      sql`char_length(btrim(${table.deviceName})) > 0`,
    ),
    check(
      "bridge_pairing_sessions_leagues_check",
      sql`jsonb_typeof(${table.allowedLeagueIds}) = 'array' and jsonb_array_length(${table.allowedLeagueIds}) between 1 and 32`,
    ),
    check("bridge_pairing_sessions_season_check", sql`${table.season} between 2000 and 2100`),
    check("bridge_pairing_sessions_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      "bridge_pairing_sessions_consumed_check",
      sql`${table.consumedAt} is null or ${table.consumedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const bridgeDeviceLeagues = pgTable(
  "bridge_device_leagues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bridgeDeviceId: uuid("bridge_device_id")
      .notNull()
      .references(() => bridgeDevices.id, { onDelete: "cascade" }),
    // ESPN league IDs are decimal strings. They are authorized before the first snapshot can
    // create/link an internal league.
    externalLeagueId: text("external_league_id").notNull(),
    season: integer("season"),
    leagueId: uuid("league_id").references(() => leagues.id, { onDelete: "set null" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("bridge_device_leagues_season_unique")
      .on(table.bridgeDeviceId, table.externalLeagueId, table.season)
      .where(sql`${table.season} is not null`),
    uniqueIndex("bridge_device_leagues_all_seasons_unique")
      .on(table.bridgeDeviceId, table.externalLeagueId)
      .where(sql`${table.season} is null`),
    index("bridge_device_leagues_league_idx").on(table.leagueId),
    check("bridge_device_leagues_external_id_check", sql`${table.externalLeagueId} ~ '^[0-9]+$'`),
    check(
      "bridge_device_leagues_season_check",
      sql`${table.season} is null or (${table.season} >= 2000 and ${table.season} <= 2200)`,
    ),
  ],
);

export const leagueSeasons = pgTable(
  "league_seasons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => providerConnections.id, {
      onDelete: "set null",
    }),
    provider: text("provider").$type<ProviderName>().notNull(),
    externalKey: text("external_key").notNull(),
    season: integer("season").notNull(),
    status: text("status").notNull().default("preseason"),
    teamCount: integer("team_count").notNull(),
    draftType: text("draft_type").notNull(),
    waiverType: text("waiver_type"),
    currentWeek: integer("current_week"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("league_seasons_provider_key_unique").on(
      table.provider,
      table.externalKey,
      table.season,
    ),
    index("league_seasons_league_idx").on(table.leagueId),
    check("league_seasons_provider_check", sql`${table.provider} in ('yahoo', 'espn', 'manual')`),
    check("league_seasons_team_count_check", sql`${table.teamCount} > 1`),
  ],
);

/** Many-to-many authorization provenance between user-owned provider accounts and leagues. */
export const providerLeagueLinks = pgTable(
  "provider_league_links",
  {
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => providerConnections.id, { onDelete: "cascade" }),
    leagueSeasonId: uuid("league_season_id")
      .notNull()
      .references(() => leagueSeasons.id, { onDelete: "cascade" }),
    currentUserTeamExternalKey: text("current_user_team_external_key"),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.connectionId, table.leagueSeasonId] }),
    index("provider_league_links_season_idx").on(table.leagueSeasonId),
    check(
      "provider_league_links_current_team_check",
      sql`${table.currentUserTeamExternalKey} is null or char_length(btrim(${table.currentUserTeamExternalKey})) > 0`,
    ),
  ],
);

export const scoringRules = pgTable(
  "scoring_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueSeasonId: uuid("league_season_id")
      .notNull()
      .references(() => leagueSeasons.id, { onDelete: "cascade" }),
    statKey: text("stat_key").notNull(),
    operation: text("operation").notNull(),
    points: numeric("points", { precision: 10, scale: 4 }).notNull(),
    thresholdLow: numeric("threshold_low", { precision: 10, scale: 2 }),
    thresholdHigh: numeric("threshold_high", { precision: 10, scale: 2 }),
    providerStatId: text("provider_stat_id"),
  },
  (table) => [index("scoring_rules_league_idx").on(table.leagueSeasonId)],
);

export const rosterSlotRules = pgTable(
  "roster_slot_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueSeasonId: uuid("league_season_id")
      .notNull()
      .references(() => leagueSeasons.id, { onDelete: "cascade" }),
    slotCode: text("slot_code").notNull(),
    count: integer("count").notNull(),
    eligiblePositions: text("eligible_positions").array().notNull(),
    isStarter: boolean("is_starter").notNull(),
  },
  (table) => [
    uniqueIndex("roster_slot_rules_unique").on(table.leagueSeasonId, table.slotCode),
    check("roster_slot_rules_count_check", sql`${table.count} >= 0`),
  ],
);

export const fantasyTeams = pgTable(
  "fantasy_teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueSeasonId: uuid("league_season_id")
      .notNull()
      .references(() => leagueSeasons.id, { onDelete: "cascade" }),
    externalKey: text("external_key").notNull(),
    name: text("name").notNull(),
    abbreviation: text("abbreviation"),
    logoUrl: text("logo_url"),
    isUserTeam: boolean("is_user_team").notNull().default(false),
    managerDisplayName: text("manager_display_name"),
    faabRemaining: integer("faab_remaining"),
    waiverPriority: integer("waiver_priority"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("fantasy_teams_external_unique").on(table.leagueSeasonId, table.externalKey),
    index("fantasy_teams_league_idx").on(table.leagueSeasonId),
  ],
);

export const leagueMemberships = pgTable(
  "league_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<LeagueMembershipRole>().notNull().default("manager"),
    claimedFantasyTeamId: uuid("claimed_fantasy_team_id").references(() => fantasyTeams.id, {
      onDelete: "set null",
    }),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("league_memberships_league_user_unique").on(table.leagueId, table.userId),
    uniqueIndex("league_memberships_owner_unique")
      .on(table.leagueId)
      .where(sql`${table.role} = 'owner'`),
    uniqueIndex("league_memberships_claimed_team_unique")
      .on(table.claimedFantasyTeamId)
      .where(sql`${table.claimedFantasyTeamId} is not null`),
    index("league_memberships_user_idx").on(table.userId),
    index("league_memberships_inviter_idx").on(table.invitedByUserId),
    check(
      "league_memberships_role_check",
      sql`${table.role} in ('owner', 'commissioner', 'manager', 'viewer')`,
    ),
    check(
      "league_memberships_claimed_at_check",
      sql`${table.claimedAt} is null or ${table.claimedFantasyTeamId} is not null`,
    ),
  ],
);

export const players = pgTable(
  "players",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gsisId: text("gsis_id"),
    fullName: text("full_name").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    nflTeam: text("nfl_team"),
    primaryPosition: text("primary_position").notNull(),
    eligiblePositions: text("eligible_positions").array().notNull(),
    status: text("status"),
    birthDate: text("birth_date"),
    rookieSeason: integer("rookie_season"),
    lastSeason: integer("last_season"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("players_gsis_unique").on(table.gsisId),
    index("players_name_idx").on(table.fullName),
    index("players_last_season_idx").on(table.lastSeason),
    check(
      "players_season_bounds_check",
      sql`(${table.rookieSeason} is null or ${table.rookieSeason} between 1900 and 2200) and (${table.lastSeason} is null or ${table.lastSeason} between 1900 and 2200)`,
    ),
    check(
      "players_season_order_check",
      sql`${table.rookieSeason} is null or ${table.lastSeason} is null or ${table.lastSeason} >= ${table.rookieSeason}`,
    ),
  ],
);

export const playerExternalIds = pgTable(
  "player_external_ids",
  {
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    season: integer("season"),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull().default("1"),
    verified: boolean("verified").notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.source, table.externalId] }),
    index("player_external_ids_player_idx").on(table.playerId),
    check(
      "player_external_ids_confidence_check",
      sql`${table.confidence} >= 0 and ${table.confidence} <= 1`,
    ),
  ],
);

export const rankingLists = pgTable(
  "ranking_lists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    leagueId: uuid("league_id").references(() => leagues.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    kind: text("kind").$type<RankingListKind>().notNull(),
    visibility: text("visibility").$type<RankingVisibility>().notNull().default("private"),
    visibilityConfig: jsonb("visibility_config")
      .$type<RankingVisibilityConfig>()
      .notNull()
      .default({ scope: "private" }),
    season: integer("season").notNull(),
    scoringContext: jsonb("scoring_context").$type<Record<string, unknown>>().notNull().default({}),
    scoringFormat: text("scoring_format"),
    sourceLabel: text("source_label"),
    settings: jsonb("settings").$type<Record<string, JsonPrimitive>>().notNull().default({}),
    currentVersionId: uuid("current_version_id").references(
      (): AnyPgColumn => rankingListVersions.id,
      { onDelete: "set null" },
    ),
    latestPublishedVersionId: uuid("latest_published_version_id").references(
      (): AnyPgColumn => rankingListVersions.id,
      { onDelete: "set null" },
    ),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("ranking_lists_owner_updated_idx").on(table.ownerUserId, table.updatedAt),
    index("ranking_lists_league_visibility_idx").on(table.leagueId, table.visibility),
    check(
      "ranking_lists_kind_check",
      sql`${table.kind} in ('rankings', 'adp', 'auction-values', 'cheat-sheet')`,
    ),
    check(
      "ranking_lists_visibility_check",
      sql`${table.visibility} in ('private', 'league', 'shared-link')`,
    ),
    check(
      "ranking_lists_visibility_config_check",
      sql`jsonb_typeof(${table.visibilityConfig}) = 'object' and ${table.visibilityConfig}->>'scope' = ${table.visibility}`,
    ),
    check("ranking_lists_season_check", sql`${table.season} >= 2000 and ${table.season} <= 2200`),
    check("ranking_lists_name_check", sql`char_length(btrim(${table.name})) > 0`),
  ],
);

export const importRuns = pgTable(
  "import_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rankingListId: uuid("ranking_list_id").references(() => rankingLists.id, {
      onDelete: "set null",
    }),
    idempotencyKey: text("idempotency_key").notNull(),
    state: text("state").$type<ImportRunState>().notNull().default("queued"),
    sourceFormat: text("source_format").notNull(),
    sourceFileName: text("source_file_name"),
    sourceObjectKey: text("source_object_key"),
    sourceChecksumSha256: text("content_hash"),
    previewChecksumSha256: text("preview_checksum_sha256"),
    columnMapping: jsonb("column_mapping").$type<Record<string, string>>().notNull().default({}),
    rowsRead: integer("rows_read").notNull().default(0),
    rowsAccepted: integer("rows_accepted").notNull().default(0),
    rowsRejected: integer("rows_rejected").notNull().default(0),
    validationSummary: jsonb("validation_summary")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    diagnostics: jsonb("diagnostics")
      .$type<ReadonlyArray<Record<string, unknown>>>()
      .notNull()
      .default([]),
    commitDecision: text("commit_decision").notNull().default("pending"),
    acceptedRowNumbers: integer("accepted_row_numbers").array().notNull().default([]),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorDetail: text("error_detail"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("import_runs_user_idempotency_unique").on(table.userId, table.idempotencyKey),
    index("import_runs_user_created_idx").on(table.userId, table.createdAt),
    index("import_runs_ranking_list_idx").on(table.rankingListId),
    check(
      "import_runs_state_check",
      sql`${table.state} in ('queued', 'processing', 'succeeded', 'failed', 'cancelled')`,
    ),
    check(
      "import_runs_row_counts_check",
      sql`${table.rowsRead} >= 0 and ${table.rowsAccepted} >= 0 and ${table.rowsRejected} >= 0 and ${table.rowsAccepted} + ${table.rowsRejected} <= ${table.rowsRead}`,
    ),
    check(
      "import_runs_finished_at_check",
      sql`${table.finishedAt} is null or ${table.startedAt} is not null`,
    ),
    check(
      "import_runs_content_hash_check",
      sql`${table.sourceChecksumSha256} is null or ${table.sourceChecksumSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "import_runs_preview_hash_check",
      sql`${table.previewChecksumSha256} is null or ${table.previewChecksumSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "import_runs_commit_decision_check",
      sql`${table.commitDecision} in ('pending', 'accepted', 'rejected')`,
    ),
    check(
      "import_runs_committed_at_check",
      sql`(${table.commitDecision} = 'accepted') = (${table.committedAt} is not null)`,
    ),
  ],
);

export const rankingListVersions = pgTable(
  "ranking_list_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listId: uuid("ranking_list_id")
      .notNull()
      .references(() => rankingLists.id, { onDelete: "cascade" }),
    versionNumber: integer("version").notNull(),
    parentVersionId: uuid("parent_version_id").references(
      (): AnyPgColumn => rankingListVersions.id,
      { onDelete: "restrict" },
    ),
    state: text("status").$type<RankingVersionStatus>().notNull().default("draft"),
    authorUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    importRunId: uuid("import_run_id").references(() => importRuns.id, { onDelete: "set null" }),
    dataAsOf: timestamp("data_as_of", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    entryCount: integer("entry_count").notNull().default(0),
    checksumSha256: text("content_hash"),
    changeNote: text("notes"),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, JsonPrimitive>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ranking_list_versions_list_version_unique").on(table.listId, table.versionNumber),
    uniqueIndex("ranking_list_versions_import_run_unique")
      .on(table.importRunId)
      .where(sql`${table.importRunId} is not null`),
    index("ranking_list_versions_status_idx").on(table.listId, table.state, table.versionNumber),
    index("ranking_list_versions_parent_idx").on(table.parentVersionId),
    check("ranking_list_versions_version_check", sql`${table.versionNumber} > 0`),
    check("ranking_list_versions_entry_count_check", sql`${table.entryCount} >= 0`),
    check("ranking_list_versions_status_check", sql`${table.state} in ('draft', 'published')`),
    check(
      "ranking_list_versions_published_at_check",
      sql`(${table.state} = 'published') = (${table.publishedAt} is not null)`,
    ),
    check(
      "ranking_list_versions_content_hash_check",
      sql`${table.checksumSha256} is null or ${table.checksumSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "ranking_list_versions_parent_check",
      sql`${table.parentVersionId} is null or ${table.parentVersionId} <> ${table.id}`,
    ),
  ],
);

export const rankingEntries = pgTable(
  "ranking_entries",
  {
    versionId: uuid("ranking_list_version_id")
      .notNull()
      .references(() => rankingListVersions.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "restrict" }),
    position: text("position"),
    overallRank: integer("rank"),
    tier: integer("tier"),
    positionRank: integer("position_rank"),
    adp: numeric("adp", { precision: 9, scale: 3 }),
    aav: numeric("aav", { precision: 12, scale: 2 }),
    floorPrice: numeric("floor", { precision: 12, scale: 2 }),
    targetPrice: numeric("target", { precision: 12, scale: 2 }),
    ceilingPrice: numeric("ceiling", { precision: 12, scale: 2 }),
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    tags: text("tags").array(),
    userFields: jsonb("user_fields").$type<RankingEntryUserFields>().notNull().default({}),
    fieldProvenance: jsonb("field_provenance")
      .$type<RankingFieldProvenance>()
      .notNull()
      .default({}),
    notes: text("notes"),
    target: boolean("is_target"),
    avoid: boolean("is_avoid"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.versionId, table.playerId] }),
    index("ranking_entries_version_rank_idx").on(table.versionId, table.overallRank),
    index("ranking_entries_player_idx").on(table.playerId),
    check(
      "ranking_entries_rank_check",
      sql`${table.overallRank} is null or ${table.overallRank} > 0`,
    ),
    check("ranking_entries_tier_check", sql`${table.tier} is null or ${table.tier} > 0`),
    check(
      "ranking_entries_position_rank_check",
      sql`${table.positionRank} is null or (${table.positionRank} > 0 and ${table.position} is not null)`,
    ),
    check("ranking_entries_adp_check", sql`${table.adp} is null or ${table.adp} > 0`),
    check("ranking_entries_aav_check", sql`${table.aav} is null or ${table.aav} >= 0`),
    check(
      "ranking_entries_confidence_check",
      sql`${table.confidence} is null or (${table.confidence} >= 0 and ${table.confidence} <= 1)`,
    ),
    check(
      "ranking_entries_value_bounds_check",
      sql`(${table.floorPrice} is null or ${table.floorPrice} >= 0) and (${table.targetPrice} is null or ${table.targetPrice} >= 0) and (${table.ceilingPrice} is null or ${table.ceilingPrice} >= 0) and (${table.floorPrice} is null or ${table.targetPrice} is null or ${table.floorPrice} <= ${table.targetPrice}) and (${table.targetPrice} is null or ${table.ceilingPrice} is null or ${table.targetPrice} <= ${table.ceilingPrice}) and (${table.floorPrice} is null or ${table.ceilingPrice} is null or ${table.floorPrice} <= ${table.ceilingPrice})`,
    ),
    check(
      "ranking_entries_target_avoid_check",
      sql`not (coalesce(${table.target}, false) and coalesce(${table.avoid}, false))`,
    ),
    check(
      "ranking_entries_provenance_check",
      sql`jsonb_typeof(${table.fieldProvenance}) = 'object' and (${table.overallRank} is null or ${table.fieldProvenance} ? 'overallRank') and (${table.positionRank} is null or ${table.fieldProvenance} ? 'positionRank') and (${table.tier} is null or ${table.fieldProvenance} ? 'tier') and (${table.adp} is null or ${table.fieldProvenance} ? 'adp') and (${table.aav} is null or ${table.fieldProvenance} ? 'aav') and (${table.floorPrice} is null or ${table.fieldProvenance} ? 'floorPrice') and (${table.targetPrice} is null or ${table.fieldProvenance} ? 'targetPrice') and (${table.ceilingPrice} is null or ${table.fieldProvenance} ? 'ceilingPrice') and (${table.confidence} is null or ${table.fieldProvenance} ? 'confidence') and (${table.tags} is null or ${table.fieldProvenance} ? 'tags') and (${table.notes} is null or ${table.fieldProvenance} ? 'notes') and (${table.target} is null or ${table.fieldProvenance} ? 'target') and (${table.avoid} is null or ${table.fieldProvenance} ? 'avoid')`,
    ),
  ],
);

export const shareLinks = pgTable(
  "share_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rankingListId: uuid("ranking_list_id").references(() => rankingLists.id, {
      onDelete: "cascade",
    }),
    leagueId: uuid("league_id").references(() => leagues.id, { onDelete: "cascade" }),
    label: text("label"),
    permission: text("permission").notNull().default("view"),
    allowCopy: boolean("allow_copy").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    maxUses: integer("max_uses"),
    useCount: integer("use_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("share_links_token_hash_unique").on(table.tokenHash),
    index("share_links_creator_created_idx").on(table.createdByUserId, table.createdAt),
    index("share_links_ranking_list_idx").on(table.rankingListId),
    index("share_links_league_idx").on(table.leagueId),
    check("share_links_token_hash_check", sql`char_length(${table.tokenHash}) >= 32`),
    check("share_links_permission_check", sql`${table.permission} in ('view', 'copy')`),
    check(
      "share_links_resource_check",
      sql`num_nonnulls(${table.rankingListId}, ${table.leagueId}) = 1`,
    ),
    check("share_links_max_uses_check", sql`${table.maxUses} is null or ${table.maxUses} > 0`),
    check(
      "share_links_use_count_check",
      sql`${table.useCount} >= 0 and (${table.maxUses} is null or ${table.useCount} <= ${table.maxUses})`,
    ),
    check(
      "share_links_expiry_check",
      sql`${table.expiresAt} is null or ${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id").references(() => providerConnections.id, {
      onDelete: "set null",
    }),
    leagueSeasonId: uuid("league_season_id").references(() => leagueSeasons.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    state: text("state").notNull().default("queued"),
    idempotencyKey: text("idempotency_key").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    recordsRead: integer("records_read").notNull().default(0),
    recordsWritten: integer("records_written").notNull().default(0),
    artifactChecksum: text("artifact_checksum"),
    errorCode: text("error_code"),
    errorDetail: text("error_detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sync_runs_idempotency_unique").on(table.idempotencyKey),
    index("sync_runs_league_created_idx").on(table.leagueSeasonId, table.createdAt),
  ],
);

export const dataSources = pgTable(
  "data_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // Public discovery/attribution URLs only. Credentials and raw response artifacts do not
    // belong in freshness state.
    sourceUrl: text("source_url"),
    attribution: text("attribution"),
    attributionUrl: text("attribution_url"),
    checkIntervalMinutes: integer("check_interval_minutes").notNull().default(1440),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastChangedAt: timestamp("last_changed_at", { withTimezone: true }),
    lastSuccessfulAt: timestamp("last_successful_at", { withTimezone: true }),
    etag: text("etag"),
    lastModified: text("last_modified"),
    lastChecksum: text("last_checksum"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorDetail: text("last_error_detail"),
    metadata: jsonb("metadata").$type<Record<string, JsonPrimitive>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("data_sources_key_unique").on(table.key),
    index("data_sources_due_idx")
      .on(table.nextCheckAt)
      .where(sql`${table.enabled} = true`),
    index("data_sources_kind_idx").on(table.kind),
    check("data_sources_key_check", sql`${table.key} ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'`),
    check("data_sources_name_check", sql`char_length(btrim(${table.name})) > 0`),
    check("data_sources_kind_check", sql`char_length(btrim(${table.kind})) > 0`),
    check("data_sources_interval_check", sql`${table.checkIntervalMinutes} between 15 and 10080`),
    check("data_sources_failures_check", sql`${table.consecutiveFailures} >= 0`),
    check(
      "data_sources_checksum_check",
      sql`${table.lastChecksum} is null or char_length(${table.lastChecksum}) >= 32`,
    ),
    check(
      "data_sources_changed_at_check",
      sql`${table.lastChangedAt} is null or (${table.lastCheckedAt} is not null and ${table.lastChangedAt} <= ${table.lastCheckedAt})`,
    ),
    check(
      "data_sources_success_at_check",
      sql`${table.lastSuccessfulAt} is null or (${table.lastCheckedAt} is not null and ${table.lastSuccessfulAt} <= ${table.lastCheckedAt})`,
    ),
    check(
      "data_sources_error_state_check",
      sql`${table.lastErrorAt} is not null or (${table.lastErrorCode} is null and ${table.lastErrorDetail} is null)`,
    ),
  ],
);

export const playerSourceObservations = pgTable(
  "player_source_observations",
  {
    sourceId: uuid("source_id")
      .notNull()
      .references(() => dataSources.id, { onDelete: "cascade" }),
    externalPlayerId: text("external_player_id").notNull(),
    playerId: uuid("player_id").references(() => players.id, { onDelete: "set null" }),
    gsisId: text("gsis_id"),
    fullName: text("full_name").notNull(),
    nflTeam: text("nfl_team"),
    primaryPosition: text("primary_position").notNull(),
    eligiblePositions: text("eligible_positions").array().notNull(),
    status: text("status"),
    injuryStatus: text("injury_status"),
    practiceParticipation: text("practice_participation"),
    depthChartPosition: text("depth_chart_position"),
    depthChartOrder: integer("depth_chart_order"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.externalPlayerId] }),
    index("player_source_observations_player_idx").on(table.playerId),
    index("player_source_observations_observed_idx").on(table.observedAt),
    check(
      "player_source_observations_external_id_check",
      sql`char_length(btrim(${table.externalPlayerId})) between 1 and 64`,
    ),
    check("player_source_observations_name_check", sql`char_length(btrim(${table.fullName})) > 0`),
    check(
      "player_source_observations_position_check",
      sql`char_length(btrim(${table.primaryPosition})) > 0 and cardinality(${table.eligiblePositions}) > 0`,
    ),
    check(
      "player_source_observations_depth_order_check",
      sql`${table.depthChartOrder} is null or ${table.depthChartOrder} between 0 and 99`,
    ),
  ],
);

export const playerMarketObservations = pgTable(
  "player_market_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => dataSources.id, { onDelete: "cascade" }),
    externalPlayerId: text("external_player_id").notNull(),
    playerId: uuid("player_id").references(() => players.id, { onDelete: "set null" }),
    signal: text("signal").$type<"add" | "drop">().notNull(),
    lookbackHours: integer("lookback_hours").notNull(),
    rank: integer("rank").notNull(),
    count: integer("count").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("player_market_observations_run_unique").on(
      table.sourceId,
      table.signal,
      table.externalPlayerId,
      table.observedAt,
    ),
    index("player_market_observations_player_observed_idx").on(table.playerId, table.observedAt),
    index("player_market_observations_source_observed_idx").on(table.sourceId, table.observedAt),
    check(
      "player_market_observations_external_id_check",
      sql`char_length(btrim(${table.externalPlayerId})) between 1 and 64`,
    ),
    check("player_market_observations_signal_check", sql`${table.signal} in ('add', 'drop')`),
    check(
      "player_market_observations_bounds_check",
      sql`${table.lookbackHours} between 1 and 168 and ${table.rank} between 1 and 250 and ${table.count} >= 0`,
    ),
  ],
);

/**
 * Immutable, context-specific draft-market observations. ADP is not portable
 * across scoring, league size, roster format, or time, so those dimensions are
 * part of every stored row rather than metadata inferred by consumers.
 */
export const adpObservations = pgTable(
  "adp_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => dataSources.id, { onDelete: "restrict" }),
    sourceSyncRunId: uuid("source_sync_run_id")
      .notNull()
      .references(() => syncRuns.id, { onDelete: "restrict" }),
    externalPlayerId: text("external_player_id").notNull(),
    playerId: uuid("player_id").references(() => players.id, { onDelete: "restrict" }),
    season: integer("season").notNull(),
    scoringFormat: text("scoring_format").$type<AdpScoringFormat>().notNull(),
    teamCount: integer("team_count").notNull(),
    rosterFormat: text("roster_format").$type<AdpRosterFormat>().notNull().default("unknown"),
    positionFilter: text("position_filter"),
    overallAdp: numeric("overall_adp", { precision: 8, scale: 3 }).notNull(),
    sourceRank: integer("source_rank"),
    positionRank: integer("position_rank"),
    standardDeviation: numeric("standard_deviation", { precision: 8, scale: 3 }),
    sampleSize: integer("sample_size"),
    sourceAsOf: timestamp("source_as_of", { withTimezone: true }).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    inputChecksum: text("input_checksum").notNull(),
    context: jsonb("context").$type<Record<string, JsonPrimitive>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("adp_observations_source_context_player_unique").on(
      table.sourceId,
      table.season,
      table.scoringFormat,
      table.teamCount,
      table.rosterFormat,
      table.sourceAsOf,
      table.externalPlayerId,
    ),
    index("adp_observations_player_context_idx").on(
      table.playerId,
      table.season,
      table.scoringFormat,
      table.teamCount,
      table.sourceAsOf,
    ),
    index("adp_observations_source_freshness_idx").on(table.sourceId, table.sourceAsOf),
    index("adp_observations_sync_run_idx").on(table.sourceSyncRunId),
    check(
      "adp_observations_external_id_check",
      sql`char_length(btrim(${table.externalPlayerId})) between 1 and 64`,
    ),
    check("adp_observations_season_check", sql`${table.season} between 2000 and 2200`),
    check(
      "adp_observations_scoring_format_check",
      sql`${table.scoringFormat} in ('standard', 'half-ppr', 'ppr')`,
    ),
    check("adp_observations_team_count_check", sql`${table.teamCount} between 4 and 32`),
    check(
      "adp_observations_roster_format_check",
      sql`${table.rosterFormat} in ('one-qb', 'superflex', 'two-qb', 'unknown')`,
    ),
    check(
      "adp_observations_position_filter_check",
      sql`${table.positionFilter} is null or char_length(btrim(${table.positionFilter})) between 1 and 16`,
    ),
    check(
      "adp_observations_value_check",
      sql`${table.overallAdp} > 0 and ${table.overallAdp} <= 1000`,
    ),
    check(
      "adp_observations_rank_check",
      sql`(${table.sourceRank} is null or ${table.sourceRank} between 1 and 1000) and (${table.positionRank} is null or ${table.positionRank} between 1 and 1000)`,
    ),
    check(
      "adp_observations_dispersion_check",
      sql`${table.standardDeviation} is null or (${table.standardDeviation} >= 0 and ${table.standardDeviation} <= 1000)`,
    ),
    check(
      "adp_observations_sample_check",
      sql`${table.sampleSize} is null or ${table.sampleSize} >= 0`,
    ),
    check("adp_observations_checksum_check", sql`${table.inputChecksum} ~ '^[a-f0-9]{64}$'`),
    check(
      "adp_observations_time_check",
      sql`${table.sourceAsOf} <= ${table.fetchedAt} + interval '5 minutes'`,
    ),
  ],
);

export const rosterSnapshots = pgTable(
  "roster_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => fantasyTeams.id, { onDelete: "cascade" }),
    season: integer("season").notNull(),
    week: integer("week"),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    sourceSyncRunId: uuid("source_sync_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("roster_snapshots_team_effective_idx").on(table.teamId, table.effectiveAt)],
);

export const rosterEntries = pgTable(
  "roster_entries",
  {
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => rosterSnapshots.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "restrict" }),
    slotCode: text("slot_code").notNull(),
    isStarter: boolean("is_starter").notNull(),
    locked: boolean("locked").notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.snapshotId, table.playerId] })],
);

export const projectionSets = pgTable(
  "projection_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueSeasonId: uuid("league_season_id").references(() => leagueSeasons.id, {
      onDelete: "cascade",
    }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    visibility: text("visibility").$type<ProjectionVisibility>().notNull().default("global"),
    source: text("source").notNull(),
    version: text("version").notNull(),
    season: integer("season").notNull(),
    week: integer("week"),
    horizon: text("horizon").$type<ProjectionObservationHorizon>().notNull(),
    identityState: text("identity_state")
      .$type<ProjectionIdentityState>()
      .notNull()
      .default("explicit"),
    windowStartWeek: integer("window_start_week").notNull().default(0),
    windowEndWeek: integer("window_end_week").notNull().default(0),
    asOfWeek: integer("as_of_week").notNull().default(-1),
    asOfAt: timestamp("as_of_at", { withTimezone: true })
      .notNull()
      .default(sql`'-infinity'::timestamptz`),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    inputChecksum: text("input_checksum").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("projection_sets_source_version_unique").on(table.source, table.version),
    uniqueIndex("projection_sets_scoped_import_unique")
      .on(table.leagueSeasonId, table.createdByUserId, table.visibility, table.inputChecksum)
      .where(sql`${table.leagueSeasonId} is not null`),
    index("projection_sets_scoped_week_idx").on(
      table.leagueSeasonId,
      table.season,
      table.week,
      table.horizon,
      table.fetchedAt,
    ),
    index("projection_sets_creator_idx").on(table.createdByUserId),
    uniqueIndex("projection_sets_managed_window_input_unique")
      .on(
        table.leagueSeasonId,
        table.source,
        table.season,
        table.horizon,
        table.identityState,
        table.windowStartWeek,
        table.windowEndWeek,
        table.asOfWeek,
        table.asOfAt,
        table.inputChecksum,
      )
      .where(sql`${table.leagueSeasonId} is not null and ${table.createdByUserId} is null`),
    index("projection_sets_scoped_window_idx").on(
      table.leagueSeasonId,
      table.season,
      table.horizon,
      table.identityState,
      table.windowStartWeek,
      table.windowEndWeek,
      table.asOfAt,
    ),
    check(
      "projection_sets_visibility_check",
      sql`${table.visibility} in ('global', 'private', 'league')`,
    ),
    check(
      "projection_sets_scope_check",
      sql`(${table.visibility} = 'global' and ${table.leagueSeasonId} is null and ${table.createdByUserId} is null) or (${table.visibility} = 'private' and ${table.leagueSeasonId} is not null and ${table.createdByUserId} is not null) or (${table.visibility} = 'league' and ${table.leagueSeasonId} is not null)`,
    ),
    check(
      "projection_sets_week_check",
      sql`${table.week} is null or ${table.week} between 1 and 25`,
    ),
    check(
      "projection_sets_horizon_window_check",
      sql`${table.horizon} in ('week', 'rest-of-season', 'full-season') and ((${table.identityState} = 'explicit' and ${table.windowStartWeek} between 1 and 25 and ${table.windowEndWeek} between ${table.windowStartWeek} and 25 and ${table.asOfWeek} between 0 and 24 and ${table.asOfWeek} < ${table.windowStartWeek} and ${table.asOfAt} >= '2000-01-01'::timestamptz and ${table.asOfAt} <= ${table.fetchedAt} + interval '5 minutes' and ((${table.horizon} = 'week' and ${table.week} is not null and ${table.windowStartWeek} = ${table.week} and ${table.windowEndWeek} = ${table.week}) or (${table.horizon} <> 'week' and ${table.week} is null))) or (${table.identityState} = 'legacy-unknown' and ${table.horizon} <> 'week' and ${table.week} is null and ${table.windowStartWeek} = 0 and ${table.windowEndWeek} = 0 and ${table.asOfWeek} = -1 and ${table.asOfAt} = '-infinity'::timestamptz))`,
    ),
  ],
);

export const playerProjections = pgTable(
  "player_projections",
  {
    projectionSetId: uuid("projection_set_id")
      .notNull()
      .references(() => projectionSets.id, { onDelete: "cascade" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    meanPoints: numeric("mean_points", { precision: 10, scale: 3 }).notNull(),
    floorPoints: numeric("floor_points", { precision: 10, scale: 3 }),
    ceilingPoints: numeric("ceiling_points", { precision: 10, scale: 3 }),
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    components: jsonb("components").$type<Record<string, number>>().notNull().default({}),
  },
  (table) => [primaryKey({ columns: [table.projectionSetId, table.playerId] })],
);

/**
 * Immutable NFL game context. A new source artifact creates new rows instead of rewriting the
 * schedule that a prior forecast used, which keeps every model run reproducible after flexes,
 * postponements, or corrections.
 */
export const nflScheduleObservations = pgTable(
  "nfl_schedule_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => dataSources.id, { onDelete: "restrict" }),
    sourceSyncRunId: uuid("source_sync_run_id")
      .notNull()
      .references(() => syncRuns.id, { onDelete: "restrict" }),
    externalGameId: text("external_game_id").notNull(),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    seasonType: text("season_type").$type<"REG" | "POST">().notNull(),
    gameDate: text("game_date").notNull(),
    startTimeEastern: text("start_time_eastern"),
    timeTbd: boolean("time_tbd").notNull(),
    kickoffAt: timestamp("kickoff_at", { withTimezone: true }),
    awayTeam: text("away_team").notNull(),
    homeTeam: text("home_team").notNull(),
    status: text("status").$type<NflScheduleGameStatus>().notNull(),
    neutralSite: boolean("neutral_site").notNull().default(false),
    awayRestDays: integer("away_rest_days"),
    homeRestDays: integer("home_rest_days"),
    awayScore: integer("away_score"),
    homeScore: integer("home_score"),
    sourceAsOf: timestamp("source_as_of", { withTimezone: true }).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    inputChecksum: text("input_checksum").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("nfl_schedule_observations_source_game_unique").on(
      table.sourceId,
      table.externalGameId,
      table.inputChecksum,
    ),
    index("nfl_schedule_observations_season_week_idx").on(
      table.season,
      table.week,
      table.seasonType,
      table.sourceAsOf,
    ),
    index("nfl_schedule_observations_away_team_idx").on(table.awayTeam, table.season, table.week),
    index("nfl_schedule_observations_home_team_idx").on(table.homeTeam, table.season, table.week),
    index("nfl_schedule_observations_sync_run_idx").on(table.sourceSyncRunId),
    check(
      "nfl_schedule_observations_game_id_check",
      sql`char_length(btrim(${table.externalGameId})) between 1 and 64`,
    ),
    check("nfl_schedule_observations_season_check", sql`${table.season} between 1999 and 2200`),
    check("nfl_schedule_observations_week_check", sql`${table.week} between 1 and 25`),
    check(
      "nfl_schedule_observations_season_type_check",
      sql`${table.seasonType} in ('REG', 'POST')`,
    ),
    check(
      "nfl_schedule_observations_teams_check",
      sql`${table.awayTeam} ~ '^[A-Z]{2,4}$' and ${table.homeTeam} ~ '^[A-Z]{2,4}$' and ${table.awayTeam} <> ${table.homeTeam}`,
    ),
    check(
      "nfl_schedule_observations_status_check",
      sql`${table.status} in ('scheduled', 'in-progress', 'final', 'postponed', 'cancelled')`,
    ),
    check(
      "nfl_schedule_observations_timing_check",
      sql`${table.gameDate} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and ((${table.timeTbd} = true and ${table.startTimeEastern} is null) or (${table.timeTbd} = false and ${table.startTimeEastern} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'))`,
    ),
    check(
      "nfl_schedule_observations_rest_check",
      sql`(${table.awayRestDays} is null or ${table.awayRestDays} between 0 and 30) and (${table.homeRestDays} is null or ${table.homeRestDays} between 0 and 30)`,
    ),
    check(
      "nfl_schedule_observations_score_check",
      sql`(${table.awayScore} is null or ${table.awayScore} between 0 and 200) and (${table.homeScore} is null or ${table.homeScore} between 0 and 200) and ((${table.awayScore} is null) = (${table.homeScore} is null)) and (${table.status} <> 'final' or ${table.awayScore} is not null)`,
    ),
    check(
      "nfl_schedule_observations_checksum_check",
      sql`${table.inputChecksum} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "nfl_schedule_observations_time_check",
      sql`${table.sourceAsOf} <= ${table.fetchedAt} + interval '5 minutes'`,
    ),
  ],
);

/** Immutable audit record for one trained and evaluated first-party projection run. */
export const projectionModelRuns = pgTable(
  "projection_model_runs",
  {
    sourceSyncRunId: uuid("source_sync_run_id")
      .primaryKey()
      .references(() => syncRuns.id, { onDelete: "restrict" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => dataSources.id, { onDelete: "restrict" }),
    season: integer("season").notNull(),
    horizon: text("horizon").$type<ProjectionObservationHorizon>().notNull().default("week"),
    targetWeek: integer("target_week"),
    windowStartWeek: integer("window_start_week").notNull().default(0),
    windowEndWeek: integer("window_end_week").notNull().default(0),
    asOfWeek: integer("as_of_week").notNull().default(-1),
    asOfAt: timestamp("as_of_at", { withTimezone: true })
      .notNull()
      .default(sql`'-infinity'::timestamptz`),
    modelVersion: text("model_version").notNull(),
    trainingWindowStartSeason: integer("training_window_start_season").notNull(),
    trainedThroughSeason: integer("trained_through_season").notNull(),
    trainedThroughWeek: integer("trained_through_week"),
    qualityState: text("quality_state").$type<ProjectionModelQualityState>().notNull(),
    playersEvaluated: integer("players_evaluated").notNull(),
    playersPublished: integer("players_published").notNull(),
    inputChecksum: text("input_checksum").notNull(),
    configuration: jsonb("configuration").$type<Record<string, unknown>>().notNull(),
    calibration: jsonb("calibration").$type<Record<string, unknown>>().notNull(),
    metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull(),
    sourceAsOf: timestamp("source_as_of", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("projection_model_runs_target_checksum_unique").on(
      table.sourceId,
      table.season,
      table.horizon,
      table.windowStartWeek,
      table.windowEndWeek,
      table.asOfWeek,
      table.asOfAt,
      table.modelVersion,
      table.inputChecksum,
    ),
    index("projection_model_runs_target_created_idx").on(
      table.season,
      table.horizon,
      table.windowStartWeek,
      table.windowEndWeek,
      table.asOfAt,
      table.createdAt,
    ),
    check("projection_model_runs_season_check", sql`${table.season} between 2000 and 2200`),
    check(
      "projection_model_runs_horizon_window_check",
      sql`${table.horizon} in ('week', 'rest-of-season', 'full-season') and ${table.windowStartWeek} between 1 and 25 and ${table.windowEndWeek} between ${table.windowStartWeek} and 25 and ${table.asOfWeek} between 0 and 24 and ${table.asOfWeek} < ${table.windowStartWeek} and ((${table.horizon} = 'week' and ${table.targetWeek} is not null and ${table.targetWeek} = ${table.windowStartWeek} and ${table.targetWeek} = ${table.windowEndWeek}) or (${table.horizon} <> 'week' and ${table.targetWeek} is null))`,
    ),
    check(
      "projection_model_runs_as_of_time_check",
      sql`${table.asOfAt} >= '2000-01-01'::timestamptz and ${table.sourceAsOf} <= ${table.asOfAt}`,
    ),
    check(
      "projection_model_runs_training_window_check",
      sql`${table.trainingWindowStartSeason} between 1999 and ${table.trainedThroughSeason} and ${table.trainedThroughSeason} <= ${table.season} and (${table.trainedThroughWeek} is null or ${table.trainedThroughWeek} between 1 and 25) and (${table.trainedThroughSeason} < ${table.season} or (${table.trainedThroughSeason} = ${table.season} and ${table.trainedThroughWeek} is not null and ${table.trainedThroughWeek} <= ${table.asOfWeek}))`,
    ),
    check(
      "projection_model_runs_identity_check",
      sql`char_length(btrim(${table.modelVersion})) > 0`,
    ),
    check(
      "projection_model_runs_quality_check",
      sql`${table.qualityState} in ('publishable', 'degraded', 'rejected')`,
    ),
    check(
      "projection_model_runs_counts_check",
      sql`${table.playersEvaluated} >= 0 and ${table.playersPublished} >= 0 and ${table.playersPublished} <= ${table.playersEvaluated}`,
    ),
    check(
      "projection_model_runs_payload_check",
      sql`jsonb_typeof(${table.configuration}) = 'object' and jsonb_typeof(${table.calibration}) = 'object' and jsonb_typeof(${table.metrics}) = 'object'`,
    ),
    check("projection_model_runs_checksum_check", sql`${table.inputChecksum} ~ '^[a-f0-9]{64}$'`),
  ],
);

/**
 * League-scored rest-of-season distribution diagnostics. Totals remain in player_projections;
 * this immutable companion records the schedule, availability, and simulation shape behind them.
 * Direct changes are rejected. Deletion is allowed only through projection-set, league-season, or
 * account lifecycle cascade so user erasure does not strand scoped forecasts while automated
 * observation history stays intact.
 */
export const playerRosProjectionSummaries = pgTable(
  "player_ros_projection_summaries",
  {
    projectionSetId: uuid("projection_set_id")
      .notNull()
      .references(() => projectionSets.id, { onDelete: "cascade" }),
    sourceSyncRunId: uuid("source_sync_run_id")
      .notNull()
      .references(() => projectionModelRuns.sourceSyncRunId, { onDelete: "restrict" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "restrict" }),
    season: integer("season").notNull(),
    windowStartWeek: integer("window_start_week").notNull(),
    windowEndWeek: integer("window_end_week").notNull(),
    asOfWeek: integer("as_of_week").notNull(),
    asOfAt: timestamp("as_of_at", { withTimezone: true }).notNull(),
    scheduledGames: integer("scheduled_games").notNull(),
    expectedGames: numeric("expected_games", { precision: 8, scale: 6 }).notNull(),
    aggregateMeanPoints: numeric("aggregate_mean_points", { precision: 10, scale: 3 }).notNull(),
    p15Points: numeric("p15_points", { precision: 10, scale: 3 }).notNull(),
    p50Points: numeric("p50_points", { precision: 10, scale: 3 }).notNull(),
    p85Points: numeric("p85_points", { precision: 10, scale: 3 }).notNull(),
    meanPointsPerExpectedGame: numeric("mean_points_per_expected_game", {
      precision: 12,
      scale: 6,
    }),
    pointsStddev: numeric("points_stddev", { precision: 10, scale: 3 }).notNull(),
    availability: jsonb("availability").$type<FirstPartyRosAvailabilitySnapshot>().notNull(),
    scenarioCount: integer("scenario_count").notNull(),
    methodVersion: text("method_version").notNull(),
    seedHash: text("seed_hash").notNull(),
    inputChecksum: text("input_checksum").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectionSetId, table.playerId] }),
    uniqueIndex("player_ros_projection_summaries_identity_unique").on(
      table.sourceSyncRunId,
      table.projectionSetId,
      table.playerId,
      table.methodVersion,
      table.seedHash,
      table.inputChecksum,
    ),
    index("player_ros_projection_summaries_run_idx").on(table.sourceSyncRunId),
    index("player_ros_projection_summaries_player_window_idx").on(
      table.playerId,
      table.season,
      table.windowStartWeek,
      table.windowEndWeek,
      table.asOfAt,
    ),
    check(
      "player_ros_projection_summaries_season_check",
      sql`${table.season} between 2000 and 2200`,
    ),
    check(
      "player_ros_projection_summaries_window_check",
      sql`${table.windowStartWeek} between 1 and 25 and ${table.windowEndWeek} between ${table.windowStartWeek} and 25 and ${table.asOfWeek} between 0 and 24 and ${table.asOfWeek} < ${table.windowStartWeek} and ${table.asOfAt} >= '2000-01-01'::timestamptz`,
    ),
    check(
      "player_ros_projection_summaries_games_check",
      sql`${table.scheduledGames} between 0 and (${table.windowEndWeek} - ${table.windowStartWeek} + 1) and ${table.expectedGames} between 0 and ${table.scheduledGames}`,
    ),
    check(
      "player_ros_projection_summaries_distribution_check",
      sql`${table.aggregateMeanPoints} between -2500 and 5000 and ${table.p15Points} between -2500 and ${table.p50Points} and ${table.p50Points} <= ${table.p85Points} and ${table.p85Points} <= 5000 and ${table.pointsStddev} between 0 and 1000 and ((${table.expectedGames} = 0 and ${table.aggregateMeanPoints} = 0 and ${table.p15Points} = 0 and ${table.p50Points} = 0 and ${table.p85Points} = 0 and ${table.pointsStddev} = 0 and ${table.meanPointsPerExpectedGame} is null) or (${table.expectedGames} > 0 and ${table.meanPointsPerExpectedGame} between -100 and 200 and abs((${table.meanPointsPerExpectedGame} * ${table.expectedGames}) - ${table.aggregateMeanPoints}) <= 0.001))`,
    ),
    check(
      "player_ros_projection_summaries_availability_check",
      sql`jsonb_typeof(${table.availability}) = 'object' and ${table.availability}->'schemaVersion' = '1'::jsonb and ${table.availability}->>'semantics' = 'unconditional-active-probability' and jsonb_typeof(${table.availability}->'weeks') = 'array'`,
    ),
    // The persisted contract is exactly the engine's admissible path-count range, imported rather
    // than restated: a released summary carries the standard 12288-path result and its convergence
    // diagnostic pins the 16384-path reference. Anything outside these bounds still fails closed.
    check(
      "player_ros_projection_summaries_scenarios_check",
      sql`${table.scenarioCount} between ${sql.raw(String(FIRST_PARTY_ROS_MINIMUM_SCENARIOS))} and ${sql.raw(String(FIRST_PARTY_ROS_MAXIMUM_SCENARIOS))}`,
    ),
    check(
      "player_ros_projection_summaries_identity_check",
      sql`char_length(btrim(${table.methodVersion})) between 1 and 128 and ${table.seedHash} ~ '^[a-f0-9]{64}$' and ${table.inputChecksum} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

/**
 * Immutable, checksummed rest-of-season champion/calibration artifact. It is the ONLY thing that
 * can authorize live ROS publication: the shadow rail fails closed until a row exists here whose
 * checksum validates, whose model/policy/calibration identities match the running code, and whose
 * scoring-profile identity matches the target league exactly. There is deliberately no automated
 * code path that inserts these rows; admission happens through a separate release-proof step, so in
 * normal operation this table stays empty and the rail records only degraded audit evidence.
 *
 * Rows are append-only and immutable (enforced by trigger). `policy` is the serialized
 * `FirstPartyRosChampionPolicy` (its choices, interval-calibration artifacts, walk-forward and
 * held-out evidence, and `evidenceIdentity`). `source_checksums` pins the exact input lineage the
 * admission run consumed. `release_gate` records the admission-time release-gate decision.
 */
export const firstPartyRosChampionArtifacts = pgTable(
  "first_party_ros_champion_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    season: integer("season").notNull(),
    scoringProfileKey: text("scoring_profile_key").notNull(),
    modelVersion: text("model_version").notNull(),
    policyVersion: text("policy_version").notNull(),
    calibrationVersion: text("calibration_version").notNull(),
    evidenceThroughSeason: integer("evidence_through_season").notNull(),
    sourceChecksums: jsonb("source_checksums")
      .$type<readonly FirstPartyRosChampionArtifactSourceChecksum[]>()
      .notNull(),
    policy: jsonb("policy").$type<Record<string, unknown>>().notNull(),
    releaseGate: jsonb("release_gate").$type<Record<string, unknown>>().notNull(),
    artifactChecksum: text("artifact_checksum").notNull(),
    admittedAt: timestamp("admitted_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("first_party_ros_champion_artifacts_identity_unique").on(
      table.season,
      table.scoringProfileKey,
      table.modelVersion,
      table.policyVersion,
      table.calibrationVersion,
      table.artifactChecksum,
    ),
    index("first_party_ros_champion_artifacts_lookup_idx").on(
      table.season,
      table.scoringProfileKey,
      table.admittedAt,
    ),
    check(
      "first_party_ros_champion_artifacts_season_check",
      sql`${table.season} between 2000 and 2200 and ${table.evidenceThroughSeason} between 1999 and ${table.season}`,
    ),
    check(
      "first_party_ros_champion_artifacts_identity_check",
      sql`char_length(btrim(${table.scoringProfileKey})) between 1 and 8192 and char_length(btrim(${table.modelVersion})) between 1 and 128 and char_length(btrim(${table.policyVersion})) between 1 and 128 and char_length(btrim(${table.calibrationVersion})) between 1 and 128`,
    ),
    check(
      "first_party_ros_champion_artifacts_checksum_check",
      sql`${table.artifactChecksum} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "first_party_ros_champion_artifacts_payload_check",
      sql`jsonb_typeof(${table.sourceChecksums}) = 'array' and jsonb_array_length(${table.sourceChecksums}) > 0 and jsonb_typeof(${table.policy}) = 'object' and jsonb_typeof(${table.releaseGate}) = 'object'`,
    ),
    check(
      "first_party_ros_champion_artifacts_admitted_check",
      sql`${table.admittedAt} >= '2000-01-01'::timestamptz`,
    ),
  ],
);

/**
 * Immutable forecasts captured from automated sources before league scoring or consensus is
 * applied. Points-only rows carry the exact source scoring profile; component rows remain
 * scoring-independent so consumers can evaluate them under each league's rules.
 */
export const projectionObservations = pgTable(
  "projection_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => dataSources.id, { onDelete: "restrict" }),
    sourceSyncRunId: uuid("source_sync_run_id")
      .notNull()
      .references(() => syncRuns.id, { onDelete: "restrict" }),
    externalPlayerId: text("external_player_id").notNull(),
    playerId: uuid("player_id").references(() => players.id, { onDelete: "restrict" }),
    kind: text("kind").$type<ProjectionObservationKind>().notNull(),
    sourceVersion: text("source_version").notNull(),
    independenceKey: text("independence_key").notNull(),
    season: integer("season").notNull(),
    week: integer("week"),
    horizon: text("horizon").$type<ProjectionObservationHorizon>().notNull(),
    scoringProfile: jsonb("scoring_profile").$type<Record<string, unknown>>(),
    scoringProfileKey: text("scoring_profile_key"),
    components: jsonb("components").$type<Record<string, number>>().notNull().default({}),
    floorComponents: jsonb("floor_components").$type<Record<string, number>>(),
    ceilingComponents: jsonb("ceiling_components").$type<Record<string, number>>(),
    meanPoints: numeric("mean_points", { precision: 10, scale: 3 }),
    floorPoints: numeric("floor_points", { precision: 10, scale: 3 }),
    ceilingPoints: numeric("ceiling_points", { precision: 10, scale: 3 }),
    sourceAsOf: timestamp("source_as_of", { withTimezone: true }).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    inputChecksum: text("input_checksum").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("projection_observations_source_version_player_unique").on(
      table.sourceId,
      table.sourceVersion,
      table.season,
      table.week,
      table.horizon,
      table.externalPlayerId,
      table.inputChecksum,
    ),
    index("projection_observations_player_horizon_idx").on(
      table.playerId,
      table.season,
      table.week,
      table.horizon,
      table.sourceAsOf,
    ),
    index("projection_observations_source_freshness_idx").on(table.sourceId, table.sourceAsOf),
    index("projection_observations_sync_run_idx").on(table.sourceSyncRunId),
    index("projection_observations_unmatched_idx")
      .on(table.sourceId, table.sourceAsOf)
      .where(sql`${table.playerId} is null`),
    check(
      "projection_observations_external_id_check",
      sql`char_length(btrim(${table.externalPlayerId})) between 1 and 128`,
    ),
    check(
      "projection_observations_kind_check",
      sql`${table.kind} in ('points', 'stat-components')`,
    ),
    check(
      "projection_observations_identity_check",
      sql`char_length(btrim(${table.sourceVersion})) > 0 and char_length(btrim(${table.independenceKey})) > 0`,
    ),
    check("projection_observations_season_check", sql`${table.season} between 2000 and 2200`),
    check(
      "projection_observations_horizon_check",
      sql`${table.horizon} in ('week', 'rest-of-season', 'full-season') and ((${table.horizon} = 'week' and ${table.week} between 1 and 25) or (${table.horizon} <> 'week' and ${table.week} is null))`,
    ),
    check(
      "projection_observations_payload_check",
      sql`(${table.kind} = 'points' and ${table.meanPoints} is not null and ${table.scoringProfile} is not null and jsonb_typeof(${table.scoringProfile}) = 'object' and ${table.scoringProfileKey} is not null and char_length(${table.scoringProfileKey}) > 0) or (${table.kind} = 'stat-components' and ${table.meanPoints} is null and ${table.floorPoints} is null and ${table.ceilingPoints} is null and ${table.scoringProfile} is null and ${table.scoringProfileKey} is null and jsonb_typeof(${table.components}) = 'object' and ${table.components} <> '{}'::jsonb)`,
    ),
    check(
      "projection_observations_component_shape_check",
      sql`jsonb_typeof(${table.components}) = 'object' and (${table.floorComponents} is null or jsonb_typeof(${table.floorComponents}) = 'object') and (${table.ceilingComponents} is null or jsonb_typeof(${table.ceilingComponents}) = 'object')`,
    ),
    check(
      "projection_observations_interval_check",
      sql`${table.floorPoints} is null or ${table.ceilingPoints} is null or ${table.floorPoints} <= ${table.ceilingPoints}`,
    ),
    check("projection_observations_checksum_check", sql`${table.inputChecksum} ~ '^[a-f0-9]{64}$'`),
    check(
      "projection_observations_time_check",
      sql`${table.sourceAsOf} <= ${table.fetchedAt} + interval '5 minutes'`,
    ),
  ],
);

/** Immutable weekly box-score facts used for league scoring, trends, and model evaluation. */
export const playerWeeklyStatObservations = pgTable(
  "player_weekly_stat_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => dataSources.id, { onDelete: "restrict" }),
    sourceSyncRunId: uuid("source_sync_run_id")
      .notNull()
      .references(() => syncRuns.id, { onDelete: "restrict" }),
    externalPlayerId: text("external_player_id").notNull(),
    playerId: uuid("player_id").references(() => players.id, { onDelete: "restrict" }),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    seasonType: text("season_type").$type<"REG" | "POST">().notNull(),
    gameId: text("game_id").notNull(),
    team: text("team").notNull(),
    opponentTeam: text("opponent_team").notNull(),
    components: jsonb("components").$type<Record<string, number>>().notNull(),
    advanced: jsonb("advanced").$type<Record<string, number | null>>().notNull().default({}),
    sourceFantasyPoints: jsonb("source_fantasy_points")
      .$type<Record<"standard" | "ppr", number>>()
      .notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    inputChecksum: text("input_checksum").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("player_weekly_stats_source_game_player_unique").on(
      table.sourceId,
      table.gameId,
      table.externalPlayerId,
      table.inputChecksum,
    ),
    index("player_weekly_stats_player_week_idx").on(
      table.playerId,
      table.season,
      table.week,
      table.seasonType,
    ),
    index("player_weekly_stats_source_week_idx").on(table.sourceId, table.season, table.week),
    index("player_weekly_stats_sync_run_idx").on(table.sourceSyncRunId),
    index("player_weekly_stats_unmatched_idx")
      .on(table.sourceId, table.season, table.week)
      .where(sql`${table.playerId} is null`),
    check(
      "player_weekly_stats_external_id_check",
      sql`${table.externalPlayerId} ~ '^00-[0-9]{7}$'`,
    ),
    check("player_weekly_stats_season_check", sql`${table.season} between 1999 and 2200`),
    check("player_weekly_stats_week_check", sql`${table.week} between 1 and 25`),
    check("player_weekly_stats_season_type_check", sql`${table.seasonType} in ('REG', 'POST')`),
    check(
      "player_weekly_stats_context_check",
      sql`char_length(btrim(${table.gameId})) between 1 and 64 and ${table.team} ~ '^[A-Z]{2,4}$' and ${table.opponentTeam} ~ '^[A-Z]{2,4}$'`,
    ),
    check(
      "player_weekly_stats_payload_check",
      sql`jsonb_typeof(${table.components}) = 'object' and ${table.components} <> '{}'::jsonb and jsonb_typeof(${table.advanced}) = 'object' and jsonb_typeof(${table.sourceFantasyPoints}) = 'object'`,
    ),
    check("player_weekly_stats_checksum_check", sql`${table.inputChecksum} ~ '^[a-f0-9]{64}$'`),
  ],
);

/** Immutable team-week facts used for opponent adjustment and team-defense projections. */
export const teamWeeklyStatObservations = pgTable(
  "team_weekly_stat_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => dataSources.id, { onDelete: "restrict" }),
    sourceSyncRunId: uuid("source_sync_run_id")
      .notNull()
      .references(() => syncRuns.id, { onDelete: "restrict" }),
    externalTeamId: text("external_team_id").notNull(),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    seasonType: text("season_type").$type<"REG" | "POST">().notNull(),
    gameId: text("game_id").notNull(),
    team: text("team").notNull(),
    opponentTeam: text("opponent_team").notNull(),
    components: jsonb("components").$type<Record<string, number>>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    inputChecksum: text("input_checksum").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("team_weekly_stats_source_game_team_unique").on(
      table.sourceId,
      table.gameId,
      table.externalTeamId,
      table.inputChecksum,
    ),
    index("team_weekly_stats_team_week_idx").on(
      table.team,
      table.season,
      table.week,
      table.seasonType,
    ),
    index("team_weekly_stats_opponent_week_idx").on(
      table.opponentTeam,
      table.season,
      table.week,
      table.seasonType,
    ),
    index("team_weekly_stats_source_week_idx").on(table.sourceId, table.season, table.week),
    index("team_weekly_stats_sync_run_idx").on(table.sourceSyncRunId),
    check(
      "team_weekly_stats_external_id_check",
      sql`char_length(btrim(${table.externalTeamId})) between 2 and 16`,
    ),
    check("team_weekly_stats_season_check", sql`${table.season} between 1999 and 2200`),
    check("team_weekly_stats_week_check", sql`${table.week} between 1 and 25`),
    check("team_weekly_stats_season_type_check", sql`${table.seasonType} in ('REG', 'POST')`),
    check(
      "team_weekly_stats_context_check",
      sql`char_length(btrim(${table.gameId})) between 1 and 64 and ${table.team} ~ '^[A-Z]{2,4}$' and ${table.opponentTeam} ~ '^[A-Z]{2,4}$' and ${table.team} <> ${table.opponentTeam}`,
    ),
    check(
      "team_weekly_stats_payload_check",
      sql`jsonb_typeof(${table.components}) = 'object' and ${table.components} <> '{}'::jsonb`,
    ),
    check("team_weekly_stats_checksum_check", sql`${table.inputChecksum} ~ '^[a-f0-9]{64}$'`),
  ],
);

/** Immutable week-level roster membership used to retain zero-snap/DNP forecast outcomes. */
export const playerWeeklyRosterObservations = pgTable(
  "player_weekly_roster_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => dataSources.id, { onDelete: "restrict" }),
    sourceSyncRunId: uuid("source_sync_run_id")
      .notNull()
      .references(() => syncRuns.id, { onDelete: "restrict" }),
    externalPlayerId: text("external_player_id").notNull(),
    playerId: uuid("player_id").references(() => players.id, { onDelete: "restrict" }),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    team: text("team").notNull(),
    position: text("position").notNull(),
    rosterStatus: text("roster_status"),
    statusDescription: text("status_description"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    inputChecksum: text("input_checksum").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("player_weekly_rosters_source_week_player_unique").on(
      table.sourceId,
      table.season,
      table.week,
      table.team,
      table.externalPlayerId,
      table.rosterStatus,
      table.statusDescription,
      table.inputChecksum,
    ),
    index("player_weekly_rosters_player_week_idx").on(table.playerId, table.season, table.week),
    index("player_weekly_rosters_source_week_idx").on(table.sourceId, table.season, table.week),
    index("player_weekly_rosters_sync_run_idx").on(table.sourceSyncRunId),
    index("player_weekly_rosters_unmatched_idx")
      .on(table.sourceId, table.season, table.week)
      .where(sql`${table.playerId} is null`),
    check(
      "player_weekly_rosters_external_id_check",
      sql`char_length(btrim(${table.externalPlayerId})) between 1 and 64`,
    ),
    check("player_weekly_rosters_season_check", sql`${table.season} between 2002 and 2200`),
    check("player_weekly_rosters_week_check", sql`${table.week} between 1 and 25`),
    check(
      "player_weekly_rosters_context_check",
      sql`${table.team} ~ '^[A-Z]{2,4}$' and char_length(btrim(${table.position})) between 1 and 16`,
    ),
    check(
      "player_weekly_rosters_status_check",
      sql`(${table.rosterStatus} is null or char_length(${table.rosterStatus}) between 1 and 64) and (${table.statusDescription} is null or char_length(${table.statusDescription}) between 1 and 64)`,
    ),
    check("player_weekly_rosters_checksum_check", sql`${table.inputChecksum} ~ '^[a-f0-9]{64}$'`),
  ],
);

/** Immutable official weekly injury/practice designations used for status-aware evaluation. */
export const playerInjuryReportObservations = pgTable(
  "player_injury_report_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => dataSources.id, { onDelete: "restrict" }),
    sourceSyncRunId: uuid("source_sync_run_id")
      .notNull()
      .references(() => syncRuns.id, { onDelete: "restrict" }),
    externalPlayerId: text("external_player_id").notNull(),
    playerId: uuid("player_id").references(() => players.id, { onDelete: "restrict" }),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    seasonType: text("season_type").$type<"REG" | "POST">().notNull(),
    gameType: text("game_type").$type<"REG" | "WC" | "DIV" | "CON" | "SB">().notNull(),
    team: text("team").notNull(),
    position: text("position").notNull(),
    reportPrimaryInjury: text("report_primary_injury"),
    reportSecondaryInjury: text("report_secondary_injury"),
    reportStatus: text("report_status"),
    practicePrimaryInjury: text("practice_primary_injury"),
    practiceSecondaryInjury: text("practice_secondary_injury"),
    practiceStatus: text("practice_status"),
    sourceModifiedAt: timestamp("source_modified_at", { withTimezone: true }),
    stateKey: text("state_key").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    inputChecksum: text("input_checksum").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("player_injury_reports_source_state_unique").on(
      table.sourceId,
      table.season,
      table.week,
      table.externalPlayerId,
      table.stateKey,
      table.inputChecksum,
    ),
    index("player_injury_reports_player_week_idx").on(table.playerId, table.season, table.week),
    index("player_injury_reports_source_week_idx").on(table.sourceId, table.season, table.week),
    index("player_injury_reports_sync_run_idx").on(table.sourceSyncRunId),
    index("player_injury_reports_unmatched_idx")
      .on(table.sourceId, table.season, table.week)
      .where(sql`${table.playerId} is null`),
    check(
      "player_injury_reports_external_id_check",
      sql`${table.externalPlayerId} ~ '^00-[0-9]{7}$'`,
    ),
    check("player_injury_reports_season_check", sql`${table.season} between 2009 and 2200`),
    check("player_injury_reports_week_check", sql`${table.week} between 1 and 25`),
    check("player_injury_reports_season_type_check", sql`${table.seasonType} in ('REG', 'POST')`),
    check(
      "player_injury_reports_game_type_check",
      sql`${table.gameType} in ('REG', 'WC', 'DIV', 'CON', 'SB')`,
    ),
    check(
      "player_injury_reports_context_check",
      sql`${table.team} ~ '^[A-Z]{2,4}$' and char_length(btrim(${table.position})) between 1 and 16`,
    ),
    check(
      "player_injury_reports_report_status_check",
      sql`${table.reportStatus} is null or ${table.reportStatus} in ('out', 'doubtful', 'questionable', 'probable', 'note')`,
    ),
    check(
      "player_injury_reports_practice_status_check",
      sql`${table.practiceStatus} is null or ${table.practiceStatus} in ('did-not-participate', 'limited', 'full', 'out', 'note')`,
    ),
    check(
      "player_injury_reports_payload_check",
      sql`${table.reportPrimaryInjury} is not null or ${table.reportStatus} is not null or ${table.practicePrimaryInjury} is not null or ${table.practiceStatus} is not null`,
    ),
    check("player_injury_reports_state_key_check", sql`${table.stateKey} ~ '^[a-f0-9]{64}$'`),
    check("player_injury_reports_checksum_check", sql`${table.inputChecksum} ~ '^[a-f0-9]{64}$'`),
  ],
);

/** Immutable PFR-keyed participation observations distributed by nflverse. */
export const playerSnapCountObservations = pgTable(
  "player_snap_count_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => dataSources.id, { onDelete: "restrict" }),
    sourceSyncRunId: uuid("source_sync_run_id")
      .notNull()
      .references(() => syncRuns.id, { onDelete: "restrict" }),
    externalPlayerId: text("external_player_id").notNull(),
    playerId: uuid("player_id").references(() => players.id, { onDelete: "restrict" }),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    seasonType: text("season_type").$type<"REG" | "POST">().notNull(),
    gameType: text("game_type").$type<"REG" | "WC" | "DIV" | "CON" | "SB">().notNull(),
    gameId: text("game_id").notNull(),
    pfrGameId: text("pfr_game_id").notNull(),
    team: text("team").notNull(),
    opponentTeam: text("opponent_team").notNull(),
    offenseSnaps: integer("offense_snaps").notNull(),
    offenseShare: numeric("offense_share", { precision: 6, scale: 5 }).notNull(),
    defenseSnaps: integer("defense_snaps").notNull(),
    defenseShare: numeric("defense_share", { precision: 6, scale: 5 }).notNull(),
    specialTeamsSnaps: integer("special_teams_snaps").notNull(),
    specialTeamsShare: numeric("special_teams_share", { precision: 6, scale: 5 }).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    inputChecksum: text("input_checksum").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("player_snap_counts_source_game_player_unique").on(
      table.sourceId,
      table.gameId,
      table.externalPlayerId,
      table.inputChecksum,
    ),
    index("player_snap_counts_player_week_idx").on(
      table.playerId,
      table.season,
      table.week,
      table.seasonType,
    ),
    index("player_snap_counts_source_week_idx").on(table.sourceId, table.season, table.week),
    index("player_snap_counts_sync_run_idx").on(table.sourceSyncRunId),
    index("player_snap_counts_unmatched_idx")
      .on(table.sourceId, table.season, table.week)
      .where(sql`${table.playerId} is null`),
    check(
      "player_snap_counts_external_id_check",
      sql`${table.externalPlayerId} ~ '^[A-Za-z0-9.-]{1,20}$'`,
    ),
    check("player_snap_counts_season_check", sql`${table.season} between 2012 and 2200`),
    check("player_snap_counts_week_check", sql`${table.week} between 1 and 25`),
    check("player_snap_counts_season_type_check", sql`${table.seasonType} in ('REG', 'POST')`),
    check(
      "player_snap_counts_game_type_check",
      sql`${table.gameType} in ('REG', 'WC', 'DIV', 'CON', 'SB')`,
    ),
    check(
      "player_snap_counts_context_check",
      sql`char_length(btrim(${table.gameId})) between 1 and 64 and char_length(btrim(${table.pfrGameId})) between 1 and 32 and ${table.team} ~ '^[A-Z]{2,4}$' and ${table.opponentTeam} ~ '^[A-Z]{2,4}$'`,
    ),
    check(
      "player_snap_counts_bounds_check",
      sql`${table.offenseSnaps} between 0 and 250 and ${table.defenseSnaps} between 0 and 250 and ${table.specialTeamsSnaps} between 0 and 250 and ${table.offenseShare} between 0 and 1 and ${table.defenseShare} between 0 and 1 and ${table.specialTeamsShare} between 0 and 1`,
    ),
    check("player_snap_counts_checksum_check", sql`${table.inputChecksum} ~ '^[a-f0-9]{64}$'`),
  ],
);

export const standingsSnapshots = pgTable(
  "standings_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueSeasonId: uuid("league_season_id")
      .notNull()
      .references(() => leagueSeasons.id, { onDelete: "cascade" }),
    asOfWeek: integer("as_of_week"),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    sourceSyncRunId: uuid("source_sync_run_id").references(() => syncRuns.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("standings_snapshots_league_effective_idx").on(table.leagueSeasonId, table.effectiveAt),
    uniqueIndex("standings_snapshots_source_sync_unique")
      .on(table.sourceSyncRunId)
      .where(sql`${table.sourceSyncRunId} is not null`),
    check(
      "standings_snapshots_week_check",
      sql`${table.asOfWeek} is null or ${table.asOfWeek} between 1 and 30`,
    ),
  ],
);

export const standingsEntries = pgTable(
  "standings_entries",
  {
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => standingsSnapshots.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => fantasyTeams.id, { onDelete: "cascade" }),
    providerTeamId: text("provider_team_id").notNull(),
    rank: integer("rank").notNull(),
    playoffSeed: integer("playoff_seed"),
    wins: integer("wins").notNull(),
    losses: integer("losses").notNull(),
    ties: integer("ties").notNull(),
    pointsFor: numeric("points_for", { precision: 14, scale: 4 }).notNull(),
    pointsAgainst: numeric("points_against", { precision: 14, scale: 4 }).notNull(),
    streakType: text("streak_type").$type<StandingStreakType>().notNull(),
    streakLength: integer("streak_length").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.snapshotId, table.teamId] }),
    uniqueIndex("standings_entries_provider_team_unique").on(
      table.snapshotId,
      table.providerTeamId,
    ),
    uniqueIndex("standings_entries_rank_unique").on(table.snapshotId, table.rank),
    check(
      "standings_entries_provider_team_check",
      sql`char_length(btrim(${table.providerTeamId})) > 0`,
    ),
    check("standings_entries_rank_check", sql`${table.rank} > 0`),
    check(
      "standings_entries_playoff_seed_check",
      sql`${table.playoffSeed} is null or ${table.playoffSeed} > 0`,
    ),
    check(
      "standings_entries_record_check",
      sql`${table.wins} >= 0 and ${table.losses} >= 0 and ${table.ties} >= 0`,
    ),
    check(
      "standings_entries_streak_type_check",
      sql`${table.streakType} in ('win', 'loss', 'tie', 'none')`,
    ),
    check("standings_entries_streak_length_check", sql`${table.streakLength} >= 0`),
  ],
);

export const matchupSnapshots = pgTable(
  "matchup_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueSeasonId: uuid("league_season_id")
      .notNull()
      .references(() => leagueSeasons.id, { onDelete: "cascade" }),
    asOfWeek: integer("as_of_week"),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    sourceSyncRunId: uuid("source_sync_run_id").references(() => syncRuns.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("matchup_snapshots_league_effective_idx").on(table.leagueSeasonId, table.effectiveAt),
    uniqueIndex("matchup_snapshots_source_sync_unique")
      .on(table.sourceSyncRunId)
      .where(sql`${table.sourceSyncRunId} is not null`),
    check(
      "matchup_snapshots_week_check",
      sql`${table.asOfWeek} is null or ${table.asOfWeek} between 1 and 30`,
    ),
  ],
);

export const weeklyMatchups = pgTable(
  "weekly_matchups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => matchupSnapshots.id, { onDelete: "cascade" }),
    externalKey: text("external_key").notNull(),
    providerMatchupId: text("provider_matchup_id").notNull(),
    week: integer("week").notNull(),
    status: text("status").$type<WeeklyMatchupStatus>().notNull(),
    homeTeamId: uuid("home_team_id")
      .notNull()
      .references(() => fantasyTeams.id, { onDelete: "cascade" }),
    awayTeamId: uuid("away_team_id")
      .notNull()
      .references(() => fantasyTeams.id, { onDelete: "cascade" }),
    homeProviderTeamId: text("home_provider_team_id").notNull(),
    awayProviderTeamId: text("away_provider_team_id").notNull(),
    homeScore: numeric("home_score", { precision: 14, scale: 4 }),
    awayScore: numeric("away_score", { precision: 14, scale: 4 }),
    winnerTeamId: uuid("winner_team_id").references(() => fantasyTeams.id, {
      onDelete: "cascade",
    }),
    tied: boolean("tied").notNull().default(false),
  },
  (table) => [
    uniqueIndex("weekly_matchups_snapshot_external_unique").on(table.snapshotId, table.externalKey),
    uniqueIndex("weekly_matchups_snapshot_provider_unique").on(
      table.snapshotId,
      table.providerMatchupId,
    ),
    index("weekly_matchups_snapshot_week_idx").on(table.snapshotId, table.week),
    check("weekly_matchups_week_check", sql`${table.week} between 1 and 30`),
    check(
      "weekly_matchups_status_check",
      sql`${table.status} in ('scheduled', 'in-progress', 'final')`,
    ),
    check(
      "weekly_matchups_external_key_check",
      sql`char_length(btrim(${table.externalKey})) > 0 and char_length(btrim(${table.providerMatchupId})) > 0`,
    ),
    check(
      "weekly_matchups_provider_team_check",
      sql`char_length(btrim(${table.homeProviderTeamId})) > 0 and char_length(btrim(${table.awayProviderTeamId})) > 0`,
    ),
    check("weekly_matchups_distinct_teams_check", sql`${table.homeTeamId} <> ${table.awayTeamId}`),
    check(
      "weekly_matchups_winner_team_check",
      sql`${table.winnerTeamId} is null or ${table.winnerTeamId} in (${table.homeTeamId}, ${table.awayTeamId})`,
    ),
    check(
      "weekly_matchups_scores_check",
      sql`(${table.status} = 'scheduled' and ${table.homeScore} is null and ${table.awayScore} is null) or (${table.status} <> 'scheduled' and ${table.homeScore} is not null and ${table.awayScore} is not null)`,
    ),
    check(
      "weekly_matchups_outcome_check",
      sql`(${table.status} = 'final' and ((${table.tied} = true and ${table.winnerTeamId} is null) or (${table.tied} = false and ${table.winnerTeamId} is not null))) or (${table.status} <> 'final' and ${table.tied} = false and ${table.winnerTeamId} is null)`,
    ),
  ],
);

/**
 * Immutable, normalized league-provider artifacts that enrich the canonical roster snapshot.
 * Each artifact is admitted independently so a drifting transaction or draft endpoint cannot
 * roll back a successful core league refresh.
 */
export const leagueSupplementalSnapshots = pgTable(
  "league_supplemental_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueSeasonId: uuid("league_season_id")
      .notNull()
      .references(() => leagueSeasons.id, { onDelete: "cascade" }),
    kind: text("kind").$type<LeagueSupplementalKind>().notNull(),
    asOfWeek: integer("as_of_week"),
    availability: text("availability").$type<"free-agent" | "waivers">(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    sourceSyncRunId: uuid("source_sync_run_id")
      .notNull()
      .references(() => syncRuns.id, { onDelete: "restrict" }),
    bridgeDeviceId: uuid("bridge_device_id").references(() => bridgeDevices.id, {
      onDelete: "set null",
    }),
    endpoint: text("endpoint").notNull(),
    artifactChecksum: text("artifact_checksum").notNull(),
    artifact: jsonb("artifact").$type<Record<string, unknown>>().notNull(),
    warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("league_supplemental_source_sync_unique").on(table.sourceSyncRunId),
    uniqueIndex("league_supplemental_artifact_unique").on(
      table.leagueSeasonId,
      table.kind,
      table.artifactChecksum,
    ),
    index("league_supplemental_latest_idx").on(
      table.leagueSeasonId,
      table.kind,
      table.asOfWeek,
      table.effectiveAt,
    ),
    check(
      "league_supplemental_kind_check",
      sql`${table.kind} in ('available-players', 'weekly-box-scores', 'transactions', 'completed-draft')`,
    ),
    check(
      "league_supplemental_week_check",
      sql`${table.asOfWeek} is null or ${table.asOfWeek} between 0 and 30`,
    ),
    check(
      "league_supplemental_availability_check",
      sql`(${table.kind} = 'available-players' and ${table.availability} in ('free-agent', 'waivers')) or (${table.kind} <> 'available-players' and ${table.availability} is null)`,
    ),
    check(
      "league_supplemental_endpoint_check",
      sql`char_length(btrim(${table.endpoint})) between 1 and 2048`,
    ),
    check("league_supplemental_checksum_check", sql`${table.artifactChecksum} ~ '^[a-f0-9]{64}$'`),
    check(
      "league_supplemental_artifact_shape_check",
      sql`jsonb_typeof(${table.artifact}) = 'object' and jsonb_typeof(${table.warnings}) = 'array'`,
    ),
  ],
);

export const refreshRequests = pgTable(
  "refresh_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => providerConnections.id, {
      onDelete: "set null",
    }),
    leagueSeasonId: uuid("league_season_id").references(() => leagueSeasons.id, {
      onDelete: "set null",
    }),
    rankingListId: uuid("ranking_list_id").references(() => rankingLists.id, {
      onDelete: "set null",
    }),
    dataSourceId: uuid("data_source_id").references(() => dataSources.id, {
      onDelete: "set null",
    }),
    resultSyncRunId: uuid("result_sync_run_id").references(() => syncRuns.id, {
      onDelete: "set null",
    }),
    kind: text("kind").$type<RefreshRequestKind>().notNull(),
    state: text("state").$type<RefreshRequestState>().notNull().default("queued"),
    idempotencyKey: text("idempotency_key").notNull(),
    force: boolean("force").notNull().default(false),
    priority: integer("priority").notNull().default(0),
    notBefore: timestamp("not_before", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorDetail: text("error_detail"),
    resultSummary: jsonb("result_summary")
      .$type<Record<string, JsonPrimitive>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("refresh_requests_user_idempotency_unique").on(
      table.requestedByUserId,
      table.idempotencyKey,
    ),
    index("refresh_requests_queue_idx")
      .on(table.state, table.priority, table.notBefore)
      .where(sql`${table.state} = 'queued'`),
    index("refresh_requests_user_created_idx").on(table.requestedByUserId, table.createdAt),
    index("refresh_requests_league_season_idx").on(table.leagueSeasonId),
    index("refresh_requests_ranking_list_idx").on(table.rankingListId),
    index("refresh_requests_data_source_idx").on(table.dataSourceId),
    check(
      "refresh_requests_kind_check",
      sql`${table.kind} in ('player_catalog', 'rankings', 'projections', 'injuries', 'league', 'all')`,
    ),
    check(
      "refresh_requests_state_check",
      sql`${table.state} in ('queued', 'processing', 'succeeded', 'failed', 'cancelled')`,
    ),
    check("refresh_requests_priority_check", sql`${table.priority} between -100 and 100`),
    check(
      "refresh_requests_scope_check",
      sql`(${table.kind} <> 'league' or ${table.leagueSeasonId} is not null) and (${table.kind} <> 'rankings' or ${table.rankingListId} is not null)`,
    ),
    check(
      "refresh_requests_finished_at_check",
      sql`${table.finishedAt} is null or ${table.startedAt} is not null`,
    ),
  ],
);

export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueSeasonId: uuid("league_season_id")
      .notNull()
      .references(() => leagueSeasons.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    state: text("state").notNull().default("created"),
    budgetPerTeam: integer("budget_per_team"),
    minimumBid: integer("minimum_bid"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("drafts_league_idx").on(table.leagueSeasonId),
    check("drafts_type_check", sql`${table.type} in ('snake', 'auction')`),
    check("drafts_budget_check", sql`${table.budgetPerTeam} is null or ${table.budgetPerTeam} > 0`),
    check("drafts_minimum_bid_check", sql`${table.minimumBid} is null or ${table.minimumBid} > 0`),
  ],
);

export const draftEvents = pgTable(
  "draft_events",
  {
    draftId: uuid("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    type: text("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    source: text("source").$type<DraftEventSource>().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    revertsSequence: integer("reverts_sequence"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.draftId, table.sequence] }),
    uniqueIndex("draft_events_idempotency_unique").on(table.draftId, table.idempotencyKey),
    // Provenance is now load-bearing: a provider fact and a manual fact must stay distinguishable.
    check("draft_events_source_check", sql`${table.source} in ('manual', 'espn')`),
  ],
);

/**
 * One live provider feed per provider league season.
 *
 * Holds only sanitized, bounded draft facts and lease bookkeeping. No provider credential, cookie,
 * draft token, WebSocket URL, or raw page markup has a column here, and none may be added.
 */
export const draftProviderFeeds = pgTable(
  "draft_provider_feeds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    leagueSeasonId: uuid("league_season_id")
      .notNull()
      .references(() => leagueSeasons.id, { onDelete: "cascade" }),
    provider: text("provider").$type<"espn">().notNull().default("espn"),
    providerLeagueId: text("provider_league_id").notNull(),
    season: integer("season").notNull(),
    state: text("state").$type<DraftProviderFeedState>().notNull().default("waiting"),
    activeDeviceId: uuid("active_device_id").references(() => bridgeDevices.id, {
      onDelete: "set null",
    }),
    leaseGeneration: integer("lease_generation").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    activePageSessionId: uuid("active_page_session_id"),
    lastPageRevision: integer("last_page_revision"),
    lastChecksum: text("last_checksum"),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    lastReceivedAt: timestamp("last_received_at", { withTimezone: true }),
    lastMaterialEventAt: timestamp("last_material_event_at", { withTimezone: true }),
    lastPickCount: integer("last_pick_count").notNull().default(0),
    currentAuctionState: jsonb("current_auction_state").$type<Record<string, unknown>>(),
    /** A destructive snapshot must repeat before it is allowed to rewrite accepted history. */
    pendingDestructiveChecksum: text("pending_destructive_checksum"),
    pendingDestructiveSeenCount: integer("pending_destructive_seen_count").notNull().default(0),
    manualBackupActive: boolean("manual_backup_active").notNull().default(false),
    verification: text("verification")
      .$type<DraftProviderFeedVerification>()
      .notNull()
      .default("pending"),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("draft_provider_feeds_draft_unique").on(table.draftId),
    uniqueIndex("draft_provider_feeds_league_season_unique").on(
      table.provider,
      table.providerLeagueId,
      table.season,
    ),
    index("draft_provider_feeds_state_idx").on(table.state, table.lastReceivedAt),
    check("draft_provider_feeds_provider_check", sql`${table.provider} = 'espn'`),
    check(
      "draft_provider_feeds_state_check",
      sql`${table.state} in ('waiting', 'live', 'paused', 'stale', 'complete', 'degraded')`,
    ),
    check(
      "draft_provider_feeds_verification_check",
      sql`${table.verification} in ('pending', 'verified', 'mismatched')`,
    ),
    check("draft_provider_feeds_external_id_check", sql`${table.providerLeagueId} ~ '^[0-9]+$'`),
    check(
      "draft_provider_feeds_season_check",
      sql`${table.season} >= 2019 and ${table.season} <= 2100`,
    ),
    check(
      "draft_provider_feeds_counts_check",
      sql`${table.leaseGeneration} >= 0 and ${table.lastPickCount} >= 0 and ${table.pendingDestructiveSeenCount} >= 0 and (${table.lastPageRevision} is null or ${table.lastPageRevision} >= 0)`,
    ),
    check(
      "draft_provider_feeds_checksum_check",
      sql`(${table.lastChecksum} is null or ${table.lastChecksum} ~ '^[a-f0-9]{64}$') and (${table.pendingDestructiveChecksum} is null or ${table.pendingDestructiveChecksum} ~ '^[a-f0-9]{64}$')`,
    ),
  ],
);

/**
 * Immutable audit trail of every provider observation, accepted or not. Retained so a disputed
 * board can be reconstructed and so ESPN contract drift is measurable after the fact.
 */
export const draftProviderObservations = pgTable(
  "draft_provider_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    feedId: uuid("feed_id")
      .notNull()
      .references(() => draftProviderFeeds.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id").references(() => bridgeDevices.id, { onDelete: "set null" }),
    pageSessionId: uuid("page_session_id").notNull(),
    pageRevision: integer("page_revision").notNull(),
    checksum: text("checksum").notNull(),
    providerState: text("provider_state").notNull(),
    pickCount: integer("pick_count").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    /** Sanitized observation only. Never raw ESPN markup. */
    normalizedPayload: jsonb("normalized_payload").$type<Record<string, unknown>>().notNull(),
    result: text("result").$type<DraftProviderObservationResult>().notNull(),
    issueSummary: jsonb("issue_summary").$type<Record<string, unknown>>(),
  },
  (table) => [
    index("draft_provider_observations_feed_idx").on(table.feedId, table.receivedAt),
    uniqueIndex("draft_provider_observations_revision_unique").on(
      table.feedId,
      table.pageSessionId,
      table.pageRevision,
    ),
    check(
      "draft_provider_observations_result_check",
      sql`${table.result} in ('accepted', 'idempotent', 'standby', 'held', 'rejected')`,
    ),
    check(
      "draft_provider_observations_state_check",
      sql`${table.providerState} in ('waiting', 'live', 'paused', 'complete')`,
    ),
    check("draft_provider_observations_checksum_check", sql`${table.checksum} ~ '^[a-f0-9]{64}$'`),
    check(
      "draft_provider_observations_counts_check",
      sql`${table.pageRevision} >= 0 and ${table.pickCount} >= 0`,
    ),
  ],
);

export const recommendationRuns = pgTable(
  "recommendation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueSeasonId: uuid("league_season_id")
      .notNull()
      .references(() => leagueSeasons.id, { onDelete: "cascade" }),
    // Lineup, waiver, and trade decisions are per claimed team. Nullable so a future league-wide
    // kind can share the ledger; the unique index below uses NULLS NOT DISTINCT so such a run still
    // deduplicates instead of inserting without limit.
    fantasyTeamId: uuid("fantasy_team_id").references(() => fantasyTeams.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    inputHash: text("input_hash").notNull(),
    randomSeed: text("random_seed"),
    inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("recommendation_runs_league_kind_idx").on(table.leagueSeasonId, table.kind),
    // ADR 0003 replay identity. The recompute checks for an existing run first; this is the second
    // line of defense, so a concurrent duplicate cannot write a second row for identical inputs.
    //
    // Migration 0026 additionally declares this index `NULLS NOT DISTINCT`, so a future league-wide
    // run with a null `fantasy_team_id` deduplicates rather than inserting without limit. Drizzle
    // 0.45's index builder cannot express that clause — only its unique *constraint* builder can —
    // so the migration is authoritative and `packages/db/scripts/schema-smoke.ts` asserts the live
    // behavior, including the null-team replay, against a real database.
    uniqueIndex("recommendation_runs_identity_unique").on(
      table.leagueSeasonId,
      table.fantasyTeamId,
      table.kind,
      table.algorithmVersion,
      table.inputHash,
    ),
    check(
      "recommendation_runs_kind_check",
      sql`${table.kind} in ('draft', 'lineup', 'waiver', 'trade')`,
    ),
  ],
);

export const recommendations = pgTable(
  "recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => recommendationRuns.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull(),
    action: jsonb("action").$type<Record<string, unknown>>().notNull(),
    expectedValueDelta: numeric("expected_value_delta", { precision: 10, scale: 4 }),
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    explanation: text("explanation").notNull(),
    warnings: text("warnings").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("recommendations_run_rank_unique").on(table.runId, table.rank)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    correlationId: text("correlation_id").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_events_user_time_idx").on(table.userId, table.occurredAt)],
);

export const changeEvents = pgTable(
  "change_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    deduplicationKey: text("deduplication_key"),
    eventType: text("event_type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    leagueId: uuid("league_id").references(() => leagues.id, { onDelete: "set null" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    visibility: text("visibility").notNull().default("private"),
    severity: text("severity").notNull().default("info"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("change_events_source_deduplication_unique")
      .on(table.source, table.deduplicationKey)
      .where(sql`${table.deduplicationKey} is not null`),
    index("change_events_league_occurred_idx").on(table.leagueId, table.occurredAt),
    index("change_events_aggregate_occurred_idx").on(
      table.aggregateType,
      table.aggregateId,
      table.occurredAt,
    ),
    check(
      "change_events_visibility_check",
      sql`${table.visibility} in ('private', 'league', 'global')`,
    ),
    check(
      "change_events_severity_check",
      sql`${table.severity} in ('info', 'action', 'warning', 'critical')`,
    ),
  ],
);

export const changeEventReceipts = pgTable(
  "change_event_receipts",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => changeEvents.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    deliveryChannels: text("delivery_channels").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.userId] }),
    index("change_event_receipts_user_unread_idx")
      .on(table.userId, table.createdAt)
      .where(sql`${table.readAt} is null and ${table.dismissedAt} is null`),
    check(
      "change_event_receipts_read_check",
      sql`${table.readAt} is null or ${table.firstSeenAt} is not null`,
    ),
    check(
      "change_event_receipts_dismissed_check",
      sql`${table.dismissedAt} is null or ${table.firstSeenAt} is not null`,
    ),
  ],
);

export const aiProviderCredentials = pgTable(
  "ai_provider_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<AiProviderName>().notNull(),
    label: text("label").notNull(),
    model: text("model"),
    dailyRequestLimit: integer("daily_request_limit").notNull().default(25),
    maxOutputTokens: integer("max_output_tokens").notNull().default(2000),
    // This is a keyed fingerprint used only for deduplication; no key suffix is retained.
    credentialFingerprintHash: text("credential_fingerprint_hash").notNull(),
    providerAccountIdHash: text("provider_account_id_hash"),
    credentialEnvelope: jsonb("credential_envelope").$type<CredentialEnvelopeMetadata>().notNull(),
    envelopeVersion: integer("envelope_version").notNull(),
    encryptionKeyId: text("encryption_key_id").notNull(),
    credentialPurpose: text("credential_purpose").notNull(),
    scopes: text("scopes").array().notNull().default([]),
    status: text("status").$type<AiCredentialStatus>().notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ai_provider_credentials_fingerprint_unique").on(
      table.userId,
      table.provider,
      table.credentialFingerprintHash,
    ),
    uniqueIndex("ai_provider_credentials_user_provider_unique").on(table.userId, table.provider),
    index("ai_provider_credentials_user_status_idx").on(table.userId, table.status),
    check(
      "ai_provider_credentials_provider_check",
      sql`${table.provider} in ('openai', 'anthropic', 'gemini', 'openrouter')`,
    ),
    check(
      "ai_provider_credentials_status_check",
      sql`${table.status} in ('active', 'invalid', 'revoked')`,
    ),
    check(
      "ai_provider_credentials_fingerprint_check",
      sql`char_length(${table.credentialFingerprintHash}) >= 32`,
    ),
    check("ai_provider_credentials_envelope_version_check", sql`${table.envelopeVersion} > 0`),
    check(
      "ai_provider_credentials_model_check",
      sql`${table.model} is null or char_length(${table.model}) between 1 and 160`,
    ),
    check(
      "ai_provider_credentials_daily_limit_check",
      sql`${table.dailyRequestLimit} between 1 and 500`,
    ),
    check(
      "ai_provider_credentials_output_limit_check",
      sql`${table.maxOutputTokens} between 64 and 8192`,
    ),
    check(
      "ai_provider_credentials_envelope_shape_check",
      sql`jsonb_typeof(${table.credentialEnvelope}) = 'object' and ${table.credentialEnvelope} ?& array['version', 'algorithm', 'keyId', 'purpose', 'createdAt', 'iv', 'ciphertext', 'authTag'] and jsonb_typeof(${table.credentialEnvelope}->'ciphertext') = 'string' and jsonb_typeof(${table.credentialEnvelope}->'authTag') = 'string'`,
    ),
    check(
      "ai_provider_credentials_envelope_metadata_check",
      sql`${table.credentialEnvelope}->>'version' = ${table.envelopeVersion}::text and ${table.credentialEnvelope}->>'keyId' = ${table.encryptionKeyId} and ${table.credentialEnvelope}->>'purpose' = ${table.credentialPurpose}`,
    ),
    check(
      "ai_provider_credentials_revoked_at_check",
      sql`(${table.status} = 'revoked') = (${table.revokedAt} is not null)`,
    ),
  ],
);

export const aiUsageLedger = pgTable(
  "ai_usage_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    credentialId: uuid("credential_id").references(() => aiProviderCredentials.id, {
      onDelete: "set null",
    }),
    provider: text("provider").$type<AiProviderName>().notNull(),
    model: text("model").notNull(),
    operation: text("operation").notNull(),
    // Provider request IDs are keyed before persistence; prompts and responses are never stored here.
    requestIdHash: text("request_id_hash"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    cost: numeric("cost", { precision: 16, scale: 6 }).notNull().default("0"),
    currency: text("currency").notNull().default("USD"),
    latencyMs: integer("latency_ms"),
    succeeded: boolean("succeeded").notNull().default(true),
    errorCode: text("error_code"),
    metadata: jsonb("metadata").$type<Record<string, JsonPrimitive>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ai_usage_ledger_provider_request_unique")
      .on(table.provider, table.requestIdHash)
      .where(sql`${table.requestIdHash} is not null`),
    index("ai_usage_ledger_user_occurred_idx").on(table.userId, table.occurredAt),
    index("ai_usage_ledger_provider_model_occurred_idx").on(
      table.provider,
      table.model,
      table.occurredAt,
    ),
    check(
      "ai_usage_ledger_provider_check",
      sql`${table.provider} in ('openai', 'anthropic', 'gemini', 'openrouter')`,
    ),
    check(
      "ai_usage_ledger_token_counts_check",
      sql`${table.inputTokens} >= 0 and ${table.outputTokens} >= 0 and ${table.cacheReadTokens} >= 0 and ${table.cacheWriteTokens} >= 0`,
    ),
    check("ai_usage_ledger_cost_check", sql`${table.cost} >= 0`),
    check(
      "ai_usage_ledger_latency_check",
      sql`${table.latencyMs} is null or ${table.latencyMs} >= 0`,
    ),
    check("ai_usage_ledger_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check(
      "ai_usage_ledger_request_hash_check",
      sql`${table.requestIdHash} is null or char_length(${table.requestIdHash}) >= 32`,
    ),
  ],
);
