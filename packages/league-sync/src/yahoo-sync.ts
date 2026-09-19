import {
  MAX_YAHOO_RETRY_AFTER_MS,
  parseYahooLeaguePageXml,
  parseYahooLeagueSyncArtifacts,
  YahooFantasyReadClient,
  YahooReadClientError,
  YahooXmlError,
  type YahooXmlArtifact,
} from "@laces-out/connector-yahoo";
import type { ExternalLeagueRef, LeagueSyncBundle } from "@laces-out/connectors";
import {
  auditEvents,
  fantasyTeams,
  leagueMemberships,
  leagues,
  leagueSeasons,
  leagueSyncExclusions,
  matchupSnapshots,
  playerExternalIds,
  players,
  providerConnections,
  providerLeagueLinks,
  rosterEntries,
  rosterSlotRules,
  rosterSnapshots,
  scoringRules,
  standingsEntries,
  standingsSnapshots,
  syncRuns,
  weeklyMatchups,
  type ConnectionHealth,
  type Database,
} from "@laces-out/db";
import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import { YahooConnectionError } from "./yahoo-connection.js";

const DEFAULT_PAGE_SIZE = 25;
const MAX_DISCOVERY_PAGES = 40;
const MAX_DISCOVERED_LEAGUES = 500;
const DEFAULT_THROTTLE_RETRY_AFTER_MS = 60 * 1_000;
const LEAGUE_DATA_HEALTH_KIND = "yahoo-league-data-health";
const INCOMPLETE_ROSTER_MESSAGE =
  "Yahoo returned incomplete roster data. This league's stored rosters were left unchanged.";

/** Yahoo rounds these yardage categories to whole scoring units when fractional points are off. */
const YAHOO_FRACTIONAL_YARDAGE_STAT_IDS = new Set(["4", "9", "12", "14", "84"]);
const YAHOO_SIGNED_YARDAGE_STAT_IDS = new Set(["4", "9", "12", "14"]);

export function yahooScoringOperation(
  statId: string,
  usesFractionalPoints: boolean | null | undefined,
  usesNegativePoints?: boolean | null,
): "multiply" | "floor-groups" | "multiply-nonnegative" | "floor-groups-nonnegative" {
  const wholeGroups =
    usesFractionalPoints === false && YAHOO_FRACTIONAL_YARDAGE_STAT_IDS.has(statId);
  const nonnegative = usesNegativePoints === false && YAHOO_SIGNED_YARDAGE_STAT_IDS.has(statId);
  if (nonnegative) return wholeGroups ? "floor-groups-nonnegative" : "multiply-nonnegative";
  return wholeGroups ? "floor-groups" : "multiply";
}

/** Canonical provider position families persisted with each Yahoo scoring rule. */
export function yahooScoringPositionTypes(
  positionTypes: readonly string[] | undefined,
): string[] | null {
  const normalized = [
    ...new Set(
      positionTypes?.map((position) => position.trim().toUpperCase()).filter(Boolean) ?? [],
    ),
  ].sort();
  return normalized.length > 0 ? normalized : null;
}

export interface YahooConnectionLeagueStatus {
  readonly leagueId: string;
  readonly leagueSeasonId: string;
  readonly name: string;
  readonly externalKey: string;
  readonly season: number;
  readonly currentWeek: number | null;
  readonly lastSyncedAt: string | null;
  readonly currentUserTeamExternalKey: string | null;
}

export interface YahooConnectionStatus {
  readonly connectionId: string;
  readonly displayName: string;
  readonly health: ConnectionHealth;
  readonly credentialExpiresAt: string | null;
  readonly lastSuccessfulAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorAt: string | null;
  readonly leagues: readonly YahooConnectionLeagueStatus[];
  readonly leagueFailures: readonly YahooLeagueSyncFailure[];
}

export interface YahooLeagueSyncFailure {
  readonly externalLeagueKey: string;
  readonly season: number | null;
  readonly code: "INCOMPLETE_ROSTER";
  readonly message: string;
  readonly failedAt: string;
}

export interface YahooSyncReceipt {
  readonly syncRunId: string;
  readonly leagueId: string;
  readonly leagueSeasonId: string;
  readonly externalLeagueKey: string;
  readonly season: number;
  readonly state: "accepted" | "unchanged";
  readonly recordsWritten: number;
  readonly syncedAt: string;
}

export interface YahooDiscoveryResult {
  readonly connectionId: string;
  readonly discovered: readonly ExternalLeagueRef[];
  readonly syncs: readonly YahooSyncReceipt[];
  readonly failures: readonly YahooLeagueSyncFailure[];
  readonly generatedAt: string;
}

export class YahooSyncError extends Error {
  readonly code:
    | "CONNECTION_NOT_FOUND"
    | "DISCOVERY_LIMIT"
    | "DUPLICATE_LEAGUE"
    | "LOCAL_DISCONNECT_FAILED"
    | "LEAGUE_REMOVED"
    | "PROVIDER_READ_FAILED"
    | "PERSISTENCE_FAILED";
  readonly statusCode: number;
  /** Closed, sanitized retry metadata used for scheduling, telemetry, and Retry-After headers. */
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly throttled: boolean;
  readonly cooldown: boolean;
  /** Present only after this league's data failure has been durably recorded. */
  readonly leagueFailure: YahooLeagueSyncFailure | null;

  constructor(
    code: YahooSyncError["code"],
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly retryAfterMs?: number | null;
      readonly throttled?: boolean;
      readonly cooldown?: boolean;
      readonly leagueFailure?: YahooLeagueSyncFailure;
    } = {},
  ) {
    super(message);
    this.name = "YahooSyncError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.throttled = options.throttled ?? false;
    this.cooldown = options.cooldown ?? false;
    this.leagueFailure = options.leagueFailure ?? null;
    this.statusCode =
      code === "CONNECTION_NOT_FOUND"
        ? 404
        : code === "LEAGUE_REMOVED"
          ? 409
          : code === "DISCOVERY_LIMIT"
            ? 422
            : code === "LOCAL_DISCONNECT_FAILED"
              ? 500
              : code === "PROVIDER_READ_FAILED" && this.throttled
                ? 429
                : code === "PROVIDER_READ_FAILED" && this.cooldown
                  ? 503
                  : 502;
  }
}

interface OwnedConnection {
  readonly id: string;
  readonly health: ConnectionHealth;
  readonly circuitOpenUntil: Date | null;
  readonly lastErrorCode: string | null;
}

export interface YahooSyncRepository {
  findOwnedConnection(userId: string, connectionId: string): Promise<OwnedConnection | undefined>;
  listConnectionStatus(userId: string): Promise<readonly YahooConnectionStatus[]>;
  disconnectOwnedConnection(input: {
    readonly userId: string;
    readonly connectionId: string;
    readonly correlationId: string;
    readonly disconnectedAt: Date;
  }): Promise<boolean>;
  listLeagueExclusions(userId: string): Promise<
    readonly {
      readonly externalKey: string;
      readonly season: number;
    }[]
  >;
  clearLeagueExclusions(userId: string): Promise<void>;
  persistBundle(
    userId: string,
    connectionId: string,
    bundle: LeagueSyncBundle,
  ): Promise<YahooSyncReceipt>;
  markFailure(
    userId: string,
    connectionId: string,
    errorCode: string,
    at: Date,
    options?: { readonly cooldownUntil: Date },
  ): Promise<void>;
  markDiscoverySuccess(userId: string, connectionId: string, at: Date): Promise<void>;
  markLeagueFailure(
    userId: string,
    connectionId: string,
    failure: YahooLeagueSyncFailure,
  ): Promise<void>;
}

export interface YahooAccessTokenPort {
  getAccessToken(
    userId: string,
    connectionId: string,
    options?: { readonly forceRefresh?: boolean; readonly minimumValiditySeconds?: number },
  ): Promise<string>;
}

export interface YahooReadPort {
  getUserLeagues(
    request: { readonly accessToken: string },
    options: {
      readonly gameKeys: readonly string[];
      readonly start: number;
      readonly count: number;
    },
  ): Promise<YahooXmlArtifact>;
  getLeagueSettings(
    request: { readonly accessToken: string },
    leagueKey: string,
  ): Promise<YahooXmlArtifact>;
  getLeagueTeams(
    request: { readonly accessToken: string },
    leagueKey: string,
  ): Promise<YahooXmlArtifact>;
  getLeagueRosters(
    request: { readonly accessToken: string },
    leagueKey: string,
  ): Promise<YahooXmlArtifact>;
  getLeagueStandings(
    request: { readonly accessToken: string },
    leagueKey: string,
  ): Promise<YahooXmlArtifact>;
  getLeagueMatchups(
    request: { readonly accessToken: string },
    leagueKey: string,
  ): Promise<YahooXmlArtifact>;
}

function slotEligibility(slotCode: string): string[] {
  const normalized = slotCode.toUpperCase();
  if (["FLEX", "W/R/T", "RB/WR/TE"].includes(normalized)) return ["RB", "WR", "TE"];
  if (["OP", "SUPER_FLEX", "Q/W/R/T", "QB/RB/WR/TE"].includes(normalized)) {
    return ["QB", "RB", "WR", "TE"];
  }
  if (["W/R", "RB/WR"].includes(normalized)) return ["RB", "WR"];
  if (["W/T", "WR/TE"].includes(normalized)) return ["WR", "TE"];
  return [slotCode];
}

function plainRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function leagueDataHealthKey(connectionId: string, leagueKey: string): string {
  return `${LEAGUE_DATA_HEALTH_KIND}:${connectionId}:${leagueKey}`;
}

function storedLeagueFailure(detail: string | null, at: Date | null): YahooLeagueSyncFailure {
  const identity: unknown = detail ? JSON.parse(detail) : null;
  if (
    typeof identity !== "object" ||
    identity === null ||
    !("externalLeagueKey" in identity) ||
    typeof identity.externalLeagueKey !== "string" ||
    !/^(?:[a-z][a-z0-9-]{0,15}|[0-9]{1,10})\.l\.[0-9]{1,20}$/u.test(identity.externalLeagueKey) ||
    !("season" in identity) ||
    (identity.season !== null &&
      (typeof identity.season !== "number" || !Number.isSafeInteger(identity.season))) ||
    at === null
  ) {
    throw new Error("Yahoo league data health record has invalid identity metadata");
  }
  return {
    externalLeagueKey: identity.externalLeagueKey,
    season: identity.season,
    code: "INCOMPLETE_ROSTER",
    message: INCOMPLETE_ROSTER_MESSAGE,
    failedAt: at.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "23505"
  );
}

function failureCode(error: unknown): string {
  if (error instanceof YahooReadClientError) return `read_${error.code.toLowerCase()}`;
  if (error instanceof YahooConnectionError) return error.code.toLowerCase();
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { readonly code: unknown }).code).toLowerCase();
    if (/^[a-z0-9_-]{1,80}$/u.test(code)) return code;
  }
  return "yahoo_sync_failed";
}

function boundedRetryAfterMs(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null;
  return Math.ceil(Math.min(value, MAX_YAHOO_RETRY_AFTER_MS) / 1_000) * 1_000;
}

function clientFacingSyncError(error: unknown): YahooSyncError {
  if (error instanceof YahooSyncError) return error;
  if (error instanceof YahooXmlError && error.code === "INCOMPLETE_ROSTER") {
    return new YahooSyncError("PROVIDER_READ_FAILED", INCOMPLETE_ROSTER_MESSAGE, {
      retryable: true,
    });
  }
  if (error instanceof YahooReadClientError) {
    const throttled = error.code === "RATE_LIMITED";
    const parsedRetryAfterMs = boundedRetryAfterMs(error.retryAfterMs);
    return new YahooSyncError(
      "PROVIDER_READ_FAILED",
      "Yahoo did not return a valid, complete league response",
      {
        retryable: error.retryable,
        retryAfterMs:
          throttled && (!parsedRetryAfterMs || parsedRetryAfterMs <= 0)
            ? DEFAULT_THROTTLE_RETRY_AFTER_MS
            : parsedRetryAfterMs,
        throttled,
        cooldown: throttled,
      },
    );
  }
  return new YahooSyncError(
    "PROVIDER_READ_FAILED",
    "Yahoo did not return a valid, complete league response",
  );
}

function connectionCooldownError(
  connection: OwnedConnection,
  at: Date,
): YahooSyncError | undefined {
  if (connection.circuitOpenUntil === null) return undefined;
  const remainingMs = connection.circuitOpenUntil.getTime() - at.getTime();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return undefined;
  const throttled =
    connection.lastErrorCode === "read_rate_limited" ||
    connection.lastErrorCode === "YAHOO_DRAFT_RATE_LIMITED";
  return new YahooSyncError(
    "PROVIDER_READ_FAILED",
    throttled
      ? "Yahoo is temporarily limiting requests. Try again shortly."
      : "Yahoo sync is temporarily cooling down. Try again shortly.",
    {
      retryable: true,
      retryAfterMs: Math.ceil(Math.min(remainingMs, MAX_YAHOO_RETRY_AFTER_MS) / 1_000) * 1_000,
      throttled,
      cooldown: true,
    },
  );
}

export class DrizzleYahooSyncRepository implements YahooSyncRepository {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async findOwnedConnection(
    userId: string,
    connectionId: string,
  ): Promise<OwnedConnection | undefined> {
    const [connection] = await this.#database
      .select({
        id: providerConnections.id,
        health: providerConnections.health,
        circuitOpenUntil: providerConnections.circuitOpenUntil,
        lastErrorCode: providerConnections.lastErrorCode,
      })
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.id, connectionId),
          eq(providerConnections.userId, userId),
          eq(providerConnections.provider, "yahoo"),
        ),
      )
      .limit(1);
    return connection;
  }

  async listConnectionStatus(userId: string): Promise<readonly YahooConnectionStatus[]> {
    const connectionRows = await this.#database
      .select({
        id: providerConnections.id,
        displayName: providerConnections.displayName,
        health: providerConnections.health,
        credentialExpiresAt: providerConnections.credentialExpiresAt,
        lastSuccessfulAt: providerConnections.lastSuccessfulAt,
        lastErrorCode: providerConnections.lastErrorCode,
        lastErrorAt: providerConnections.lastErrorAt,
      })
      .from(providerConnections)
      .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, "yahoo")))
      .orderBy(asc(providerConnections.createdAt));
    if (connectionRows.length === 0) return [];

    const linkRows = await this.#database
      .select({
        connectionId: providerLeagueLinks.connectionId,
        leagueId: leagues.id,
        leagueSeasonId: leagueSeasons.id,
        name: leagues.name,
        externalKey: leagueSeasons.externalKey,
        season: leagueSeasons.season,
        currentWeek: leagueSeasons.currentWeek,
        seasonLastSyncedAt: leagueSeasons.lastSyncedAt,
        linkLastSyncedAt: providerLeagueLinks.lastSyncedAt,
        currentUserTeamExternalKey: providerLeagueLinks.currentUserTeamExternalKey,
      })
      .from(providerLeagueLinks)
      .innerJoin(leagueSeasons, eq(providerLeagueLinks.leagueSeasonId, leagueSeasons.id))
      .innerJoin(leagues, eq(leagueSeasons.leagueId, leagues.id))
      .where(
        inArray(
          providerLeagueLinks.connectionId,
          connectionRows.map((row) => row.id),
        ),
      )
      .orderBy(asc(leagues.name), asc(leagueSeasons.season));

    const links = new Map<string, YahooConnectionLeagueStatus[]>();
    for (const row of linkRows) {
      const list = links.get(row.connectionId) ?? [];
      const lastSyncedAt = row.linkLastSyncedAt ?? row.seasonLastSyncedAt;
      list.push({
        leagueId: row.leagueId,
        leagueSeasonId: row.leagueSeasonId,
        name: row.name,
        externalKey: row.externalKey,
        season: row.season,
        currentWeek: row.currentWeek,
        lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
        currentUserTeamExternalKey: row.currentUserTeamExternalKey,
      });
      links.set(row.connectionId, list);
    }
    const failureRows = await this.#database
      .select({
        connectionId: syncRuns.connectionId,
        detail: syncRuns.errorDetail,
        failedAt: syncRuns.finishedAt,
      })
      .from(syncRuns)
      .where(
        and(
          inArray(
            syncRuns.connectionId,
            connectionRows.map((row) => row.id),
          ),
          eq(syncRuns.kind, LEAGUE_DATA_HEALTH_KIND),
          eq(syncRuns.state, "failed"),
          eq(syncRuns.errorCode, "INCOMPLETE_ROSTER"),
        ),
      )
      .orderBy(desc(syncRuns.finishedAt), asc(syncRuns.id));
    const failures = new Map<string, YahooLeagueSyncFailure[]>();
    const exclusions = failureRows.length > 0 ? await this.listLeagueExclusions(userId) : [];
    for (const row of failureRows) {
      if (row.connectionId === null) continue;
      const failure = storedLeagueFailure(row.detail, row.failedAt);
      if (
        exclusions.some(
          (entry) =>
            entry.externalKey === failure.externalLeagueKey &&
            (failure.season === null || entry.season === failure.season),
        )
      )
        continue;
      const list = failures.get(row.connectionId) ?? [];
      list.push(failure);
      failures.set(row.connectionId, list);
    }
    return connectionRows.map((row) => ({
      connectionId: row.id,
      displayName: row.displayName ?? "Yahoo Fantasy",
      health: row.health,
      credentialExpiresAt: row.credentialExpiresAt?.toISOString() ?? null,
      lastSuccessfulAt: row.lastSuccessfulAt?.toISOString() ?? null,
      lastErrorCode: row.lastErrorCode,
      lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
      leagues: links.get(row.id) ?? [],
      leagueFailures: failures.get(row.id) ?? [],
    }));
  }

  async listLeagueExclusions(
    userId: string,
  ): Promise<readonly { readonly externalKey: string; readonly season: number }[]> {
    return this.#database
      .select({
        externalKey: leagueSyncExclusions.externalKey,
        season: leagueSyncExclusions.season,
      })
      .from(leagueSyncExclusions)
      .where(
        and(eq(leagueSyncExclusions.userId, userId), eq(leagueSyncExclusions.provider, "yahoo")),
      );
  }

  async clearLeagueExclusions(userId: string): Promise<void> {
    await this.#database
      .delete(leagueSyncExclusions)
      .where(
        and(eq(leagueSyncExclusions.userId, userId), eq(leagueSyncExclusions.provider, "yahoo")),
      );
  }

  async disconnectOwnedConnection(input: {
    readonly userId: string;
    readonly connectionId: string;
    readonly correlationId: string;
    readonly disconnectedAt: Date;
  }): Promise<boolean> {
    return this.#database.transaction(async (transaction) => {
      const [connection] = await transaction
        .select({ id: providerConnections.id })
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.id, input.connectionId),
            eq(providerConnections.userId, input.userId),
            eq(providerConnections.provider, "yahoo"),
          ),
        )
        .limit(1)
        .for("update");
      if (!connection) return false;

      const linkedSeasons = await transaction
        .select({ id: leagueSeasons.id })
        .from(leagueSeasons)
        .where(eq(leagueSeasons.connectionId, connection.id));
      await transaction
        .update(leagueSeasons)
        .set({ connectionId: null, updatedAt: input.disconnectedAt })
        .where(eq(leagueSeasons.connectionId, connection.id));
      const deleted = await transaction
        .delete(providerConnections)
        .where(
          and(
            eq(providerConnections.id, connection.id),
            eq(providerConnections.userId, input.userId),
            eq(providerConnections.provider, "yahoo"),
          ),
        )
        .returning({ id: providerConnections.id });
      if (deleted.length !== 1) {
        throw new Error("Owned Yahoo connection disappeared during local disconnect");
      }

      await transaction.insert(auditEvents).values({
        userId: input.userId,
        action: "yahoo.connection.local_authorization_removed",
        targetType: "provider_connection",
        targetId: connection.id,
        correlationId: input.correlationId.slice(0, 128),
        metadata: {
          provider: "yahoo",
          providerRevocationAttempted: false,
          localCredentialRemoved: true,
          linkedLeagueSeasonCount: linkedSeasons.length,
          synchronizedLeagueData: "preserved_last_known",
        },
        occurredAt: input.disconnectedAt,
      });
      return true;
    });
  }

  async markFailure(
    userId: string,
    connectionId: string,
    errorCode: string,
    at: Date,
    options: { readonly cooldownUntil: Date } | undefined = undefined,
  ): Promise<void> {
    const cooldownUntilIso = options?.cooldownUntil.toISOString();
    await this.#database
      .update(providerConnections)
      .set({
        health: options
          ? sql<ConnectionHealth>`case
              when ${providerConnections.health} in ('reauthorize', 'disabled')
                then ${providerConnections.health}
              else 'healthy'
            end`
          : sql<ConnectionHealth>`case
              when ${providerConnections.health} in ('reauthorize', 'disabled')
                then ${providerConnections.health}
              else 'degraded'
            end`,
        lastErrorCode: errorCode.slice(0, 120),
        lastErrorAt: at,
        updatedAt: at,
        ...(cooldownUntilIso
          ? {
              circuitOpenUntil: sql<Date>`case
                when ${providerConnections.circuitOpenUntil} is null
                  or ${providerConnections.circuitOpenUntil} < ${cooldownUntilIso}::timestamptz
                then ${cooldownUntilIso}::timestamptz
                else ${providerConnections.circuitOpenUntil}
              end`,
            }
          : {}),
      })
      .where(
        and(
          eq(providerConnections.id, connectionId),
          eq(providerConnections.userId, userId),
          eq(providerConnections.provider, "yahoo"),
        ),
      );
  }

  async markDiscoverySuccess(userId: string, connectionId: string, at: Date): Promise<void> {
    await this.#database
      .update(providerConnections)
      .set({
        health: "healthy",
        lastSuccessfulAt: at,
        lastErrorCode: null,
        lastErrorAt: null,
        lastErrorDetail: null,
        consecutiveFailures: 0,
        circuitOpenUntil: null,
        updatedAt: at,
      })
      .where(
        and(
          eq(providerConnections.id, connectionId),
          eq(providerConnections.userId, userId),
          eq(providerConnections.provider, "yahoo"),
        ),
      );
  }

  async markLeagueFailure(
    userId: string,
    connectionId: string,
    failure: YahooLeagueSyncFailure,
  ): Promise<void> {
    const at = new Date(failure.failedAt);
    const safeFailure = storedLeagueFailure(
      JSON.stringify({ externalLeagueKey: failure.externalLeagueKey, season: failure.season }),
      at,
    );
    await this.#database.transaction(async (transaction) => {
      // The same connection lock serializes failure recording and successful snapshot commits.
      const [connection] = await transaction
        .select({ id: providerConnections.id })
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.id, connectionId),
            eq(providerConnections.userId, userId),
            eq(providerConnections.provider, "yahoo"),
          ),
        )
        .limit(1)
        .for("update");
      if (!connection) {
        throw new YahooSyncError("CONNECTION_NOT_FOUND", "Yahoo connection was not found");
      }
      const [linked] = await transaction
        .select({
          id: leagueSeasons.id,
          season: leagueSeasons.season,
          lastSyncedAt: providerLeagueLinks.lastSyncedAt,
        })
        .from(providerLeagueLinks)
        .innerJoin(leagueSeasons, eq(leagueSeasons.id, providerLeagueLinks.leagueSeasonId))
        .where(
          and(
            eq(providerLeagueLinks.connectionId, connectionId),
            eq(leagueSeasons.provider, "yahoo"),
            eq(leagueSeasons.externalKey, safeFailure.externalLeagueKey),
            ...(safeFailure.season === null ? [] : [eq(leagueSeasons.season, safeFailure.season)]),
          ),
        )
        .limit(1);
      if (linked?.lastSyncedAt && linked.lastSyncedAt >= at) return;
      // This is a connection/key-scoped health observation, not an imported snapshot. Leave the
      // leagueSeasonId null so latest-league-sync readers still select actual snapshot runs.
      // One current record also keeps failed first imports visible before a league/link exists.
      const [recorded] = await transaction
        .insert(syncRuns)
        .values({
          connectionId,
          leagueSeasonId: null,
          kind: LEAGUE_DATA_HEALTH_KIND,
          state: "failed",
          idempotencyKey: leagueDataHealthKey(connectionId, safeFailure.externalLeagueKey),
          startedAt: at,
          finishedAt: at,
          errorCode: safeFailure.code,
          errorDetail: JSON.stringify({
            externalLeagueKey: safeFailure.externalLeagueKey,
            season: linked?.season ?? safeFailure.season,
          }),
        })
        .onConflictDoUpdate({
          target: syncRuns.idempotencyKey,
          set: {
            leagueSeasonId: null,
            state: "failed",
            startedAt: at,
            finishedAt: at,
            errorCode: safeFailure.code,
            errorDetail: JSON.stringify({
              externalLeagueKey: safeFailure.externalLeagueKey,
              season: linked?.season ?? safeFailure.season,
            }),
          },
          setWhere: lt(syncRuns.finishedAt, at),
        })
        .returning({ id: syncRuns.id });
      if (!recorded) return;
      if (linked) {
        await transaction
          .update(providerLeagueLinks)
          .set({
            lastErrorCode: safeFailure.code,
            lastErrorAt: at,
            lastErrorDetail: INCOMPLETE_ROSTER_MESSAGE,
            consecutiveFailures: sql`${providerLeagueLinks.consecutiveFailures} + 1`,
            updatedAt: at,
          })
          .where(
            and(
              eq(providerLeagueLinks.connectionId, connectionId),
              eq(providerLeagueLinks.leagueSeasonId, linked.id),
              or(isNull(providerLeagueLinks.lastErrorAt), lte(providerLeagueLinks.lastErrorAt, at)),
            ),
          );
      }
    });
  }

  async persistBundle(
    userId: string,
    connectionId: string,
    bundle: LeagueSyncBundle,
  ): Promise<YahooSyncReceipt> {
    if (bundle.provider !== "yahoo" || bundle.provenance.mode !== "official-api") {
      throw new YahooSyncError("PERSISTENCE_FAILED", "Yahoo sync rejected non-official provenance");
    }
    const checksum = bundle.provenance.artifactChecksumSha256;
    if (!checksum || !/^[a-f0-9]{64}$/u.test(checksum)) {
      throw new YahooSyncError("PERSISTENCE_FAILED", "Yahoo sync artifact checksum is invalid");
    }
    const fetchedAt = new Date(bundle.provenance.fetchedAt);
    if (!Number.isFinite(fetchedAt.getTime())) {
      throw new YahooSyncError("PERSISTENCE_FAILED", "Yahoo sync fetch timestamp is invalid");
    }
    const idempotencyKey = `yahoo:${connectionId}:${bundle.league.externalId}:${bundle.league.season}:${checksum}`;
    const now = this.#now();
    const currentUserTeams = bundle.teams.filter((team) => team.isCurrentUser);
    if (currentUserTeams.length > 1) {
      throw new Error("Yahoo marked more than one team as owned by the current login");
    }
    const currentUserTeam = currentUserTeams[0];
    const providerCommissioner = currentUserTeam?.currentUserIsCommissioner ?? null;

    return this.#database.transaction(async (transaction) => {
      const [connection] = await transaction
        .select({ id: providerConnections.id, health: providerConnections.health })
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.id, connectionId),
            eq(providerConnections.userId, userId),
            eq(providerConnections.provider, "yahoo"),
          ),
        )
        .limit(1)
        .for("update");
      if (!connection) {
        throw new YahooSyncError("CONNECTION_NOT_FOUND", "Yahoo connection was not found");
      }

      const [excluded] = await transaction
        .select({ userId: leagueSyncExclusions.userId })
        .from(leagueSyncExclusions)
        .where(
          and(
            eq(leagueSyncExclusions.userId, userId),
            eq(leagueSyncExclusions.provider, "yahoo"),
            eq(leagueSyncExclusions.externalKey, bundle.league.externalId),
            eq(leagueSyncExclusions.season, bundle.league.season),
          ),
        )
        .limit(1);
      if (excluded) {
        throw new YahooSyncError(
          "LEAGUE_REMOVED",
          "This Yahoo league was removed from the member's account",
        );
      }

      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`yahoo:${bundle.league.externalId}:${bundle.league.season}`}, 0))`,
      );
      const [existingSeason] = await transaction
        .select()
        .from(leagueSeasons)
        .where(
          and(
            eq(leagueSeasons.provider, "yahoo"),
            eq(leagueSeasons.externalKey, bundle.league.externalId),
            eq(leagueSeasons.season, bundle.league.season),
          ),
        )
        .limit(1);
      const [latestCore] = existingSeason
        ? await transaction
            .select({
              id: syncRuns.id,
              connectionId: syncRuns.connectionId,
              leagueSeasonId: syncRuns.leagueSeasonId,
              recordsWritten: syncRuns.recordsWritten,
              artifactChecksum: syncRuns.artifactChecksum,
            })
            .from(rosterSnapshots)
            .innerJoin(fantasyTeams, eq(fantasyTeams.id, rosterSnapshots.teamId))
            .innerJoin(syncRuns, eq(syncRuns.id, rosterSnapshots.sourceSyncRunId))
            .where(
              and(
                eq(fantasyTeams.leagueSeasonId, existingSeason.id),
                eq(syncRuns.kind, "yahoo-official-read"),
                eq(syncRuns.state, "succeeded"),
              ),
            )
            .orderBy(
              desc(rosterSnapshots.effectiveAt),
              desc(rosterSnapshots.createdAt),
              desc(rosterSnapshots.id),
            )
            .limit(1)
        : [];
      if (
        existingSeason?.lastSyncedAt &&
        (fetchedAt < existingSeason.lastSyncedAt ||
          (fetchedAt.getTime() === existingSeason.lastSyncedAt.getTime() &&
            latestCore?.artifactChecksum !== checksum))
      ) {
        throw new YahooSyncError(
          "PERSISTENCE_FAILED",
          "Yahoo sync capture is older than or conflicts with the current league snapshot",
        );
      }
      const persistProviderLink = async (leagueSeasonId: string): Promise<void> => {
        const [previousLink] = await transaction
          .select({ providerCommissioner: providerLeagueLinks.providerCommissioner })
          .from(providerLeagueLinks)
          .where(
            and(
              eq(providerLeagueLinks.connectionId, connectionId),
              eq(providerLeagueLinks.leagueSeasonId, leagueSeasonId),
            ),
          )
          .limit(1);
        await transaction
          .insert(providerLeagueLinks)
          .values({
            connectionId,
            leagueSeasonId,
            currentUserTeamExternalKey: currentUserTeam?.externalId ?? null,
            providerCommissioner,
            providerCommissionerObservedAt: providerCommissioner === null ? null : fetchedAt,
            lastSyncedAt: fetchedAt,
          })
          .onConflictDoUpdate({
            target: [providerLeagueLinks.connectionId, providerLeagueLinks.leagueSeasonId],
            set: {
              currentUserTeamExternalKey: currentUserTeam?.externalId ?? null,
              providerCommissioner,
              providerCommissionerObservedAt: providerCommissioner === null ? null : fetchedAt,
              lastSyncedAt: sql`greatest(${providerLeagueLinks.lastSyncedAt}, ${fetchedAt.toISOString()}::timestamptz)`,
              lastErrorCode: sql`case when ${providerLeagueLinks.lastErrorAt} > ${fetchedAt.toISOString()}::timestamptz then ${providerLeagueLinks.lastErrorCode} else null end`,
              lastErrorAt: sql`case when ${providerLeagueLinks.lastErrorAt} > ${fetchedAt.toISOString()}::timestamptz then ${providerLeagueLinks.lastErrorAt} else null end`,
              lastErrorDetail: sql`case when ${providerLeagueLinks.lastErrorAt} > ${fetchedAt.toISOString()}::timestamptz then ${providerLeagueLinks.lastErrorDetail} else null end`,
              consecutiveFailures: sql`case when ${providerLeagueLinks.lastErrorAt} > ${fetchedAt.toISOString()}::timestamptz then ${providerLeagueLinks.consecutiveFailures} else 0 end`,
              circuitOpenUntil: sql`case when ${providerLeagueLinks.lastErrorAt} > ${fetchedAt.toISOString()}::timestamptz then ${providerLeagueLinks.circuitOpenUntil} else null end`,
              updatedAt: now,
            },
          });
        await transaction
          .update(syncRuns)
          .set({
            state: "succeeded",
            finishedAt: fetchedAt,
            errorCode: null,
            errorDetail: null,
          })
          .where(
            and(
              eq(
                syncRuns.idempotencyKey,
                leagueDataHealthKey(connectionId, bundle.league.externalId),
              ),
              eq(syncRuns.kind, LEAGUE_DATA_HEALTH_KIND),
              lte(syncRuns.finishedAt, fetchedAt),
            ),
          );

        const previousCommissioner = previousLink?.providerCommissioner ?? null;
        if (previousCommissioner !== providerCommissioner) {
          await transaction.insert(auditEvents).values({
            userId,
            action: "yahoo.membership.provider_commissioner_evidence_updated",
            targetType: "provider_league_link",
            targetId: `${connectionId}:${leagueSeasonId}`,
            correlationId: idempotencyKey.slice(0, 128) || "yahoo-official-commissioner-evidence",
            metadata: {
              provider: "yahoo",
              signal: "league-manager",
              previous: previousCommissioner,
              current: providerCommissioner,
            },
            occurredAt: now,
          });
        }
      };
      // Only the current snapshot can be unchanged. A historical checksum match would silently
      // retain B on an A -> B -> A roster change while falsely advancing its freshness.
      const prior =
        latestCore?.artifactChecksum === checksum && latestCore.connectionId === connectionId
          ? latestCore
          : undefined;
      if (prior?.leagueSeasonId) {
        const [season] = await transaction
          .select({ id: leagueSeasons.id, leagueId: leagueSeasons.leagueId })
          .from(leagueSeasons)
          .where(eq(leagueSeasons.id, prior.leagueSeasonId))
          .limit(1);
        if (!season) throw new Error("Yahoo idempotent sync referenced a missing league season");
        await transaction
          .update(leagueSeasons)
          .set({
            lastSyncedAt: sql`greatest(${leagueSeasons.lastSyncedAt}, ${fetchedAt.toISOString()}::timestamptz)`,
            updatedAt: now,
            // A newer normalizer may recognize draft status in unchanged provider bytes. Keep
            // that observed field current without replacing other settings or creating a roster.
            ...(bundle.league.settings.draftStatus === undefined
              ? {}
              : {
                  settings: sql`jsonb_set(${leagueSeasons.settings}, '{draftStatus}', ${JSON.stringify(bundle.league.settings.draftStatus)}::jsonb, true)`,
                }),
          })
          .where(eq(leagueSeasons.id, season.id));
        await persistProviderLink(season.id);
        const mappedExternalKey = currentUserTeam?.externalId;
        if (mappedExternalKey) {
          const [mappedTeam] = await transaction
            .select({ id: fantasyTeams.id })
            .from(fantasyTeams)
            .where(
              and(
                eq(fantasyTeams.leagueSeasonId, season.id),
                eq(fantasyTeams.externalKey, mappedExternalKey),
              ),
            )
            .limit(1);
          if (mappedTeam) {
            const [conflict] = await transaction
              .select({ userId: leagueMemberships.userId })
              .from(leagueMemberships)
              .where(eq(leagueMemberships.claimedFantasyTeamId, mappedTeam.id))
              .limit(1);
            if (!conflict || conflict.userId === userId) {
              try {
                await transaction.transaction(async (savepoint) => {
                  await savepoint
                    .update(leagueMemberships)
                    .set({ claimedFantasyTeamId: mappedTeam.id, claimedAt: now, updatedAt: now })
                    .where(
                      and(
                        eq(leagueMemberships.leagueId, season.leagueId),
                        eq(leagueMemberships.userId, userId),
                        isNull(leagueMemberships.claimedFantasyTeamId),
                      ),
                    );
                });
              } catch (error) {
                // A historical or concurrent claim conflict must not invalidate a read sync.
                if (!isUniqueViolation(error)) throw error;
              }
            }
          }
        }
        await transaction
          .update(providerConnections)
          .set({
            health: "healthy",
            lastSuccessfulAt: now,
            lastErrorCode: null,
            lastErrorAt: null,
            updatedAt: now,
          })
          .where(eq(providerConnections.id, connectionId));
        return {
          syncRunId: prior.id,
          leagueId: season.leagueId,
          leagueSeasonId: season.id,
          externalLeagueKey: bundle.league.externalId,
          season: bundle.league.season,
          state: "unchanged",
          recordsWritten: prior.recordsWritten,
          syncedAt: fetchedAt.toISOString(),
        };
      }

      const recordsRead =
        bundle.teams.length +
        bundle.teams.reduce((total, team) => total + team.roster.length, 0) +
        (bundle.standings?.entries.length ?? 0) +
        (bundle.matchups?.matchups.length ?? 0);
      const [run] = await transaction
        .insert(syncRuns)
        .values({
          connectionId,
          kind: "yahoo-official-read",
          state: "processing",
          idempotencyKey: latestCore ? `${idempotencyKey}:after:${latestCore.id}` : idempotencyKey,
          startedAt: now,
          recordsRead,
          artifactChecksum: checksum,
        })
        .returning({ id: syncRuns.id });
      if (!run) throw new Error("Yahoo sync run could not be created");

      let leagueId: string;
      let leagueSeasonId: string;
      let createdLeague = false;
      if (existingSeason) {
        leagueId = existingSeason.leagueId;
        leagueSeasonId = existingSeason.id;
        await transaction
          .update(leagues)
          .set({ name: bundle.league.name, updatedAt: now })
          .where(eq(leagues.id, leagueId));
        await transaction
          .update(leagueSeasons)
          .set({
            connectionId: existingSeason.connectionId ?? connectionId,
            status: bundle.league.currentWeek ? "active" : "preseason",
            teamCount: bundle.league.settings.teamCount,
            draftType: bundle.league.settings.draftType,
            waiverType: bundle.league.settings.waiverType,
            currentWeek: bundle.league.currentWeek,
            settings: plainRecord(bundle.league.settings),
            lastSyncedAt: sql`greatest(${leagueSeasons.lastSyncedAt}, ${fetchedAt.toISOString()}::timestamptz)`,
            updatedAt: now,
          })
          .where(eq(leagueSeasons.id, leagueSeasonId));
      } else {
        const [created] = await transaction
          .insert(leagues)
          .values({ ownerUserId: userId, name: bundle.league.name })
          .returning({ id: leagues.id });
        if (!created) throw new Error("Yahoo league could not be created");
        leagueId = created.id;
        createdLeague = true;
        const [season] = await transaction
          .insert(leagueSeasons)
          .values({
            leagueId,
            connectionId,
            provider: "yahoo",
            externalKey: bundle.league.externalId,
            season: bundle.league.season,
            status: bundle.league.currentWeek ? "active" : "preseason",
            teamCount: bundle.league.settings.teamCount,
            draftType: bundle.league.settings.draftType,
            waiverType: bundle.league.settings.waiverType,
            currentWeek: bundle.league.currentWeek,
            settings: plainRecord(bundle.league.settings),
            lastSyncedAt: fetchedAt,
          })
          .returning({ id: leagueSeasons.id });
        if (!season) throw new Error("Yahoo league season could not be created");
        leagueSeasonId = season.id;
      }

      await transaction
        .insert(leagueMemberships)
        .values({ leagueId, userId, role: createdLeague ? "owner" : "member" })
        .onConflictDoNothing({ target: [leagueMemberships.leagueId, leagueMemberships.userId] });

      await persistProviderLink(leagueSeasonId);

      await transaction.delete(scoringRules).where(eq(scoringRules.leagueSeasonId, leagueSeasonId));
      if (bundle.league.settings.scoringRules.length > 0) {
        await transaction.insert(scoringRules).values(
          bundle.league.settings.scoringRules.map((rule) => ({
            leagueSeasonId,
            statKey: rule.name ?? rule.statId,
            operation: yahooScoringOperation(
              rule.statId,
              bundle.league.settings.usesFractionalPoints,
              bundle.league.settings.usesNegativePoints,
            ),
            points: String(rule.points),
            providerStatId: rule.statId,
            positionTypes: yahooScoringPositionTypes(rule.positionTypes),
          })),
        );
      }
      await transaction
        .delete(rosterSlotRules)
        .where(eq(rosterSlotRules.leagueSeasonId, leagueSeasonId));
      if (bundle.league.settings.rosterSlots.length > 0) {
        await transaction.insert(rosterSlotRules).values(
          bundle.league.settings.rosterSlots.map((slot) => ({
            leagueSeasonId,
            slotCode: slot.position,
            count: slot.count,
            eligiblePositions: slotEligibility(slot.position),
            isStarter: slot.starting,
          })),
        );
      }

      let recordsWritten = 2;
      const teamIds = new Map<string, string>();
      for (const team of bundle.teams) {
        const manager = team.managers[0];
        // Same preference as the ESPN path. Yahoo reports only a nickname today, so this resolves
        // to that; it stays correct if Yahoo ever starts sending a separate real name.
        const managerDisplayName = manager ? (manager.fullName ?? manager.displayName) : null;
        const [storedTeam] = await transaction
          .insert(fantasyTeams)
          .values({
            leagueSeasonId,
            externalKey: team.externalId,
            name: team.name,
            abbreviation: team.abbreviation,
            logoUrl: team.logoUrl ?? null,
            isUserTeam: false,
            managerDisplayName,
          })
          .onConflictDoUpdate({
            target: [fantasyTeams.leagueSeasonId, fantasyTeams.externalKey],
            set: {
              name: team.name,
              abbreviation: team.abbreviation,
              logoUrl: team.logoUrl ?? null,
              managerDisplayName,
              updatedAt: now,
            },
          })
          .returning({ id: fantasyTeams.id });
        if (!storedTeam) throw new Error("Yahoo fantasy team could not be stored");
        teamIds.set(team.externalId, storedTeam.id);
        const [snapshot] = await transaction
          .insert(rosterSnapshots)
          .values({
            teamId: storedTeam.id,
            season: bundle.league.season,
            week: bundle.league.currentWeek,
            effectiveAt: fetchedAt,
            sourceSyncRunId: run.id,
          })
          .returning({ id: rosterSnapshots.id });
        if (!snapshot) throw new Error("Yahoo roster snapshot could not be stored");

        const entries: Array<{
          snapshotId: string;
          playerId: string;
          slotCode: string;
          isStarter: boolean;
        }> = [];
        for (const player of team.roster) {
          const [external] = await transaction
            .select({ playerId: playerExternalIds.playerId })
            .from(playerExternalIds)
            .where(
              and(
                eq(playerExternalIds.source, "yahoo"),
                eq(playerExternalIds.externalId, player.externalId),
              ),
            )
            .limit(1);
          let playerId = external?.playerId;
          if (playerId) {
            await transaction
              .update(players)
              .set({
                fullName: player.fullName,
                nflTeam: player.proTeamAbbreviation,
                primaryPosition: player.primaryPosition,
                eligiblePositions: [...new Set(player.eligiblePositions)],
                status: player.status,
                updatedAt: now,
              })
              .where(eq(players.id, playerId));
          } else {
            const [storedPlayer] = await transaction
              .insert(players)
              .values({
                fullName: player.fullName,
                nflTeam: player.proTeamAbbreviation,
                primaryPosition: player.primaryPosition,
                eligiblePositions: [...new Set(player.eligiblePositions)],
                status: player.status,
              })
              .returning({ id: players.id });
            if (!storedPlayer) throw new Error("Yahoo player could not be stored");
            playerId = storedPlayer.id;
            await transaction.insert(playerExternalIds).values({
              playerId,
              source: "yahoo",
              externalId: player.externalId,
              season: bundle.league.season,
              confidence: "1",
              verified: true,
            });
          }
          entries.push({
            snapshotId: snapshot.id,
            playerId,
            slotCode: player.lineupSlot,
            isStarter: !["BN", "IR", "IR+", "IL", "IL+", "NA"].includes(
              player.lineupSlot.toUpperCase(),
            ),
          });
        }
        if (entries.length > 0) await transaction.insert(rosterEntries).values(entries);
        recordsWritten += 2 + entries.length;
      }

      const mappedTeamId = currentUserTeam ? teamIds.get(currentUserTeam.externalId) : undefined;
      if (mappedTeamId) {
        const [conflict] = await transaction
          .select({ userId: leagueMemberships.userId })
          .from(leagueMemberships)
          .where(eq(leagueMemberships.claimedFantasyTeamId, mappedTeamId))
          .limit(1);
        if (!conflict || conflict.userId === userId) {
          try {
            await transaction.transaction(async (savepoint) => {
              await savepoint
                .update(leagueMemberships)
                .set({ claimedFantasyTeamId: mappedTeamId, claimedAt: now, updatedAt: now })
                .where(
                  and(
                    eq(leagueMemberships.leagueId, leagueId),
                    eq(leagueMemberships.userId, userId),
                    isNull(leagueMemberships.claimedFantasyTeamId),
                  ),
                );
            });
          } catch (error) {
            // Preserve the provider mirror even if an older self-asserted claim owns this team.
            if (!isUniqueViolation(error)) throw error;
          }
        }
      }

      if (bundle.standings) {
        const [snapshot] = await transaction
          .insert(standingsSnapshots)
          .values({
            leagueSeasonId,
            asOfWeek: bundle.standings.asOfWeek,
            effectiveAt: fetchedAt,
            sourceSyncRunId: run.id,
          })
          .returning({ id: standingsSnapshots.id });
        if (!snapshot) throw new Error("Yahoo standings snapshot could not be stored");
        const entries = bundle.standings.entries.map((entry) => {
          const teamId = teamIds.get(entry.teamExternalId);
          if (!teamId) throw new Error("Yahoo standings referenced an unstored team");
          return {
            snapshotId: snapshot.id,
            teamId,
            providerTeamId: entry.providerTeamId,
            rank: entry.rank,
            playoffSeed: entry.playoffSeed,
            wins: entry.wins,
            losses: entry.losses,
            ties: entry.ties,
            pointsFor: String(entry.pointsFor),
            pointsAgainst: String(entry.pointsAgainst),
            streakType: entry.streakType,
            streakLength: entry.streakLength,
          };
        });
        if (entries.length > 0) await transaction.insert(standingsEntries).values(entries);
        recordsWritten += 1 + entries.length;
      }

      if (bundle.matchups) {
        const [snapshot] = await transaction
          .insert(matchupSnapshots)
          .values({
            leagueSeasonId,
            asOfWeek: bundle.matchups.asOfWeek,
            effectiveAt: fetchedAt,
            sourceSyncRunId: run.id,
          })
          .returning({ id: matchupSnapshots.id });
        if (!snapshot) throw new Error("Yahoo matchup snapshot could not be stored");
        const matchups = bundle.matchups.matchups.map((matchup) => {
          const homeTeamId = teamIds.get(matchup.home.teamExternalId);
          const awayTeamId = teamIds.get(matchup.away.teamExternalId);
          const winnerTeamId = matchup.winnerTeamExternalId
            ? teamIds.get(matchup.winnerTeamExternalId)
            : undefined;
          if (!homeTeamId || !awayTeamId || (matchup.winnerTeamExternalId && !winnerTeamId)) {
            throw new Error("Yahoo matchup referenced an unstored team");
          }
          return {
            snapshotId: snapshot.id,
            externalKey: matchup.externalId,
            providerMatchupId: matchup.providerMatchupId,
            week: matchup.week,
            status: matchup.status,
            homeTeamId,
            awayTeamId,
            homeProviderTeamId: matchup.home.providerTeamId,
            awayProviderTeamId: matchup.away.providerTeamId,
            homeScore: matchup.home.score === null ? null : String(matchup.home.score),
            awayScore: matchup.away.score === null ? null : String(matchup.away.score),
            winnerTeamId: winnerTeamId ?? null,
            tied: matchup.tied,
          };
        });
        if (matchups.length > 0) await transaction.insert(weeklyMatchups).values(matchups);
        recordsWritten += 1 + matchups.length;
      }

      await transaction
        .update(leagueSeasons)
        .set({ projectionRefreshDemandId: run.id })
        .where(eq(leagueSeasons.id, leagueSeasonId));
      await transaction
        .update(syncRuns)
        .set({
          leagueSeasonId,
          state: "succeeded",
          finishedAt: now,
          recordsWritten,
        })
        .where(eq(syncRuns.id, run.id));
      await transaction
        .update(providerConnections)
        .set({
          health: "healthy",
          lastSuccessfulAt: now,
          lastErrorCode: null,
          lastErrorAt: null,
          updatedAt: now,
        })
        .where(eq(providerConnections.id, connectionId));

      return {
        syncRunId: run.id,
        leagueId,
        leagueSeasonId,
        externalLeagueKey: bundle.league.externalId,
        season: bundle.league.season,
        state: "accepted",
        recordsWritten,
        syncedAt: fetchedAt.toISOString(),
      };
    });
  }
}

export class YahooSyncService {
  readonly #repository: YahooSyncRepository;
  readonly #tokens: YahooAccessTokenPort;
  readonly #client: YahooReadPort;
  readonly #now: () => Date;
  readonly #pageSize: number;

  constructor(input: {
    readonly repository: YahooSyncRepository;
    readonly tokens: YahooAccessTokenPort;
    readonly client?: YahooReadPort;
    readonly now?: () => Date;
    readonly pageSize?: number;
  }) {
    this.#repository = input.repository;
    this.#tokens = input.tokens;
    this.#client = input.client ?? new YahooFantasyReadClient();
    this.#now = input.now ?? (() => new Date());
    this.#pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > 100) {
      throw new TypeError("Yahoo discovery page size must be between 1 and 100");
    }
  }

  listConnections(userId: string): Promise<readonly YahooConnectionStatus[]> {
    return this.#repository.listConnectionStatus(userId);
  }

  async disconnectConnection(
    userId: string,
    connectionId: string,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.#repository.disconnectOwnedConnection({
        userId,
        connectionId,
        correlationId,
        disconnectedAt: this.#now(),
      });
    } catch {
      throw new YahooSyncError(
        "LOCAL_DISCONNECT_FAILED",
        "The stored Yahoo authorization could not be removed from Laces Out",
      );
    }
  }

  async discoverAndSync(
    userId: string,
    connectionId: string,
    options: { readonly restoreRemoved?: boolean } = {},
  ): Promise<YahooDiscoveryResult> {
    const connection = await this.#repository.findOwnedConnection(userId, connectionId);
    if (!connection) {
      throw new YahooSyncError("CONNECTION_NOT_FOUND", "Yahoo connection was not found");
    }
    const cooldownError = connectionCooldownError(connection, this.#now());
    if (cooldownError) throw cooldownError;
    try {
      if (options.restoreRemoved) await this.#repository.clearLeagueExclusions(userId);
      const discovered = await this.#discover(userId, connectionId);
      const exclusions = await this.#repository.listLeagueExclusions(userId);
      const excluded = new Set(
        exclusions.map((league) => `${league.externalKey}:${league.season}`),
      );
      const eligible = discovered.filter(
        (league) => !excluded.has(`${league.externalId}:${league.season}`),
      );
      const syncs: YahooSyncReceipt[] = [];
      const failures: YahooLeagueSyncFailure[] = [];
      for (const league of eligible) {
        try {
          syncs.push(await this.#syncLeague(userId, connectionId, league.externalId, league));
        } catch (error) {
          // Yahoo exposes newly created leagues to discovery before a second team has joined.
          // They are not persistable league seasons yet and must not block the member's playable
          // leagues from syncing. A later discovery will pick them up once Yahoo reports a real
          // multi-team league.
          if (error instanceof YahooXmlError && error.code === "LEAGUE_NOT_READY") continue;
          if (error instanceof YahooSyncError && error.leagueFailure !== null) {
            failures.push(error.leagueFailure);
            continue;
          }
          throw error;
        }
      }
      await this.#repository.markDiscoverySuccess(userId, connectionId, this.#now());
      return {
        connectionId,
        discovered: eligible,
        syncs,
        failures,
        generatedAt: this.#now().toISOString(),
      };
    } catch (error) {
      const syncError = clientFacingSyncError(error);
      const failedAt = this.#now();
      if (syncError.throttled) {
        await this.#repository.markFailure(userId, connectionId, failureCode(error), failedAt, {
          cooldownUntil: new Date(
            failedAt.getTime() + (syncError.retryAfterMs ?? DEFAULT_THROTTLE_RETRY_AFTER_MS),
          ),
        });
      } else {
        await this.#repository.markFailure(userId, connectionId, failureCode(error), failedAt);
      }
      throw syncError;
    }
  }

  async syncLeague(
    userId: string,
    connectionId: string,
    leagueKey: string,
  ): Promise<YahooSyncReceipt> {
    const connection = await this.#repository.findOwnedConnection(userId, connectionId);
    if (!connection) {
      throw new YahooSyncError("CONNECTION_NOT_FOUND", "Yahoo connection was not found");
    }
    if (!/^(?:[a-z][a-z0-9-]{0,15}|[0-9]{1,10})\.l\.[0-9]{1,20}$/u.test(leagueKey)) {
      throw new TypeError("Yahoo league key is invalid");
    }
    const cooldownError = connectionCooldownError(connection, this.#now());
    if (cooldownError) throw cooldownError;
    const exclusions = await this.#repository.listLeagueExclusions(userId);
    if (exclusions.some((league) => league.externalKey === leagueKey)) {
      throw new YahooSyncError(
        "LEAGUE_REMOVED",
        "This Yahoo league was removed. Reconnect Yahoo to add it again.",
      );
    }
    try {
      return await this.#syncLeague(userId, connectionId, leagueKey);
    } catch (error) {
      if (error instanceof YahooSyncError && error.leagueFailure !== null) throw error;
      const syncError = clientFacingSyncError(error);
      const failedAt = this.#now();
      if (syncError.throttled) {
        await this.#repository.markFailure(userId, connectionId, failureCode(error), failedAt, {
          cooldownUntil: new Date(
            failedAt.getTime() + (syncError.retryAfterMs ?? DEFAULT_THROTTLE_RETRY_AFTER_MS),
          ),
        });
      } else {
        await this.#repository.markFailure(userId, connectionId, failureCode(error), failedAt);
      }
      throw syncError;
    }
  }

  async #withToken<T>(
    userId: string,
    connectionId: string,
    read: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    let accessToken = await this.#tokens.getAccessToken(userId, connectionId);
    try {
      return await read(accessToken);
    } catch (error) {
      if (!(error instanceof YahooReadClientError) || !error.refreshAccessToken) throw error;
      accessToken = await this.#tokens.getAccessToken(userId, connectionId, {
        forceRefresh: true,
      });
      return read(accessToken);
    }
  }

  async #discover(userId: string, connectionId: string): Promise<readonly ExternalLeagueRef[]> {
    const leagues = new Map<string, ExternalLeagueRef>();
    let start = 0;
    for (let pageNumber = 0; pageNumber < MAX_DISCOVERY_PAGES; pageNumber += 1) {
      const artifact = await this.#withToken(userId, connectionId, (accessToken) =>
        this.#client.getUserLeagues(
          { accessToken },
          { gameKeys: ["nfl"], start, count: this.#pageSize },
        ),
      );
      const page = parseYahooLeaguePageXml(artifact.xml);
      for (const league of page.leagues) {
        const existing = leagues.get(league.externalId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(league)) {
          throw new YahooSyncError("DUPLICATE_LEAGUE", "Yahoo returned conflicting league records");
        }
        leagues.set(league.externalId, league);
      }
      if (leagues.size > MAX_DISCOVERED_LEAGUES) {
        throw new YahooSyncError(
          "DISCOVERY_LIMIT",
          "Yahoo league discovery exceeded its safety limit",
        );
      }
      if (page.returned < this.#pageSize) return [...leagues.values()];
      start += page.returned;
    }
    throw new YahooSyncError("DISCOVERY_LIMIT", "Yahoo league discovery did not terminate");
  }

  async #syncLeague(
    userId: string,
    connectionId: string,
    leagueKey: string,
    expectedLeague?: ExternalLeagueRef,
  ): Promise<YahooSyncReceipt> {
    const artifacts = await this.#withToken(userId, connectionId, async (accessToken) => {
      const request = { accessToken };
      const [settings, teams, rosters, standings, matchups] = await Promise.all([
        this.#client.getLeagueSettings(request, leagueKey),
        this.#client.getLeagueTeams(request, leagueKey),
        this.#client.getLeagueRosters(request, leagueKey),
        this.#client.getLeagueStandings(request, leagueKey),
        this.#client.getLeagueMatchups(request, leagueKey),
      ]);
      return { settings, teams, rosters, standings, matchups };
    });
    const fetchedAt = this.#now();
    let bundle: LeagueSyncBundle;
    try {
      bundle = parseYahooLeagueSyncArtifacts({
        settingsXml: artifacts.settings.xml,
        teamsXml: artifacts.teams.xml,
        rostersXml: artifacts.rosters.xml,
        standingsXml: artifacts.standings.xml,
        matchupsXml: artifacts.matchups.xml,
        fetchedAt,
        endpoint: `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}`,
      });
    } catch (error) {
      if (!(error instanceof YahooXmlError) || error.code !== "INCOMPLETE_ROSTER") throw error;
      const failure: YahooLeagueSyncFailure = {
        externalLeagueKey: leagueKey,
        season: expectedLeague?.season ?? null,
        code: "INCOMPLETE_ROSTER",
        message: INCOMPLETE_ROSTER_MESSAGE,
        failedAt: fetchedAt.toISOString(),
      };
      try {
        await this.#repository.markLeagueFailure(userId, connectionId, failure);
      } catch {
        throw new YahooSyncError(
          "PERSISTENCE_FAILED",
          "Yahoo league failure could not be recorded",
        );
      }
      throw new YahooSyncError("PROVIDER_READ_FAILED", INCOMPLETE_ROSTER_MESSAGE, {
        retryable: true,
        leagueFailure: failure,
      });
    }
    if (
      bundle.league.externalId !== leagueKey ||
      (expectedLeague !== undefined && bundle.league.season !== expectedLeague.season)
    ) {
      throw new YahooSyncError("PROVIDER_READ_FAILED", "Yahoo league metadata changed during sync");
    }
    try {
      return await this.#repository.persistBundle(userId, connectionId, bundle);
    } catch (error) {
      if (error instanceof YahooSyncError) throw error;
      throw new YahooSyncError("PERSISTENCE_FAILED", "Yahoo league data could not be committed");
    }
  }
}

export type YahooSyncPort = Pick<
  YahooSyncService,
  "listConnections" | "disconnectConnection" | "discoverAndSync" | "syncLeague"
>;
