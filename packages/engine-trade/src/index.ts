import {
  assignPlayersToRosterSlots,
  projectionFor,
  type Player,
  type PlayerId,
  type ProjectionLookup,
  type ProjectionMetric,
  type RosterSlot,
  type TeamId,
} from "@laces-out/domain";
import { optimizeLineup, type LineupOptimizationResult } from "@laces-out/engine-lineup";

export interface TradeHorizon {
  readonly id: string;
  readonly label: string;
  readonly weight: number;
  readonly metric?: ProjectionMetric;
}

export interface TradeTeamContext {
  readonly teamId: TeamId;
  readonly name: string;
  readonly roster: readonly Player[];
  readonly starterSlots: readonly RosterSlot[];
  readonly rosterCapacity?: number;
  readonly rosterSlots?: readonly RosterSlot[];
  readonly protectedPlayerIds?: readonly PlayerId[];
}

export interface EvaluateTradeInput {
  readonly teamA: TradeTeamContext;
  readonly teamB: TradeTeamContext;
  readonly sendsFromA: readonly PlayerId[];
  readonly sendsFromB: readonly PlayerId[];
  readonly horizons: readonly TradeHorizon[];
  readonly projectionsByHorizon: Readonly<Record<string, ProjectionLookup | undefined>>;
  readonly benchValueWeight?: number;
  /** Incoming players cannot be selected as forced drops by default. */
  readonly protectIncomingPlayers?: boolean;
}

export interface TradeRosterValue {
  readonly lineupPoints: number;
  readonly benchDepthPoints: number;
  readonly totalValue: number;
  readonly lineup: LineupOptimizationResult;
}

export interface TradeHorizonImpact {
  readonly horizonId: string;
  readonly label: string;
  readonly weight: number;
  readonly before: TradeRosterValue;
  readonly after: TradeRosterValue;
  readonly lineupDelta: number;
  readonly benchDepthDelta: number;
  readonly totalDelta: number;
}

export interface TradeSideEvaluation {
  readonly teamId: TeamId;
  readonly sendsPlayerIds: readonly PlayerId[];
  readonly receivesPlayerIds: readonly PlayerId[];
  readonly forcedDropPlayerIds: readonly PlayerId[];
  readonly beforeWeightedValue: number;
  readonly afterWeightedValue: number;
  readonly weightedDelta: number;
  readonly horizons: readonly TradeHorizonImpact[];
  readonly resultingRosterPlayerIds: readonly PlayerId[];
  readonly explanation: string;
}

export interface TradeDiagnostic {
  readonly code:
    | "INVALID_TRADE"
    | "UNKNOWN_TRADED_PLAYER"
    | "DUPLICATE_TRADED_PLAYER"
    | "NO_LEGAL_FORCED_DROP"
    | "ILLEGAL_RESULTING_ROSTER";
  readonly message: string;
  readonly teamId?: TeamId;
  readonly playerId?: PlayerId;
}

export interface TradeEvaluation {
  readonly legal: boolean;
  readonly teamA: TradeSideEvaluation | null;
  readonly teamB: TradeSideEvaluation | null;
  readonly mutuallyBeneficial: boolean;
  readonly totalWeightedDelta: number;
  readonly fairnessGap: number;
  readonly diagnostics: readonly TradeDiagnostic[];
}

interface EvaluatedRoster {
  readonly roster: readonly Player[];
  readonly weightedValue: number;
  readonly values: Readonly<Record<string, TradeRosterValue>>;
}

function validateWeight(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite number`);
  }
}

function rosterValue(
  roster: readonly Player[],
  slots: readonly RosterSlot[],
  projections: ProjectionLookup,
  metric: ProjectionMetric,
  benchWeight: number,
): TradeRosterValue {
  const lineup = optimizeLineup({ players: roster, slots, projections, metric });
  const benchDepthPoints = lineup.benchPlayerIds.reduce((sum, id) => {
    const score = projectionFor(projections, id)?.[metric] ?? 0;
    return sum + (Number.isFinite(score) ? Math.max(0, score) : 0);
  }, 0);
  return {
    lineupPoints: lineup.projectedPoints,
    benchDepthPoints,
    totalValue: lineup.projectedPoints + benchDepthPoints * benchWeight,
    lineup,
  };
}

function evaluateRoster(
  team: TradeTeamContext,
  roster: readonly Player[],
  horizons: readonly TradeHorizon[],
  projectionsByHorizon: Readonly<Record<string, ProjectionLookup | undefined>>,
  benchWeight: number,
): EvaluatedRoster {
  let weightedValue = 0;
  const values: Record<string, TradeRosterValue> = {};
  for (const horizon of horizons) {
    const value = rosterValue(
      roster,
      team.starterSlots,
      projectionsByHorizon[horizon.id]!,
      horizon.metric ?? "mean",
      benchWeight,
    );
    values[horizon.id] = value;
    weightedValue += horizon.weight * value.totalValue;
  }
  return { roster, weightedValue, values };
}

function combinations<T>(values: readonly T[], count: number): readonly (readonly T[])[] {
  if (count === 0) {
    return [[]];
  }
  const result: T[][] = [];
  const current: T[] = [];
  const visit = (start: number): void => {
    if (current.length === count) {
      result.push([...current]);
      if (result.length > 100_000) {
        throw new RangeError("Forced-drop search exceeded 100,000 combinations");
      }
      return;
    }
    for (let index = start; index <= values.length - (count - current.length); index += 1) {
      current.push(values[index]!);
      visit(index + 1);
      current.pop();
    }
  };
  visit(0);
  return result;
}

interface BestResultingRoster {
  readonly evaluated: EvaluatedRoster;
  readonly drops: readonly Player[];
}

function bestResultingRoster(
  team: TradeTeamContext,
  rawRoster: readonly Player[],
  incomingIds: ReadonlySet<PlayerId>,
  horizons: readonly TradeHorizon[],
  projectionsByHorizon: Readonly<Record<string, ProjectionLookup | undefined>>,
  benchWeight: number,
  protectIncoming: boolean,
): BestResultingRoster | null {
  const capacity = team.rosterCapacity ?? team.rosterSlots?.length ?? team.roster.length;
  if (!Number.isSafeInteger(capacity) || capacity < 0) {
    throw new RangeError(`Roster capacity for ${team.teamId} must be a non-negative integer`);
  }
  const overflow = Math.max(0, rawRoster.length - capacity);
  const protectedIds = new Set(team.protectedPlayerIds ?? []);
  const droppable = rawRoster
    .filter(
      (player) => !protectedIds.has(player.id) && !(protectIncoming && incomingIds.has(player.id)),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  if (droppable.length < overflow) {
    return null;
  }

  let best: BestResultingRoster | null = null;
  for (const drops of combinations(droppable, overflow)) {
    const dropIds = new Set(drops.map((player) => player.id));
    const resulting = rawRoster.filter((player) => !dropIds.has(player.id));
    if (
      team.rosterSlots !== undefined &&
      !assignPlayersToRosterSlots(resulting, team.rosterSlots).feasible
    ) {
      continue;
    }
    const evaluated = evaluateRoster(team, resulting, horizons, projectionsByHorizon, benchWeight);
    if (
      best === null ||
      evaluated.weightedValue > best.evaluated.weightedValue + 1e-9 ||
      (Math.abs(evaluated.weightedValue - best.evaluated.weightedValue) <= 1e-9 &&
        drops.map((player) => player.id).join("|") <
          best.drops.map((player) => player.id).join("|"))
    ) {
      best = { evaluated, drops };
    }
  }
  return best;
}

function buildSideEvaluation(
  team: TradeTeamContext,
  sends: readonly PlayerId[],
  receives: readonly PlayerId[],
  before: EvaluatedRoster,
  after: BestResultingRoster,
  horizons: readonly TradeHorizon[],
): TradeSideEvaluation {
  const horizonImpacts = horizons.map((horizon): TradeHorizonImpact => {
    const beforeValue = before.values[horizon.id]!;
    const afterValue = after.evaluated.values[horizon.id]!;
    return {
      horizonId: horizon.id,
      label: horizon.label,
      weight: horizon.weight,
      before: beforeValue,
      after: afterValue,
      lineupDelta: afterValue.lineupPoints - beforeValue.lineupPoints,
      benchDepthDelta: afterValue.benchDepthPoints - beforeValue.benchDepthPoints,
      totalDelta: afterValue.totalValue - beforeValue.totalValue,
    };
  });
  const weightedDelta = after.evaluated.weightedValue - before.weightedValue;
  const forcedDrops = after.drops.map((player) => player.id);
  return {
    teamId: team.teamId,
    sendsPlayerIds: sends,
    receivesPlayerIds: receives,
    forcedDropPlayerIds: forcedDrops,
    beforeWeightedValue: before.weightedValue,
    afterWeightedValue: after.evaluated.weightedValue,
    weightedDelta,
    horizons: horizonImpacts,
    resultingRosterPlayerIds: after.evaluated.roster
      .map((player) => player.id)
      .sort((left, right) => left.localeCompare(right)),
    explanation: `${team.name}'s weighted roster value changes by ${weightedDelta >= 0 ? "+" : ""}${weightedDelta.toFixed(2)}${forcedDrops.length === 0 ? "" : ` after dropping ${forcedDrops.join(", ")}`}`,
  };
}

export function evaluateTrade(input: EvaluateTradeInput): TradeEvaluation {
  const benchWeight = input.benchValueWeight ?? 0.1;
  validateWeight(benchWeight, "Bench value weight");
  if (input.teamA.teamId === input.teamB.teamId) {
    throw new Error("A trade requires two different teams");
  }
  if (input.sendsFromA.length === 0 || input.sendsFromB.length === 0) {
    throw new Error("Each trade side must send at least one player");
  }
  if (input.horizons.length === 0) {
    throw new Error("At least one trade horizon is required");
  }
  if (new Set(input.horizons.map((horizon) => horizon.id)).size !== input.horizons.length) {
    throw new Error("Trade horizon IDs must be unique");
  }
  for (const horizon of input.horizons) {
    validateWeight(horizon.weight, `Weight for ${horizon.id}`);
    if (input.projectionsByHorizon[horizon.id] === undefined) {
      throw new Error(`Missing projections for trade horizon ${horizon.id}`);
    }
  }

  const diagnostics: TradeDiagnostic[] = [];
  const rosterA = new Map(input.teamA.roster.map((player) => [player.id, player]));
  const rosterB = new Map(input.teamB.roster.map((player) => [player.id, player]));
  if (rosterA.size !== input.teamA.roster.length || rosterB.size !== input.teamB.roster.length) {
    throw new Error("Trade team rosters may not contain duplicate players");
  }
  for (const id of rosterA.keys()) {
    if (rosterB.has(id)) {
      diagnostics.push({
        code: "INVALID_TRADE",
        message: `Player ${id} cannot be rostered by both trade teams`,
        playerId: id,
      });
    }
  }
  if (diagnostics.length > 0) {
    return {
      legal: false,
      teamA: null,
      teamB: null,
      mutuallyBeneficial: false,
      totalWeightedDelta: 0,
      fairnessGap: 0,
      diagnostics,
    };
  }

  const validateSends = (
    sends: readonly PlayerId[],
    roster: ReadonlyMap<PlayerId, Player>,
    teamId: TeamId,
  ): boolean => {
    let valid = true;
    const seen = new Set<PlayerId>();
    for (const id of sends) {
      if (seen.has(id)) {
        diagnostics.push({
          code: "DUPLICATE_TRADED_PLAYER",
          message: `Player ${id} appears twice on the same side of the trade`,
          teamId,
          playerId: id,
        });
        valid = false;
      } else if (!roster.has(id)) {
        diagnostics.push({
          code: "UNKNOWN_TRADED_PLAYER",
          message: `Player ${id} is not rostered by team ${teamId}`,
          teamId,
          playerId: id,
        });
        valid = false;
      }
      seen.add(id);
    }
    return valid;
  };
  if (
    !validateSends(input.sendsFromA, rosterA, input.teamA.teamId) ||
    !validateSends(input.sendsFromB, rosterB, input.teamB.teamId)
  ) {
    return {
      legal: false,
      teamA: null,
      teamB: null,
      mutuallyBeneficial: false,
      totalWeightedDelta: 0,
      fairnessGap: 0,
      diagnostics,
    };
  }

  const incomingA = input.sendsFromB.map((id) => rosterB.get(id)!);
  const incomingB = input.sendsFromA.map((id) => rosterA.get(id)!);
  const sendsA = new Set(input.sendsFromA);
  const sendsB = new Set(input.sendsFromB);
  const rawAfterA = [
    ...input.teamA.roster.filter((player) => !sendsA.has(player.id)),
    ...incomingA,
  ];
  const rawAfterB = [
    ...input.teamB.roster.filter((player) => !sendsB.has(player.id)),
    ...incomingB,
  ];
  const protectIncoming = input.protectIncomingPlayers ?? true;
  const bestA = bestResultingRoster(
    input.teamA,
    rawAfterA,
    new Set(input.sendsFromB),
    input.horizons,
    input.projectionsByHorizon,
    benchWeight,
    protectIncoming,
  );
  const bestB = bestResultingRoster(
    input.teamB,
    rawAfterB,
    new Set(input.sendsFromA),
    input.horizons,
    input.projectionsByHorizon,
    benchWeight,
    protectIncoming,
  );
  if (bestA === null || bestB === null) {
    if (bestA === null) {
      diagnostics.push({
        code: "NO_LEGAL_FORCED_DROP",
        message: `Team ${input.teamA.teamId} cannot make the required legal forced drops`,
        teamId: input.teamA.teamId,
      });
    }
    if (bestB === null) {
      diagnostics.push({
        code: "NO_LEGAL_FORCED_DROP",
        message: `Team ${input.teamB.teamId} cannot make the required legal forced drops`,
        teamId: input.teamB.teamId,
      });
    }
    return {
      legal: false,
      teamA: null,
      teamB: null,
      mutuallyBeneficial: false,
      totalWeightedDelta: 0,
      fairnessGap: 0,
      diagnostics,
    };
  }

  const beforeA = evaluateRoster(
    input.teamA,
    input.teamA.roster,
    input.horizons,
    input.projectionsByHorizon,
    benchWeight,
  );
  const beforeB = evaluateRoster(
    input.teamB,
    input.teamB.roster,
    input.horizons,
    input.projectionsByHorizon,
    benchWeight,
  );
  const teamA = buildSideEvaluation(
    input.teamA,
    input.sendsFromA,
    input.sendsFromB,
    beforeA,
    bestA,
    input.horizons,
  );
  const teamB = buildSideEvaluation(
    input.teamB,
    input.sendsFromB,
    input.sendsFromA,
    beforeB,
    bestB,
    input.horizons,
  );
  return {
    legal: true,
    teamA,
    teamB,
    mutuallyBeneficial: teamA.weightedDelta > 1e-9 && teamB.weightedDelta > 1e-9,
    totalWeightedDelta: teamA.weightedDelta + teamB.weightedDelta,
    fairnessGap: Math.abs(teamA.weightedDelta - teamB.weightedDelta),
    diagnostics,
  };
}

export interface TradePackage {
  readonly sendsFromA: readonly PlayerId[];
  readonly sendsFromB: readonly PlayerId[];
}

export function rankTradePackages(
  input: Omit<EvaluateTradeInput, "sendsFromA" | "sendsFromB">,
  packages: readonly TradePackage[],
): readonly TradeEvaluation[] {
  return packages
    .map((tradePackage) => evaluateTrade({ ...input, ...tradePackage }))
    .sort((left, right) => {
      if (left.legal !== right.legal) {
        return left.legal ? -1 : 1;
      }
      if (left.mutuallyBeneficial !== right.mutuallyBeneficial) {
        return left.mutuallyBeneficial ? -1 : 1;
      }
      const worstLeft = Math.min(
        left.teamA?.weightedDelta ?? -Infinity,
        left.teamB?.weightedDelta ?? -Infinity,
      );
      const worstRight = Math.min(
        right.teamA?.weightedDelta ?? -Infinity,
        right.teamB?.weightedDelta ?? -Infinity,
      );
      return worstRight - worstLeft || left.fairnessGap - right.fairnessGap;
    });
}
