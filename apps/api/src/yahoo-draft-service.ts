import { createHash } from "node:crypto";

import {
  MAX_YAHOO_RETRY_AFTER_MS,
  MAX_YAHOO_DRAFT_PLAYER_KEYS,
  YahooFantasyReadClient,
  YahooReadClientError,
  YahooTokenClientError,
  YahooXmlError,
  parseYahooDraftPlayersXml,
  parseYahooDraftResultsXml,
  type YahooDraftPlayer,
  type YahooDraftResultsSnapshot,
  type YahooXmlArtifact,
} from "@laces-out/connector-yahoo";
import {
  yahooDraftIssueCodeSchema,
  type DraftProviderFeedStatus,
  type YahooDraftFeedStatus,
  type YahooDraftIssueCode,
} from "@laces-out/contracts";
import {
  draftEvents,
  drafts,
  fantasyTeams,
  leagues,
  leagueSeasons,
  playerExternalIds,
  providerConnections,
  providerLeagueLinks,
  yahooDraftPollFeeds,
  yahooDraftPollObservations,
  type Database,
  type YahooDraftPollObservationResult,
} from "@laces-out/db";
import { reduceDraft, type DraftEvent } from "@laces-out/engine-draft";
import { and, asc, desc, eq, inArray, isNull, lte, max, ne, or, sql } from "drizzle-orm";

import type {
  DraftSessionEventRecord,
  DraftSessionSnapshot,
  PendingDraftEvent,
  ProviderFeedStatusSource,
} from "./draft-session.js";
import { ProviderPlayerResolver } from "./espn-live-draft-identity.js";
import { YahooConnectionError } from "./yahoo-connection.js";
import {
  reconcileYahooDraftSnapshot,
  type YahooDraftReconciliationIssueCode,
  type YahooDraftReconciliationResult,
} from "./yahoo-draft-reconciler.js";
import {
  YAHOO_DRAFT_PREREGISTRATION_CHECKSUM,
  YAHOO_DRAFT_RELEASE,
} from "./yahoo-draft-release.js";

export const YAHOO_DRAFT_ACTIVE_POLL_INTERVAL_SECONDS = 15;
export const YAHOO_DRAFT_WAITING_POLL_INTERVAL_SECONDS = 60;
const YAHOO_DRAFT_POLL_LEASE_SECONDS = 45;
const YAHOO_DRAFT_MAX_BACKOFF_SECONDS = MAX_YAHOO_RETRY_AFTER_MS / 1_000;

export interface YahooDraftTokenPort {
  getAccessToken(
    userId: string,
    connectionId: string,
    options?: { readonly forceRefresh?: boolean; readonly minimumValiditySeconds?: number },
  ): Promise<string>;
}

export interface YahooDraftReadPort {
  getLeagueDraftResults(
    request: { readonly accessToken: string; readonly signal?: AbortSignal },
    leagueKey: string,
  ): Promise<YahooXmlArtifact>;
  getLeaguePlayersByKeys(
    request: { readonly accessToken: string; readonly signal?: AbortSignal },
    leagueKey: string,
    playerKeys: readonly string[],
  ): Promise<YahooXmlArtifact>;
}

export interface YahooDraftSessionPort {
  getSession(userId: string, draftId: string): Promise<DraftSessionSnapshot>;
}

interface ClaimedYahooPoll {
  readonly feedId: string;
  readonly draftId: string;
  readonly leagueSeasonId: string;
  readonly providerLeagueKey: string;
  readonly season: number;
  readonly format: "snake" | "auction";
  readonly applicationMode: "shadow" | "append";
  readonly releaseArtifactChecksum: string;
  readonly standardScopeConfirmed: boolean;
  readonly generation: number;
  readonly previousChecksum: string | null;
}

interface YahooConnectionTarget {
  readonly connectionId: string;
  readonly userId: string;
}

type YahooDraftPollFailureClass =
  | "connection-unavailable"
  | "rate-limited"
  | "authentication"
  | "invalid-response"
  | "transport"
  | "token";

interface CommitYahooObservationInput {
  readonly claim: ClaimedYahooPoll;
  readonly connectionId: string;
  readonly expectedSequence: number;
  readonly resultingDraftState: "live" | "complete";
  readonly snapshot: YahooDraftResultsSnapshot;
  readonly reconciliation: YahooDraftReconciliationResult;
  readonly checkedAt: Date;
  readonly pollIntervalSeconds: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function publicIssue(value: string | null): YahooDraftIssueCode | null {
  const parsed = yahooDraftIssueCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function publicState(
  state: typeof yahooDraftPollFeeds.$inferSelect.state,
): YahooDraftFeedStatus["state"] {
  switch (state) {
    case "waiting":
      return "waiting";
    case "drafting":
      return "live";
    case "complete":
      return "complete";
    case "delayed":
      return "stale";
    case "attention":
    case "disabled":
      return "degraded";
  }
}

function secondsBetween(later: Date, earlier: Date | null): number | null {
  return earlier === null ? null : Math.max(0, (later.getTime() - earlier.getTime()) / 1000);
}

function effectivePollIntervalSeconds(feed: typeof yahooDraftPollFeeds.$inferSelect): number {
  if (feed.state === "drafting") return YAHOO_DRAFT_ACTIVE_POLL_INTERVAL_SECONDS;
  if (feed.lastCheckedAt === null) return YAHOO_DRAFT_WAITING_POLL_INTERVAL_SECONDS;
  const scheduled = Math.ceil((feed.nextPollAt.getTime() - feed.lastCheckedAt.getTime()) / 1_000);
  if (!Number.isFinite(scheduled)) return YAHOO_DRAFT_WAITING_POLL_INTERVAL_SECONDS;
  return Math.max(
    YAHOO_DRAFT_WAITING_POLL_INTERVAL_SECONDS,
    Math.min(YAHOO_DRAFT_MAX_BACKOFF_SECONDS, scheduled),
  );
}

function normalizedObservation(snapshot: YahooDraftResultsSnapshot): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: "yahoo",
    leagueKey: snapshot.leagueKey,
    status: snapshot.status,
    providerStatus: snapshot.providerStatus,
    declaredCount: snapshot.declaredCount,
    observedCount: snapshot.observedCount,
    collectionComplete: snapshot.collectionComplete,
    refreshRateSeconds: snapshot.refreshRateSeconds,
    picks: snapshot.picks.map((pick) => ({
      pick: pick.pick,
      round: pick.round,
      teamKey: pick.teamKey,
      playerKey: pick.playerKey,
      cost: pick.cost,
      keeper: pick.keeper,
    })),
  };
}

function eventPayload(event: DraftEvent): Record<string, unknown> {
  const payload = jsonRecord(event);
  delete payload.occurredAt;
  return payload;
}

function activeEvents(records: readonly DraftSessionEventRecord[]): readonly DraftEvent[] {
  const reverted = new Set(
    records.flatMap((record) =>
      record.event.type === "DRAFT_EVENT_REVERTED" ? [record.event.targetEventId] : [],
    ),
  );
  return records
    .map((record) => record.event)
    .filter((event) => event.type !== "DRAFT_EVENT_REVERTED" && !reverted.has(event.id));
}

function hasRevertedYahooAcquisition(records: readonly DraftSessionEventRecord[]): boolean {
  const yahooAcquisitionIds = new Set(
    records.flatMap((record) =>
      record.source === "yahoo" &&
      (record.event.type === "SNAKE_PLAYER_SELECTED" || record.event.type === "AUCTION_PLAYER_SOLD")
        ? [record.event.id]
        : [],
    ),
  );
  return records.some(
    (record) =>
      record.event.type === "DRAFT_EVENT_REVERTED" &&
      yahooAcquisitionIds.has(record.event.targetEventId),
  );
}

function mappedIssueCounts(issue: YahooDraftReconciliationIssueCode | null): {
  readonly unresolvedTeams: number;
  readonly unresolvedPlayers: number;
} {
  return {
    unresolvedTeams: issue === "UNRESOLVED_TEAM" ? 1 : 0,
    unresolvedPlayers: issue === "UNRESOLVED_PLAYER" ? 1 : 0,
  };
}

function failureClass(error: unknown): YahooDraftPollFailureClass {
  if (error instanceof YahooReadClientError) {
    if (error.code === "RATE_LIMITED") return "rate-limited";
    if (error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN") {
      return "authentication";
    }
    if (
      error.code === "INVALID_RESPONSE" ||
      error.code === "REDIRECT" ||
      error.code === "TOO_LARGE" ||
      error.code === "UNSUPPORTED_CONTENT_TYPE"
    ) {
      return "invalid-response";
    }
    return "transport";
  }
  if (error instanceof YahooXmlError) return "invalid-response";
  if (error instanceof YahooTokenClientError || error instanceof YahooConnectionError) {
    return "token";
  }
  return "transport";
}

function boundedRetryAfterMs(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null;
  return Math.min(value, MAX_YAHOO_RETRY_AFTER_MS);
}

export class DrizzleYahooDraftPollRepository implements ProviderFeedStatusSource {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async loadFeedStatus(draftId: string): Promise<DraftProviderFeedStatus | undefined> {
    const [feed] = await this.#database
      .select()
      .from(yahooDraftPollFeeds)
      .where(eq(yahooDraftPollFeeds.draftId, draftId))
      .limit(1);
    if (!feed) return undefined;
    const ageSeconds = secondsBetween(this.#now(), feed.lastSuccessfulAt);
    const pollIntervalSeconds = effectivePollIntervalSeconds(feed);
    const admitted =
      feed.applicationMode === "append" &&
      feed.releaseArtifactChecksum === YAHOO_DRAFT_PREREGISTRATION_CHECKSUM &&
      YAHOO_DRAFT_RELEASE[feed.format].state === "append-beta";
    return {
      provider: "yahoo",
      state: publicState(feed.state),
      providerLeagueId: feed.providerLeagueKey,
      season: feed.season,
      fresh: ageSeconds !== null && ageSeconds <= pollIntervalSeconds * 2 + 30,
      ageSeconds,
      lastAcceptedAt: feed.lastSuccessfulAt?.toISOString() ?? null,
      lastMaterialEventAt: feed.lastMaterialEventAt?.toISOString() ?? null,
      pickCount: feed.lastObservedCount,
      unresolvedTeams: feed.unresolvedTeams,
      unresolvedPlayers: feed.unresolvedPlayers,
      manualBackupActive: false,
      pendingReconciliation: 0,
      standbySources: 0,
      verification: feed.verification,
      lastIssueCode: publicIssue(feed.lastIssueCode),
      currentAuction: null,
      applicationMode: admitted ? "append" : "shadow",
      releaseState: admitted ? "append-beta" : "shadow-only",
      pollIntervalSeconds,
    };
  }

  async claimPoll(draftId: string, now: Date): Promise<ClaimedYahooPoll | undefined> {
    const leaseExpiresAt = new Date(now.getTime() + YAHOO_DRAFT_POLL_LEASE_SECONDS * 1000);
    const nextPollAt = new Date(now.getTime() + YAHOO_DRAFT_ACTIVE_POLL_INTERVAL_SECONDS * 1000);
    const [feed] = await this.#database
      .update(yahooDraftPollFeeds)
      .set({
        pollGeneration: sql<number>`${yahooDraftPollFeeds.pollGeneration} + 1`,
        pollLeaseExpiresAt: leaseExpiresAt,
        nextPollAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(yahooDraftPollFeeds.draftId, draftId),
          ne(yahooDraftPollFeeds.state, "complete"),
          ne(yahooDraftPollFeeds.state, "disabled"),
          lte(yahooDraftPollFeeds.nextPollAt, now),
          or(
            isNull(yahooDraftPollFeeds.pollLeaseExpiresAt),
            lte(yahooDraftPollFeeds.pollLeaseExpiresAt, now),
          ),
        ),
      )
      .returning();
    if (!feed || feed.draftId === null) return undefined;
    return {
      feedId: feed.id,
      draftId: feed.draftId,
      leagueSeasonId: feed.leagueSeasonId,
      providerLeagueKey: feed.providerLeagueKey,
      season: feed.season,
      format: feed.format,
      applicationMode: feed.applicationMode,
      releaseArtifactChecksum: feed.releaseArtifactChecksum,
      standardScopeConfirmed: feed.standardScopeConfirmed,
      generation: feed.pollGeneration,
      previousChecksum: feed.lastChecksum,
    };
  }

  async connectionForLeague(
    leagueSeasonId: string,
    now: Date,
  ): Promise<YahooConnectionTarget | undefined> {
    const [connection] = await this.#database
      .select({
        connectionId: providerConnections.id,
        userId: providerConnections.userId,
      })
      .from(providerLeagueLinks)
      .innerJoin(providerConnections, eq(providerLeagueLinks.connectionId, providerConnections.id))
      .where(
        and(
          eq(providerLeagueLinks.leagueSeasonId, leagueSeasonId),
          eq(providerConnections.provider, "yahoo"),
          eq(providerConnections.health, "healthy"),
          or(
            isNull(providerConnections.circuitOpenUntil),
            lte(providerConnections.circuitOpenUntil, now),
          ),
        ),
      )
      .orderBy(desc(providerConnections.lastSuccessfulAt), asc(providerConnections.createdAt))
      .limit(1);
    return connection;
  }

  async releaseClaim(claim: ClaimedYahooPoll, checkedAt: Date): Promise<void> {
    await this.#database
      .update(yahooDraftPollFeeds)
      .set({
        pollLeaseExpiresAt: null,
        nextPollAt: new Date(
          checkedAt.getTime() + YAHOO_DRAFT_WAITING_POLL_INTERVAL_SECONDS * 1000,
        ),
        updatedAt: checkedAt,
      })
      .where(
        and(
          eq(yahooDraftPollFeeds.id, claim.feedId),
          eq(yahooDraftPollFeeds.pollGeneration, claim.generation),
        ),
      );
  }

  async teamMappings(leagueSeasonId: string): Promise<ReadonlyMap<string, string>> {
    const rows = await this.#database
      .select({ key: fantasyTeams.externalKey, id: fantasyTeams.id })
      .from(fantasyTeams)
      .where(eq(fantasyTeams.leagueSeasonId, leagueSeasonId));
    return new Map(rows.map((row) => [row.key, row.id]));
  }

  async playerMappings(playerKeys: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (playerKeys.length === 0) return new Map();
    const rows = await this.#database
      .select({ key: playerExternalIds.externalId, id: playerExternalIds.playerId })
      .from(playerExternalIds)
      .where(
        and(
          eq(playerExternalIds.source, "yahoo"),
          eq(playerExternalIds.verified, true),
          inArray(playerExternalIds.externalId, [...playerKeys]),
        ),
      );
    return new Map(rows.map((row) => [row.key, row.id]));
  }

  async persistPlayerMappings(
    season: number,
    mappings: ReadonlyMap<string, string>,
  ): Promise<ReadonlyMap<string, string>> {
    for (const [externalId, playerId] of mappings) {
      await this.#database
        .insert(playerExternalIds)
        .values({
          playerId,
          source: "yahoo",
          externalId,
          season,
          confidence: "1",
          verified: true,
        })
        .onConflictDoNothing();
    }
    return this.playerMappings([...mappings.keys()]);
  }

  async recordFailure(input: {
    readonly claim: ClaimedYahooPoll;
    readonly connectionId: string | null;
    readonly issue: "PROVIDER_UNAVAILABLE" | "POLL_FAILED";
    readonly failureClass: YahooDraftPollFailureClass;
    readonly checkedAt: Date;
    readonly retryAfterMs?: number | null;
  }): Promise<void> {
    const [current] = await this.#database
      .select({ failures: yahooDraftPollFeeds.consecutiveFailures })
      .from(yahooDraftPollFeeds)
      .where(eq(yahooDraftPollFeeds.id, input.claim.feedId))
      .limit(1);
    const failures = (current?.failures ?? 0) + 1;
    const exponentialBackoff = Math.min(
      YAHOO_DRAFT_MAX_BACKOFF_SECONDS,
      YAHOO_DRAFT_WAITING_POLL_INTERVAL_SECONDS * 2 ** Math.min(failures - 1, 4),
    );
    const retryAfterMs = boundedRetryAfterMs(input.retryAfterMs);
    const retryAfterSeconds = Math.ceil((retryAfterMs ?? 0) / 1000);
    const backoffSeconds = Math.max(exponentialBackoff, retryAfterSeconds);
    const checksum = sha256(
      JSON.stringify(["yahoo-draft-poll-failure-v1", input.claim.generation, input.issue]),
    );
    await this.#database.transaction(async (transaction) => {
      // Draft mutations lock draft -> feed. Use the same order here so publishing a provider-only
      // status change cannot deadlock with a commissioner recording a manual pick.
      await transaction.execute(
        sql`select id from drafts where id = ${input.claim.draftId} for update`,
      );
      const [feed] = await transaction
        .select({ generation: yahooDraftPollFeeds.pollGeneration })
        .from(yahooDraftPollFeeds)
        .where(eq(yahooDraftPollFeeds.id, input.claim.feedId))
        .for("update")
        .limit(1);
      if (!feed || feed.generation !== input.claim.generation) return;
      await transaction.insert(yahooDraftPollObservations).values({
        feedId: input.claim.feedId,
        connectionId: input.connectionId,
        pollGeneration: input.claim.generation,
        checkedAt: input.checkedAt,
        providerStatus: "unavailable",
        declaredCount: null,
        observedCount: 0,
        checksum,
        normalizedPayload: {
          schemaVersion: 1,
          provider: "yahoo",
          outcome: "failed",
          failureClass: input.failureClass,
          retryAfterSeconds: retryAfterMs === null ? null : retryAfterSeconds,
          effectiveBackoffSeconds: backoffSeconds,
        },
        result: "failed",
        issueCode: input.issue,
        appliedEvents: 0,
      });
      await transaction
        .update(yahooDraftPollFeeds)
        .set({
          state: "delayed",
          pollLeaseExpiresAt: null,
          nextPollAt: new Date(input.checkedAt.getTime() + backoffSeconds * 1000),
          lastCheckedAt: input.checkedAt,
          consecutiveFailures: failures,
          lastIssueCode: input.issue,
          updatedAt: input.checkedAt,
        })
        .where(eq(yahooDraftPollFeeds.id, input.claim.feedId));
      // Shadow observations do not advance the event sequence. Advance the room timestamp so a
      // same-sequence browser response can still publish this delayed/degraded feed state.
      await transaction
        .update(drafts)
        .set({
          updatedAt: sql<Date>`greatest(${drafts.updatedAt} + interval '1 millisecond', ${input.checkedAt.toISOString()}::timestamptz)`,
        })
        .where(eq(drafts.id, input.claim.draftId));
      if (input.failureClass === "rate-limited" && input.connectionId !== null) {
        const circuitOpenUntil = new Date(input.checkedAt.getTime() + backoffSeconds * 1000);
        const circuitOpenUntilIso = circuitOpenUntil.toISOString();
        await transaction
          .update(providerConnections)
          .set({
            circuitOpenUntil: sql<Date>`case
              when ${providerConnections.circuitOpenUntil} is null
                or ${providerConnections.circuitOpenUntil} < ${circuitOpenUntilIso}::timestamptz
              then ${circuitOpenUntilIso}::timestamptz
              else ${providerConnections.circuitOpenUntil}
            end`,
            lastErrorCode: "YAHOO_DRAFT_RATE_LIMITED",
            lastErrorAt: input.checkedAt,
            updatedAt: input.checkedAt,
          })
          .where(
            and(
              eq(providerConnections.id, input.connectionId),
              eq(providerConnections.provider, "yahoo"),
            ),
          );
      }
    });
  }

  async commitObservation(input: CommitYahooObservationInput): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`yahoo-draft:${input.claim.feedId}`}, 0))`,
      );
      // Manual session mutations use the order draft -> Yahoo feed. Keep the same order here to
      // avoid a draft/feed lock inversion while a commissioner records a pick during a poll.
      await transaction.execute(
        sql`select id from drafts where id = ${input.claim.draftId} for update`,
      );
      const [draftScope] = await transaction
        .select({ archived: leagues.archived })
        .from(drafts)
        .innerJoin(leagueSeasons, eq(drafts.leagueSeasonId, leagueSeasons.id))
        .innerJoin(leagues, eq(leagueSeasons.leagueId, leagues.id))
        .where(eq(drafts.id, input.claim.draftId))
        .for("share", { of: leagues })
        .limit(1);
      if (!draftScope) return;
      const [feed] = await transaction
        .select()
        .from(yahooDraftPollFeeds)
        .where(eq(yahooDraftPollFeeds.id, input.claim.feedId))
        .for("update")
        .limit(1);
      if (!feed || feed.pollGeneration !== input.claim.generation) return;

      const [sequenceRow] = await transaction
        .select({ sequence: max(draftEvents.sequence) })
        .from(draftEvents)
        .where(eq(draftEvents.draftId, input.claim.draftId));
      const currentSequence = sequenceRow?.sequence ?? 0;
      const reconciliation = input.reconciliation;
      let concurrentLedgerChange = false;
      if (currentSequence !== input.expectedSequence) concurrentLedgerChange = true;

      let appliedEvents = 0;
      let observationResult: YahooDraftPollObservationResult;
      let issue: YahooDraftIssueCode | null = null;
      if (draftScope.archived) {
        observationResult = "held";
      } else if (concurrentLedgerChange) {
        observationResult = "held";
        issue = "CONCURRENT_LEDGER_CHANGE";
      } else if (reconciliation.kind === "held") {
        observationResult = "held";
        issue = reconciliation.issue;
      } else if (input.claim.applicationMode === "shadow") {
        observationResult = "shadow";
        issue = "RELEASE_SHADOW_ONLY";
      } else if (reconciliation.kind === "idempotent") {
        observationResult = "confirmed";
      } else {
        const pending: PendingDraftEvent[] = reconciliation.append.map((item, index) => ({
          sequence: currentSequence + index + 1,
          idempotencyKey: item.idempotencyKey,
          type: item.event.type,
          occurredAt: input.checkedAt,
          source: "yahoo",
          payload: eventPayload(item.event),
          revertsSequence: null,
        }));
        if (pending.length > 0) {
          await transaction.insert(draftEvents).values(
            pending.map((event) => ({
              draftId: input.claim.draftId,
              sequence: event.sequence,
              idempotencyKey: event.idempotencyKey,
              type: event.type,
              occurredAt: event.occurredAt,
              source: event.source,
              payload: event.payload,
              revertsSequence: null,
              createdAt: input.checkedAt,
            })),
          );
          await transaction
            .update(drafts)
            .set({ state: input.resultingDraftState, updatedAt: input.checkedAt })
            .where(eq(drafts.id, input.claim.draftId));
          appliedEvents = pending.length;
        }
        observationResult = appliedEvents > 0 ? "appended" : "idempotent";
      }

      const isChanged = feed.lastChecksum !== input.snapshot.checksumSha256;
      const observedNewPick = input.snapshot.observedCount > feed.lastObservedCount;
      const issueCounts = mappedIssueCounts(
        reconciliation.kind === "held" ? reconciliation.issue : null,
      );
      const providerState =
        input.snapshot.status === "predraft"
          ? "waiting"
          : input.snapshot.status === "postdraft"
            ? "complete"
            : input.snapshot.status === "drafting"
              ? "drafting"
              : "attention";
      const verification =
        !draftScope.archived &&
        input.snapshot.status === "postdraft" &&
        reconciliation.kind !== "held" &&
        !concurrentLedgerChange &&
        input.resultingDraftState === "complete" &&
        input.claim.applicationMode === "append"
          ? "verified"
          : reconciliation.kind === "held" &&
              (reconciliation.issue === "HISTORY_DIVERGED" ||
                reconciliation.issue === "HISTORY_TRUNCATED")
            ? "mismatched"
            : "pending";
      await transaction.insert(yahooDraftPollObservations).values({
        feedId: input.claim.feedId,
        connectionId: input.connectionId,
        pollGeneration: input.claim.generation,
        checkedAt: input.checkedAt,
        providerStatus: input.snapshot.providerStatus ?? input.snapshot.status,
        declaredCount: input.snapshot.declaredCount,
        observedCount: input.snapshot.observedCount,
        checksum: input.snapshot.checksumSha256,
        normalizedPayload: isChanged
          ? normalizedObservation(input.snapshot)
          : {
              schemaVersion: 1,
              provider: "yahoo",
              outcome: "unchanged",
              checksum: input.snapshot.checksumSha256,
            },
        result: observationResult,
        issueCode: issue,
        appliedEvents,
      });
      await transaction
        .update(yahooDraftPollFeeds)
        .set({
          state: draftScope.archived
            ? "disabled"
            : issue && issue !== "RELEASE_SHADOW_ONLY"
              ? "attention"
              : providerState,
          pollLeaseExpiresAt: null,
          nextPollAt: new Date(input.checkedAt.getTime() + input.pollIntervalSeconds * 1000),
          lastChecksum: input.snapshot.checksumSha256,
          lastProviderStatus: input.snapshot.providerStatus ?? input.snapshot.status,
          lastDeclaredCount: input.snapshot.declaredCount,
          lastObservedCount: input.snapshot.observedCount,
          lastCheckedAt: input.checkedAt,
          lastSuccessfulAt: input.checkedAt,
          lastChangedAt: isChanged ? input.checkedAt : feed.lastChangedAt,
          lastMaterialEventAt:
            appliedEvents > 0 || (input.claim.applicationMode === "shadow" && observedNewPick)
              ? input.checkedAt
              : feed.lastMaterialEventAt,
          consecutiveFailures: 0,
          unresolvedTeams: issueCounts.unresolvedTeams,
          unresolvedPlayers: issueCounts.unresolvedPlayers,
          verification,
          lastIssueCode: issue,
          updatedAt: input.checkedAt,
        })
        .where(eq(yahooDraftPollFeeds.id, input.claim.feedId));
      const checkedAtIso = input.checkedAt.toISOString();
      // A successful official read heals only connection failures that predate this poll. Preserve
      // any newer failure/cooldown recorded concurrently after the poll captured `checkedAt`.
      await transaction
        .update(providerConnections)
        .set({
          lastSuccessfulAt: sql<Date>`greatest(
            coalesce(${providerConnections.lastSuccessfulAt}, ${checkedAtIso}::timestamptz),
            ${checkedAtIso}::timestamptz
          )`,
          consecutiveFailures: sql<number>`case
            when ${providerConnections.lastErrorAt} is null
              or ${providerConnections.lastErrorAt} < ${checkedAtIso}::timestamptz
            then 0
            else ${providerConnections.consecutiveFailures}
          end`,
          circuitOpenUntil: sql<Date | null>`case
            when ${providerConnections.lastErrorAt} is null
              or ${providerConnections.lastErrorAt} < ${checkedAtIso}::timestamptz
            then null
            else ${providerConnections.circuitOpenUntil}
          end`,
          lastErrorCode: sql<string | null>`case
            when ${providerConnections.lastErrorAt} is null
              or ${providerConnections.lastErrorAt} < ${checkedAtIso}::timestamptz
            then null
            else ${providerConnections.lastErrorCode}
          end`,
          lastErrorAt: sql<Date | null>`case
            when ${providerConnections.lastErrorAt} is null
              or ${providerConnections.lastErrorAt} < ${checkedAtIso}::timestamptz
            then null
            else ${providerConnections.lastErrorAt}
          end`,
          lastErrorDetail: sql<string | null>`case
            when ${providerConnections.lastErrorAt} is null
              or ${providerConnections.lastErrorAt} < ${checkedAtIso}::timestamptz
            then null
            else ${providerConnections.lastErrorDetail}
          end`,
          updatedAt: sql<Date>`greatest(${providerConnections.updatedAt}, ${checkedAtIso}::timestamptz)`,
        })
        .where(
          and(
            eq(providerConnections.id, input.connectionId),
            eq(providerConnections.provider, "yahoo"),
          ),
        );
      // Feed-only observations—including every shadow-mode pick and completion—still need a room
      // revision. Otherwise the browser's race guard retains its same-sequence stale feed forever.
      await transaction
        .update(drafts)
        .set({
          updatedAt: sql<Date>`greatest(${drafts.updatedAt} + interval '1 millisecond', ${checkedAtIso}::timestamptz)`,
        })
        .where(eq(drafts.id, input.claim.draftId));
    });
  }
}

/**
 * Official Yahoo reads with strict, append-only reconciliation. Calling this more often than the
 * configured cadence is cheap: the database lease returns no claim and no provider request occurs.
 */
export class YahooDraftPollService {
  readonly #repository: DrizzleYahooDraftPollRepository;
  readonly #sessions: YahooDraftSessionPort;
  readonly #tokens: YahooDraftTokenPort;
  readonly #client: YahooDraftReadPort;
  readonly #now: () => Date;

  constructor(input: {
    readonly repository: DrizzleYahooDraftPollRepository;
    readonly sessions: YahooDraftSessionPort;
    readonly tokens: YahooDraftTokenPort;
    readonly client?: YahooDraftReadPort;
    readonly now?: () => Date;
  }) {
    this.#repository = input.repository;
    this.#sessions = input.sessions;
    this.#tokens = input.tokens;
    this.#client = input.client ?? new YahooFantasyReadClient();
    this.#now = input.now ?? (() => new Date());
  }

  async refresh(userId: string, draftId: string): Promise<DraftSessionSnapshot> {
    const session = await this.#sessions.getSession(userId, draftId);
    if (session.transport !== "yahoo-assisted" || session.providerFeed?.provider !== "yahoo") {
      return session;
    }
    const checkedAt = this.#now();
    const storedClaim = await this.#repository.claimPoll(draftId, checkedAt);
    if (!storedClaim) return session;
    const admitted =
      storedClaim.applicationMode === "append" &&
      storedClaim.releaseArtifactChecksum === YAHOO_DRAFT_PREREGISTRATION_CHECKSUM &&
      YAHOO_DRAFT_RELEASE[storedClaim.format].state === "append-beta";
    const claim: ClaimedYahooPoll = {
      ...storedClaim,
      applicationMode: admitted ? "append" : "shadow",
    };
    const connection = await this.#repository.connectionForLeague(claim.leagueSeasonId, checkedAt);
    if (!connection) {
      await this.#repository.recordFailure({
        claim,
        connectionId: null,
        issue: "PROVIDER_UNAVAILABLE",
        failureClass: "connection-unavailable",
        checkedAt,
      });
      return this.#sessions.getSession(userId, draftId);
    }

    try {
      const snapshot = await this.#withToken(connection, (accessToken) =>
        this.#client.getLeagueDraftResults({ accessToken }, claim.providerLeagueKey),
      ).then((artifact) =>
        parseYahooDraftResultsXml(artifact.xml, {
          expectedLeagueKey: claim.providerLeagueKey,
        }),
      );
      const teamIdByKey = await this.#repository.teamMappings(claim.leagueSeasonId);
      const playerKeys = [...new Set(snapshot.picks.map((pick) => pick.playerKey))];
      let playerIdByKey = await this.#repository.playerMappings(playerKeys);
      const unknownPlayerKeys = playerKeys.filter((key) => !playerIdByKey.has(key));
      if (unknownPlayerKeys.length > 0) {
        // One bounded identity page keeps a normal poll inside its lease. A large first snapshot
        // catches up over several checks; no picks are admitted until every observed key is exact.
        const keys = unknownPlayerKeys.slice(0, MAX_YAHOO_DRAFT_PLAYER_KEYS);
        const metadataArtifact = await this.#withToken(connection, (accessToken) =>
          this.#client.getLeaguePlayersByKeys({ accessToken }, claim.providerLeagueKey, keys),
        );
        const metadata = parseYahooDraftPlayersXml(metadataArtifact.xml, {
          expectedLeagueKey: claim.providerLeagueKey,
          expectedPlayerKeys: keys,
        }).players;
        const resolved = this.#resolvePlayers(session, metadata);
        if (resolved.size > 0) {
          const persisted = await this.#repository.persistPlayerMappings(claim.season, resolved);
          playerIdByKey = new Map([...playerIdByKey, ...persisted]);
        }
      }
      const expectedPickCount =
        session.config.mode === "SNAKE"
          ? session.config.pickOrder.length
          : session.config.teams.reduce((sum, team) => sum + team.rosterSlots.length, 0);
      const completedTeamCount = new Set(snapshot.picks.map((pick) => pick.teamKey)).size;
      const reconciliation: YahooDraftReconciliationResult = hasRevertedYahooAcquisition(
        session.events,
      )
        ? {
            kind: "held",
            issue: "HISTORY_DIVERGED",
            detail:
              "A Yahoo-authored acquisition was manually reverted, so it cannot be reapplied automatically.",
            append: [],
          }
        : snapshot.status === "unknown"
          ? {
              kind: "held",
              issue: "PROVIDER_STATUS_UNSUPPORTED",
              detail: "Yahoo returned an unrecognized draft status.",
              append: [],
            }
          : snapshot.status === "postdraft" &&
              snapshot.collectionComplete &&
              snapshot.observedCount !== expectedPickCount
            ? {
                kind: "held",
                issue: "COMPLETED_COUNT_MISMATCH",
                detail: "Yahoo's completed result did not fill the configured draft room.",
                append: [],
              }
            : snapshot.status === "postdraft" &&
                snapshot.collectionComplete &&
                completedTeamCount !== session.config.teams.length
              ? {
                  kind: "held",
                  issue: "TEAM_COUNT_MISMATCH",
                  detail: "Yahoo's completed result did not include every configured team.",
                  append: [],
                }
              : reconcileYahooDraftSnapshot({
                  feedId: claim.feedId,
                  draftId: claim.draftId,
                  draftMode: claim.format,
                  config: session.config,
                  snapshot,
                  teamIdByKey,
                  playerIdByKey,
                  activeEvents: activeEvents(session.events),
                  standardScopeConfirmed: claim.standardScopeConfirmed,
                  occurredAt: checkedAt,
                });
      const candidateEvents = [
        ...activeEvents(session.events),
        ...(claim.applicationMode === "append" && reconciliation.kind === "append"
          ? reconciliation.append.map((item) => item.event)
          : []),
      ];
      const resultingDraftState = reduceDraft(session.config, candidateEvents).complete
        ? "complete"
        : "live";
      const refreshHint = snapshot.refreshRateSeconds ?? YAHOO_DRAFT_WAITING_POLL_INTERVAL_SECONDS;
      // Yahoo's response hint remains the floor while waiting. During an actual draft we make a
      // narrowly scoped faster check; one shared DB lease still caps the entire league, and any
      // throttle response immediately enters the exponential backoff path.
      const pollIntervalSeconds =
        snapshot.status === "drafting" && reconciliation.kind !== "held"
          ? YAHOO_DRAFT_ACTIVE_POLL_INTERVAL_SECONDS
          : Math.max(YAHOO_DRAFT_WAITING_POLL_INTERVAL_SECONDS, Math.min(refreshHint, 15 * 60));
      await this.#repository.commitObservation({
        claim,
        connectionId: connection.connectionId,
        expectedSequence: session.sequence,
        resultingDraftState,
        snapshot,
        reconciliation,
        checkedAt,
        pollIntervalSeconds,
      });
    } catch (error) {
      const expectedProviderFailure =
        error instanceof YahooReadClientError ||
        error instanceof YahooTokenClientError ||
        error instanceof YahooConnectionError ||
        error instanceof YahooXmlError;
      if (!expectedProviderFailure) {
        await this.#repository.releaseClaim(claim, checkedAt);
        throw error;
      }
      await this.#repository.recordFailure({
        claim,
        connectionId: connection.connectionId,
        issue: "POLL_FAILED",
        failureClass: failureClass(error),
        checkedAt,
        retryAfterMs:
          error instanceof YahooReadClientError ? boundedRetryAfterMs(error.retryAfterMs) : null,
      });
      // The public feed carries a bounded reason. Provider responses, OAuth material, and raw XML
      // must never be reflected through the route or stored as an error detail.
    }
    return this.#sessions.getSession(userId, draftId);
  }

  #resolvePlayers(
    session: DraftSessionSnapshot,
    metadata: readonly YahooDraftPlayer[],
  ): ReadonlyMap<string, string> {
    const resolver = new ProviderPlayerResolver(
      session.config.players.map((player) => ({
        id: player.id,
        name: player.name,
        positions: player.positions,
        nflTeam: player.nflTeam ?? null,
      })),
      new Map(),
    );
    const resolved = new Map<string, string>();
    for (const player of metadata) {
      const match = resolver.resolve({
        providerPlayerId: null,
        playerName: player.fullName,
        proTeam: player.proTeamAbbreviation,
        position: player.primaryPosition,
      });
      if (match.status === "resolved") resolved.set(player.playerKey, match.id);
    }
    return resolved;
  }

  async #withToken<T>(
    connection: YahooConnectionTarget,
    read: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    let accessToken = await this.#tokens.getAccessToken(
      connection.userId,
      connection.connectionId,
      { minimumValiditySeconds: 120 },
    );
    try {
      return await read(accessToken);
    } catch (error) {
      if (!(error instanceof YahooReadClientError) || !error.refreshAccessToken) throw error;
      accessToken = await this.#tokens.getAccessToken(connection.userId, connection.connectionId, {
        forceRefresh: true,
        minimumValiditySeconds: 120,
      });
      return read(accessToken);
    }
  }
}
