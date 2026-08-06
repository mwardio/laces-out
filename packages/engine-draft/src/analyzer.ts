import {
  assignPlayersToRosterSlots,
  isPlayerEligibleForSlot,
  type Player,
  type PlayerId,
  type Position,
  type RosterSlot,
  type TeamId,
} from "@laces-out/domain";

import { maximumLegalBid } from "./auction.js";
import { reduceDraft } from "./reducer.js";
import type {
  AuctionDraftConfig,
  DraftConfig,
  DraftEvent,
  DraftState,
  DraftTeamConfig,
  DraftTeamState,
  SnakeDraftConfig,
} from "./types.js";

export const DRAFT_ANALYZER_ALGORITHM_VERSION = "draft-analyzer-v1";

export interface DraftAnalysisMarketPlayer {
  readonly playerId: PlayerId;
  /** Overall average draft position. Lower values indicate earlier selections. */
  readonly adp?: number;
  readonly tier?: number;
  /** League-contextual baseline value in whole auction dollars. */
  readonly auctionValue?: number;
}

/**
 * Only source-admitted, context-compatible market data belongs in this input.
 * The analyzer validates the marker at runtime rather than silently treating an
 * arbitrary list as an admitted baseline.
 */
export interface DraftAnalysisMarket {
  readonly admissionStatus: "ADMITTED";
  readonly source: string;
  readonly sourceVersion: string;
  readonly asOf: string;
  readonly players: readonly DraftAnalysisMarketPlayer[];
}

export interface DraftAnalysisProjection {
  readonly playerId: PlayerId;
  readonly projectedPoints: number;
}

export interface DraftAnalysisProjectionSet {
  readonly source: string;
  readonly sourceVersion: string;
  readonly asOf: string;
  readonly horizon: string;
  /** Must exactly match the analyzed league's scoring profile. */
  readonly scoringProfileId: string;
  readonly players: readonly DraftAnalysisProjection[];
}

export interface DraftAnalyzerInput {
  readonly config: DraftConfig;
  readonly events: readonly DraftEvent[];
  readonly market?: DraftAnalysisMarket;
  readonly projections?: DraftAnalysisProjectionSet;
  readonly leagueScoringProfileId?: string;
  readonly missedAlternativeLimit?: number;
}

export interface DraftAnalysisWarning {
  readonly code: string;
  readonly message: string;
}

export interface RosterConstructionAnalysis {
  readonly rosteredPlayers: number;
  readonly totalRosterSlots: number;
  readonly openRosterSlots: number;
  readonly starterSlots: number;
  readonly coveredStarterSlots: number;
  readonly openStarterSlots: readonly {
    readonly slotId: string;
    readonly type: RosterSlot["type"];
    readonly eligiblePositions: readonly Position[];
  }[];
  /** Counts each player's first listed eligible position exactly once. */
  readonly primaryPositionCounts: readonly {
    readonly position: Position;
    readonly count: number;
  }[];
  readonly warnings: readonly DraftAnalysisWarning[];
}

export interface SnakeMissedAlternative {
  readonly playerId: PlayerId;
  readonly name: string;
  readonly adp: number;
  readonly adpAdvantage: number;
  readonly tier: number | null;
  readonly outcome: "DRAFTED_LATER_BY_OPPONENT" | "UNDRAFTED_AT_ANALYSIS";
  readonly laterOverallPick: number | null;
  readonly laterTeamId: TeamId | null;
}

export interface SnakeSelectionAnalysis {
  readonly eventId: string;
  readonly acquisition: "SNAKE_PICK" | "SNAKE_KEEPER";
  readonly playerId: PlayerId;
  readonly playerName: string;
  readonly overallPick: number;
  readonly market: {
    readonly status: "AVAILABLE" | "UNAVAILABLE";
    readonly adp: number | null;
    /** Positive means the player was selected after ADP; negative means before ADP. */
    readonly pickVsAdp: number | null;
    readonly classification: "VALUE" | "AT_MARKET" | "REACH" | "UNAVAILABLE";
    readonly classificationThresholdPicks: number;
  };
  readonly rosterNeed: {
    readonly starterCoverageBefore: number;
    readonly starterCoverageAfter: number;
    readonly filledOpenStarterSlot: boolean;
  };
  readonly opportunityCost: {
    readonly selectedTier: number | null;
    readonly bestAvailableTier: number | null;
    /** Positive means a better (lower-numbered) tier was passed. */
    readonly tierGap: number | null;
    readonly bestAvailableAdp: number | null;
    /** Positive means an earlier-ADP legal option was passed. */
    readonly adpCost: number | null;
  };
  readonly missedAlternatives: readonly SnakeMissedAlternative[];
  readonly warnings: readonly DraftAnalysisWarning[];
}

export interface AuctionMissedAlternative {
  readonly playerId: PlayerId;
  readonly name: string;
  readonly baselineValue: number;
  readonly laterPrice: number;
  readonly valueAtLaterPrice: number;
  readonly surplusAdvantage: number;
  readonly laterTeamId: TeamId;
}

export interface AuctionPurchaseAnalysis {
  readonly eventId: string;
  readonly acquisition: "AUCTION" | "AUCTION_KEEPER";
  readonly playerId: PlayerId;
  readonly playerName: string;
  readonly price: number;
  readonly market: {
    readonly status: "AVAILABLE" | "UNAVAILABLE";
    readonly baselineValue: number | null;
    /** Positive is value gained; negative is an overpay against the admitted baseline. */
    readonly surplus: number | null;
    readonly classification: "VALUE" | "AT_MARKET" | "OVERPAY" | "UNAVAILABLE";
    readonly classificationThresholdDollars: number;
  };
  readonly legality: {
    readonly maximumLegalBidBeforePurchase: number;
    readonly withinMaximumBid: boolean;
    readonly remainingBudgetBeforePurchase: number;
    readonly openSlotsBeforePurchase: number;
  };
  readonly rosterNeed: {
    readonly starterCoverageBefore: number;
    readonly starterCoverageAfter: number;
    readonly filledOpenStarterSlot: boolean;
  };
  readonly missedAlternatives: readonly AuctionMissedAlternative[];
  readonly warnings: readonly DraftAnalysisWarning[];
}

export type ProjectionUnavailableReason =
  "NO_PROJECTIONS" | "MISSING_LEAGUE_SCORING_PROFILE" | "INCOMPATIBLE_SCORING_PROFILE";

export type ProjectionAvailability =
  | {
      readonly status: "AVAILABLE";
      readonly source: string;
      readonly sourceVersion: string;
      readonly asOf: string;
      readonly horizon: string;
      readonly scoringProfileId: string;
    }
  | {
      readonly status: "UNAVAILABLE";
      readonly reason: ProjectionUnavailableReason;
      readonly message: string;
    };

export type TeamStrengthAnalysis =
  | {
      readonly status: "AVAILABLE";
      readonly projectedRosterPoints: number;
      readonly projectedStarterPoints: number;
      readonly projectedStarterPlayerIds: readonly PlayerId[];
      readonly leagueRank: number;
      readonly rankedTeamCount: number;
      readonly basis: "CURRENT_ROSTER";
      readonly warnings: readonly DraftAnalysisWarning[];
    }
  | {
      readonly status: "UNAVAILABLE";
      readonly reason: ProjectionUnavailableReason | "EMPTY_ROSTER" | "MISSING_PLAYER_PROJECTIONS";
      readonly missingPlayerIds: readonly PlayerId[];
      readonly message: string;
    };

export interface SnakeTeamAnalysis {
  readonly mode: "SNAKE";
  readonly teamId: TeamId;
  readonly name: string;
  readonly roster: RosterConstructionAnalysis;
  readonly selections: readonly SnakeSelectionAnalysis[];
  readonly marketSummary: {
    readonly status: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
    readonly coveredSelections: number;
    readonly totalSelections: number;
    readonly averagePickVsAdp: number | null;
    readonly values: number;
    readonly reaches: number;
  };
  readonly teamStrength: TeamStrengthAnalysis;
  readonly warnings: readonly DraftAnalysisWarning[];
}

export interface AuctionTeamAnalysis {
  readonly mode: "AUCTION";
  readonly teamId: TeamId;
  readonly name: string;
  readonly roster: RosterConstructionAnalysis;
  readonly purchases: readonly AuctionPurchaseAnalysis[];
  readonly budget: {
    readonly initialBudget: number;
    readonly spent: number;
    readonly remainingBudget: number;
    readonly maximumLegalBid: number;
    readonly rosterFillRate: number;
    readonly budgetSpentRate: number;
    /** Positive means dollars are being spent faster than slots are being filled. */
    readonly paceDelta: number;
  };
  readonly marketEfficiency:
    | {
        readonly status: "AVAILABLE";
        readonly baselineValueAcquired: number;
        readonly spent: number;
        readonly surplus: number;
        readonly baselineValuePerDollar: number | null;
      }
    | {
        readonly status: "UNAVAILABLE" | "PARTIAL";
        readonly coveredPurchases: number;
        readonly totalPurchases: number;
        readonly message: string;
      };
  readonly teamStrength: TeamStrengthAnalysis;
  readonly warnings: readonly DraftAnalysisWarning[];
}

export type DraftTeamAnalysis = SnakeTeamAnalysis | AuctionTeamAnalysis;

export interface DraftAnalysisReport {
  readonly algorithmVersion: typeof DRAFT_ANALYZER_ALGORITHM_VERSION;
  readonly mode: DraftConfig["mode"];
  readonly draftStatus: "IN_PROGRESS" | "COMPLETE";
  readonly projectionAvailability: ProjectionAvailability;
  readonly teams: readonly DraftTeamAnalysis[];
  readonly warnings: readonly DraftAnalysisWarning[];
}

interface ActiveAcquisition {
  readonly index: number;
  readonly event:
    | Extract<DraftEvent, { readonly type: "SNAKE_PLAYER_SELECTED" }>
    | Extract<DraftEvent, { readonly type: "SNAKE_KEEPER_ASSIGNED" }>
    | Extract<DraftEvent, { readonly type: "AUCTION_PLAYER_SOLD" }>
    | Extract<DraftEvent, { readonly type: "AUCTION_KEEPER_ASSIGNED" }>;
}

interface StarterProjection {
  readonly projectedStarterPoints: number;
  readonly playerIds: readonly PlayerId[];
}

function nonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new RangeError(`${label} must not be empty`);
}

function validateLimit(value: number | undefined): number {
  const limit = value ?? 3;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 20) {
    throw new RangeError("Missed-alternative limit must be between 0 and 20");
  }
  return limit;
}

function validateMarket(
  market: DraftAnalysisMarket | undefined,
  playerIds: ReadonlySet<PlayerId>,
): ReadonlyMap<PlayerId, DraftAnalysisMarketPlayer> {
  if (market === undefined) return new Map();
  if (market.admissionStatus !== "ADMITTED") {
    throw new Error("Draft analysis market must be source-admitted");
  }
  nonEmpty(market.source, "Market source");
  nonEmpty(market.sourceVersion, "Market source version");
  nonEmpty(market.asOf, "Market as-of time");
  const values = new Map<PlayerId, DraftAnalysisMarketPlayer>();
  for (const row of market.players) {
    if (!playerIds.has(row.playerId)) {
      throw new Error(`Draft analysis market references unknown player ${row.playerId}`);
    }
    if (values.has(row.playerId)) {
      throw new Error(`Draft analysis market repeats player ${row.playerId}`);
    }
    if (row.adp !== undefined && (!Number.isFinite(row.adp) || row.adp <= 0)) {
      throw new RangeError(`ADP for ${row.playerId} must be positive and finite`);
    }
    if (row.tier !== undefined && (!Number.isSafeInteger(row.tier) || row.tier <= 0)) {
      throw new RangeError(`Tier for ${row.playerId} must be a positive integer`);
    }
    if (
      row.auctionValue !== undefined &&
      (!Number.isFinite(row.auctionValue) || row.auctionValue < 0)
    ) {
      throw new RangeError(`Auction value for ${row.playerId} must be non-negative and finite`);
    }
    values.set(row.playerId, row);
  }
  return values;
}

function projectionAvailability(input: DraftAnalyzerInput): ProjectionAvailability {
  if (input.projections === undefined) {
    return {
      status: "UNAVAILABLE",
      reason: "NO_PROJECTIONS",
      message:
        "No league-scored projection set was supplied; rankings and ADP were not used as points.",
    };
  }
  if (input.leagueScoringProfileId === undefined || input.leagueScoringProfileId.trim() === "") {
    return {
      status: "UNAVAILABLE",
      reason: "MISSING_LEAGUE_SCORING_PROFILE",
      message:
        "The league scoring profile is missing, so projection compatibility cannot be verified.",
    };
  }
  if (input.projections.scoringProfileId !== input.leagueScoringProfileId) {
    return {
      status: "UNAVAILABLE",
      reason: "INCOMPATIBLE_SCORING_PROFILE",
      message: "The supplied projections use a different scoring profile and were not applied.",
    };
  }
  return {
    status: "AVAILABLE",
    source: input.projections.source,
    sourceVersion: input.projections.sourceVersion,
    asOf: input.projections.asOf,
    horizon: input.projections.horizon,
    scoringProfileId: input.projections.scoringProfileId,
  };
}

function validateProjections(
  input: DraftAnalyzerInput,
  playerIds: ReadonlySet<PlayerId>,
): ReadonlyMap<PlayerId, number> {
  const projections = input.projections;
  if (projections === undefined) return new Map();
  nonEmpty(projections.source, "Projection source");
  nonEmpty(projections.sourceVersion, "Projection source version");
  nonEmpty(projections.asOf, "Projection as-of time");
  nonEmpty(projections.horizon, "Projection horizon");
  nonEmpty(projections.scoringProfileId, "Projection scoring profile");
  const values = new Map<PlayerId, number>();
  for (const row of projections.players) {
    if (!playerIds.has(row.playerId)) {
      throw new Error(`Draft analysis projections reference unknown player ${row.playerId}`);
    }
    if (values.has(row.playerId)) {
      throw new Error(`Draft analysis projections repeat player ${row.playerId}`);
    }
    if (!Number.isFinite(row.projectedPoints)) {
      throw new RangeError(`Projection for ${row.playerId} must be finite`);
    }
    values.set(row.playerId, row.projectedPoints);
  }
  return values;
}

function activeActions(events: readonly DraftEvent[], state: DraftState): readonly DraftEvent[] {
  const active = new Set(state.activeEventIds);
  return events.filter((event) => active.has(event.id) && event.type !== "DRAFT_EVENT_REVERTED");
}

function acquisitionFrom(event: DraftEvent, index: number): ActiveAcquisition | null {
  switch (event.type) {
    case "SNAKE_PLAYER_SELECTED":
    case "SNAKE_KEEPER_ASSIGNED":
    case "AUCTION_PLAYER_SOLD":
    case "AUCTION_KEEPER_ASSIGNED":
      return { event, index };
    default:
      return null;
  }
}

function rosterPlayers(
  state: DraftTeamState,
  playerById: ReadonlyMap<PlayerId, Player>,
): readonly Player[] {
  return state.roster.map((entry) => playerById.get(entry.playerId)!);
}

function starterCoverage(players: readonly Player[], slots: readonly RosterSlot[]): number {
  return assignPlayersToRosterSlots(
    players,
    slots.filter((slot) => slot.kind === "STARTER"),
  ).assignments.length;
}

function canRoster(
  team: DraftTeamConfig,
  currentPlayers: readonly Player[],
  candidate: Player,
): boolean {
  return assignPlayersToRosterSlots([...currentPlayers, candidate], team.rosterSlots).feasible;
}

function rosterConstruction(
  team: DraftTeamConfig,
  state: DraftTeamState,
  playerById: ReadonlyMap<PlayerId, Player>,
): RosterConstructionAnalysis {
  const players = rosterPlayers(state, playerById);
  const starterSlots = team.rosterSlots.filter((slot) => slot.kind === "STARTER");
  const assignment = assignPlayersToRosterSlots(players, starterSlots);
  const covered = new Set(assignment.assignments.map((row) => row.slotId));
  const counts = new Map<Position, number>();
  for (const player of players) {
    const position = player.positions[0];
    if (position !== undefined) counts.set(position, (counts.get(position) ?? 0) + 1);
  }
  const openStarterSlots = starterSlots
    .filter((slot) => !covered.has(slot.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((slot) => ({
      slotId: String(slot.id),
      type: slot.type,
      eligiblePositions: [...slot.eligiblePositions].sort((left, right) =>
        left.localeCompare(right),
      ),
    }));
  const warnings: DraftAnalysisWarning[] = [];
  if (openStarterSlots.length > 0) {
    warnings.push({
      code: "OPEN_STARTER_SLOTS",
      message: `${openStarterSlots.length} starter slot${openStarterSlots.length === 1 ? " is" : "s are"} not covered by the current roster.`,
    });
  }
  return {
    rosteredPlayers: players.length,
    totalRosterSlots: team.rosterSlots.length,
    openRosterSlots: state.openSlots,
    starterSlots: starterSlots.length,
    coveredStarterSlots: assignment.assignments.length,
    openStarterSlots,
    primaryPositionCounts: [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([position, count]) => ({ position, count })),
    warnings,
  };
}

interface FlowEdge {
  to: number;
  reverse: number;
  capacity: number;
  cost: number;
  playerId?: PlayerId;
  slotIndex?: number;
}

function addFlowEdge(
  graph: FlowEdge[][],
  from: number,
  to: number,
  capacity: number,
  cost: number,
  metadata: Pick<FlowEdge, "playerId" | "slotIndex"> = {},
): void {
  const forward: FlowEdge = {
    to,
    reverse: graph[to]!.length,
    capacity,
    cost,
    ...metadata,
  };
  const reverse: FlowEdge = { to: from, reverse: graph[from]!.length, capacity: 0, cost: -cost };
  graph[from]!.push(forward);
  graph[to]!.push(reverse);
}

/** Exact maximum-cardinality, maximum-points starter assignment. */
function optimizeStarterProjection(
  players: readonly Player[],
  slots: readonly RosterSlot[],
  points: ReadonlyMap<PlayerId, number>,
): StarterProjection {
  const orderedPlayers = [...players].sort((left, right) => left.id.localeCompare(right.id));
  const orderedSlots = slots
    .filter((slot) => slot.kind === "STARTER")
    .sort((left, right) => left.id.localeCompare(right.id));
  const source = 0;
  const playerOffset = 1;
  const slotOffset = playerOffset + orderedPlayers.length;
  const sink = slotOffset + orderedSlots.length;
  const graph: FlowEdge[][] = Array.from({ length: sink + 1 }, () => []);
  orderedPlayers.forEach((player, playerIndex) => {
    addFlowEdge(graph, source, playerOffset + playerIndex, 1, 0);
    orderedSlots.forEach((slot, slotIndex) => {
      if (isPlayerEligibleForSlot(player, slot)) {
        addFlowEdge(
          graph,
          playerOffset + playerIndex,
          slotOffset + slotIndex,
          1,
          -(points.get(player.id) ?? 0),
          { playerId: player.id, slotIndex },
        );
      }
    });
  });
  orderedSlots.forEach((_, slotIndex) => addFlowEdge(graph, slotOffset + slotIndex, sink, 1, 0));

  for (;;) {
    const distance = Array<number>(graph.length).fill(Number.POSITIVE_INFINITY);
    const previousNode = Array<number>(graph.length).fill(-1);
    const previousEdge = Array<number>(graph.length).fill(-1);
    distance[source] = 0;
    for (let pass = 0; pass < graph.length - 1; pass += 1) {
      let changed = false;
      for (let from = 0; from < graph.length; from += 1) {
        if (!Number.isFinite(distance[from])) continue;
        for (const [edgeIndex, edge] of graph[from]!.entries()) {
          if (edge.capacity <= 0) continue;
          const candidate = distance[from]! + edge.cost;
          if (candidate < distance[edge.to]! - Number.EPSILON) {
            distance[edge.to] = candidate;
            previousNode[edge.to] = from;
            previousEdge[edge.to] = edgeIndex;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    if (previousNode[sink] === -1) break;
    for (let node = sink; node !== source; node = previousNode[node]!) {
      const from = previousNode[node]!;
      const edge = graph[from]![previousEdge[node]!]!;
      edge.capacity -= 1;
      graph[node]![edge.reverse]!.capacity += 1;
    }
  }

  const assigned = new Set<PlayerId>();
  for (let playerIndex = 0; playerIndex < orderedPlayers.length; playerIndex += 1) {
    const node = playerOffset + playerIndex;
    for (const edge of graph[node]!) {
      if (edge.playerId !== undefined && edge.slotIndex !== undefined && edge.capacity === 0) {
        assigned.add(edge.playerId);
      }
    }
  }
  const playerIds = [...assigned].sort((left, right) => left.localeCompare(right));
  return {
    projectedStarterPoints: playerIds.reduce((total, id) => total + points.get(id)!, 0),
    playerIds,
  };
}

function initialTeamStrength(
  projectionState: ProjectionAvailability,
  teamState: DraftTeamState,
  teamConfig: DraftTeamConfig,
  playerById: ReadonlyMap<PlayerId, Player>,
  points: ReadonlyMap<PlayerId, number>,
  draftComplete: boolean,
): TeamStrengthAnalysis {
  if (projectionState.status === "UNAVAILABLE") {
    return {
      status: "UNAVAILABLE",
      reason: projectionState.reason,
      missingPlayerIds: [],
      message: projectionState.message,
    };
  }
  const players = rosterPlayers(teamState, playerById);
  if (players.length === 0) {
    return {
      status: "UNAVAILABLE",
      reason: "EMPTY_ROSTER",
      missingPlayerIds: [],
      message: "The team has not acquired a player, so current-roster strength is unavailable.",
    };
  }
  const missing = players
    .filter((player) => !points.has(player.id))
    .map((player) => player.id)
    .sort((left, right) => left.localeCompare(right));
  if (missing.length > 0) {
    return {
      status: "UNAVAILABLE",
      reason: "MISSING_PLAYER_PROJECTIONS",
      missingPlayerIds: missing,
      message: "At least one rostered player lacks a compatible league-scored projection.",
    };
  }
  const starter = optimizeStarterProjection(players, teamConfig.rosterSlots, points);
  return {
    status: "AVAILABLE",
    projectedRosterPoints: players.reduce((total, player) => total + points.get(player.id)!, 0),
    projectedStarterPoints: starter.projectedStarterPoints,
    projectedStarterPlayerIds: starter.playerIds,
    leagueRank: 0,
    rankedTeamCount: 0,
    basis: "CURRENT_ROSTER",
    warnings: draftComplete
      ? []
      : [
          {
            code: "IN_PROGRESS_STRENGTH",
            message:
              "Strength reflects only players acquired so far; teams may have unequal pick counts.",
          },
        ],
  };
}

function rankTeamStrengths<
  T extends { readonly teamId: TeamId; readonly strength: TeamStrengthAnalysis },
>(rows: readonly T[]): ReadonlyMap<TeamId, TeamStrengthAnalysis> {
  const available = rows
    .filter(
      (
        row,
      ): row is T & { readonly strength: Extract<TeamStrengthAnalysis, { status: "AVAILABLE" }> } =>
        row.strength.status === "AVAILABLE",
    )
    .sort(
      (left, right) =>
        right.strength.projectedStarterPoints - left.strength.projectedStarterPoints ||
        left.teamId.localeCompare(right.teamId),
    );
  const ranked = new Map<TeamId, TeamStrengthAnalysis>();
  let priorPoints: number | undefined;
  let rank = 0;
  for (const [index, row] of available.entries()) {
    if (priorPoints === undefined || row.strength.projectedStarterPoints !== priorPoints) {
      rank = index + 1;
      priorPoints = row.strength.projectedStarterPoints;
    }
    ranked.set(row.teamId, {
      ...row.strength,
      leagueRank: rank,
      rankedTeamCount: available.length,
    });
  }
  for (const row of rows) {
    if (row.strength.status === "UNAVAILABLE") ranked.set(row.teamId, row.strength);
  }
  return ranked;
}

function teamWarnings(
  marketPresent: boolean,
  strength: TeamStrengthAnalysis,
): DraftAnalysisWarning[] {
  const warnings: DraftAnalysisWarning[] = [];
  if (!marketPresent) {
    warnings.push({
      code: "NO_ADMITTED_MARKET_BASELINE",
      message:
        "No admitted market baseline was supplied; market grades and missed alternatives are unavailable.",
    });
  }
  if (strength.status === "UNAVAILABLE") {
    warnings.push({ code: "TEAM_STRENGTH_UNAVAILABLE", message: strength.message });
  }
  return warnings;
}

function snakeSelection(
  config: SnakeDraftConfig,
  action: ActiveAcquisition,
  before: DraftState,
  teamConfig: DraftTeamConfig,
  playerById: ReadonlyMap<PlayerId, Player>,
  market: ReadonlyMap<PlayerId, DraftAnalysisMarketPlayer>,
  laterAcquisitions: readonly ActiveAcquisition[],
  limit: number,
): SnakeSelectionAnalysis {
  const event = action.event;
  if (event.type !== "SNAKE_PLAYER_SELECTED" && event.type !== "SNAKE_KEEPER_ASSIGNED") {
    throw new Error("Snake selection analysis received a non-snake event");
  }
  const player = playerById.get(event.playerId)!;
  const baseline = market.get(event.playerId);
  const threshold = Math.max(2, Math.ceil(config.teams.length / 2));
  const pickVsAdp = baseline?.adp === undefined ? null : event.overallPick - baseline.adp;
  const classification =
    pickVsAdp === null
      ? "UNAVAILABLE"
      : pickVsAdp >= threshold
        ? "VALUE"
        : pickVsAdp <= -threshold
          ? "REACH"
          : "AT_MARKET";
  const beforeTeam = before.teams.find((team) => team.teamId === event.teamId)!;
  const beforePlayers = rosterPlayers(beforeTeam, playerById);
  const beforeCoverage = starterCoverage(beforePlayers, teamConfig.rosterSlots);
  const afterCoverage = starterCoverage([...beforePlayers, player], teamConfig.rosterSlots);
  const draftedBefore = new Set(before.draftedPlayerIds);
  const legalMarket = [...market.values()]
    .filter((candidate) => {
      const candidatePlayer = playerById.get(candidate.playerId)!;
      return (
        candidate.playerId !== event.playerId &&
        !draftedBefore.has(candidate.playerId) &&
        canRoster(teamConfig, beforePlayers, candidatePlayer)
      );
    })
    .sort(
      (left, right) =>
        (left.adp ?? Number.POSITIVE_INFINITY) - (right.adp ?? Number.POSITIVE_INFINITY) ||
        (left.tier ?? Number.POSITIVE_INFINITY) - (right.tier ?? Number.POSITIVE_INFINITY) ||
        left.playerId.localeCompare(right.playerId),
    );
  const bestAdp = legalMarket.find((row) => row.adp !== undefined)?.adp ?? null;
  const bestTier = [...legalMarket]
    .filter((row) => row.tier !== undefined)
    .sort(
      (left, right) => left.tier! - right.tier! || left.playerId.localeCompare(right.playerId),
    )[0]?.tier;
  const laterByPlayer = new Map(
    laterAcquisitions
      .filter((row) => row.index > action.index)
      .map((row) => [row.event.playerId, row.event] as const),
  );
  const missed =
    baseline?.adp === undefined
      ? []
      : legalMarket
          .filter((row) => row.adp !== undefined && row.adp < baseline.adp!)
          .flatMap((row): SnakeMissedAlternative[] => {
            const later = laterByPlayer.get(row.playerId);
            if (later !== undefined && later.teamId === event.teamId) {
              return [];
            }
            const snakeLater =
              later?.type === "SNAKE_PLAYER_SELECTED" || later?.type === "SNAKE_KEEPER_ASSIGNED"
                ? later
                : undefined;
            return [
              {
                playerId: row.playerId,
                name: playerById.get(row.playerId)!.name,
                adp: row.adp!,
                adpAdvantage: baseline.adp! - row.adp!,
                tier: row.tier ?? null,
                outcome:
                  snakeLater === undefined ? "UNDRAFTED_AT_ANALYSIS" : "DRAFTED_LATER_BY_OPPONENT",
                laterOverallPick: snakeLater?.overallPick ?? null,
                laterTeamId: snakeLater?.teamId ?? null,
              },
            ];
          })
          .sort(
            (left, right) =>
              right.adpAdvantage - left.adpAdvantage || left.playerId.localeCompare(right.playerId),
          )
          .slice(0, limit);
  const warnings: DraftAnalysisWarning[] = [];
  if (baseline?.adp === undefined) {
    warnings.push({
      code: "PLAYER_ADP_UNAVAILABLE",
      message: "This selection has no admitted ADP observation, so reach/value is unavailable.",
    });
  }
  if (
    afterCoverage === beforeCoverage &&
    beforeCoverage < teamConfig.rosterSlots.filter((slot) => slot.kind === "STARTER").length
  ) {
    warnings.push({
      code: "STARTER_NEED_NOT_FILLED",
      message: "The selection did not increase current starter-slot coverage.",
    });
  }
  return {
    eventId: String(event.id),
    acquisition: event.type === "SNAKE_PLAYER_SELECTED" ? "SNAKE_PICK" : "SNAKE_KEEPER",
    playerId: event.playerId,
    playerName: player.name,
    overallPick: event.overallPick,
    market: {
      status: pickVsAdp === null ? "UNAVAILABLE" : "AVAILABLE",
      adp: baseline?.adp ?? null,
      pickVsAdp,
      classification,
      classificationThresholdPicks: threshold,
    },
    rosterNeed: {
      starterCoverageBefore: beforeCoverage,
      starterCoverageAfter: afterCoverage,
      filledOpenStarterSlot: afterCoverage > beforeCoverage,
    },
    opportunityCost: {
      selectedTier: baseline?.tier ?? null,
      bestAvailableTier: bestTier ?? null,
      tierGap:
        baseline?.tier === undefined || bestTier === undefined ? null : baseline.tier - bestTier,
      bestAvailableAdp: bestAdp,
      adpCost: baseline?.adp === undefined || bestAdp === null ? null : baseline.adp - bestAdp,
    },
    missedAlternatives: missed,
    warnings,
  };
}

function auctionPurchase(
  config: AuctionDraftConfig,
  action: ActiveAcquisition,
  before: DraftState,
  teamConfig: DraftTeamConfig,
  playerById: ReadonlyMap<PlayerId, Player>,
  market: ReadonlyMap<PlayerId, DraftAnalysisMarketPlayer>,
  laterAcquisitions: readonly ActiveAcquisition[],
  limit: number,
): AuctionPurchaseAnalysis {
  const event = action.event;
  if (event.type !== "AUCTION_PLAYER_SOLD" && event.type !== "AUCTION_KEEPER_ASSIGNED") {
    throw new Error("Auction purchase analysis received a non-auction event");
  }
  const player = playerById.get(event.playerId)!;
  const baseline = market.get(event.playerId)?.auctionValue;
  const threshold = Math.max(1, Math.round(config.minimumBid));
  const surplus = baseline === undefined ? null : baseline - event.price;
  const classification =
    surplus === null
      ? "UNAVAILABLE"
      : surplus >= threshold
        ? "VALUE"
        : surplus <= -threshold
          ? "OVERPAY"
          : "AT_MARKET";
  const beforeTeam = before.teams.find((team) => team.teamId === event.teamId)!;
  const beforePlayers = rosterPlayers(beforeTeam, playerById);
  const beforeCoverage = starterCoverage(beforePlayers, teamConfig.rosterSlots);
  const afterCoverage = starterCoverage([...beforePlayers, player], teamConfig.rosterSlots);
  const remainingBudget = beforeTeam.remainingBudget!;
  const legalMaximum = maximumLegalBid(remainingBudget, beforeTeam.openSlots, config.minimumBid);
  const draftedBefore = new Set(before.draftedPlayerIds);
  const missed =
    surplus === null
      ? []
      : laterAcquisitions
          .filter(
            (
              row,
            ): row is ActiveAcquisition & {
              readonly event:
                | Extract<DraftEvent, { readonly type: "AUCTION_PLAYER_SOLD" }>
                | Extract<DraftEvent, { readonly type: "AUCTION_KEEPER_ASSIGNED" }>;
            } =>
              row.index > action.index &&
              (row.event.type === "AUCTION_PLAYER_SOLD" ||
                row.event.type === "AUCTION_KEEPER_ASSIGNED") &&
              row.event.teamId !== event.teamId,
          )
          .flatMap((row): AuctionMissedAlternative[] => {
            const candidateBaseline = market.get(row.event.playerId)?.auctionValue;
            const candidate = playerById.get(row.event.playerId)!;
            if (
              candidateBaseline === undefined ||
              draftedBefore.has(row.event.playerId) ||
              row.event.price > legalMaximum ||
              !canRoster(teamConfig, beforePlayers, candidate)
            ) {
              return [];
            }
            const candidateSurplus = candidateBaseline - row.event.price;
            const advantage = candidateSurplus - surplus;
            if (advantage <= 0) return [];
            return [
              {
                playerId: row.event.playerId,
                name: candidate.name,
                baselineValue: candidateBaseline,
                laterPrice: row.event.price,
                valueAtLaterPrice: candidateSurplus,
                surplusAdvantage: advantage,
                laterTeamId: row.event.teamId,
              },
            ];
          })
          .sort(
            (left, right) =>
              right.surplusAdvantage - left.surplusAdvantage ||
              left.playerId.localeCompare(right.playerId),
          )
          .slice(0, limit);
  const warnings: DraftAnalysisWarning[] = [];
  if (baseline === undefined) {
    warnings.push({
      code: "PLAYER_AUCTION_VALUE_UNAVAILABLE",
      message: "This purchase has no admitted auction baseline, so price/value is unavailable.",
    });
  }
  if (event.price > legalMaximum) {
    warnings.push({
      code: "MAXIMUM_BID_EXCEEDED",
      message: "The recorded price exceeded the maximum legal bid before this purchase.",
    });
  }
  return {
    eventId: String(event.id),
    acquisition: event.type === "AUCTION_PLAYER_SOLD" ? "AUCTION" : "AUCTION_KEEPER",
    playerId: event.playerId,
    playerName: player.name,
    price: event.price,
    market: {
      status: surplus === null ? "UNAVAILABLE" : "AVAILABLE",
      baselineValue: baseline ?? null,
      surplus,
      classification,
      classificationThresholdDollars: threshold,
    },
    legality: {
      maximumLegalBidBeforePurchase: legalMaximum,
      withinMaximumBid: event.price <= legalMaximum,
      remainingBudgetBeforePurchase: remainingBudget,
      openSlotsBeforePurchase: beforeTeam.openSlots,
    },
    rosterNeed: {
      starterCoverageBefore: beforeCoverage,
      starterCoverageAfter: afterCoverage,
      filledOpenStarterSlot: afterCoverage > beforeCoverage,
    },
    missedAlternatives: missed,
    warnings,
  };
}

export function analyzeDraft(input: DraftAnalyzerInput): DraftAnalysisReport {
  const limit = validateLimit(input.missedAlternativeLimit);
  const state = reduceDraft(input.config, input.events);
  const playerById = new Map(input.config.players.map((player) => [player.id, player]));
  const playerIds = new Set(playerById.keys());
  const market = validateMarket(input.market, playerIds);
  const projectionState = projectionAvailability(input);
  const projections = validateProjections(input, playerIds);
  const actions = activeActions(input.events, state);
  const acquisitions = actions
    .map(acquisitionFrom)
    .filter((row): row is ActiveAcquisition => row !== null);
  const teamStateById = new Map(state.teams.map((team) => [team.teamId, team]));
  const unrankedStrengths = input.config.teams.map((team) => ({
    teamId: team.id,
    strength: initialTeamStrength(
      projectionState,
      teamStateById.get(team.id)!,
      team,
      playerById,
      projections,
      state.complete,
    ),
  }));
  const strengths = rankTeamStrengths(unrankedStrengths);

  const prefixes = new Map<number, DraftState>();
  const stateBefore = (action: ActiveAcquisition): DraftState => {
    const existing = prefixes.get(action.index);
    if (existing !== undefined) return existing;
    const reduced = reduceDraft(input.config, actions.slice(0, action.index));
    prefixes.set(action.index, reduced);
    return reduced;
  };

  const config = input.config;
  const teams: DraftTeamAnalysis[] = [...config.teams]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((teamConfig): DraftTeamAnalysis => {
      const teamState = teamStateById.get(teamConfig.id)!;
      const strength = strengths.get(teamConfig.id)!;
      const common = {
        teamId: teamConfig.id,
        name: teamConfig.name,
        roster: rosterConstruction(teamConfig, teamState, playerById),
        teamStrength: strength,
        warnings: teamWarnings(input.market !== undefined, strength),
      };
      const teamAcquisitions = acquisitions.filter((row) => row.event.teamId === teamConfig.id);
      if (config.mode === "SNAKE") {
        const selections = teamAcquisitions
          .filter(
            (row) =>
              row.event.type === "SNAKE_PLAYER_SELECTED" ||
              row.event.type === "SNAKE_KEEPER_ASSIGNED",
          )
          .map((row) =>
            snakeSelection(
              config,
              row,
              stateBefore(row),
              teamConfig,
              playerById,
              market,
              acquisitions,
              limit,
            ),
          );
        const covered = selections.filter((row) => row.market.status === "AVAILABLE");
        const totalDelta = covered.reduce((total, row) => total + row.market.pickVsAdp!, 0);
        return {
          mode: "SNAKE",
          ...common,
          selections,
          marketSummary: {
            status:
              covered.length === 0
                ? "UNAVAILABLE"
                : covered.length === selections.length
                  ? "AVAILABLE"
                  : "PARTIAL",
            coveredSelections: covered.length,
            totalSelections: selections.length,
            averagePickVsAdp: covered.length === 0 ? null : totalDelta / covered.length,
            values: covered.filter((row) => row.market.classification === "VALUE").length,
            reaches: covered.filter((row) => row.market.classification === "REACH").length,
          },
        };
      }

      const purchases = teamAcquisitions
        .filter(
          (row) =>
            row.event.type === "AUCTION_PLAYER_SOLD" ||
            row.event.type === "AUCTION_KEEPER_ASSIGNED",
        )
        .map((row) =>
          auctionPurchase(
            config,
            row,
            stateBefore(row),
            teamConfig,
            playerById,
            market,
            acquisitions,
            limit,
          ),
        );
      const covered = purchases.filter((row) => row.market.status === "AVAILABLE");
      const budget = teamConfig.budget!;
      const spent = teamState.spent!;
      const baselineValue = covered.reduce((total, row) => total + row.market.baselineValue!, 0);
      return {
        mode: "AUCTION",
        ...common,
        purchases,
        budget: {
          initialBudget: budget,
          spent,
          remainingBudget: teamState.remainingBudget!,
          maximumLegalBid: teamState.maximumBid!,
          rosterFillRate: teamState.roster.length / teamConfig.rosterSlots.length,
          budgetSpentRate: budget === 0 ? 0 : spent / budget,
          paceDelta:
            (budget === 0 ? 0 : spent / budget) -
            teamState.roster.length / teamConfig.rosterSlots.length,
        },
        marketEfficiency:
          covered.length > 0 && covered.length === purchases.length
            ? {
                status: "AVAILABLE",
                baselineValueAcquired: baselineValue,
                spent,
                surplus: baselineValue - spent,
                baselineValuePerDollar: spent === 0 ? null : baselineValue / spent,
              }
            : {
                status: covered.length === 0 ? "UNAVAILABLE" : "PARTIAL",
                coveredPurchases: covered.length,
                totalPurchases: purchases.length,
                message:
                  covered.length === 0
                    ? "No purchases have an admitted auction-value baseline."
                    : "At least one purchase lacks an admitted auction-value baseline; aggregate efficiency is withheld.",
              },
      };
    });

  const warnings: DraftAnalysisWarning[] = [];
  if (input.market === undefined) {
    warnings.push({
      code: "NO_ADMITTED_MARKET_BASELINE",
      message: "Reach/value, auction efficiency, and missed-alternative analysis are unavailable.",
    });
  }
  if (projectionState.status === "UNAVAILABLE") {
    warnings.push({ code: "PROJECTIONS_UNAVAILABLE", message: projectionState.message });
  }
  return {
    algorithmVersion: DRAFT_ANALYZER_ALGORITHM_VERSION,
    mode: input.config.mode,
    draftStatus: state.complete ? "COMPLETE" : "IN_PROGRESS",
    projectionAvailability: projectionState,
    teams,
    warnings,
  };
}
