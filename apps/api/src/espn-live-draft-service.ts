import { createHash } from "node:crypto";

import {
  ESPN_LIVE_DRAFT_PULSE_LIMITS,
  ESPN_LIVE_DRAFT_LIMITS,
  draftManualBackupRequestSchema,
  espnLiveDraftDigestSource,
  espnLiveDraftTransientAuctionSchema,
  type DraftManualBackupReconciliation,
  type DraftManualBackupRequest,
  type EspnLiveDraftCurrentAuction,
  type EspnLiveDraftFeedStatus,
  type EspnLiveDraftIngestRequest,
  type EspnLiveDraftIngestResponse,
  type EspnLiveDraftIssueCode,
  type EspnLiveDraftObservation,
  type EspnLiveDraftPulseResponse,
  type EspnLiveDraftTransientAuction,
} from "@laces-out/contracts";
import type { LeagueMembershipRole } from "@laces-out/db";
import { assignPlayersToRosterSlots } from "@laces-out/domain";
import { reduceDraft, type DraftConfig } from "@laces-out/engine-draft";

import { DraftSessionError, mayMutate, type DraftSessionEventRecord } from "./draft-session.js";
import {
  ProviderPlayerResolver,
  ProviderTeamResolver,
  type ProviderPlayerCandidate,
  type ProviderTeamCandidate,
} from "./espn-live-draft-identity.js";
import {
  reconcileProviderObservation,
  type ProviderDraftAction,
  type ProviderPendingEvent,
} from "./espn-live-draft-reconciler.js";

const maximumObservationAgeMs = 5 * 60 * 1000;
const maximumFutureSkewMs = 60 * 1000;

export type EspnLiveDraftErrorCode =
  "UNAUTHORIZED" | "OUT_OF_SCOPE" | "NOT_FOUND" | "STALE" | "CHECKSUM" | "DISABLED";

export class EspnLiveDraftError extends Error {
  readonly code: EspnLiveDraftErrorCode;
  readonly statusCode: number;

  constructor(code: EspnLiveDraftErrorCode, message: string) {
    super(message);
    this.name = "EspnLiveDraftError";
    this.code = code;
    this.statusCode =
      code === "UNAUTHORIZED"
        ? 401
        : code === "OUT_OF_SCOPE"
          ? 403
          : code === "NOT_FOUND"
            ? 404
            : code === "DISABLED"
              ? 503
              : 400;
  }
}

export interface LiveDraftPulseScope {
  readonly userId: string;
  readonly leagueSeasonId: string;
  readonly providerLeagueId: string;
  readonly season: number;
}

export interface LiveDraftDeviceScope extends LiveDraftPulseScope {
  readonly deviceId: string;
}

export interface LiveDraftFeedRow {
  readonly id: string;
  readonly draftId: string;
  readonly state: EspnLiveDraftFeedStatus["state"];
  readonly activeDeviceId: string | null;
  readonly activePageSessionId: string | null;
  readonly lastPageRevision: number | null;
  readonly leaseExpiresAt: Date | null;
  readonly leaseGeneration: number;
  readonly lastChecksum: string | null;
  readonly lastObservedAt: Date | null;
  readonly lastReceivedAt: Date | null;
  readonly currentAuctionState: Record<string, unknown> | null;
  readonly pendingDestructiveChecksum: string | null;
  readonly pendingDestructiveSeenCount: number;
  readonly manualBackupActive: boolean;
}

export interface LiveDraftSessionContext {
  readonly feed: LiveDraftFeedRow;
  readonly draftId: string;
  readonly config: DraftConfig;
  readonly events: readonly DraftSessionEventRecord[];
  readonly sequence: number;
  readonly teams: readonly ProviderTeamCandidate[];
  readonly players: readonly ProviderPlayerCandidate[];
  /** ESPN provider player ID to internal player ID, verified or league-scoped. */
  readonly playerCrosswalk: ReadonlyMap<string, string>;
}

/** One bounded audit-row projection; source/device/page-session identity is deliberately absent. */
export interface LiveDraftPulseObservation {
  readonly pageRevision: number;
  /** Server receipt time supplies stable ordering even when a browser clock is skewed. */
  readonly receivedAt: Date;
  readonly currentAuction: EspnLiveDraftCurrentAuction | null;
}

export interface LiveDraftPulseContext extends LiveDraftSessionContext {
  readonly persistedState: "created" | "live" | "complete";
  readonly controlledTeamId: string | null;
  readonly transitionObservations: readonly LiveDraftPulseObservation[];
}

export interface CommitProviderEventsInput {
  readonly feedId: string;
  readonly draftId: string;
  readonly deviceId: string;
  readonly expectedSequence: number;
  readonly expectedLeaseGeneration: number;
  readonly expectedManualBackupActive: boolean;
  readonly append: readonly ProviderPendingEvent[];
  readonly observation: EspnLiveDraftObservation;
  readonly result: "accepted" | "idempotent" | "standby" | "held" | "rejected";
  readonly issue: EspnLiveDraftIssueCode | null;
  readonly feedState: EspnLiveDraftFeedStatus["state"];
  readonly transientAuction: EspnLiveDraftTransientAuction | null;
  readonly pendingDestructiveChecksum: string | null;
  readonly pendingDestructiveSeenCount: number;
  readonly unresolvedTeams: number;
  readonly unresolvedPlayers: number;
  readonly now: Date;
}

/**
 * Everything the manual backup decision needs, and nothing else.
 *
 * `feedId` is null for a room with no provider feed. `accessRole` is the caller's effective role;
 * an absent role means an absent context, so a stranger cannot tell a real draft from a fictional
 * one. Nothing here identifies the device supplying the board.
 */
export interface ManualBackupContext {
  readonly feedId: string | null;
  readonly accessRole: LeagueMembershipRole;
  readonly archived: boolean;
  readonly manualBackupActive: boolean;
  /** Length of the draft ledger, which is what `expectedSequence` is compared against. */
  readonly sequence: number;
  /** Provider snapshots validated and held since the ledger last moved. */
  readonly pendingReconciliation: number;
}

export interface SetManualBackupInput {
  readonly feedId: string;
  readonly draftId: string;
  readonly expectedSequence: number;
  readonly active: boolean;
  readonly now: Date;
}

export type SetManualBackupResult =
  | { readonly status: "updated" }
  | { readonly status: "version-conflict"; readonly currentSequence: number }
  | { readonly status: "not-found" };

/** What the toggle actually did, for the route's audit log. Carries no session material. */
export interface ManualBackupOutcome {
  readonly draftId: string;
  readonly active: boolean;
  /** False when the room was already in the requested mode and nothing was written. */
  readonly changed: boolean;
  readonly reconciliation: DraftManualBackupReconciliation | null;
  readonly pendingReconciliation: number;
}

export interface EspnLiveDraftRepository {
  authorizeDevice(
    deviceToken: string,
    providerLeagueId: string,
    season: number,
  ): Promise<LiveDraftDeviceScope | undefined>;
  /** Unlike legacy ingest scope, a live reader requires an explicitly paired season. */
  authorizePulseDevice(
    deviceToken: string,
    providerLeagueId: string,
    season: number,
  ): Promise<LiveDraftDeviceScope | undefined>;
  /** Resolves current membership on every capability-authenticated pulse read. */
  authorizePulseMember(
    userId: string,
    providerLeagueId: string,
    season: number,
  ): Promise<LiveDraftPulseScope | undefined>;
  loadSessionContext(
    scope: LiveDraftDeviceScope,
    observation: EspnLiveDraftObservation,
  ): Promise<LiveDraftSessionContext | undefined>;
  claimLease(input: {
    readonly feedId: string;
    readonly deviceId: string;
    readonly pageSessionId: string;
    readonly expectedGeneration: number;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<{
    readonly granted: boolean;
    readonly expiresAt: Date | null;
    readonly generation: number;
  }>;
  commitObservation(
    input: CommitProviderEventsInput,
  ): Promise<{ readonly sequence: number; readonly committed: boolean }>;
  recordHeartbeat(input: {
    readonly scope: LiveDraftDeviceScope;
    readonly pageSessionId: string;
    readonly revision: number;
    readonly lastChecksumSha256: string | null;
    readonly state: EspnLiveDraftObservation["state"];
    readonly now: Date;
  }): Promise<EspnLiveDraftFeedStatus | undefined>;
  loadFeedStatus(draftId: string): Promise<EspnLiveDraftFeedStatus | undefined>;
  loadPulseContext(scope: LiveDraftPulseScope): Promise<LiveDraftPulseContext | undefined>;
  loadManualBackupContext(
    actorUserId: string,
    draftId: string,
  ): Promise<ManualBackupContext | undefined>;
  setManualBackupActive(input: SetManualBackupInput): Promise<SetManualBackupResult>;
}

function canonicalChecksum(observation: EspnLiveDraftObservation): string {
  return createHash("sha256").update(espnLiveDraftDigestSource(observation), "utf8").digest("hex");
}

function rejection(
  feedState: EspnLiveDraftFeedStatus["state"],
  issue: EspnLiveDraftIssueCode,
): EspnLiveDraftIngestResponse {
  return {
    status: "rejected",
    draftId: null,
    serverSequence: null,
    feedState,
    acceptedChecksum: null,
    unresolvedTeams: 0,
    unresolvedPlayers: 0,
    issueCode: issue,
    sourceLeaseExpiresAt: null,
    feedCursor: null,
  };
}

/**
 * Structural checks that do not need any league context. A snapshot that fails these describes a
 * board nobody should act on — a half-rendered table, a duplicated row, a gap where a pick should
 * be — and is held rather than applied.
 */
export function observationCompletenessIssue(
  observation: EspnLiveDraftObservation,
): EspnLiveDraftIssueCode | null {
  const sequences = observation.picks.map((pick) => pick.sequence);
  if (new Set(sequences).size !== sequences.length) return "DUPLICATE_PICK_SEQUENCE";
  if (observation.completeness.duplicateSequences > 0) return "DUPLICATE_PICK_SEQUENCE";
  const sorted = [...sequences].sort((left, right) => left - right);
  for (const [index, sequence] of sorted.entries()) {
    if (sequence !== index + 1) return "PICK_SEQUENCE_GAP";
  }
  if (observation.completeness.contiguousThrough !== observation.picks.length) {
    return "PICK_SEQUENCE_GAP";
  }
  if (observation.completeness.unresolvedRows > 0) return "EMPTY_RENDER";
  // Older or hostile clients may still submit a keeper acquisition without its auction price.
  // Treat that as an incomplete render; $0 is not a safe budget assumption.
  if (
    observation.draftType === "auction" &&
    observation.picks.some((pick) => pick.price === null)
  ) {
    return "EMPTY_RENDER";
  }
  return null;
}

const liveDraftCursorRevisionBase = BigInt(1_000_001);

function feedCursor(leaseGeneration: number, pageRevision: number): string {
  if (
    !Number.isSafeInteger(leaseGeneration) ||
    leaseGeneration < 0 ||
    !Number.isSafeInteger(pageRevision) ||
    pageRevision < 0 ||
    pageRevision >= Number(liveDraftCursorRevisionBase)
  ) {
    throw new RangeError("ESPN live draft cursor components are invalid");
  }
  return (BigInt(leaseGeneration) * liveDraftCursorRevisionBase + BigInt(pageRevision)).toString();
}

function pulseCursor(feed: LiveDraftFeedRow): string {
  return feedCursor(feed.leaseGeneration, feed.lastPageRevision ?? 0);
}

function resolveProviderAuction(
  auction: EspnLiveDraftCurrentAuction,
  teamResolver: ProviderTeamResolver,
  playerResolver: ProviderPlayerResolver,
  observedAt: Date,
): EspnLiveDraftTransientAuction {
  const nominator =
    auction.nominatingProviderTeamId === null
      ? null
      : teamResolver.resolve({
          providerTeamId: auction.nominatingProviderTeamId,
          teamName: "",
        });
  const highBidder =
    auction.highBidProviderTeamId === null && auction.highBidTeamName === null
      ? null
      : teamResolver.resolve({
          providerTeamId: auction.highBidProviderTeamId,
          teamName: auction.highBidTeamName ?? "",
        });
  const player = playerResolver.resolve({
    providerPlayerId: auction.providerPlayerId,
    playerName: auction.playerName,
    proTeam: auction.proTeam,
    position: auction.position,
  });
  return {
    nominationNumber: auction.nominationNumber,
    nominatingTeamId: nominator?.status === "resolved" ? nominator.id : null,
    playerId: player.status === "resolved" ? player.id : null,
    playerName: auction.playerName,
    proTeam: auction.proTeam,
    position: auction.position,
    highBidTeamId: highBidder?.status === "resolved" ? highBidder.id : null,
    highBid: auction.highBid,
    observedAt: observedAt.toISOString(),
  };
}

/**
 * Builds the latency-sensitive read-only pulse from already-authorized, sanitized repository data.
 * Provider IDs are consumed only by the resolvers and never survive into the returned object.
 */
export function projectEspnLiveDraftPulse(
  scope: LiveDraftPulseScope,
  context: LiveDraftPulseContext,
  now: Date,
): EspnLiveDraftPulseResponse {
  const state = reduceDraft(
    context.config,
    context.events.map((record) => record.event),
  );
  const teamById = new Map(context.config.teams.map((team) => [String(team.id), team]));
  const playerById = new Map(context.config.players.map((player) => [String(player.id), player]));
  const stateByTeamId = new Map(state.teams.map((team) => [String(team.teamId), team]));
  const activeEventIds = new Set(state.activeEventIds.map(String));

  const completedSales: EspnLiveDraftPulseResponse["draft"]["completedSales"] = [];
  for (const record of context.events) {
    const event = record.event;
    if (event.type !== "AUCTION_PLAYER_SOLD" || !activeEventIds.has(String(event.id))) continue;
    const player = playerById.get(String(event.playerId));
    const team = teamById.get(String(event.teamId));
    if (!player || !team) continue;
    completedSales.push({
      sequence: record.sequence,
      playerId: String(event.playerId),
      playerName: player.name,
      positions: [...player.positions],
      teamId: String(event.teamId),
      teamName: team.name,
      price: event.price,
    });
  }

  const teams: EspnLiveDraftPulseResponse["draft"]["teams"] = context.config.teams.map((team) => {
    const reduced = stateByTeamId.get(String(team.id));
    if (!reduced) throw new Error("Reduced ESPN draft state omitted a configured team");
    const roster = reduced.roster.map((entry) => {
      const player = playerById.get(String(entry.playerId));
      if (!player) throw new Error("Reduced ESPN draft roster referenced an unknown player");
      return {
        playerId: String(player.id),
        playerName: player.name,
        positions: [...player.positions],
      };
    });
    return {
      id: String(team.id),
      name: team.name,
      budget: context.config.mode === "AUCTION" ? (team.budget ?? null) : null,
      spent: context.config.mode === "AUCTION" ? (reduced.spent ?? null) : null,
      remainingBudget: context.config.mode === "AUCTION" ? (reduced.remainingBudget ?? null) : null,
      openSlots: reduced.openSlots,
      maximumBid: context.config.mode === "AUCTION" ? (reduced.maximumBid ?? null) : null,
      rosterPlayerIds: roster.map((entry) => entry.playerId),
      rosterPlayers: roster,
      rosterSlots: team.rosterSlots.map((slot) => ({
        id: String(slot.id),
        type: slot.type,
        label: slot.label,
        kind: slot.kind,
        eligiblePositions: [...slot.eligiblePositions],
      })),
    };
  });

  const controlledTeamId =
    context.controlledTeamId !== null && teamById.has(context.controlledTeamId)
      ? context.controlledTeamId
      : null;
  const parsedCurrentAuction = espnLiveDraftTransientAuctionSchema.safeParse(
    context.feed.currentAuctionState,
  );
  const currentAuction = parsedCurrentAuction.success ? parsedCurrentAuction.data : null;
  let rosterFit: boolean | null = null;
  if (controlledTeamId !== null && currentAuction !== null && currentAuction.playerId !== null) {
    const team = teamById.get(controlledTeamId);
    const teamState = stateByTeamId.get(controlledTeamId);
    const player = playerById.get(currentAuction.playerId);
    if (team && teamState && player) {
      const roster = teamState.roster.map((entry) => playerById.get(String(entry.playerId)));
      if (roster.every((candidate) => candidate !== undefined)) {
        rosterFit = assignPlayersToRosterSlots(
          [...roster.filter((candidate) => candidate !== undefined), player],
          team.rosterSlots,
        ).feasible;
      }
    }
  }
  const currentPlayerPositions =
    currentAuction === null || currentAuction.playerId === null
      ? null
      : (playerById.get(currentAuction.playerId)?.positions ?? null);

  let nextBid: number | null = null;
  if (currentAuction !== null && context.config.mode === "AUCTION") {
    const candidate =
      currentAuction.highBid === null
        ? context.config.minimumBid
        : Math.max(context.config.minimumBid, currentAuction.highBid + 1);
    if (candidate <= ESPN_LIVE_DRAFT_LIMITS.maximumPrice) nextBid = candidate;
  }

  const teamResolver = new ProviderTeamResolver(context.teams);
  const playerResolver = new ProviderPlayerResolver(context.players, context.playerCrosswalk);
  const transitions: EspnLiveDraftPulseResponse["auctionTransitions"]["items"] = [];
  let priorSignature: string | null = null;
  for (const observation of context.transitionObservations) {
    if (observation.currentAuction === null) continue;
    const auction = resolveProviderAuction(
      observation.currentAuction,
      teamResolver,
      playerResolver,
      observation.receivedAt,
    );
    const signature = JSON.stringify([
      auction.nominationNumber,
      auction.nominatingTeamId,
      auction.playerId,
      auction.playerName,
      auction.proTeam,
      auction.position,
      auction.highBidTeamId,
      auction.highBid,
    ]);
    if (signature === priorSignature) continue;
    priorSignature = signature;
    transitions.push({ ...auction, pageRevision: observation.pageRevision });
  }
  const sampledTransitions = transitions.slice(
    -ESPN_LIVE_DRAFT_PULSE_LIMITS.maximumTransitionItems,
  );

  const ageMs =
    context.feed.lastReceivedAt === null
      ? null
      : Math.max(0, now.getTime() - context.feed.lastReceivedAt.getTime());
  const feedState: EspnLiveDraftFeedStatus["state"] =
    context.feed.state === "complete"
      ? "complete"
      : ageMs !== null && ageMs > ESPN_LIVE_DRAFT_LIMITS.disconnectedMs
        ? "stale"
        : context.feed.state;

  return {
    schemaVersion: 1,
    provider: "espn",
    providerLeagueId: scope.providerLeagueId,
    season: scope.season,
    cursor: pulseCursor(context.feed),
    pageRevision: context.feed.lastPageRevision,
    generatedAt: now.toISOString(),
    observedAt: context.feed.lastObservedAt?.toISOString() ?? null,
    lastReceivedAt: context.feed.lastReceivedAt?.toISOString() ?? null,
    fresh: ageMs !== null && ageMs <= ESPN_LIVE_DRAFT_LIMITS.freshWindowMs,
    ageSeconds: ageMs === null ? null : Math.round(ageMs / 100) / 10,
    feedState,
    manualBackupActive: context.feed.manualBackupActive,
    draft: {
      id: context.draftId,
      sequence: context.sequence,
      persistedState: context.persistedState,
      mode: context.config.mode,
      minimumBid: context.config.mode === "AUCTION" ? context.config.minimumBid : null,
      complete: state.complete,
      teams,
      completedSales,
    },
    controlledTeamId,
    currentAuction:
      currentAuction === null || context.feed.manualBackupActive
        ? null
        : {
            ...currentAuction,
            playerPositions: currentPlayerPositions === null ? null : [...currentPlayerPositions],
            nextBid,
            nextBidSource: nextBid === null ? null : "ESPN_MINIMUM_INCREMENT",
            rosterFit,
            marketInflationFactor: null,
          },
    auctionTransitions: {
      sampling: "sampled",
      maximumItems: ESPN_LIVE_DRAFT_PULSE_LIMITS.maximumTransitionItems,
      observationsScanned: context.transitionObservations.length,
      items: sampledTransitions,
    },
  };
}

export class EspnLiveDraftService {
  readonly #repository: EspnLiveDraftRepository;
  readonly #now: () => Date;
  readonly #enabled: boolean;

  constructor(
    repository: EspnLiveDraftRepository,
    options: { readonly enabled: boolean; readonly now?: () => Date },
  ) {
    this.#repository = repository;
    this.#enabled = options.enabled;
    this.#now = options.now ?? (() => new Date());
  }

  async latest(
    deviceToken: string,
    providerLeagueId: string,
    season: number,
  ): Promise<EspnLiveDraftPulseResponse> {
    if (!this.#enabled) {
      throw new EspnLiveDraftError(
        "DISABLED",
        "ESPN live draft sync is not enabled on this server",
      );
    }
    const scope = await this.#repository.authorizePulseDevice(
      deviceToken,
      providerLeagueId,
      season,
    );
    if (!scope) {
      throw new EspnLiveDraftError(
        "OUT_OF_SCOPE",
        "ESPN league season is outside this bridge device scope",
      );
    }
    return this.#pulseForScope(scope);
  }

  async latestForMember(
    userId: string,
    providerLeagueId: string,
    season: number,
  ): Promise<EspnLiveDraftPulseResponse> {
    if (!this.#enabled) {
      throw new EspnLiveDraftError(
        "DISABLED",
        "ESPN live draft sync is not enabled on this server",
      );
    }
    const scope = await this.#repository.authorizePulseMember(userId, providerLeagueId, season);
    if (!scope) {
      throw new EspnLiveDraftError(
        "OUT_OF_SCOPE",
        "ESPN league season is outside the member's current access",
      );
    }
    return this.#pulseForScope(scope);
  }

  async #pulseForScope(scope: LiveDraftPulseScope): Promise<EspnLiveDraftPulseResponse> {
    const context = await this.#repository.loadPulseContext(scope);
    if (!context) {
      throw new EspnLiveDraftError(
        "NOT_FOUND",
        "No ESPN live draft pulse is available for this paired league season",
      );
    }
    return projectEspnLiveDraftPulse(scope, context, this.#now());
  }

  async ingest(
    deviceToken: string,
    request: EspnLiveDraftIngestRequest,
  ): Promise<EspnLiveDraftIngestResponse> {
    if (!this.#enabled) {
      throw new EspnLiveDraftError(
        "DISABLED",
        "ESPN live draft sync is not enabled on this server",
      );
    }
    const now = this.#now();
    const scope = await this.#repository.authorizeDevice(
      deviceToken,
      request.leagueId,
      request.season,
    );
    if (!scope) {
      throw new EspnLiveDraftError(
        "OUT_OF_SCOPE",
        "ESPN league is outside this bridge device scope",
      );
    }

    const capturedAt = new Date(request.capturedAt);
    const age = now.getTime() - capturedAt.getTime();
    if (age > maximumObservationAgeMs || age < -maximumFutureSkewMs) {
      throw new EspnLiveDraftError(
        "STALE",
        "ESPN live draft observation capture time is not current",
      );
    }

    if (request.kind === "espn-live-draft-heartbeat") {
      const status = await this.#repository.recordHeartbeat({
        scope,
        pageSessionId: request.pageSessionId,
        revision: request.revision,
        lastChecksumSha256: request.lastChecksumSha256,
        state: request.state,
        now,
      });
      return {
        status: status ? "accepted" : "standby",
        draftId: null,
        serverSequence: null,
        feedState: status?.state ?? "waiting",
        acceptedChecksum: null,
        unresolvedTeams: status?.unresolvedTeams ?? 0,
        unresolvedPlayers: status?.unresolvedPlayers ?? 0,
        issueCode: null,
        sourceLeaseExpiresAt: null,
        feedCursor: null,
      };
    }

    const observation = request;
    if (canonicalChecksum(observation) !== observation.checksumSha256) {
      throw new EspnLiveDraftError(
        "CHECKSUM",
        "ESPN live draft observation checksum does not match its board",
      );
    }

    const structural = observationCompletenessIssue(observation);
    if (structural !== null) return rejection("degraded", structural);

    const context = await this.#repository.loadSessionContext(scope, observation);
    if (!context) return rejection("waiting", "SESSION_NOT_READY");

    if (context.config.mode !== (observation.draftType === "snake" ? "SNAKE" : "AUCTION")) {
      return rejection("degraded", "DRAFT_TYPE_MISMATCH");
    }
    if (context.config.teams.length !== observation.expectedTeamCount) {
      return rejection("degraded", "TEAM_COUNT_MISMATCH");
    }

    const lease = await this.#repository.claimLease({
      feedId: context.feed.id,
      deviceId: scope.deviceId,
      pageSessionId: observation.pageSessionId,
      expectedGeneration: context.feed.leaseGeneration,
      expiresAt: new Date(now.getTime() + ESPN_LIVE_DRAFT_LIMITS.failoverEligibleMs),
      now,
    });
    if (!lease.granted) {
      return {
        status: "standby",
        draftId: context.draftId,
        serverSequence: context.sequence,
        feedState: context.feed.state,
        acceptedChecksum: context.feed.lastChecksum,
        unresolvedTeams: 0,
        unresolvedPlayers: 0,
        issueCode: null,
        sourceLeaseExpiresAt: lease.expiresAt?.toISOString() ?? null,
        feedCursor: null,
      };
    }

    const standbyAfterLostCommit = (serverSequence: number): EspnLiveDraftIngestResponse => ({
      status: "standby",
      draftId: context.draftId,
      serverSequence,
      feedState: context.feed.state,
      acceptedChecksum: context.feed.lastChecksum,
      unresolvedTeams: 0,
      unresolvedPlayers: 0,
      issueCode: null,
      sourceLeaseExpiresAt: lease.expiresAt?.toISOString() ?? null,
      feedCursor: null,
    });

    // A page revision may replay only when its durable checksum still matches the committed feed.
    // Transient auction frames deliberately share that checksum and are bound to the request by the
    // browser's causal response handling rather than by this durable-board replay fence.
    if (
      context.feed.activePageSessionId === observation.pageSessionId &&
      context.feed.lastPageRevision !== null &&
      observation.revision < context.feed.lastPageRevision
    ) {
      return rejection(context.feed.state, "STALE_PAGE_REVISION");
    }
    if (
      context.feed.activePageSessionId === observation.pageSessionId &&
      context.feed.lastPageRevision === observation.revision
    ) {
      if (context.feed.lastChecksum !== observation.checksumSha256) {
        return rejection(context.feed.state, "STALE_PAGE_REVISION");
      }
      return {
        status: "idempotent",
        draftId: context.draftId,
        serverSequence: context.sequence,
        feedState: context.feed.state,
        acceptedChecksum: context.feed.lastChecksum,
        unresolvedTeams: 0,
        unresolvedPlayers: 0,
        issueCode: null,
        sourceLeaseExpiresAt: lease.expiresAt?.toISOString() ?? null,
        feedCursor: feedCursor(lease.generation, observation.revision),
      };
    }

    const teamResolver = new ProviderTeamResolver(context.teams);
    const playerResolver = new ProviderPlayerResolver(context.players, context.playerCrosswalk);

    const actions: ProviderDraftAction[] = [];
    let unresolvedTeams = 0;
    let unresolvedPlayers = 0;
    for (const pick of observation.picks) {
      const team = teamResolver.resolve({
        providerTeamId: pick.providerTeamId,
        teamName: pick.teamName,
      });
      const player = playerResolver.resolve({
        providerPlayerId: pick.providerPlayerId,
        playerName: pick.playerName,
        proTeam: pick.proTeam,
        position: pick.position,
      });
      if (team.status === "unresolved") unresolvedTeams += 1;
      if (player.status === "unresolved") unresolvedPlayers += 1;
      if (team.status === "unresolved" || player.status === "unresolved") continue;
      if (observation.draftType === "snake") {
        actions.push({
          kind: "snake-pick",
          overallPick: pick.sequence,
          teamId: team.id,
          playerId: player.id,
          keeper: pick.keeper,
        });
      } else {
        const price = pick.price;
        if (price === null) {
          throw new Error("Auction observation passed completeness without a pick price");
        }
        actions.push({
          kind: "auction-sale",
          teamId: team.id,
          playerId: player.id,
          price,
          keeper: pick.keeper,
        });
      }
    }

    // A single unmapped identity stops the board advancing. Advancing past it would silently
    // renumber every later pick. The observation is still recorded so the mapping gap is visible
    // to an operator rather than vanishing into a rejected response.
    if (unresolvedTeams > 0 || unresolvedPlayers > 0) {
      const issue: EspnLiveDraftIssueCode =
        unresolvedTeams > 0 ? "UNRESOLVED_TEAM" : "UNRESOLVED_PLAYER";
      const committed = await this.#repository.commitObservation({
        feedId: context.feed.id,
        draftId: context.draftId,
        deviceId: scope.deviceId,
        expectedSequence: context.sequence,
        expectedLeaseGeneration: lease.generation,
        expectedManualBackupActive: context.feed.manualBackupActive,
        append: [],
        observation,
        result: "held",
        issue,
        feedState: "degraded",
        transientAuction: null,
        pendingDestructiveChecksum: null,
        pendingDestructiveSeenCount: 0,
        unresolvedTeams,
        unresolvedPlayers,
        now,
      });
      if (!committed.committed) return standbyAfterLostCommit(committed.sequence);
      return {
        status: "held",
        draftId: context.draftId,
        serverSequence: committed.sequence,
        feedState: "degraded",
        acceptedChecksum: context.feed.lastChecksum,
        unresolvedTeams,
        unresolvedPlayers,
        issueCode: issue,
        sourceLeaseExpiresAt: lease.expiresAt?.toISOString() ?? null,
        feedCursor: feedCursor(lease.generation, observation.revision),
      };
    }

    // Manual backup freezes application but not validation: snapshots keep being recorded so the
    // operator can see how far the provider board has diverged before handing control back.
    if (context.feed.manualBackupActive) {
      const committed = await this.#repository.commitObservation({
        feedId: context.feed.id,
        draftId: context.draftId,
        deviceId: scope.deviceId,
        expectedSequence: context.sequence,
        expectedLeaseGeneration: lease.generation,
        expectedManualBackupActive: context.feed.manualBackupActive,
        append: [],
        observation,
        result: "held",
        issue: "MANUAL_BACKUP_ACTIVE",
        feedState: context.feed.state,
        transientAuction: null,
        pendingDestructiveChecksum: null,
        pendingDestructiveSeenCount: 0,
        unresolvedTeams: 0,
        unresolvedPlayers: 0,
        now,
      });
      if (!committed.committed) return standbyAfterLostCommit(committed.sequence);
      return {
        status: "held",
        draftId: context.draftId,
        serverSequence: committed.sequence,
        feedState: context.feed.state,
        acceptedChecksum: context.feed.lastChecksum,
        unresolvedTeams: 0,
        unresolvedPlayers: 0,
        issueCode: "MANUAL_BACKUP_ACTIVE",
        sourceLeaseExpiresAt: lease.expiresAt?.toISOString() ?? null,
        feedCursor: feedCursor(lease.generation, observation.revision),
      };
    }

    const destructiveConfirmed =
      context.feed.pendingDestructiveChecksum === observation.checksumSha256 &&
      context.feed.pendingDestructiveSeenCount + 1 >=
        ESPN_LIVE_DRAFT_LIMITS.destructiveConfirmations;

    const plan = reconcileProviderObservation({
      feedId: context.feed.id,
      config: context.config,
      events: context.events,
      observed: actions,
      occurredAt: now,
      destructiveConfirmed,
      eventIdFor: (key) =>
        `espn:${createHash("sha256").update(`${context.draftId}\0${key}`).digest("hex")}`,
    });

    const transientAuction = this.#transientAuction(observation, teamResolver, playerResolver, now);
    const feedState: EspnLiveDraftFeedStatus["state"] =
      observation.state === "complete"
        ? "complete"
        : observation.state === "paused"
          ? "paused"
          : observation.state === "waiting"
            ? "waiting"
            : "live";

    const base = {
      feedId: context.feed.id,
      draftId: context.draftId,
      deviceId: scope.deviceId,
      expectedSequence: context.sequence,
      expectedLeaseGeneration: lease.generation,
      expectedManualBackupActive: context.feed.manualBackupActive,
      observation,
      transientAuction,
      unresolvedTeams: 0,
      unresolvedPlayers: 0,
      now,
    } as const;

    switch (plan.kind) {
      case "held": {
        const committed = await this.#repository.commitObservation({
          ...base,
          append: [],
          result: "held",
          issue: plan.issue,
          feedState: "degraded",
          pendingDestructiveChecksum: null,
          pendingDestructiveSeenCount: 0,
        });
        if (!committed.committed) return standbyAfterLostCommit(committed.sequence);
        return {
          status: "held",
          draftId: context.draftId,
          serverSequence: committed.sequence,
          feedState: "degraded",
          acceptedChecksum: context.feed.lastChecksum,
          unresolvedTeams: 0,
          unresolvedPlayers: 0,
          issueCode: plan.issue,
          sourceLeaseExpiresAt: lease.expiresAt?.toISOString() ?? null,
          feedCursor: feedCursor(lease.generation, observation.revision),
        };
      }
      case "destructive-hold": {
        const seen =
          context.feed.pendingDestructiveChecksum === observation.checksumSha256
            ? context.feed.pendingDestructiveSeenCount + 1
            : 1;
        const committed = await this.#repository.commitObservation({
          ...base,
          append: [],
          result: "held",
          issue: "DESTRUCTIVE_PENDING",
          feedState,
          pendingDestructiveChecksum: observation.checksumSha256,
          pendingDestructiveSeenCount: seen,
        });
        if (!committed.committed) return standbyAfterLostCommit(committed.sequence);
        return {
          status: "held",
          draftId: context.draftId,
          serverSequence: committed.sequence,
          feedState,
          acceptedChecksum: context.feed.lastChecksum,
          unresolvedTeams: 0,
          unresolvedPlayers: 0,
          issueCode: "DESTRUCTIVE_PENDING",
          sourceLeaseExpiresAt: lease.expiresAt?.toISOString() ?? null,
          feedCursor: feedCursor(lease.generation, observation.revision),
        };
      }
      case "idempotent": {
        const committed = await this.#repository.commitObservation({
          ...base,
          append: [],
          result: "idempotent",
          issue: null,
          feedState,
          pendingDestructiveChecksum: null,
          pendingDestructiveSeenCount: 0,
        });
        if (!committed.committed) return standbyAfterLostCommit(committed.sequence);
        return {
          status: "idempotent",
          draftId: context.draftId,
          serverSequence: committed.sequence,
          feedState,
          acceptedChecksum: observation.checksumSha256,
          unresolvedTeams: 0,
          unresolvedPlayers: 0,
          issueCode: null,
          sourceLeaseExpiresAt: lease.expiresAt?.toISOString() ?? null,
          feedCursor: feedCursor(lease.generation, observation.revision),
        };
      }
      case "forward":
      case "destructive": {
        const committed = await this.#repository.commitObservation({
          ...base,
          append: plan.append,
          result: "accepted",
          issue: null,
          feedState,
          pendingDestructiveChecksum: null,
          pendingDestructiveSeenCount: 0,
        });
        if (!committed.committed) {
          return standbyAfterLostCommit(committed.sequence);
        }
        return {
          status: "accepted",
          draftId: context.draftId,
          serverSequence: committed.sequence,
          feedState,
          acceptedChecksum: observation.checksumSha256,
          unresolvedTeams: 0,
          unresolvedPlayers: 0,
          issueCode: null,
          sourceLeaseExpiresAt: lease.expiresAt?.toISOString() ?? null,
          feedCursor: feedCursor(lease.generation, observation.revision),
        };
      }
    }
  }

  /**
   * Freezes or resumes provider application for one room (plan §7.3, §16.5).
   *
   * Deliberately not gated on the ingest feature flag: a room frozen while the flag was on must
   * still be recoverable after it is turned off. Errors are `DraftSessionError`s because this is a
   * cookie-authenticated draft mutation, and it must fail exactly like its neighbours.
   *
   * The write is a boolean, never an event: no ledger row is appended, reverted, or deleted here,
   * so returning to provider control cannot revert a manual entry. A provider board that truly
   * diverges is still held by the reconciler, which refuses to rewrite a room containing manual
   * events (§14.4).
   */
  async setManualBackup(
    actorUserId: string,
    draftId: string,
    unsafeInput: DraftManualBackupRequest,
  ): Promise<ManualBackupOutcome> {
    const parsed = draftManualBackupRequestSchema.safeParse(unsafeInput);
    if (!parsed.success) {
      throw new DraftSessionError("DRAFT_INVALID_INPUT", "Manual backup input is invalid.");
    }
    const input = parsed.data;
    if (input.active && input.reconciliation !== undefined) {
      throw new DraftSessionError(
        "DRAFT_INVALID_INPUT",
        "A reconciliation choice only applies when returning to provider sync.",
      );
    }

    const context = await this.#repository.loadManualBackupContext(actorUserId, draftId);
    // No role and no draft are the same answer, so a probe cannot discover that a room exists.
    if (!context) {
      throw new DraftSessionError(
        "DRAFT_NOT_FOUND",
        "The draft session was not found for this account.",
      );
    }
    if (!mayMutate(context.accessRole)) {
      throw new DraftSessionError(
        "DRAFT_FORBIDDEN",
        "Only a league owner or commissioner can change manual backup mode.",
      );
    }
    if (context.archived) {
      throw new DraftSessionError(
        "DRAFT_FORBIDDEN",
        "Archived leagues cannot change draft backup mode.",
      );
    }
    if (context.feedId === null) {
      throw new DraftSessionError(
        "DRAFT_NOT_FOUND",
        "This draft room has no provider feed to fall back from.",
      );
    }

    const outcome = {
      draftId,
      active: input.active,
      reconciliation: input.reconciliation ?? null,
      pendingReconciliation: context.pendingReconciliation,
    } as const;

    // Already in the requested mode: a retry changes nothing, so it must not be answered with a
    // version conflict the caller cannot act on, nor made to supply a choice about nothing.
    if (context.manualBackupActive === input.active) return { ...outcome, changed: false };

    // Optimistic concurrency first: a caller reading a stale ledger is also reading a stale count
    // of held snapshots, so it cannot make the reconciliation choice honestly until it resyncs.
    if (context.sequence !== input.expectedSequence) {
      throw new DraftSessionError(
        "DRAFT_VERSION_CONFLICT",
        `Draft is at sequence ${context.sequence}; reconnect before writing.`,
        { currentSequence: context.sequence },
      );
    }
    if (!input.active && context.pendingReconciliation > 0 && input.reconciliation === undefined) {
      throw new DraftSessionError(
        "DRAFT_RECONCILIATION_REQUIRED",
        `${context.pendingReconciliation} provider snapshot(s) were held while manual backup was on. Choose accept-provider or keep-manual before provider control resumes.`,
      );
    }

    const result = await this.#repository.setManualBackupActive({
      feedId: context.feedId,
      draftId,
      expectedSequence: input.expectedSequence,
      active: input.active,
      now: this.#now(),
    });
    switch (result.status) {
      case "not-found":
        throw new DraftSessionError(
          "DRAFT_NOT_FOUND",
          "The draft session is no longer available to this account.",
        );
      case "version-conflict":
        throw new DraftSessionError(
          "DRAFT_VERSION_CONFLICT",
          `Draft is at sequence ${result.currentSequence}; reconnect before writing.`,
          { currentSequence: result.currentSequence },
        );
      case "updated":
        return { ...outcome, changed: true };
    }
  }

  #transientAuction(
    observation: EspnLiveDraftObservation,
    teamResolver: ProviderTeamResolver,
    playerResolver: ProviderPlayerResolver,
    now: Date,
  ): EspnLiveDraftTransientAuction | null {
    const auction = observation.currentAuction;
    if (!auction) return null;
    return resolveProviderAuction(auction, teamResolver, playerResolver, now);
  }
}
