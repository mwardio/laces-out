import {
  assignPlayersToRosterSlots,
  isPlayerEligibleForSlot,
  projectionFor,
  type Player,
  type PlayerId,
  type ProjectionLookup,
  type ProjectionMetric,
  type RosterSlot,
} from "@laces-out/domain";
import {
  optimizeLineup,
  type LineupChange,
  type LineupLock,
  type LineupOptimizationResult,
} from "@laces-out/engine-lineup";

export interface WaiverHorizon {
  readonly id: string;
  readonly label: string;
  readonly weight: number;
  readonly metric?: ProjectionMetric;
}

export interface EvaluateWaiversInput {
  readonly roster: readonly Player[];
  readonly candidates: readonly Player[];
  readonly starterSlots: readonly RosterSlot[];
  /** If omitted, the current roster size is treated as the capacity. */
  readonly rosterCapacity?: number;
  /** Optional full roster constraints, including bench slots. */
  readonly rosterSlots?: readonly RosterSlot[];
  readonly horizons: readonly WaiverHorizon[];
  readonly projectionsByHorizon: Readonly<Record<string, ProjectionLookup | undefined>>;
  readonly protectedPlayerIds?: readonly PlayerId[];
  /** Require a modeled outgoing player even when the roster has unused capacity. */
  readonly requireDrop?: boolean;
  /** Known provider locks that must remain fixed in before/after lineup optimization. */
  readonly lineupLocks?: readonly LineupLock[];
  /** Marginal weight assigned to legal bench depth. Defaults to 0.1. */
  readonly benchValueWeight?: number;
}

export interface WaiverRosterValue {
  readonly lineupPoints: number;
  readonly benchDepthPoints: number;
  readonly totalValue: number;
  readonly lineup: LineupOptimizationResult;
}

export interface WaiverHorizonDelta {
  readonly horizonId: string;
  readonly label: string;
  readonly weight: number;
  readonly before: WaiverRosterValue;
  readonly after: WaiverRosterValue;
  readonly lineupDelta: number;
  readonly benchDepthDelta: number;
  readonly totalDelta: number;
  readonly lineupChanges: readonly LineupChange[];
}

export interface WaiverMoveEvaluation {
  readonly addPlayerId: PlayerId;
  readonly dropPlayerId: PlayerId | null;
  readonly weightedDelta: number;
  readonly horizonDeltas: readonly WaiverHorizonDelta[];
  readonly improvesRoster: boolean;
  readonly explanation: string;
}

export interface WaiverEvaluationDiagnostic {
  readonly code:
    | "INVALID_INPUT"
    | "DUPLICATE_PLAYER"
    | "CANDIDATE_ALREADY_ROSTERED"
    | "NO_DROPPABLE_PLAYER"
    | "ILLEGAL_RESULTING_ROSTER";
  readonly message: string;
  readonly playerId?: PlayerId;
}

export interface WaiverEvaluationResult {
  readonly baselineByHorizon: Readonly<Record<string, WaiverRosterValue>>;
  /** Best legal add/drop pairing for each candidate, ranked by weighted delta. */
  readonly recommendations: readonly WaiverMoveEvaluation[];
  /** Every legal pairing, useful for explaining why a different drop is worse. */
  readonly allEvaluations: readonly WaiverMoveEvaluation[];
  readonly diagnostics: readonly WaiverEvaluationDiagnostic[];
}

function validateFiniteRatio(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite number`);
  }
}

function calculateRosterValue(
  roster: readonly Player[],
  starterSlots: readonly RosterSlot[],
  projections: ProjectionLookup,
  metric: ProjectionMetric,
  benchValueWeight: number,
  locks: readonly LineupLock[] = [],
  currentAssignments: readonly {
    readonly playerId: PlayerId;
    readonly slotId: RosterSlot["id"];
  }[] = [],
): WaiverRosterValue {
  const lineup = optimizeLineup({
    players: roster,
    slots: starterSlots,
    projections,
    metric,
    locks,
    currentAssignments,
  });
  const benchDepthPoints = lineup.benchPlayerIds.reduce((sum, id) => {
    const score = projectionFor(projections, id)?.[metric] ?? 0;
    return sum + (Number.isFinite(score) ? Math.max(0, score) : 0);
  }, 0);
  return {
    lineupPoints: lineup.projectedPoints,
    benchDepthPoints,
    totalValue: lineup.projectedPoints + benchDepthPoints * benchValueWeight,
    lineup,
  };
}

/**
 * Verifies that the optimizer's chosen starters and the remaining players form one legal full-
 * roster assignment. The lineup optimizer intentionally ignores non-starter slots, while the
 * generic roster matcher does not know about fixed lineup locks; checking the residual bench here
 * prevents those two individually feasible assignments from contradicting each other.
 */
function optimizedLineupFitsRosterSlots(
  roster: readonly Player[],
  value: WaiverRosterValue,
  rosterSlots: readonly RosterSlot[],
): boolean {
  const playerById = new Map(roster.map((player) => [player.id, player]));
  const slotById = new Map(rosterSlots.map((slot) => [slot.id, slot]));
  const starterPlayerIds = new Set<PlayerId>();
  for (const assignment of value.lineup.assignments) {
    const player = playerById.get(assignment.playerId);
    const slot = slotById.get(assignment.slotId);
    if (
      player === undefined ||
      slot === undefined ||
      slot.kind !== "STARTER" ||
      starterPlayerIds.has(player.id) ||
      !isPlayerEligibleForSlot(player, slot)
    ) {
      return false;
    }
    starterPlayerIds.add(player.id);
  }

  const benchPlayers = roster.filter((player) => !starterPlayerIds.has(player.id));
  const nonStarterSlots = rosterSlots.filter((slot) => slot.kind !== "STARTER");
  return assignPlayersToRosterSlots(benchPlayers, nonStarterSlots).feasible;
}

function moveSignature(move: WaiverMoveEvaluation): string {
  return `${move.addPlayerId}:${move.dropPlayerId ?? ""}`;
}

function compareMoves(left: WaiverMoveEvaluation, right: WaiverMoveEvaluation): number {
  const delta = right.weightedDelta - left.weightedDelta;
  return Math.abs(delta) > 1e-9 ? delta : moveSignature(left).localeCompare(moveSignature(right));
}

export function evaluateWaiverMoves(input: EvaluateWaiversInput): WaiverEvaluationResult {
  const rosterCapacity = input.rosterCapacity ?? input.roster.length;
  const benchValueWeight = input.benchValueWeight ?? 0.1;
  if (!Number.isSafeInteger(rosterCapacity) || rosterCapacity < 0) {
    throw new RangeError("Roster capacity must be a non-negative integer");
  }
  if (input.roster.length > rosterCapacity) {
    throw new RangeError("Current roster exceeds roster capacity");
  }
  validateFiniteRatio(benchValueWeight, "Bench value weight");
  if (input.horizons.length === 0) {
    throw new RangeError("At least one waiver evaluation horizon is required");
  }
  if (new Set(input.horizons.map((horizon) => horizon.id)).size !== input.horizons.length) {
    throw new Error("Waiver horizon IDs must be unique");
  }
  for (const horizon of input.horizons) {
    validateFiniteRatio(horizon.weight, `Weight for ${horizon.id}`);
    if (input.projectionsByHorizon[horizon.id] === undefined) {
      throw new Error(`Missing projections for waiver horizon ${horizon.id}`);
    }
  }

  const diagnostics: WaiverEvaluationDiagnostic[] = [];
  const rosterIds = new Set(input.roster.map((player) => player.id));
  if (rosterIds.size !== input.roster.length) {
    throw new Error("Current waiver roster contains duplicate players");
  }
  const candidateIds = new Set<PlayerId>();
  const uniqueCandidates: Player[] = [];
  for (const candidate of input.candidates) {
    if (candidateIds.has(candidate.id)) {
      diagnostics.push({
        code: "DUPLICATE_PLAYER",
        message: `Candidate ${candidate.id} appears more than once`,
        playerId: candidate.id,
      });
      continue;
    }
    candidateIds.add(candidate.id);
    uniqueCandidates.push(candidate);
  }

  const baselineByHorizon: Record<string, WaiverRosterValue> = {};
  for (const horizon of input.horizons) {
    baselineByHorizon[horizon.id] = calculateRosterValue(
      input.roster,
      input.starterSlots,
      input.projectionsByHorizon[horizon.id]!,
      horizon.metric ?? "mean",
      benchValueWeight,
      input.lineupLocks,
    );
  }

  const protectedIds = new Set([
    ...(input.protectedPlayerIds ?? []),
    ...(input.lineupLocks ?? []).map((lock) => lock.playerId),
  ]);
  const hasLineupLocks = (input.lineupLocks?.length ?? 0) > 0;
  const requiresDrop = input.requireDrop === true || input.roster.length >= rosterCapacity;
  const dropOptions: readonly (Player | null)[] = requiresDrop
    ? input.roster.filter((player) => !protectedIds.has(player.id))
    : [null];
  if (requiresDrop && dropOptions.length === 0) {
    diagnostics.push({
      code: "NO_DROPPABLE_PLAYER",
      message: "A drop is required and every player is protected",
    });
  }

  const allEvaluations: WaiverMoveEvaluation[] = [];
  for (const candidate of uniqueCandidates.sort((left, right) => left.id.localeCompare(right.id))) {
    if (rosterIds.has(candidate.id)) {
      diagnostics.push({
        code: "CANDIDATE_ALREADY_ROSTERED",
        message: `Candidate ${candidate.id} is already on the roster`,
        playerId: candidate.id,
      });
      continue;
    }
    for (const drop of dropOptions) {
      const resultingRoster = [
        ...input.roster.filter((player) => player.id !== drop?.id),
        candidate,
      ];
      if (resultingRoster.length > rosterCapacity) {
        continue;
      }
      if (
        input.rosterSlots !== undefined &&
        !assignPlayersToRosterSlots(resultingRoster, input.rosterSlots).feasible
      ) {
        diagnostics.push({
          code: "ILLEGAL_RESULTING_ROSTER",
          message: `Adding ${candidate.id} and dropping ${drop?.id ?? "nobody"} creates an illegal roster`,
          playerId: candidate.id,
        });
        continue;
      }

      let weightedDelta = 0;
      const horizonDeltas = input.horizons.map((horizon): WaiverHorizonDelta => {
        const projections = input.projectionsByHorizon[horizon.id]!;
        const metric = horizon.metric ?? "mean";
        const before = baselineByHorizon[horizon.id]!;
        const after = calculateRosterValue(
          resultingRoster,
          input.starterSlots,
          projections,
          metric,
          benchValueWeight,
          input.lineupLocks,
          before.lineup.assignments,
        );
        const lineupDelta = after.lineupPoints - before.lineupPoints;
        const benchDepthDelta = after.benchDepthPoints - before.benchDepthPoints;
        const totalDelta = after.totalValue - before.totalValue;
        weightedDelta += horizon.weight * totalDelta;
        return {
          horizonId: horizon.id,
          label: horizon.label,
          weight: horizon.weight,
          before,
          after,
          lineupDelta,
          benchDepthDelta,
          totalDelta,
          lineupChanges: after.lineup.changes,
        };
      });
      const incompleteLockedLineup =
        hasLineupLocks && horizonDeltas.some((horizon) => !horizon.after.lineup.feasible);
      const rosterSlots = input.rosterSlots;
      const violatesFullRosterSlots =
        rosterSlots !== undefined &&
        horizonDeltas.some(
          (horizon) =>
            (horizon.before.lineup.feasible &&
              !optimizedLineupFitsRosterSlots(input.roster, horizon.before, rosterSlots)) ||
            (horizon.after.lineup.feasible &&
              !optimizedLineupFitsRosterSlots(resultingRoster, horizon.after, rosterSlots)),
        );
      if (incompleteLockedLineup || violatesFullRosterSlots) {
        diagnostics.push({
          code: "ILLEGAL_RESULTING_ROSTER",
          message: `Adding ${candidate.id} and dropping ${drop?.id ?? "nobody"} cannot preserve a complete legal roster assignment${hasLineupLocks ? " under the stored locks" : ""}`,
          playerId: candidate.id,
        });
        continue;
      }
      const strongest = [...horizonDeltas].sort(
        (left, right) =>
          Math.abs(right.weight * right.totalDelta) - Math.abs(left.weight * left.totalDelta),
      )[0]!;
      allEvaluations.push({
        addPlayerId: candidate.id,
        dropPlayerId: drop?.id ?? null,
        weightedDelta,
        horizonDeltas,
        improvesRoster: weightedDelta > 1e-9,
        explanation: `${candidate.name} for ${drop?.name ?? "an open roster spot"} changes weighted roster value by ${weightedDelta.toFixed(2)}; the largest effect is ${strongest.label} (${strongest.totalDelta >= 0 ? "+" : ""}${strongest.totalDelta.toFixed(2)})`,
      });
    }
  }

  allEvaluations.sort(compareMoves);
  const bestByCandidate = new Map<PlayerId, WaiverMoveEvaluation>();
  for (const evaluation of allEvaluations) {
    if (!bestByCandidate.has(evaluation.addPlayerId)) {
      bestByCandidate.set(evaluation.addPlayerId, evaluation);
    }
  }

  return {
    baselineByHorizon,
    recommendations: [...bestByCandidate.values()].sort(compareMoves),
    allEvaluations,
    diagnostics,
  };
}

export interface FaabRecommendationInput {
  readonly weightedDelta: number;
  readonly remainingBudget: number;
  readonly urgency: number;
  readonly scarcity: number;
  readonly competition: number;
  /** A weighted point gain considered a very large improvement. Defaults to 20. */
  readonly valueScale?: number;
}

export interface FaabRecommendation {
  readonly recommendedBid: number;
  readonly lowBid: number;
  readonly highBid: number;
  readonly budgetFraction: number;
}

export function recommendFaabBid(input: FaabRecommendationInput): FaabRecommendation {
  if (!Number.isFinite(input.weightedDelta)) {
    throw new RangeError("Weighted waiver delta must be finite");
  }
  if (!Number.isSafeInteger(input.remainingBudget) || input.remainingBudget < 0) {
    throw new RangeError("Remaining FAAB must be a non-negative integer");
  }
  for (const [label, value] of [
    ["urgency", input.urgency],
    ["scarcity", input.scarcity],
    ["competition", input.competition],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`${label} must be between zero and one`);
    }
  }
  const valueScale = input.valueScale ?? 20;
  if (!Number.isFinite(valueScale) || valueScale <= 0) {
    throw new RangeError("FAAB value scale must be positive and finite");
  }
  if (input.weightedDelta <= 0 || input.remainingBudget === 0) {
    return { recommendedBid: 0, lowBid: 0, highBid: 0, budgetFraction: 0 };
  }

  const valueSignal = 1 - Math.exp(-input.weightedDelta / valueScale);
  const contextCeiling =
    0.05 + input.urgency * 0.35 + input.scarcity * 0.25 + input.competition * 0.15;
  const budgetFraction = Math.min(0.8, 0.01 + valueSignal * contextCeiling);
  const recommendedBid = Math.min(
    input.remainingBudget,
    Math.max(1, Math.round(input.remainingBudget * budgetFraction)),
  );
  return {
    recommendedBid,
    lowBid: Math.max(1, Math.floor(recommendedBid * 0.75)),
    highBid: Math.min(
      input.remainingBudget,
      Math.max(recommendedBid, Math.ceil(recommendedBid * 1.25)),
    ),
    budgetFraction,
  };
}
