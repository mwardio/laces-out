import { createHash } from "node:crypto";

import {
  EspnSessionReadClient,
  EspnSessionReadError,
  EspnSupplementalNormalizationError,
  normalizeEspnSupplementalSnapshot,
  type EspnSessionCredential,
  type EspnSessionSupplementalArtifact,
} from "@laces-out/connector-espn";
import type { EspnLiveDraftIssueCode } from "@laces-out/contracts";
import {
  draftEvents,
  draftProviderFeeds,
  drafts,
  fantasyTeams,
  playerExternalIds,
  players,
  providerConnections,
  providerLeagueLinks,
  type Database,
  type DraftProviderFeedState,
} from "@laces-out/db";
import { reduceDraft, type DraftEvent } from "@laces-out/engine-draft";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, max, ne, or, sql } from "drizzle-orm";

import type { DraftSessionSnapshot } from "./draft-session.js";
import {
  ESPN_SELF_ASSERTED_PLAYER_SOURCE,
  espnSelfAssertedPlayerKey,
} from "./espn-sync-persistence.js";
import {
  reconcileProviderObservation,
  type ProviderDraftAction,
  type ProviderPendingEvent,
} from "./espn-live-draft-reconciler.js";

export const ESPN_DRAFT_ACTIVE_POLL_INTERVAL_SECONDS = 5;
export const ESPN_DRAFT_PREDRAFT_POLL_INTERVAL_SECONDS = 15;
const ESPN_DRAFT_POLL_LEASE_SECONDS = 20;
const ESPN_DRAFT_POLL_START_EARLY_MS = 5 * 60_000;
const ESPN_DRAFT_MAX_BACKOFF_SECONDS = 5 * 60;
const ESPN_BROWSER_FRESH_MS = 30_000;

export interface EspnDraftSessionPort {
  getSession(userId: string, draftId: string): Promise<DraftSessionSnapshot>;
}

export interface EspnDraftCredentialPort {
  getSession(userId: string, connectionId: string): Promise<EspnSessionCredential>;
}

export interface EspnDraftReadPort {
  fetchCompletedDraft(input: {
    readonly credential: EspnSessionCredential;
    readonly leagueId: string;
    readonly season: number;
    readonly signal?: AbortSignal;
  }): Promise<EspnSessionSupplementalArtifact>;
}

export interface EspnDraftPollClaim {
  readonly feedId: string;
  readonly draftId: string;
  readonly leagueSeasonId: string;
  readonly providerLeagueId: string;
  readonly season: number;
  readonly generation: number;
  readonly previousChecksum: string | null;
  readonly pendingDestructiveChecksum: string | null;
  readonly pendingDestructiveSeenCount: number;
  readonly manualBackupActive: boolean;
}

interface EspnDraftConnectionTarget {
  readonly connectionId: string;
  readonly userId: string;
}

export interface CommitServerPollInput {
  readonly claim: EspnDraftPollClaim;
  readonly expectedSequence: number;
  readonly expectedManualBackupActive: boolean;
  readonly append: readonly ProviderPendingEvent[];
  readonly feedState: DraftProviderFeedState;
  readonly resultingDraftState: "created" | "live" | "complete";
  readonly checksum: string;
  readonly pickCount: number;
  readonly issue: EspnLiveDraftIssueCode | null;
  readonly unresolvedTeams: number;
  readonly unresolvedPlayers: number;
  readonly pendingDestructiveChecksum: string | null;
  readonly pendingDestructiveSeenCount: number;
  readonly nextPollAt: Date;
  readonly checkedAt: Date;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function eventPayload(event: DraftEvent): Record<string, unknown> {
  const payload = jsonRecord(event);
  delete payload.occurredAt;
  return payload;
}

function eventIdFor(draftId: string, key: string): string {
  return `espn:${createHash("sha256").update(`${draftId}\0${key}`).digest("hex")}`;
}

function teamProviderId(externalKey: string): string | null {
  const match = /:team:(\d{1,20})$/u.exec(externalKey);
  return match?.[1] ?? null;
}

function nextPollAt(
  snapshot: Extract<
    ReturnType<typeof normalizeEspnSupplementalSnapshot>,
    { kind: "completed-draft" }
  >,
  now: Date,
): Date {
  if (snapshot.state === "in-progress") {
    return new Date(now.getTime() + ESPN_DRAFT_ACTIVE_POLL_INTERVAL_SECONDS * 1_000);
  }
  if (snapshot.state === "complete") return now;
  const scheduledAt = snapshot.scheduledAt === null ? null : new Date(snapshot.scheduledAt);
  if (scheduledAt && Number.isFinite(scheduledAt.getTime())) {
    const activeWindow = scheduledAt.getTime() - ESPN_DRAFT_POLL_START_EARLY_MS;
    if (now.getTime() < activeWindow) return new Date(activeWindow);
  }
  return new Date(now.getTime() + ESPN_DRAFT_PREDRAFT_POLL_INTERVAL_SECONDS * 1_000);
}

function feedStateFor(state: "predraft" | "in-progress" | "complete"): DraftProviderFeedState {
  return state === "predraft" ? "waiting" : state === "complete" ? "complete" : "live";
}

function activeEvents(session: DraftSessionSnapshot): readonly DraftEvent[] {
  return session.events.map((record) => record.event);
}

export class DrizzleEspnDraftPollRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async duePolls(now: Date, limit = 8): Promise<readonly { userId: string; draftId: string }[]> {
    return this.#database
      .select({ userId: providerConnections.userId, draftId: draftProviderFeeds.draftId })
      .from(draftProviderFeeds)
      .innerJoin(drafts, eq(drafts.id, draftProviderFeeds.draftId))
      .innerJoin(
        providerLeagueLinks,
        eq(providerLeagueLinks.leagueSeasonId, draftProviderFeeds.leagueSeasonId),
      )
      .innerJoin(providerConnections, eq(providerConnections.id, providerLeagueLinks.connectionId))
      .where(
        and(
          eq(draftProviderFeeds.provider, "espn"),
          ne(draftProviderFeeds.state, "complete"),
          lte(draftProviderFeeds.serverNextPollAt, now),
          or(
            isNull(draftProviderFeeds.serverPollLeaseExpiresAt),
            lte(draftProviderFeeds.serverPollLeaseExpiresAt, now),
          ),
          eq(providerConnections.provider, "espn"),
          inArray(providerConnections.health, ["pending", "healthy", "degraded"]),
          isNotNull(providerConnections.encryptedCredential),
          or(
            isNull(providerConnections.circuitOpenUntil),
            lte(providerConnections.circuitOpenUntil, now),
          ),
          sql`${drafts.settings}->>'transport' = 'espn-live'`,
        ),
      )
      .orderBy(asc(draftProviderFeeds.serverNextPollAt), desc(providerConnections.lastSuccessfulAt))
      .limit(limit);
  }

  async claimPoll(draftId: string, now: Date): Promise<EspnDraftPollClaim | undefined> {
    const [feed] = await this.#database
      .update(draftProviderFeeds)
      .set({
        serverPollGeneration: sql<number>`${draftProviderFeeds.serverPollGeneration} + 1`,
        serverPollLeaseExpiresAt: new Date(now.getTime() + ESPN_DRAFT_POLL_LEASE_SECONDS * 1_000),
        serverNextPollAt: new Date(now.getTime() + ESPN_DRAFT_ACTIVE_POLL_INTERVAL_SECONDS * 1_000),
        updatedAt: now,
      })
      .where(
        and(
          eq(draftProviderFeeds.draftId, draftId),
          ne(draftProviderFeeds.state, "complete"),
          lte(draftProviderFeeds.serverNextPollAt, now),
          or(
            isNull(draftProviderFeeds.serverPollLeaseExpiresAt),
            lte(draftProviderFeeds.serverPollLeaseExpiresAt, now),
          ),
        ),
      )
      .returning();
    if (!feed) return undefined;
    return {
      feedId: feed.id,
      draftId: feed.draftId,
      leagueSeasonId: feed.leagueSeasonId,
      providerLeagueId: feed.providerLeagueId,
      season: feed.season,
      generation: feed.serverPollGeneration,
      previousChecksum: feed.serverLastChecksum,
      pendingDestructiveChecksum: feed.serverPendingDestructiveChecksum,
      pendingDestructiveSeenCount: feed.serverPendingDestructiveSeenCount,
      manualBackupActive: feed.manualBackupActive,
    };
  }

  async connectionForLeague(
    leagueSeasonId: string,
    now: Date,
  ): Promise<EspnDraftConnectionTarget | undefined> {
    const [connection] = await this.#database
      .select({ connectionId: providerConnections.id, userId: providerConnections.userId })
      .from(providerLeagueLinks)
      .innerJoin(providerConnections, eq(providerConnections.id, providerLeagueLinks.connectionId))
      .where(
        and(
          eq(providerLeagueLinks.leagueSeasonId, leagueSeasonId),
          eq(providerConnections.provider, "espn"),
          inArray(providerConnections.health, ["pending", "healthy", "degraded"]),
          isNotNull(providerConnections.encryptedCredential),
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

  async teamMappings(leagueSeasonId: string): Promise<ReadonlyMap<string, string>> {
    const rows = await this.#database
      .select({ id: fantasyTeams.id, externalKey: fantasyTeams.externalKey })
      .from(fantasyTeams)
      .where(eq(fantasyTeams.leagueSeasonId, leagueSeasonId));
    return new Map(
      rows.flatMap((row) => {
        const providerId = teamProviderId(row.externalKey);
        return providerId === null ? [] : [[providerId, row.id] as const];
      }),
    );
  }

  async playerMappings(input: {
    readonly leagueSeasonId: string;
    readonly providerPlayerIds: readonly string[];
    readonly poolPlayerIds: ReadonlySet<string>;
  }): Promise<ReadonlyMap<string, string>> {
    if (input.providerPlayerIds.length === 0) return new Map();
    const scopedKeys = input.providerPlayerIds.map((id) =>
      espnSelfAssertedPlayerKey(input.leagueSeasonId, id),
    );
    const rows = await this.#database
      .select({
        source: playerExternalIds.source,
        externalId: playerExternalIds.externalId,
        playerId: playerExternalIds.playerId,
      })
      .from(playerExternalIds)
      .innerJoin(players, eq(players.id, playerExternalIds.playerId))
      .where(
        or(
          and(
            eq(playerExternalIds.source, "espn"),
            eq(playerExternalIds.verified, true),
            isNotNull(players.gsisId),
            inArray(playerExternalIds.externalId, [...input.providerPlayerIds]),
          ),
          and(
            eq(playerExternalIds.source, ESPN_SELF_ASSERTED_PLAYER_SOURCE),
            inArray(playerExternalIds.externalId, scopedKeys),
          ),
        ),
      );
    const mapping = new Map<string, string>();
    for (const row of rows) {
      if (!input.poolPlayerIds.has(row.playerId)) continue;
      const providerId =
        row.source === "espn"
          ? row.externalId
          : row.externalId.slice(espnSelfAssertedPlayerKey(input.leagueSeasonId, "").length);
      if (providerId.length > 0 && !mapping.has(providerId)) mapping.set(providerId, row.playerId);
    }
    return mapping;
  }

  async releaseClaim(claim: EspnDraftPollClaim, now: Date): Promise<void> {
    await this.#database
      .update(draftProviderFeeds)
      .set({
        serverPollLeaseExpiresAt: null,
        serverNextPollAt: new Date(
          now.getTime() + ESPN_DRAFT_PREDRAFT_POLL_INTERVAL_SECONDS * 1_000,
        ),
        updatedAt: now,
      })
      .where(
        and(
          eq(draftProviderFeeds.id, claim.feedId),
          eq(draftProviderFeeds.serverPollGeneration, claim.generation),
        ),
      );
  }

  async recordFailure(input: {
    readonly claim: EspnDraftPollClaim;
    readonly issue: Extract<EspnLiveDraftIssueCode, "PROVIDER_UNAVAILABLE" | "POLL_FAILED">;
    readonly checkedAt: Date;
  }): Promise<void> {
    const [current] = await this.#database
      .select({ failures: draftProviderFeeds.serverConsecutiveFailures })
      .from(draftProviderFeeds)
      .where(eq(draftProviderFeeds.id, input.claim.feedId))
      .limit(1);
    const failures = (current?.failures ?? 0) + 1;
    const backoffSeconds = Math.min(
      ESPN_DRAFT_MAX_BACKOFF_SECONDS,
      ESPN_DRAFT_PREDRAFT_POLL_INTERVAL_SECONDS * 2 ** Math.min(failures - 1, 4),
    );
    const browserFreshCutoff = new Date(input.checkedAt.getTime() - ESPN_BROWSER_FRESH_MS);
    await this.#database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from drafts where id = ${input.claim.draftId} for update`,
      );
      const [feed] = await transaction
        .select({
          generation: draftProviderFeeds.serverPollGeneration,
          lastReceivedAt: draftProviderFeeds.lastReceivedAt,
          state: draftProviderFeeds.state,
        })
        .from(draftProviderFeeds)
        .where(eq(draftProviderFeeds.id, input.claim.feedId))
        .for("update")
        .limit(1);
      if (!feed || feed.generation !== input.claim.generation) return;
      await transaction
        .update(draftProviderFeeds)
        .set({
          state:
            feed.lastReceivedAt !== null && feed.lastReceivedAt >= browserFreshCutoff
              ? feed.state
              : "stale",
          serverPollLeaseExpiresAt: null,
          serverNextPollAt: new Date(input.checkedAt.getTime() + backoffSeconds * 1_000),
          serverLastCheckedAt: input.checkedAt,
          serverConsecutiveFailures: failures,
          lastErrorCode: input.issue,
          updatedAt: input.checkedAt,
        })
        .where(eq(draftProviderFeeds.id, input.claim.feedId));
      await transaction
        .update(drafts)
        .set({ updatedAt: input.checkedAt })
        .where(eq(drafts.id, input.claim.draftId));
    });
  }

  async commitPoll(input: CommitServerPollInput): Promise<boolean> {
    return this.#database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from drafts where id = ${input.claim.draftId} for update`,
      );
      const [sequenceRow] = await transaction
        .select({ sequence: max(draftEvents.sequence) })
        .from(draftEvents)
        .where(eq(draftEvents.draftId, input.claim.draftId));
      const sequence = sequenceRow?.sequence ?? 0;
      const [feed] = await transaction
        .select({
          generation: draftProviderFeeds.serverPollGeneration,
          manualBackupActive: draftProviderFeeds.manualBackupActive,
          lastReceivedAt: draftProviderFeeds.lastReceivedAt,
          state: draftProviderFeeds.state,
        })
        .from(draftProviderFeeds)
        .where(eq(draftProviderFeeds.id, input.claim.feedId))
        .for("update")
        .limit(1);
      if (
        !feed ||
        feed.generation !== input.claim.generation ||
        feed.manualBackupActive !== input.expectedManualBackupActive
      ) {
        return false;
      }
      if (sequence !== input.expectedSequence) {
        await transaction
          .update(draftProviderFeeds)
          .set({
            serverPollLeaseExpiresAt: null,
            serverNextPollAt: new Date(input.checkedAt.getTime() + 1_000),
            lastErrorCode: "CONCURRENT_LEDGER_CHANGE",
            updatedAt: input.checkedAt,
          })
          .where(eq(draftProviderFeeds.id, input.claim.feedId));
        return false;
      }

      if (input.append.length > 0) {
        const inserted = await transaction
          .insert(draftEvents)
          .values(
            input.append.map((pending, index) => ({
              draftId: input.claim.draftId,
              sequence: sequence + index + 1,
              idempotencyKey: pending.idempotencyKey,
              type: pending.event.type,
              occurredAt:
                pending.event.occurredAt === undefined
                  ? input.checkedAt
                  : new Date(pending.event.occurredAt),
              source: pending.source,
              payload: eventPayload(pending.event),
              revertsSequence: pending.revertsSequence,
              createdAt: input.checkedAt,
            })),
          )
          .onConflictDoNothing()
          .returning({ sequence: draftEvents.sequence });
        if (inserted.length !== input.append.length) {
          throw new Error("ESPN server draft poll lost its event idempotency fence");
        }
      }

      await transaction
        .update(drafts)
        .set({ state: input.resultingDraftState, updatedAt: input.checkedAt })
        .where(eq(drafts.id, input.claim.draftId));

      const browserFreshCutoff = new Date(input.checkedAt.getTime() - ESPN_BROWSER_FRESH_MS);
      const preserveBrowserState =
        feed.lastReceivedAt !== null && feed.lastReceivedAt >= browserFreshCutoff;
      await transaction
        .update(draftProviderFeeds)
        .set({
          state:
            input.feedState === "complete"
              ? "complete"
              : preserveBrowserState
                ? feed.state
                : input.feedState,
          serverPollLeaseExpiresAt: null,
          serverNextPollAt: input.nextPollAt,
          serverLastChecksum: input.checksum,
          serverLastCheckedAt: input.checkedAt,
          serverLastSuccessfulAt: input.checkedAt,
          serverConsecutiveFailures: 0,
          serverUnresolvedTeams: input.unresolvedTeams,
          serverUnresolvedPlayers: input.unresolvedPlayers,
          lastPickCount: input.pickCount,
          serverPendingDestructiveChecksum: input.pendingDestructiveChecksum,
          serverPendingDestructiveSeenCount: input.pendingDestructiveSeenCount,
          lastErrorCode: input.issue,
          verification:
            input.feedState === "complete" && input.issue === null ? "verified" : "pending",
          ...(input.feedState === "complete" ? { currentAuctionState: null } : {}),
          ...(input.append.length > 0 ? { lastMaterialEventAt: input.checkedAt } : {}),
          updatedAt: input.checkedAt,
        })
        .where(eq(draftProviderFeeds.id, input.claim.feedId));
      return true;
    });
  }
}

export class EspnDraftPollService {
  readonly #repository: DrizzleEspnDraftPollRepository;
  readonly #sessions: EspnDraftSessionPort;
  readonly #credentials: EspnDraftCredentialPort;
  readonly #client: EspnDraftReadPort;
  readonly #now: () => Date;

  constructor(input: {
    readonly repository: DrizzleEspnDraftPollRepository;
    readonly sessions: EspnDraftSessionPort;
    readonly credentials: EspnDraftCredentialPort;
    readonly client?: EspnDraftReadPort;
    readonly now?: () => Date;
  }) {
    this.#repository = input.repository;
    this.#sessions = input.sessions;
    this.#credentials = input.credentials;
    this.#client = input.client ?? new EspnSessionReadClient();
    this.#now = input.now ?? (() => new Date());
  }

  async refreshDue(): Promise<void> {
    const due = await this.#repository.duePolls(this.#now());
    await Promise.all(
      due.map((item) => this.refresh(item.userId, item.draftId).then(() => undefined)),
    );
  }

  async refresh(userId: string, draftId: string): Promise<DraftSessionSnapshot> {
    const session = await this.#sessions.getSession(userId, draftId);
    if (session.transport !== "espn-live" || session.providerFeed?.provider !== "espn") {
      return session;
    }
    const checkedAt = this.#now();
    const claim = await this.#repository.claimPoll(draftId, checkedAt);
    if (!claim) return session;
    const connection = await this.#repository.connectionForLeague(claim.leagueSeasonId, checkedAt);
    if (!connection) {
      await this.#repository.recordFailure({
        claim,
        issue: "PROVIDER_UNAVAILABLE",
        checkedAt,
      });
      return this.#sessions.getSession(userId, draftId);
    }

    try {
      const credential = await this.#credentials.getSession(
        connection.userId,
        connection.connectionId,
      );
      const artifact = await this.#client.fetchCompletedDraft({
        credential,
        leagueId: claim.providerLeagueId,
        season: claim.season,
      });
      const normalized = normalizeEspnSupplementalSnapshot({
        schemaVersion: 1,
        provider: "espn",
        authority: "server-session",
        readOnly: true,
        leagueId: artifact.leagueId,
        season: artifact.season,
        capturedAt: artifact.capturedAt,
        endpoint: artifact.endpoint,
        checksumSha256: artifact.checksumSha256,
        checksumAlgorithm: "canonical-json-v1-sha256",
        kind: "completed-draft",
        week: null,
        payload: artifact.payload,
      });
      if (normalized.kind !== "completed-draft") {
        throw new Error("ESPN completed-draft read normalized to another artifact family");
      }
      await this.#applySnapshot(session, claim, normalized, artifact.checksumSha256, checkedAt);
    } catch (error) {
      const expected =
        error instanceof EspnSessionReadError ||
        error instanceof EspnSupplementalNormalizationError ||
        (error instanceof Error && error.name === "EspnSessionConnectionError");
      if (!expected) {
        await this.#repository.releaseClaim(claim, checkedAt);
        throw error;
      }
      await this.#repository.recordFailure({ claim, issue: "POLL_FAILED", checkedAt });
    }
    return this.#sessions.getSession(userId, draftId);
  }

  async #applySnapshot(
    session: DraftSessionSnapshot,
    claim: EspnDraftPollClaim,
    snapshot: Extract<
      ReturnType<typeof normalizeEspnSupplementalSnapshot>,
      { kind: "completed-draft" }
    >,
    checksum: string,
    checkedAt: Date,
  ): Promise<void> {
    const expectedMode = snapshot.draftType === "auction" ? "AUCTION" : "SNAKE";
    let issue: EspnLiveDraftIssueCode | null =
      session.config.mode === expectedMode ? null : "DRAFT_TYPE_MISMATCH";
    if (
      issue === null &&
      snapshot.draftType === "auction" &&
      session.config.mode === "AUCTION" &&
      session.config.teams.some((team) => team.budget !== snapshot.budgetPerTeam)
    ) {
      issue = "PRICE_ILLEGAL";
    }
    if (issue === null && snapshot.picks.some((pick, index) => pick.sequence !== index + 1)) {
      issue = "PICK_SEQUENCE_GAP";
    }

    const expectedPickCount = session.config.teams.reduce(
      (count, team) => count + team.rosterSlots.length,
      0,
    );
    if (
      issue === null &&
      snapshot.state === "complete" &&
      snapshot.picks.length !== expectedPickCount
    ) {
      issue = "COMPLETED_COUNT_MISMATCH";
    }

    const teamIdByProviderId = await this.#repository.teamMappings(claim.leagueSeasonId);
    const providerPlayerIds = [...new Set(snapshot.picks.map((pick) => pick.providerPlayerId))];
    const playerIdByProviderId = await this.#repository.playerMappings({
      leagueSeasonId: claim.leagueSeasonId,
      providerPlayerIds,
      poolPlayerIds: new Set(session.config.players.map((player) => String(player.id))),
    });
    const observed: ProviderDraftAction[] = [];
    let unresolvedTeams = 0;
    let unresolvedPlayers = 0;
    for (const pick of snapshot.picks) {
      const resolvedTeamId = teamIdByProviderId.get(pick.providerTeamId);
      const resolvedPlayerId = playerIdByProviderId.get(pick.providerPlayerId);
      if (resolvedTeamId === undefined) unresolvedTeams += 1;
      if (resolvedPlayerId === undefined) unresolvedPlayers += 1;
      if (resolvedTeamId === undefined || resolvedPlayerId === undefined) continue;
      observed.push(
        snapshot.draftType === "auction"
          ? {
              kind: "auction-sale",
              teamId: resolvedTeamId,
              playerId: resolvedPlayerId,
              price: pick.amount ?? -1,
              keeper: pick.keeper,
            }
          : {
              kind: "snake-pick",
              overallPick: pick.sequence,
              teamId: resolvedTeamId,
              playerId: resolvedPlayerId,
              keeper: pick.keeper,
            },
      );
    }
    if (issue === null && unresolvedTeams > 0) issue = "UNRESOLVED_TEAM";
    if (issue === null && unresolvedPlayers > 0) issue = "UNRESOLVED_PLAYER";
    if (
      issue === null &&
      snapshot.draftType === "auction" &&
      snapshot.picks.some((pick) => pick.amount === null || pick.amount < 0)
    ) {
      issue = "PRICE_ILLEGAL";
    }

    const base = {
      claim,
      expectedSequence: session.sequence,
      expectedManualBackupActive: claim.manualBackupActive,
      checksum,
      pickCount: snapshot.picks.length,
      unresolvedTeams,
      unresolvedPlayers,
      nextPollAt: nextPollAt(snapshot, checkedAt),
      checkedAt,
    } as const;
    const observedFeedState = feedStateFor(snapshot.state);
    if (claim.manualBackupActive) {
      await this.#repository.commitPoll({
        ...base,
        append: [],
        feedState: observedFeedState,
        resultingDraftState: session.persistedState,
        issue: "MANUAL_BACKUP_ACTIVE",
        pendingDestructiveChecksum: null,
        pendingDestructiveSeenCount: 0,
      });
      return;
    }
    if (issue !== null) {
      await this.#repository.commitPoll({
        ...base,
        append: [],
        feedState: "degraded",
        resultingDraftState: session.persistedState,
        issue,
        pendingDestructiveChecksum: null,
        pendingDestructiveSeenCount: 0,
      });
      return;
    }

    const destructiveConfirmed =
      claim.pendingDestructiveChecksum === checksum && claim.pendingDestructiveSeenCount + 1 >= 2;
    const plan = reconcileProviderObservation({
      feedId: claim.feedId,
      config: session.config,
      events: session.events,
      observed,
      occurredAt: checkedAt,
      destructiveConfirmed,
      eventIdFor: (key) => eventIdFor(claim.draftId, key),
    });
    if (plan.kind === "held") {
      await this.#repository.commitPoll({
        ...base,
        append: [],
        feedState: "degraded",
        resultingDraftState: session.persistedState,
        issue: plan.issue,
        pendingDestructiveChecksum: null,
        pendingDestructiveSeenCount: 0,
      });
      return;
    }
    if (plan.kind === "destructive-hold") {
      const seen =
        claim.pendingDestructiveChecksum === checksum ? claim.pendingDestructiveSeenCount + 1 : 1;
      await this.#repository.commitPoll({
        ...base,
        append: [],
        feedState: observedFeedState,
        resultingDraftState: session.persistedState,
        issue: "DESTRUCTIVE_PENDING",
        pendingDestructiveChecksum: checksum,
        pendingDestructiveSeenCount: seen,
      });
      return;
    }

    const append = plan.kind === "idempotent" ? [] : plan.append;
    const candidate = [...activeEvents(session), ...append.map((pending) => pending.event)];
    const reduced = reduceDraft(session.config, candidate);
    if (snapshot.state === "complete" && !reduced.complete) {
      await this.#repository.commitPoll({
        ...base,
        append: [],
        feedState: "degraded",
        resultingDraftState: session.persistedState,
        issue: "COMPLETED_COUNT_MISMATCH",
        pendingDestructiveChecksum: null,
        pendingDestructiveSeenCount: 0,
      });
      return;
    }
    const resultingDraftState = reduced.complete
      ? "complete"
      : candidate.length > 0 || snapshot.state === "in-progress"
        ? "live"
        : "created";
    await this.#repository.commitPoll({
      ...base,
      append,
      feedState: reduced.complete ? "complete" : observedFeedState,
      resultingDraftState,
      issue: null,
      pendingDestructiveChecksum: null,
      pendingDestructiveSeenCount: 0,
    });
  }
}
