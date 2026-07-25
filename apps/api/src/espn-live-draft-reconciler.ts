import { createHash } from "node:crypto";

import type { EspnLiveDraftIssueCode } from "@fantasy/contracts";
import type { DraftEventSource } from "@fantasy/db";
import { draftEventId, playerId, teamId } from "@fantasy/domain";
import {
  DraftInvariantError,
  reduceDraft,
  type DraftConfig,
  type DraftEvent,
} from "@fantasy/engine-draft";

import type { DraftSessionEventRecord } from "./draft-session.js";

/**
 * Reconciling an ESPN draft room against the Laces Out ledger.
 *
 * Every material upload is a full cumulative snapshot of the board, never a delta, so this module
 * is a pure function of (accepted event stream, observed board). It decides between four outcomes:
 * nothing changed, the board moved forward, the board contradicts accepted history, or the
 * observation cannot be trusted. It never mutates and never talks to the database — the caller
 * commits the plan atomically.
 *
 * The load-bearing rules, all from the plan's §14:
 *   - a rollback must be confirmed twice before it rewrites accepted history, because a
 *     half-rendered ESPN table is indistinguishable from a commissioner undo in a single frame;
 *   - manual events are never reverted here, only provider ones;
 *   - the candidate stream is reduced through the real draft engine before anything is persisted.
 */

export type ProviderDraftAction =
  | {
      readonly kind: "snake-pick";
      readonly overallPick: number;
      readonly teamId: string;
      readonly playerId: string;
      readonly keeper: boolean;
    }
  | {
      readonly kind: "auction-sale";
      readonly teamId: string;
      readonly playerId: string;
      readonly price: number;
      readonly keeper: boolean;
    };

export interface ProviderPendingEvent {
  readonly idempotencyKey: string;
  readonly source: DraftEventSource;
  readonly event: DraftEvent;
  /** Set only for reverts; points at the sequence of the event being undone. */
  readonly revertsSequence: number | null;
}

export type ReconciliationPlan =
  | { readonly kind: "idempotent" }
  | { readonly kind: "forward"; readonly append: readonly ProviderPendingEvent[] }
  | {
      /** A destructive difference seen for the first time. Hold it and wait for confirmation. */
      readonly kind: "destructive-hold";
      readonly commonPrefix: number;
      readonly supersededActions: number;
    }
  | {
      readonly kind: "destructive";
      readonly commonPrefix: number;
      readonly append: readonly ProviderPendingEvent[];
    }
  | { readonly kind: "held"; readonly issue: EspnLiveDraftIssueCode; readonly detail: string };

/**
 * Canonical order for provider actions.
 *
 * Keepers come first because ESPN assigns them before the draft runs and the snake reducer only
 * accepts a normal selection at the next *open* pick — a keeper sitting in a later round has to
 * have consumed its slot before the picks around it replay. Within each group, ascending pick
 * order. This ordering must stay stable as a draft progresses, otherwise ordinary forward movement
 * would read as a rewrite.
 */
export function canonicalProviderOrder(
  actions: readonly ProviderDraftAction[],
): readonly ProviderDraftAction[] {
  const rank = (action: ProviderDraftAction, index: number): number =>
    action.kind === "snake-pick" ? action.overallPick : index;
  const indexed = actions.map((action, index) => ({ action, index }));
  const keepers = indexed.filter((entry) => entry.action.keeper);
  const live = indexed.filter((entry) => !entry.action.keeper);
  const byRank = (
    left: { action: ProviderDraftAction; index: number },
    right: { action: ProviderDraftAction; index: number },
  ): number => rank(left.action, left.index) - rank(right.action, right.index);
  return [...keepers.sort(byRank), ...live.sort(byRank)].map((entry) => entry.action);
}

/** Stable identity of an action, independent of when or how often it was observed. */
export function providerActionFingerprint(action: ProviderDraftAction): string {
  const tuple =
    action.kind === "snake-pick"
      ? ["snake-pick", action.overallPick, action.keeper, action.teamId, action.playerId]
      : ["auction-sale", action.keeper, action.teamId, action.playerId, action.price];
  return createHash("sha256").update(JSON.stringify(tuple), "utf8").digest("hex").slice(0, 16);
}

function baseKey(feedId: string, action: ProviderDraftAction, saleSequence: number): string {
  return action.kind === "snake-pick"
    ? `espn-live:${feedId}:snake-pick:${action.overallPick}`
    : `espn-live:${feedId}:auction-sale:${saleSequence}`;
}

/**
 * Reverted events keep their idempotency key forever, so re-picking the same slot with the same
 * player after a rollback would collide. The generation counter — how many events already claim
 * this slot — keeps the key deterministic for a replayed upload while still being unique across
 * successive rollbacks of the same slot.
 */
function generationOf(usedKeys: ReadonlyMap<string, number>, base: string): number {
  return usedKeys.get(base) ?? 0;
}

function providerEventFor(
  action: ProviderDraftAction,
  eventId: string,
  occurredAt: string,
): DraftEvent {
  if (action.kind === "snake-pick") {
    return {
      id: draftEventId(eventId),
      type: action.keeper ? "SNAKE_KEEPER_ASSIGNED" : "SNAKE_PLAYER_SELECTED",
      teamId: teamId(action.teamId),
      playerId: playerId(action.playerId),
      overallPick: action.overallPick,
      occurredAt,
    };
  }
  return {
    id: draftEventId(eventId),
    type: action.keeper ? "AUCTION_KEEPER_ASSIGNED" : "AUCTION_PLAYER_SOLD",
    teamId: teamId(action.teamId),
    playerId: playerId(action.playerId),
    price: action.price,
    occurredAt,
  };
}

export interface AcceptedProviderAction {
  readonly action: ProviderDraftAction;
  readonly sequence: number;
  readonly eventId: string;
  readonly idempotencyKey: string;
}

/**
 * Recovers the provider actions currently standing in the ledger.
 *
 * Reverted events are dropped, and manual events are ignored here but reported separately so the
 * caller can refuse to rewrite a room a human has been editing.
 */
export function acceptedProviderActions(events: readonly DraftSessionEventRecord[]): {
  readonly actions: readonly AcceptedProviderAction[];
  readonly manualActionSequences: readonly number[];
  readonly usedKeys: ReadonlyMap<string, number>;
} {
  const reverted = new Set<string>();
  for (const record of events) {
    if (record.event.type === "DRAFT_EVENT_REVERTED") reverted.add(record.event.targetEventId);
  }
  const actions: AcceptedProviderAction[] = [];
  const manualActionSequences: number[] = [];
  const usedKeys = new Map<string, number>();
  for (const record of events) {
    const event = record.event;
    if (event.type === "DRAFT_EVENT_REVERTED") continue;
    // Count every claimed slot key, reverted or not — that is what makes the generation counter
    // collision-proof across repeated rollbacks.
    const separator = record.idempotencyKey.lastIndexOf(":");
    if (record.source === "espn" && separator > 0) {
      const base = record.idempotencyKey.slice(0, separator);
      usedKeys.set(base, (usedKeys.get(base) ?? 0) + 1);
    }
    if (reverted.has(event.id)) continue;
    if (record.source === "manual") {
      manualActionSequences.push(record.sequence);
      continue;
    }
    if (record.source !== "espn") continue;
    switch (event.type) {
      case "SNAKE_PLAYER_SELECTED":
      case "SNAKE_KEEPER_ASSIGNED":
        actions.push({
          action: {
            kind: "snake-pick",
            overallPick: event.overallPick,
            teamId: event.teamId,
            playerId: event.playerId,
            keeper: event.type === "SNAKE_KEEPER_ASSIGNED",
          },
          sequence: record.sequence,
          eventId: event.id,
          idempotencyKey: record.idempotencyKey,
        });
        break;
      case "AUCTION_PLAYER_SOLD":
      case "AUCTION_KEEPER_ASSIGNED":
        actions.push({
          action: {
            kind: "auction-sale",
            teamId: event.teamId,
            playerId: event.playerId,
            price: event.price,
            keeper: event.type === "AUCTION_KEEPER_ASSIGNED",
          },
          sequence: record.sequence,
          eventId: event.id,
          idempotencyKey: record.idempotencyKey,
        });
        break;
      default:
        break;
    }
  }
  return { actions, manualActionSequences, usedKeys };
}

export interface ReconcileInput {
  readonly feedId: string;
  readonly config: DraftConfig;
  readonly events: readonly DraftSessionEventRecord[];
  /** Observed board, already mapped to internal team and player identities. */
  readonly observed: readonly ProviderDraftAction[];
  readonly occurredAt: Date;
  /**
   * True once the identical destructive snapshot has been seen enough times to be trusted.
   * The caller owns that counter because it is durable feed state, not a property of one payload.
   */
  readonly destructiveConfirmed: boolean;
  readonly eventIdFor: (idempotencyKey: string) => string;
}

export function reconcileProviderObservation(input: ReconcileInput): ReconciliationPlan {
  const {
    actions: accepted,
    manualActionSequences,
    usedKeys,
  } = acceptedProviderActions(input.events);
  const observed = canonicalProviderOrder(input.observed);

  let commonPrefix = 0;
  while (
    commonPrefix < accepted.length &&
    commonPrefix < observed.length &&
    providerActionFingerprint(accepted[commonPrefix]!.action) ===
      providerActionFingerprint(observed[commonPrefix]!)
  ) {
    commonPrefix += 1;
  }

  const superseded = accepted.slice(commonPrefix);
  const additions = observed.slice(commonPrefix);

  if (superseded.length === 0 && additions.length === 0) return { kind: "idempotent" };

  if (superseded.length > 0) {
    if (manualActionSequences.length > 0) {
      return {
        kind: "held",
        issue: "MANUAL_BACKUP_ACTIVE",
        detail:
          "Manual draft events exist in this room, so provider history cannot be rewritten automatically.",
      };
    }
    if (!input.destructiveConfirmed) {
      return { kind: "destructive-hold", commonPrefix, supersededActions: superseded.length };
    }
  }

  const occurredAt = input.occurredAt.toISOString();
  const append: ProviderPendingEvent[] = [];
  const generations = new Map(usedKeys);

  // Reverts run newest-first so the ledger reads as an unwind rather than an arbitrary set.
  for (const stale of [...superseded].reverse()) {
    const revertKey = `espn-live:${input.feedId}:revert:${stale.sequence}:${providerActionFingerprint(
      observed[commonPrefix] ?? stale.action,
    )}`;
    append.push({
      idempotencyKey: revertKey,
      source: "espn",
      revertsSequence: stale.sequence,
      event: {
        id: draftEventId(input.eventIdFor(revertKey)),
        type: "DRAFT_EVENT_REVERTED",
        targetEventId: draftEventId(stale.eventId),
        occurredAt,
      },
    });
  }

  for (const [offset, action] of additions.entries()) {
    const saleSequence = commonPrefix + offset + 1;
    const base = baseKey(input.feedId, action, saleSequence);
    const generation = generationOf(generations, base);
    generations.set(base, generation + 1);
    const suffix = `${providerActionFingerprint(action)}${generation > 0 ? `-${generation}` : ""}`;
    const idempotencyKey = `${base}:${suffix}`;
    append.push({
      idempotencyKey,
      source: "espn",
      revertsSequence: null,
      event: providerEventFor(action, input.eventIdFor(idempotencyKey), occurredAt),
    });
  }

  if (append.length === 0) return { kind: "idempotent" };

  // Prove the whole candidate stream is legal before the caller is allowed to persist any of it.
  const candidate = [
    ...input.events.map((record) => record.event),
    ...append.map((pending) => pending.event),
  ];
  try {
    reduceDraft(input.config, candidate);
  } catch (error) {
    if (error instanceof DraftInvariantError) {
      return {
        kind: "held",
        issue: "REDUCER_INVARIANT",
        detail: `Observed board violates a draft invariant (${error.code}).`,
      };
    }
    throw error;
  }

  return superseded.length > 0
    ? { kind: "destructive", commonPrefix, append }
    : { kind: "forward", append };
}
