import type { Player } from "./entities.js";
import { NFL_POSITIONS, type Position } from "./football.js";
import { rosterSlotId, type PlayerId, type RosterSlotId } from "./ids.js";

export const ROSTER_SLOT_TYPES = [
  "QB",
  "RB",
  "WR",
  "TE",
  "FLEX",
  "REC_FLEX",
  "SUPER_FLEX",
  "OP",
  "K",
  "DST",
  "DL",
  "LB",
  "DB",
  "IDP_FLEX",
  "BENCH",
  "IR",
  "TAXI",
] as const;

export type RosterSlotType = (typeof ROSTER_SLOT_TYPES)[number];
export type RosterSlotKind = "STARTER" | "BENCH" | "INJURED_RESERVE" | "TAXI";

export interface RosterSlot {
  readonly id: RosterSlotId;
  readonly type: RosterSlotType;
  readonly label: string;
  readonly kind: RosterSlotKind;
  readonly eligiblePositions: readonly Position[];
}

export interface RosterSlotRule {
  readonly type: RosterSlotType;
  readonly count: number;
  readonly label?: string;
  readonly kind?: RosterSlotKind;
  readonly eligiblePositions?: readonly Position[];
}

const DEFAULT_ELIGIBILITY: Readonly<Record<RosterSlotType, readonly Position[]>> = {
  QB: ["QB"],
  RB: ["RB"],
  WR: ["WR"],
  TE: ["TE"],
  FLEX: ["RB", "WR", "TE"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  OP: ["QB", "RB", "WR", "TE"],
  K: ["K"],
  DST: ["DST"],
  DL: ["DL"],
  LB: ["LB"],
  DB: ["DB"],
  IDP_FLEX: ["DL", "LB", "DB", "IDP"],
  BENCH: NFL_POSITIONS,
  IR: NFL_POSITIONS,
  TAXI: NFL_POSITIONS,
};

export function defaultEligibility(type: RosterSlotType): readonly Position[] {
  return DEFAULT_ELIGIBILITY[type];
}

export function defaultSlotKind(type: RosterSlotType): RosterSlotKind {
  switch (type) {
    case "BENCH":
      return "BENCH";
    case "IR":
      return "INJURED_RESERVE";
    case "TAXI":
      return "TAXI";
    default:
      return "STARTER";
  }
}

export function createRosterSlots(rules: readonly RosterSlotRule[]): readonly RosterSlot[] {
  const slots: RosterSlot[] = [];

  for (const rule of rules) {
    if (!Number.isSafeInteger(rule.count) || rule.count < 0) {
      throw new RangeError(`Roster slot count for ${rule.type} must be a non-negative integer`);
    }

    for (let index = 1; index <= rule.count; index += 1) {
      slots.push({
        id: rosterSlotId(`${rule.type}-${index}`),
        type: rule.type,
        label: rule.label === undefined ? `${rule.type} ${index}` : `${rule.label} ${index}`,
        kind: rule.kind ?? defaultSlotKind(rule.type),
        eligiblePositions: rule.eligiblePositions ?? defaultEligibility(rule.type),
      });
    }
  }

  const ids = new Set(slots.map((slot) => slot.id));
  if (ids.size !== slots.length) {
    throw new Error(
      "Roster slot rules produced duplicate slot IDs; combine rules of the same type",
    );
  }

  return slots;
}

export function isPlayerEligibleForSlot(player: Player, slot: RosterSlot): boolean {
  if (player.eligibleSlotTypes?.includes(slot.type) === true) {
    return true;
  }

  return player.positions.some((position) => slot.eligiblePositions.includes(position));
}

export interface RosterAssignment {
  readonly playerId: PlayerId;
  readonly slotId: RosterSlotId;
}

export interface RosterAssignmentResult {
  readonly feasible: boolean;
  readonly assignments: readonly RosterAssignment[];
  readonly unassignedPlayerIds: readonly PlayerId[];
}

/**
 * Finds a deterministic maximum-cardinality player-to-slot matching. This is
 * used for roster legality, not lineup scoring.
 */
export function assignPlayersToRosterSlots(
  players: readonly Player[],
  slots: readonly RosterSlot[],
): RosterAssignmentResult {
  const orderedPlayers = [...players].sort((left, right) => left.id.localeCompare(right.id));
  const orderedSlots = [...slots].sort((left, right) => left.id.localeCompare(right.id));
  const slotByPlayer = new Map<PlayerId, RosterSlotId>();
  const playerBySlot = new Map<RosterSlotId, PlayerId>();
  const playerLookup = new Map(orderedPlayers.map((player) => [player.id, player]));

  const tryAssign = (player: Player, visitedSlots: Set<RosterSlotId>): boolean => {
    for (const slot of orderedSlots) {
      if (visitedSlots.has(slot.id) || !isPlayerEligibleForSlot(player, slot)) {
        continue;
      }

      visitedSlots.add(slot.id);
      const occupyingPlayerId = playerBySlot.get(slot.id);
      if (occupyingPlayerId === undefined) {
        playerBySlot.set(slot.id, player.id);
        slotByPlayer.set(player.id, slot.id);
        return true;
      }

      const occupyingPlayer = playerLookup.get(occupyingPlayerId);
      if (occupyingPlayer !== undefined && tryAssign(occupyingPlayer, visitedSlots)) {
        playerBySlot.set(slot.id, player.id);
        slotByPlayer.set(player.id, slot.id);
        return true;
      }
    }

    return false;
  };

  const unassignedPlayerIds: PlayerId[] = [];
  for (const player of orderedPlayers) {
    if (!tryAssign(player, new Set())) {
      unassignedPlayerIds.push(player.id);
    }
  }

  const assignments = [...slotByPlayer.entries()]
    .map(([assignedPlayerId, slotId]) => ({ playerId: assignedPlayerId, slotId }))
    .sort((left, right) => left.slotId.localeCompare(right.slotId));

  return {
    feasible: unassignedPlayerIds.length === 0,
    assignments,
    unassignedPlayerIds,
  };
}
