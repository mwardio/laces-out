import {
  assignPlayersToRosterSlots,
  type Player,
  type PlayerId,
  type Position,
  type RosterSlot,
} from "@laces-out/domain";

export interface DraftAdvisorPlayer {
  readonly playerId: PlayerId;
  readonly name: string;
  readonly positions: readonly Position[];
  readonly projectedPoints: number;
  readonly floorPoints?: number;
  readonly ceilingPoints?: number;
  readonly confidence?: number;
  readonly tier?: number;
  /** Probability from zero to one that the player reaches the user's next pick. */
  readonly availabilityAtNextPick?: number;
  /** Combined injury, role, and data-quality risk from zero to one. */
  readonly risk?: number;
}

export interface ReplacementLevel {
  readonly position: Position;
  readonly projectedPoints: number;
  readonly starterDemand: number;
  readonly replacementPlayerId: PlayerId | null;
}

export interface DraftRecommendationFactors {
  readonly projectedPoints: number;
  readonly replacementPoints: number;
  readonly valueOverReplacement: number;
  readonly rosterNeedBonus: number;
  readonly tierUrgencyBonus: number;
  readonly waitUrgencyBonus: number;
  readonly riskPenalty: number;
  readonly score: number;
}

export interface DraftPlayerRecommendation {
  readonly rank: number;
  readonly playerId: PlayerId;
  readonly name: string;
  readonly positions: readonly Position[];
  readonly factors: DraftRecommendationFactors;
  readonly reasons: readonly string[];
  readonly warnings: readonly string[];
}

export interface DraftRecommendationInput {
  readonly availablePlayers: readonly DraftAdvisorPlayer[];
  readonly userRoster: readonly DraftAdvisorPlayer[];
  readonly userRosterSlots: readonly RosterSlot[];
  /** Starter slots for every team, flattened into one league-wide pool. */
  readonly leagueStarterSlots: readonly RosterSlot[];
  readonly replacementLevels?: ReadonlyMap<Position, number>;
  readonly limit?: number;
}

function assertProbability(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
    throw new RangeError(`${label} must be between zero and one`);
  }
}

function validatePlayer(player: DraftAdvisorPlayer): void {
  if (player.positions.length === 0)
    throw new RangeError(`${player.name} has no eligible position`);
  if (!Number.isFinite(player.projectedPoints)) {
    throw new RangeError(`${player.name} must have a finite projection`);
  }
  if (player.tier !== undefined && (!Number.isSafeInteger(player.tier) || player.tier <= 0)) {
    throw new RangeError(`${player.name} has an invalid tier`);
  }
  assertProbability(player.confidence, `${player.name} confidence`);
  assertProbability(player.availabilityAtNextPick, `${player.name} availability`);
  assertProbability(player.risk, `${player.name} risk`);
}

function orderedPlayers(players: readonly DraftAdvisorPlayer[]): DraftAdvisorPlayer[] {
  return [...players].sort(
    (left, right) =>
      right.projectedPoints - left.projectedPoints || left.playerId.localeCompare(right.playerId),
  );
}

function primaryEligiblePosition(
  player: DraftAdvisorPlayer,
  eligible: readonly Position[],
): Position | undefined {
  return player.positions.find((position) => eligible.includes(position));
}

/**
 * Derives transparent replacement baselines from league-wide starter demand.
 * Dedicated slots are filled first, then flexible slots consume the best
 * remaining eligible player. The first unselected player at each position is
 * the replacement baseline.
 */
export function deriveReplacementLevels(
  players: readonly DraftAdvisorPlayer[],
  leagueStarterSlots: readonly RosterSlot[],
): readonly ReplacementLevel[] {
  players.forEach(validatePlayer);
  const starters = leagueStarterSlots.filter((slot) => slot.kind === "STARTER");
  const selected = new Set<PlayerId>();
  const demand = new Map<Position, number>();
  const byPosition = new Map<Position, DraftAdvisorPlayer[]>();

  for (const player of orderedPlayers(players)) {
    for (const position of player.positions) {
      const values = byPosition.get(position) ?? [];
      values.push(player);
      byPosition.set(position, values);
    }
  }

  const dedicated = starters
    .filter((slot) => slot.eligiblePositions.length === 1)
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const slot of dedicated) {
    const position = slot.eligiblePositions[0];
    if (!position) continue;
    const player = byPosition.get(position)?.find((candidate) => !selected.has(candidate.playerId));
    if (!player) continue;
    selected.add(player.playerId);
    demand.set(position, (demand.get(position) ?? 0) + 1);
  }

  const flexible = starters
    .filter((slot) => slot.eligiblePositions.length > 1)
    .sort(
      (left, right) =>
        left.eligiblePositions.length - right.eligiblePositions.length ||
        left.id.localeCompare(right.id),
    );
  const allOrdered = orderedPlayers(players);
  for (const slot of flexible) {
    const player = allOrdered.find(
      (candidate) =>
        !selected.has(candidate.playerId) &&
        candidate.positions.some((position) => slot.eligiblePositions.includes(position)),
    );
    if (!player) continue;
    const position = primaryEligiblePosition(player, slot.eligiblePositions);
    if (!position) continue;
    selected.add(player.playerId);
    demand.set(position, (demand.get(position) ?? 0) + 1);
  }

  return [...byPosition.entries()]
    .map(([position, candidates]): ReplacementLevel => {
      const replacement = candidates.find((candidate) => !selected.has(candidate.playerId));
      const lastSelected = [...candidates]
        .reverse()
        .find((candidate) => selected.has(candidate.playerId));
      return {
        position,
        projectedPoints: replacement?.projectedPoints ?? lastSelected?.projectedPoints ?? 0,
        starterDemand: demand.get(position) ?? 0,
        replacementPlayerId: replacement?.playerId ?? null,
      };
    })
    .sort((left, right) => left.position.localeCompare(right.position));
}

function asDomainPlayer(player: DraftAdvisorPlayer): Player {
  return { id: player.playerId, name: player.name, positions: player.positions };
}

function starterCoverage(
  players: readonly DraftAdvisorPlayer[],
  slots: readonly RosterSlot[],
): number {
  const starters = slots.filter((slot) => slot.kind === "STARTER");
  return assignPlayersToRosterSlots(players.map(asDomainPlayer), starters).assignments.length;
}

function bestReplacement(
  player: DraftAdvisorPlayer,
  replacement: ReadonlyMap<Position, number>,
): number {
  const values = player.positions.flatMap((position) => {
    const value = replacement.get(position);
    return value === undefined ? [] : [value];
  });
  return values.length === 0 ? 0 : Math.min(...values);
}

function nextTierDrop(
  player: DraftAdvisorPlayer,
  availablePlayers: readonly DraftAdvisorPlayer[],
): number {
  const tier = player.tier;
  if (tier === undefined) return 0;
  const lowerTier = orderedPlayers(availablePlayers).find(
    (candidate) =>
      candidate.playerId !== player.playerId &&
      candidate.tier !== undefined &&
      candidate.tier > tier &&
      candidate.positions.some((position) => player.positions.includes(position)),
  );
  return lowerTier ? Math.max(0, player.projectedPoints - lowerTier.projectedPoints) : 0;
}

export function recommendDraftPlayers(
  input: DraftRecommendationInput,
): readonly DraftPlayerRecommendation[] {
  const limit = input.limit ?? 12;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
    throw new RangeError("Draft recommendation limit must be between 1 and 100");
  }
  input.availablePlayers.forEach(validatePlayer);
  input.userRoster.forEach(validatePlayer);
  const rostered = new Set(input.userRoster.map((player) => player.playerId));
  if (input.availablePlayers.some((player) => rostered.has(player.playerId))) {
    throw new Error("Available-player input includes a player already on the user's roster");
  }

  const derived = deriveReplacementLevels(input.availablePlayers, input.leagueStarterSlots);
  const replacement =
    input.replacementLevels ??
    new Map(derived.map((level) => [level.position, level.projectedPoints] as const));
  const coverageBefore = starterCoverage(input.userRoster, input.userRosterSlots);

  const ranked = input.availablePlayers.map((player) => {
    const replacementPoints = bestReplacement(player, replacement);
    const valueOverReplacement = player.projectedPoints - replacementPoints;
    const coverageAfter = starterCoverage([...input.userRoster, player], input.userRosterSlots);
    const rosterNeedBonus =
      coverageAfter > coverageBefore ? Math.max(1, valueOverReplacement * 0.12) : 0;
    const tierDrop = nextTierDrop(player, input.availablePlayers);
    const tierUrgencyBonus = tierDrop * 0.35;
    const waitUrgency = 1 - (player.availabilityAtNextPick ?? 0.5);
    const waitUrgencyBonus = Math.max(0, valueOverReplacement) * waitUrgency * 0.2;
    const combinedRisk = Math.max(player.risk ?? 0, 1 - (player.confidence ?? 1));
    const riskPenalty = Math.max(0, valueOverReplacement) * combinedRisk * 0.25;
    const score =
      valueOverReplacement + rosterNeedBonus + tierUrgencyBonus + waitUrgencyBonus - riskPenalty;
    const reasons = [
      `${valueOverReplacement.toFixed(1)} points above the ${player.positions.join("/")} replacement baseline`,
      ...(rosterNeedBonus > 0 ? ["Fills an open starter slot"] : []),
      ...(tierUrgencyBonus > 0 ? [`A ${tierDrop.toFixed(1)}-point tier drop follows`] : []),
      ...(player.availabilityAtNextPick !== undefined && player.availabilityAtNextPick < 0.35
        ? ["Unlikely to remain available at the next pick"]
        : []),
    ];
    const warnings = [
      ...(combinedRisk >= 0.5 ? ["Projection or availability risk is elevated"] : []),
      ...(valueOverReplacement <= 0 ? ["Does not currently clear replacement value"] : []),
    ];
    return {
      player,
      factors: {
        projectedPoints: player.projectedPoints,
        replacementPoints,
        valueOverReplacement,
        rosterNeedBonus,
        tierUrgencyBonus,
        waitUrgencyBonus,
        riskPenalty,
        score,
      },
      reasons,
      warnings,
    };
  });

  return ranked
    .sort(
      (left, right) =>
        right.factors.score - left.factors.score ||
        right.player.projectedPoints - left.player.projectedPoints ||
        left.player.playerId.localeCompare(right.player.playerId),
    )
    .slice(0, limit)
    .map((item, index) => ({
      rank: index + 1,
      playerId: item.player.playerId,
      name: item.player.name,
      positions: item.player.positions,
      factors: item.factors,
      reasons: item.reasons,
      warnings: item.warnings,
    }));
}
