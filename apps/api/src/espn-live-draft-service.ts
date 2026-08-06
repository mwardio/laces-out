import { createHash } from "node:crypto";

import {
  ESPN_LIVE_DRAFT_LIMITS,
  draftManualBackupRequestSchema,
  espnLiveDraftDigestSource,
  type DraftManualBackupReconciliation,
  type DraftManualBackupRequest,
  type EspnLiveDraftFeedStatus,
  type EspnLiveDraftIngestRequest,
  type EspnLiveDraftIngestResponse,
  type EspnLiveDraftIssueCode,
  type EspnLiveDraftObservation,
  type EspnLiveDraftTransientAuction,
} from "@laces-out/contracts";
import type { LeagueMembershipRole } from "@laces-out/db";
import type { DraftConfig } from "@laces-out/engine-draft";

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
  "UNAUTHORIZED" | "OUT_OF_SCOPE" | "STALE" | "CHECKSUM" | "DISABLED";

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
          : code === "DISABLED"
            ? 503
            : 400;
  }
}

export interface LiveDraftDeviceScope {
  readonly deviceId: string;
  readonly userId: string;
  readonly leagueSeasonId: string;
  readonly providerLeagueId: string;
  readonly season: number;
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

export interface CommitProviderEventsInput {
  readonly feedId: string;
  readonly draftId: string;
  readonly deviceId: string;
  readonly expectedSequence: number;
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
  loadSessionContext(
    scope: LiveDraftDeviceScope,
    observation: EspnLiveDraftObservation,
  ): Promise<LiveDraftSessionContext | undefined>;
  claimLease(input: {
    readonly feedId: string;
    readonly deviceId: string;
    readonly pageSessionId: string;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<{ readonly granted: boolean; readonly expiresAt: Date | null }>;
  commitObservation(input: CommitProviderEventsInput): Promise<{ readonly sequence: number }>;
  recordHeartbeat(input: {
    readonly scope: LiveDraftDeviceScope;
    readonly pageSessionId: string;
    readonly state: EspnLiveDraftObservation["state"];
    readonly now: Date;
  }): Promise<EspnLiveDraftFeedStatus | undefined>;
  loadFeedStatus(draftId: string): Promise<EspnLiveDraftFeedStatus | undefined>;
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
  return null;
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
      };
    }

    // A page that rewinds its own revision is a stale retry from the same tab, not new truth.
    if (
      context.feed.activePageSessionId === observation.pageSessionId &&
      context.feed.lastPageRevision !== null &&
      observation.revision < context.feed.lastPageRevision &&
      context.feed.lastChecksum !== observation.checksumSha256
    ) {
      return rejection(context.feed.state, "STALE_PAGE_REVISION");
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
      actions.push(
        observation.draftType === "snake"
          ? {
              kind: "snake-pick",
              overallPick: pick.sequence,
              teamId: team.id,
              playerId: player.id,
              keeper: pick.keeper,
            }
          : {
              kind: "auction-sale",
              teamId: team.id,
              playerId: player.id,
              price: pick.price ?? 0,
              keeper: pick.keeper,
            },
      );
    }

    // A single unmapped identity stops the board advancing. Advancing past it would silently
    // renumber every later pick. The observation is still recorded so the mapping gap is visible
    // to an operator rather than vanishing into a rejected response.
    if (unresolvedTeams > 0 || unresolvedPlayers > 0) {
      const issue: EspnLiveDraftIssueCode =
        unresolvedTeams > 0 ? "UNRESOLVED_TEAM" : "UNRESOLVED_PLAYER";
      await this.#repository.commitObservation({
        feedId: context.feed.id,
        draftId: context.draftId,
        deviceId: scope.deviceId,
        expectedSequence: context.sequence,
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
      return {
        status: "held",
        draftId: context.draftId,
        serverSequence: context.sequence,
        feedState: "degraded",
        acceptedChecksum: context.feed.lastChecksum,
        unresolvedTeams,
        unresolvedPlayers,
        issueCode: issue,
        sourceLeaseExpiresAt: lease.expiresAt?.toISOString() ?? null,
      };
    }

    // Manual backup freezes application but not validation: snapshots keep being recorded so the
    // operator can see how far the provider board has diverged before handing control back.
    if (context.feed.manualBackupActive) {
      await this.#repository.commitObservation({
        feedId: context.feed.id,
        draftId: context.draftId,
        deviceId: scope.deviceId,
        expectedSequence: context.sequence,
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
      return {
        status: "held",
        draftId: context.draftId,
        serverSequence: context.sequence,
        feedState: context.feed.state,
        acceptedChecksum: context.feed.lastChecksum,
        unresolvedTeams: 0,
        unresolvedPlayers: 0,
        issueCode: "MANUAL_BACKUP_ACTIVE",
        sourceLeaseExpiresAt: lease.expiresAt?.toISOString() ?? null,
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
      observation,
      transientAuction,
      unresolvedTeams: 0,
      unresolvedPlayers: 0,
      now,
    } as const;

    switch (plan.kind) {
      case "held": {
        await this.#repository.commitObservation({
          ...base,
          append: [],
          result: "held",
          issue: plan.issue,
          feedState: "degraded",
          pendingDestructiveChecksum: null,
          pendingDestructiveSeenCount: 0,
        });
        return {
          status: "held",
          draftId: context.draftId,
          serverSequence: context.sequence,
          feedState: "degraded",
          acceptedChecksum: context.feed.lastChecksum,
          unresolvedTeams: 0,
          unresolvedPlayers: 0,
          issueCode: plan.issue,
          sourceLeaseExpiresAt: lease.expiresAt?.toISOString() ?? null,
        };
      }
      case "destructive-hold": {
        const seen =
          context.feed.pendingDestructiveChecksum === observation.checksumSha256
            ? context.feed.pendingDestructiveSeenCount + 1
            : 1;
        await this.#repository.commitObservation({
          ...base,
          append: [],
          result: "held",
          issue: "DESTRUCTIVE_PENDING",
          feedState,
          pendingDestructiveChecksum: observation.checksumSha256,
          pendingDestructiveSeenCount: seen,
        });
        return {
          status: "held",
          draftId: context.draftId,
          serverSequence: context.sequence,
          feedState,
          acceptedChecksum: context.feed.lastChecksum,
          unresolvedTeams: 0,
          unresolvedPlayers: 0,
          issueCode: "DESTRUCTIVE_PENDING",
          sourceLeaseExpiresAt: lease.expiresAt?.toISOString() ?? null,
        };
      }
      case "idempotent": {
        await this.#repository.commitObservation({
          ...base,
          append: [],
          result: "idempotent",
          issue: null,
          feedState,
          pendingDestructiveChecksum: null,
          pendingDestructiveSeenCount: 0,
        });
        return {
          status: "idempotent",
          draftId: context.draftId,
          serverSequence: context.sequence,
          feedState,
          acceptedChecksum: observation.checksumSha256,
          unresolvedTeams: 0,
          unresolvedPlayers: 0,
          issueCode: null,
          sourceLeaseExpiresAt: lease.expiresAt?.toISOString() ?? null,
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
    const nominator =
      auction.nominatingProviderTeamId === null
        ? null
        : teamResolver.resolve({
            providerTeamId: auction.nominatingProviderTeamId,
            teamName: "",
          });
    const highBidder =
      auction.highBidProviderTeamId === null
        ? null
        : teamResolver.resolve({ providerTeamId: auction.highBidProviderTeamId, teamName: "" });
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
      observedAt: now.toISOString(),
    };
  }
}
