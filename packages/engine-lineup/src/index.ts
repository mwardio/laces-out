import {
  isPlayerEligibleForSlot,
  projectionFor,
  type Player,
  type PlayerId,
  type ProjectionLookup,
  type ProjectionMetric,
  type RosterSlot,
  type RosterSlotId,
} from "@fantasy/domain";

export type LineupLock =
  | {
      readonly playerId: PlayerId;
      readonly kind: "STARTER";
      readonly slotId: RosterSlotId;
    }
  | {
      readonly playerId: PlayerId;
      readonly kind: "BENCH";
    };

export interface LineupAssignmentInput {
  readonly playerId: PlayerId;
  readonly slotId: RosterSlotId;
}

export interface OptimizeLineupInput {
  readonly players: readonly Player[];
  /** Non-starter slots are intentionally ignored and returned as bench. */
  readonly slots: readonly RosterSlot[];
  readonly projections: ProjectionLookup;
  readonly metric?: ProjectionMetric;
  readonly locks?: readonly LineupLock[];
  readonly currentAssignments?: readonly LineupAssignmentInput[];
}

export type LineupDiagnosticCode =
  | "DUPLICATE_PLAYER"
  | "DUPLICATE_SLOT"
  | "DUPLICATE_LOCK"
  | "UNKNOWN_LOCKED_PLAYER"
  | "UNKNOWN_LOCKED_SLOT"
  | "INELIGIBLE_LOCK"
  | "CONFLICTING_SLOT_LOCK"
  | "MISSING_PROJECTION"
  | "INVALID_PROJECTION"
  | "UNFILLED_SLOT";

export interface LineupDiagnostic {
  readonly code: LineupDiagnosticCode;
  readonly message: string;
  readonly playerId?: PlayerId;
  readonly slotId?: RosterSlotId;
}

export interface LineupAssignment {
  readonly playerId: PlayerId;
  readonly slotId: RosterSlotId;
  readonly projectedPoints: number;
  readonly locked: boolean;
  readonly explanation: string;
  readonly advantageOverNextEligible: number | null;
}

export interface LineupChange {
  readonly slotId: RosterSlotId;
  readonly removePlayerId: PlayerId | null;
  readonly addPlayerId: PlayerId | null;
  readonly projectedPointDelta: number;
  readonly explanation: string;
}

export interface LineupOptimizationResult {
  /** False when constraints conflict or not every starter slot can be filled. */
  readonly feasible: boolean;
  readonly metric: ProjectionMetric;
  readonly assignments: readonly LineupAssignment[];
  readonly benchPlayerIds: readonly PlayerId[];
  readonly unfilledSlotIds: readonly RosterSlotId[];
  readonly projectedPoints: number;
  readonly changes: readonly LineupChange[];
  readonly diagnostics: readonly LineupDiagnostic[];
}

interface DynamicAssignment {
  readonly player: Player;
  readonly slot: RosterSlot;
  readonly score: number;
}

interface DynamicCandidate {
  readonly score: number;
  readonly assignments: readonly DynamicAssignment[];
}

const SCORE_EPSILON = 1e-9;

function scoreFor(
  projections: ProjectionLookup,
  playerId: PlayerId,
  metric: ProjectionMetric,
  diagnostics: LineupDiagnostic[],
  playersWithProjectionDiagnostic: Set<PlayerId>,
): number {
  const projection = projectionFor(projections, playerId);
  if (projection === undefined) {
    if (!playersWithProjectionDiagnostic.has(playerId)) {
      diagnostics.push({
        code: "MISSING_PROJECTION",
        message: `No projection was available for player ${playerId}; zero was used`,
        playerId,
      });
      playersWithProjectionDiagnostic.add(playerId);
    }
    return 0;
  }

  const score = projection[metric];
  if (!Number.isFinite(score)) {
    if (!playersWithProjectionDiagnostic.has(playerId)) {
      diagnostics.push({
        code: "INVALID_PROJECTION",
        message: `The ${metric} projection for player ${playerId} was not finite; zero was used`,
        playerId,
      });
      playersWithProjectionDiagnostic.add(playerId);
    }
    return 0;
  }

  return score;
}

function assignmentSignature(assignments: readonly DynamicAssignment[]): string {
  return [...assignments]
    .sort((left, right) => left.slot.id.localeCompare(right.slot.id))
    .map((assignment) => `${assignment.slot.id}:${assignment.player.id}`)
    .join("|");
}

function isBetterForSameMask(candidate: DynamicCandidate, incumbent: DynamicCandidate): boolean {
  if (candidate.score > incumbent.score + SCORE_EPSILON) {
    return true;
  }
  if (Math.abs(candidate.score - incumbent.score) <= SCORE_EPSILON) {
    return assignmentSignature(candidate.assignments) < assignmentSignature(incumbent.assignments);
  }
  return false;
}

function bitCount(value: number): number {
  let remaining = value;
  let count = 0;
  while (remaining !== 0) {
    remaining &= remaining - 1;
    count += 1;
  }
  return count;
}

function fatalResult(
  players: readonly Player[],
  metric: ProjectionMetric,
  diagnostics: readonly LineupDiagnostic[],
): LineupOptimizationResult {
  return {
    feasible: false,
    metric,
    assignments: [],
    benchPlayerIds: [...players].map((player) => player.id).sort((a, b) => a.localeCompare(b)),
    unfilledSlotIds: [],
    projectedPoints: 0,
    changes: [],
    diagnostics,
  };
}

export function optimizeLineup(input: OptimizeLineupInput): LineupOptimizationResult {
  const metric = input.metric ?? "mean";
  const diagnostics: LineupDiagnostic[] = [];
  const projectionDiagnostics = new Set<PlayerId>();
  const starterSlots = input.slots
    .filter((slot) => slot.kind === "STARTER")
    .sort((left, right) => left.id.localeCompare(right.id));
  const orderedPlayers = [...input.players].sort((left, right) => left.id.localeCompare(right.id));
  const playerById = new Map(orderedPlayers.map((player) => [player.id, player]));
  const slotById = new Map(starterSlots.map((slot) => [slot.id, slot]));

  if (playerById.size !== orderedPlayers.length) {
    diagnostics.push({
      code: "DUPLICATE_PLAYER",
      message: "A player may appear only once in a lineup optimization roster",
    });
  }
  if (slotById.size !== starterSlots.length) {
    diagnostics.push({
      code: "DUPLICATE_SLOT",
      message: "Every starter slot must have a unique ID",
    });
  }
  if (diagnostics.length > 0) {
    return fatalResult(orderedPlayers, metric, diagnostics);
  }

  const lockedPlayerIds = new Set<PlayerId>();
  const lockedSlotIds = new Set<RosterSlotId>();
  const lockedBenchIds = new Set<PlayerId>();
  const lockedAssignments: DynamicAssignment[] = [];

  for (const lock of input.locks ?? []) {
    const player = playerById.get(lock.playerId);
    if (lockedPlayerIds.has(lock.playerId)) {
      diagnostics.push({
        code: "DUPLICATE_LOCK",
        message: `Player ${lock.playerId} has more than one lock`,
        playerId: lock.playerId,
      });
      continue;
    }
    if (player === undefined) {
      diagnostics.push({
        code: "UNKNOWN_LOCKED_PLAYER",
        message: `Locked player ${lock.playerId} is not on the roster`,
        playerId: lock.playerId,
      });
      continue;
    }

    lockedPlayerIds.add(lock.playerId);
    if (lock.kind === "BENCH") {
      lockedBenchIds.add(lock.playerId);
      continue;
    }

    const slot = slotById.get(lock.slotId);
    if (slot === undefined) {
      diagnostics.push({
        code: "UNKNOWN_LOCKED_SLOT",
        message: `Locked slot ${lock.slotId} is not a starter slot`,
        playerId: lock.playerId,
        slotId: lock.slotId,
      });
      continue;
    }
    if (lockedSlotIds.has(lock.slotId)) {
      diagnostics.push({
        code: "CONFLICTING_SLOT_LOCK",
        message: `More than one player is locked into slot ${lock.slotId}`,
        playerId: lock.playerId,
        slotId: lock.slotId,
      });
      continue;
    }
    if (!isPlayerEligibleForSlot(player, slot)) {
      diagnostics.push({
        code: "INELIGIBLE_LOCK",
        message: `Player ${lock.playerId} is not eligible for locked slot ${lock.slotId}`,
        playerId: lock.playerId,
        slotId: lock.slotId,
      });
      continue;
    }

    lockedSlotIds.add(lock.slotId);
    lockedAssignments.push({
      player,
      slot,
      score: scoreFor(input.projections, player.id, metric, diagnostics, projectionDiagnostics),
    });
  }

  const fatalCodes = new Set<LineupDiagnosticCode>([
    "DUPLICATE_LOCK",
    "UNKNOWN_LOCKED_PLAYER",
    "UNKNOWN_LOCKED_SLOT",
    "INELIGIBLE_LOCK",
    "CONFLICTING_SLOT_LOCK",
  ]);
  if (diagnostics.some((diagnostic) => fatalCodes.has(diagnostic.code))) {
    return fatalResult(orderedPlayers, metric, diagnostics);
  }

  const openSlots = starterSlots.filter((slot) => !lockedSlotIds.has(slot.id));
  if (openSlots.length > 30) {
    throw new RangeError("Lineup optimization supports at most 30 unlocked starter slots");
  }
  const availablePlayers = orderedPlayers.filter((player) => !lockedPlayerIds.has(player.id));
  let candidates = new Map<number, DynamicCandidate>([[0, { score: 0, assignments: [] }]]);

  for (const player of availablePlayers) {
    const score = scoreFor(
      input.projections,
      player.id,
      metric,
      diagnostics,
      projectionDiagnostics,
    );
    const nextCandidates = new Map(candidates);
    for (const [mask, candidate] of candidates) {
      for (let slotIndex = 0; slotIndex < openSlots.length; slotIndex += 1) {
        const slot = openSlots[slotIndex]!;
        const bit = 1 << slotIndex;
        if ((mask & bit) !== 0 || !isPlayerEligibleForSlot(player, slot)) {
          continue;
        }

        const nextMask = mask | bit;
        const nextCandidate: DynamicCandidate = {
          score: candidate.score + score,
          assignments: [...candidate.assignments, { player, slot, score }],
        };
        const incumbent = nextCandidates.get(nextMask);
        if (incumbent === undefined || isBetterForSameMask(nextCandidate, incumbent)) {
          nextCandidates.set(nextMask, nextCandidate);
        }
      }
    }
    candidates = nextCandidates;
  }

  let bestMask = 0;
  let best: DynamicCandidate = { score: 0, assignments: [] };
  for (const [mask, candidate] of candidates) {
    const filled = bitCount(mask);
    const bestFilled = bitCount(bestMask);
    if (filled > bestFilled || (filled === bestFilled && isBetterForSameMask(candidate, best))) {
      bestMask = mask;
      best = candidate;
    }
  }

  const allDynamicAssignments = [...lockedAssignments, ...best.assignments];
  const assignedPlayerIds = new Set(
    allDynamicAssignments.map((assignment) => assignment.player.id),
  );
  const assignmentBySlot = new Map(
    allDynamicAssignments.map((assignment) => [assignment.slot.id, assignment]),
  );
  const unfilledSlotIds = starterSlots
    .filter((slot) => !assignmentBySlot.has(slot.id))
    .map((slot) => slot.id);
  for (const slotId of unfilledSlotIds) {
    diagnostics.push({
      code: "UNFILLED_SLOT",
      message: `No eligible unlocked player was available for slot ${slotId}`,
      slotId,
    });
  }

  const assignments: LineupAssignment[] = allDynamicAssignments
    .sort((left, right) => left.slot.id.localeCompare(right.slot.id))
    .map((assignment) => {
      const nextEligibleScore = orderedPlayers
        .filter(
          (player) =>
            player.id !== assignment.player.id &&
            !assignedPlayerIds.has(player.id) &&
            !lockedBenchIds.has(player.id) &&
            isPlayerEligibleForSlot(player, assignment.slot),
        )
        .map((player) =>
          scoreFor(input.projections, player.id, metric, diagnostics, projectionDiagnostics),
        )
        .sort((left, right) => right - left)[0];
      const locked = lockedSlotIds.has(assignment.slot.id);
      const advantage =
        nextEligibleScore === undefined ? null : assignment.score - nextEligibleScore;
      const explanation = locked
        ? `${assignment.player.name} remains in ${assignment.slot.label} because that player is locked`
        : nextEligibleScore === undefined
          ? `${assignment.player.name} is the only available eligible player for ${assignment.slot.label}`
          : `${assignment.player.name} projects ${advantage!.toFixed(2)} ${metric} points above the best eligible benched alternative for ${assignment.slot.label}`;

      return {
        playerId: assignment.player.id,
        slotId: assignment.slot.id,
        projectedPoints: assignment.score,
        locked,
        explanation,
        advantageOverNextEligible: advantage,
      };
    });

  const currentBySlot = new Map(
    (input.currentAssignments ?? []).map((assignment) => [assignment.slotId, assignment.playerId]),
  );
  const resultBySlot = new Map(assignments.map((assignment) => [assignment.slotId, assignment]));
  const changes: LineupChange[] = starterSlots.flatMap((slot) => {
    const currentPlayerId = currentBySlot.get(slot.id) ?? null;
    const recommended = resultBySlot.get(slot.id);
    const recommendedPlayerId = recommended?.playerId ?? null;
    if (currentPlayerId === recommendedPlayerId) {
      return [];
    }

    const oldScore =
      currentPlayerId === null
        ? 0
        : scoreFor(input.projections, currentPlayerId, metric, diagnostics, projectionDiagnostics);
    const newScore = recommended?.projectedPoints ?? 0;
    return [
      {
        slotId: slot.id,
        removePlayerId: currentPlayerId,
        addPlayerId: recommendedPlayerId,
        projectedPointDelta: newScore - oldScore,
        explanation:
          currentPlayerId === null
            ? `Fill ${slot.label} with ${recommendedPlayerId ?? "an eligible player"}`
            : recommendedPlayerId === null
              ? `${slot.label} cannot currently be filled`
              : `Replace ${currentPlayerId} with ${recommendedPlayerId} in ${slot.label}`,
      },
    ];
  });

  return {
    feasible: unfilledSlotIds.length === 0,
    metric,
    assignments,
    benchPlayerIds: orderedPlayers
      .filter((player) => !assignedPlayerIds.has(player.id))
      .map((player) => player.id),
    unfilledSlotIds,
    projectedPoints: assignments.reduce(
      (total, assignment) => total + assignment.projectedPoints,
      0,
    ),
    changes,
    diagnostics,
  };
}
