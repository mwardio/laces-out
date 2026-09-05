import { createHash } from "node:crypto";

import { draftEventId, playerId, teamId } from "@laces-out/domain";
import {
  DraftInvariantError,
  reduceDraft,
  type DraftConfig,
  type DraftEvent,
} from "@laces-out/engine-draft";

/** Yahoo's cumulative, one-based representation of a completed draft action. */
export interface YahooDraftPick {
  readonly pick: number;
  readonly round: number | null;
  readonly teamKey: string;
  readonly playerKey: string;
  readonly cost: number | null;
  readonly keeper?: boolean | null;
}

/**
 * The reconciler needs only the completeness signal and picks from the larger Yahoo artifact.
 * Connector snapshots with additional metadata are therefore structurally assignable to this type.
 */
export interface YahooDraftSnapshot {
  readonly collectionComplete: boolean;
  readonly picks: readonly YahooDraftPick[];
}

export type YahooDraftMode = "snake" | "auction";

/** A bounded, log-safe reason why no Yahoo events were admitted. */
export type YahooDraftReconciliationIssueCode =
  | "INCOMPLETE_SNAPSHOT"
  | "PICK_SEQUENCE_GAP"
  | "DRAFT_TYPE_MISMATCH"
  | "TEAM_COUNT_MISMATCH"
  | "KEEPER_SCOPE_UNVALIDATED"
  | "UNRESOLVED_TEAM"
  | "UNRESOLVED_PLAYER"
  | "SNAKE_COST_PRESENT"
  | "AUCTION_COST_MISSING"
  | "AUCTION_COST_INVALID"
  | "HISTORY_TRUNCATED"
  | "HISTORY_DIVERGED"
  | "COMPLETED_COUNT_MISMATCH"
  | "PROVIDER_STATUS_UNSUPPORTED"
  | "REDUCER_INVARIANT";

export type YahooDraftActionEvent = Extract<
  DraftEvent,
  { readonly type: "SNAKE_PLAYER_SELECTED" | "AUCTION_PLAYER_SOLD" }
>;

/** Persistence-ready append proposed by the pure reconciler. */
export interface YahooDraftPendingEvent {
  readonly idempotencyKey: string;
  readonly source: "yahoo";
  readonly revertsSequence: null;
  readonly event: YahooDraftActionEvent;
}

export type YahooDraftReconciliationResult =
  | { readonly kind: "idempotent"; readonly append: readonly [] }
  | { readonly kind: "append"; readonly append: readonly YahooDraftPendingEvent[] }
  | {
      readonly kind: "held";
      readonly issue: YahooDraftReconciliationIssueCode;
      readonly detail: string;
      readonly append: readonly [];
    };

export interface ReconcileYahooDraftSnapshotInput {
  readonly feedId: string;
  readonly draftId: string;
  /** Draft type reported by Yahoo league settings. */
  readonly draftMode: YahooDraftMode;
  readonly config: DraftConfig;
  readonly snapshot: YahooDraftSnapshot;
  /** Exact Yahoo team-key to internal team-ID mappings. */
  readonly teamIdByKey: ReadonlyMap<string, string>;
  /** Exact Yahoo player-key to internal player-ID mappings. */
  readonly playerIdByKey: ReadonlyMap<string, string>;
  /**
   * The entire current active ledger, in action order. The caller resolves reverts before calling.
   * Provenance is deliberately absent: matching manual actions confirm Yahoo facts too.
   */
  readonly activeEvents: readonly DraftEvent[];
  /** Explicit commissioner confirmation that this room has neither keepers nor traded picks. */
  readonly standardScopeConfirmed: boolean;
  readonly occurredAt: Date;
}

type ProviderEquivalentAction =
  | {
      readonly mode: "snake";
      readonly providerPick: number;
      readonly teamId: string;
      readonly playerId: string;
    }
  | {
      readonly mode: "auction";
      readonly providerPick: number;
      readonly teamId: string;
      readonly playerId: string;
      readonly cost: number;
    };

interface ResolvedPick {
  readonly pick: YahooDraftPick;
  readonly action: ProviderEquivalentAction;
}

function held(
  issue: YahooDraftReconciliationIssueCode,
  detail: string,
): YahooDraftReconciliationResult {
  return { kind: "held", issue, detail, append: [] };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Stable across polls and process restarts. The raw provider keys stay inside the digest so an
 * idempotency key is bounded even if a future Yahoo key format grows.
 */
export function yahooDraftPickIdempotencyKey(input: {
  readonly feedId: string;
  readonly draftId: string;
  readonly draftMode: YahooDraftMode;
  readonly pick: YahooDraftPick;
}): string {
  const providerFact = JSON.stringify([
    "yahoo-draft-pick-v1",
    input.feedId,
    input.draftId,
    input.draftMode,
    input.pick.pick,
    input.pick.round,
    input.pick.teamKey,
    input.pick.playerKey,
    input.pick.cost,
  ]);
  return `yahoo-draft:${sha256(providerFact)}`;
}

function eventIdFor(draftId: string, idempotencyKey: string) {
  return draftEventId(`yahoo:${sha256(`${draftId}\0${idempotencyKey}`)}`);
}

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function ledgerActions(events: readonly DraftEvent[]): readonly ProviderEquivalentAction[] {
  const actions: ProviderEquivalentAction[] = [];
  let auctionPick = 0;
  for (const event of events) {
    switch (event.type) {
      case "SNAKE_PLAYER_SELECTED":
      case "SNAKE_KEEPER_ASSIGNED":
        actions.push({
          mode: "snake",
          providerPick: event.overallPick,
          teamId: event.teamId,
          playerId: event.playerId,
        });
        break;
      case "AUCTION_PLAYER_SOLD":
      case "AUCTION_KEEPER_ASSIGNED":
        auctionPick += 1;
        actions.push({
          mode: "auction",
          providerPick: auctionPick,
          teamId: event.teamId,
          playerId: event.playerId,
          cost: event.price,
        });
        break;
      case "AUCTION_NOMINATION_STARTED":
      case "AUCTION_BID_PLACED":
      case "DRAFT_EVENT_REVERTED":
        break;
    }
  }
  return actions;
}

function sameAction(left: ProviderEquivalentAction, right: ProviderEquivalentAction): boolean {
  if (
    left.mode !== right.mode ||
    left.providerPick !== right.providerPick ||
    left.teamId !== right.teamId ||
    left.playerId !== right.playerId
  ) {
    return false;
  }
  return left.mode === "snake" || (right.mode === "auction" && left.cost === right.cost);
}

function actionEvent(
  input: ReconcileYahooDraftSnapshotInput,
  resolved: ResolvedPick,
  idempotencyKey: string,
  occurredAt: string,
): YahooDraftActionEvent {
  const base = {
    id: eventIdFor(input.draftId, idempotencyKey),
    teamId: teamId(resolved.action.teamId),
    playerId: playerId(resolved.action.playerId),
    occurredAt,
  };
  return resolved.action.mode === "snake"
    ? {
        ...base,
        type: "SNAKE_PLAYER_SELECTED",
        overallPick: resolved.action.providerPick,
      }
    : { ...base, type: "AUCTION_PLAYER_SOLD", price: resolved.action.cost };
}

function reducerIssue(
  config: DraftConfig,
  candidate: readonly DraftEvent[],
): YahooDraftReconciliationResult | null {
  try {
    reduceDraft(config, candidate);
    return null;
  } catch (error) {
    if (error instanceof DraftInvariantError) {
      return held(
        "REDUCER_INVARIANT",
        `Candidate ledger violates a draft invariant (${error.code}).`,
      );
    }
    throw error;
  }
}

/**
 * Reconciles one complete cumulative Yahoo snapshot without mutating accepted history.
 *
 * Existing active acquisitions, whether manual or Yahoo-authored, must be an exact prefix of the
 * observation. A mismatch is held forever unless an operator changes the ledger outside this
 * function: this function never proposes a revert, deletion, or correction.
 */
export function reconcileYahooDraftSnapshot(
  input: ReconcileYahooDraftSnapshotInput,
): YahooDraftReconciliationResult {
  if (
    !input.standardScopeConfirmed ||
    input.activeEvents.some(
      (event) => event.type === "SNAKE_KEEPER_ASSIGNED" || event.type === "AUCTION_KEEPER_ASSIGNED",
    )
  ) {
    return held(
      "KEEPER_SCOPE_UNVALIDATED",
      "Yahoo assistance is limited to a confirmed draft with no keepers or traded picks.",
    );
  }
  if (!input.snapshot.collectionComplete) {
    return held("INCOMPLETE_SNAPSHOT", "Yahoo's draft result collection was incomplete.");
  }

  const expectedConfigMode = input.draftMode === "snake" ? "SNAKE" : "AUCTION";
  if (input.config.mode !== expectedConfigMode) {
    return held("DRAFT_TYPE_MISMATCH", "Yahoo's draft type does not match the draft room.");
  }

  for (const [index, pick] of input.snapshot.picks.entries()) {
    if (
      pick.pick !== index + 1 ||
      !validPositiveInteger(pick.pick) ||
      (pick.round !== null && !validPositiveInteger(pick.round))
    ) {
      return held(
        "PICK_SEQUENCE_GAP",
        "Yahoo's draft results were not a contiguous one-based sequence.",
      );
    }
    if (pick.keeper === true) {
      return held(
        "KEEPER_SCOPE_UNVALIDATED",
        "Yahoo marked a keeper pick, which requires separate admission evidence.",
      );
    }
    if (input.draftMode === "snake" && pick.cost !== null) {
      return held("SNAKE_COST_PRESENT", "A snake draft result unexpectedly included a cost.");
    }
    if (input.draftMode === "auction" && pick.cost === null) {
      return held("AUCTION_COST_MISSING", "An auction draft result omitted its sale cost.");
    }
    if (
      input.draftMode === "auction" &&
      pick.cost !== null &&
      (!Number.isSafeInteger(pick.cost) || pick.cost < 0)
    ) {
      return held("AUCTION_COST_INVALID", "An auction sale cost was not a non-negative integer.");
    }
  }

  const configuredTeams = new Set<string>(input.config.teams.map((team) => team.id));
  const configuredPlayers = new Set<string>(input.config.players.map((player) => player.id));
  const resolved: ResolvedPick[] = [];
  for (const pick of input.snapshot.picks) {
    const mappedTeamId = input.teamIdByKey.get(pick.teamKey);
    if (mappedTeamId === undefined || !configuredTeams.has(mappedTeamId)) {
      return held("UNRESOLVED_TEAM", "A Yahoo team key has no exact draft-room mapping.");
    }
    const mappedPlayerId = input.playerIdByKey.get(pick.playerKey);
    if (mappedPlayerId === undefined || !configuredPlayers.has(mappedPlayerId)) {
      return held("UNRESOLVED_PLAYER", "A Yahoo player key has no exact draft-room mapping.");
    }
    resolved.push({
      pick,
      action:
        input.draftMode === "snake"
          ? {
              mode: "snake",
              providerPick: pick.pick,
              teamId: mappedTeamId,
              playerId: mappedPlayerId,
            }
          : {
              mode: "auction",
              providerPick: pick.pick,
              teamId: mappedTeamId,
              playerId: mappedPlayerId,
              cost: pick.cost!,
            },
    });
  }

  const existing = ledgerActions(input.activeEvents);
  if (existing.some((action) => action.mode !== input.draftMode)) {
    return held("DRAFT_TYPE_MISMATCH", "The active ledger contains another draft mode.");
  }
  if (existing.length > resolved.length) {
    return held("HISTORY_TRUNCATED", "Yahoo's snapshot ended before the active draft ledger.");
  }
  for (const [index, accepted] of existing.entries()) {
    if (!sameAction(accepted, resolved[index]!.action)) {
      return held("HISTORY_DIVERGED", "Yahoo's snapshot differs from the active draft ledger.");
    }
  }

  const occurredAt = input.occurredAt.toISOString();
  const append = resolved.slice(existing.length).map<YahooDraftPendingEvent>((item) => {
    const idempotencyKey = yahooDraftPickIdempotencyKey({
      feedId: input.feedId,
      draftId: input.draftId,
      draftMode: input.draftMode,
      pick: item.pick,
    });
    return {
      idempotencyKey,
      source: "yahoo",
      revertsSequence: null,
      event: actionEvent(input, item, idempotencyKey, occurredAt),
    };
  });

  const invariant = reducerIssue(input.config, [
    ...input.activeEvents,
    ...append.map((pending) => pending.event),
  ]);
  if (invariant !== null) return invariant;
  return append.length === 0 ? { kind: "idempotent", append: [] } : { kind: "append", append };
}
