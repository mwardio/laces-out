import {
  calculateAuctionInflation,
  estimateDraftAvailability,
  recommendAuctionNominations,
  recommendBid,
  type DraftAvailabilityEstimate,
} from "@laces-out/engine-draft";
import { playerId } from "@laces-out/domain";

export type DraftBoardSort = "rank" | "tier" | "aav" | "name";

export interface DraftBoardPlayer {
  readonly id: string;
  readonly name: string;
  readonly positions: readonly string[];
}

export interface DraftBoardValue {
  readonly playerId: string;
  readonly overallRank: number | null;
  readonly positionRank: number | null;
  readonly tier: number | null;
  readonly adp: number | null;
  readonly adpStandardDeviation?: number | null;
  readonly adpSampleSize?: number | null;
  readonly aav: number | null;
  readonly targetPrice: number | null;
  readonly ceilingPrice: number | null;
  readonly target: boolean;
  readonly avoid: boolean;
}

export interface DraftBoardRow<Player extends DraftBoardPlayer = DraftBoardPlayer> {
  readonly player: Player;
  readonly value: DraftBoardValue | null;
  readonly covered: boolean;
}

function finite(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

export function hasDraftBoardCoverage(value: DraftBoardValue | null): boolean {
  return (
    value !== null &&
    [
      value.overallRank,
      value.positionRank,
      value.tier,
      value.adp,
      value.aav,
      value.targetPrice,
      value.ceilingPrice,
    ].some((candidate) => finite(candidate) !== null)
  );
}

function rankMetric(value: DraftBoardValue | null): number | null {
  return finite(value?.overallRank ?? null) ?? finite(value?.adp ?? null);
}

function compareNullable(
  left: number | null,
  right: number | null,
  direction: "ascending" | "descending",
): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return direction === "ascending" ? left - right : right - left;
}

export function buildDraftBoardRows<Player extends DraftBoardPlayer>(
  players: readonly Player[],
  values: readonly DraftBoardValue[],
  sort: DraftBoardSort,
): readonly DraftBoardRow<Player>[] {
  const byPlayer = new Map(values.map((value) => [value.playerId, value]));
  return players
    .map((player) => {
      const value = byPlayer.get(player.id) ?? null;
      return { player, value, covered: hasDraftBoardCoverage(value) };
    })
    .sort((left, right) => {
      if (sort === "name") return left.player.name.localeCompare(right.player.name);
      let compared = 0;
      if (sort === "rank") {
        compared = compareNullable(rankMetric(left.value), rankMetric(right.value), "ascending");
      } else if (sort === "tier") {
        compared = compareNullable(
          finite(left.value?.tier ?? null),
          finite(right.value?.tier ?? null),
          "ascending",
        );
      } else if (sort === "aav") {
        compared = compareNullable(
          finite(left.value?.aav ?? null),
          finite(right.value?.aav ?? null),
          "descending",
        );
      }
      if (compared !== 0) return compared;
      const rankCompared = compareNullable(
        rankMetric(left.value),
        rankMetric(right.value),
        "ascending",
      );
      if (rankCompared !== 0) return rankCompared;
      const tierCompared = compareNullable(
        finite(left.value?.tier ?? null),
        finite(right.value?.tier ?? null),
        "ascending",
      );
      return tierCompared || left.player.name.localeCompare(right.player.name);
    });
}

export interface DraftBoardRosterSlot {
  readonly id: string;
  readonly label: string;
  readonly kind: "STARTER" | "BENCH" | "INJURED_RESERVE" | "TAXI";
  readonly eligiblePositions: readonly string[];
}

export interface SnakeQueueInput<Player extends DraftBoardPlayer> {
  readonly availablePlayers: readonly Player[];
  readonly values: readonly DraftBoardValue[];
  readonly allPlayers: readonly Player[];
  readonly rosteredPlayerIds: readonly string[];
  readonly rosterSlots: readonly DraftBoardRosterSlot[];
  readonly currentPick?: number;
  readonly nextPick?: number | null;
  readonly limit?: number;
}

export interface SnakeQueueRow<
  Player extends DraftBoardPlayer = DraftBoardPlayer,
> extends DraftBoardRow<Player> {
  readonly baseRank: number;
  readonly adjustedRank: number;
  readonly needScore: number;
  readonly needLabel: string;
  readonly availability: DraftAvailabilityEstimate | null;
  readonly waitRiskAdjustment: number;
}

export function nextPickForTeam(
  pickOrder: readonly string[],
  currentPick: number,
  teamId: string,
): number | null {
  if (!Number.isSafeInteger(currentPick) || currentPick <= 0) return null;
  const nextIndex = pickOrder.findIndex(
    (candidate, index) => index >= currentPick && candidate === teamId,
  );
  return nextIndex === -1 ? null : nextIndex + 1;
}

/**
 * Starter slots a roster cannot cover, by maximum bipartite matching rather than position counting
 * so a flex-eligible player is never double-counted. Exported for the live-draft mobile summary.
 */
export function unfilledStarterSlots<Player extends DraftBoardPlayer>(
  allPlayers: readonly Player[],
  rosteredPlayerIds: readonly string[],
  rosterSlots: readonly DraftBoardRosterSlot[],
): readonly DraftBoardRosterSlot[] {
  const players = new Map(allPlayers.map((player) => [player.id, player]));
  const rostered = rosteredPlayerIds
    .map((id) => players.get(id))
    .filter((player): player is Player => player !== undefined)
    .sort(
      (left, right) =>
        left.positions.length - right.positions.length || left.id.localeCompare(right.id),
    );
  const slots = rosterSlots
    .filter((slot) => slot.kind === "STARTER")
    .sort(
      (left, right) =>
        left.eligiblePositions.length - right.eligiblePositions.length ||
        left.id.localeCompare(right.id),
    );
  const playerBySlot = new Map<string, string>();

  const assign = (player: Player, visited: Set<string>): boolean => {
    for (const slot of slots) {
      if (
        visited.has(slot.id) ||
        !player.positions.some((position) => slot.eligiblePositions.includes(position))
      ) {
        continue;
      }
      visited.add(slot.id);
      const occupantId = playerBySlot.get(slot.id);
      const occupant = occupantId ? players.get(occupantId) : undefined;
      if (!occupant || assign(occupant, visited)) {
        playerBySlot.set(slot.id, player.id);
        return true;
      }
    }
    return false;
  };

  for (const player of rostered) assign(player, new Set());
  return slots.filter((slot) => !playerBySlot.has(slot.id));
}

function candidateNeed(
  player: DraftBoardPlayer,
  openSlots: readonly DraftBoardRosterSlot[],
): { readonly score: number; readonly label: string } {
  const eligible = openSlots.filter((slot) =>
    player.positions.some((position) => slot.eligiblePositions.includes(position)),
  );
  const direct = eligible.filter((slot) => slot.eligiblePositions.length === 1);
  const flexible = eligible.length - direct.length;
  if (direct.length > 0) {
    return {
      score: direct.length * 3 + flexible,
      label: `${direct[0]?.label ?? player.positions[0] ?? "Starter"} open`,
    };
  }
  if (flexible > 0) return { score: flexible, label: "Flex starter open" };
  return { score: 0, label: "Depth only" };
}

/** Rank/ADP minus at most 12 places for open starter fit; no probability is inferred. */
export function buildSnakeBestNowQueue<Player extends DraftBoardPlayer>(
  input: SnakeQueueInput<Player>,
): readonly SnakeQueueRow<Player>[] {
  const openSlots = unfilledStarterSlots(
    input.allPlayers,
    input.rosteredPlayerIds,
    input.rosterSlots,
  );
  const rows = buildDraftBoardRows(input.availablePlayers, input.values, "rank");
  return rows
    .flatMap((row): SnakeQueueRow<Player>[] => {
      const baseRank = rankMetric(row.value);
      if (baseRank === null) return [];
      const need = candidateNeed(row.player, openSlots);
      const adp = finite(row.value?.adp ?? null);
      const availability =
        adp !== null &&
        input.currentPick !== undefined &&
        input.nextPick !== undefined &&
        input.nextPick !== null &&
        input.nextPick > input.currentPick
          ? estimateDraftAvailability({
              meanAdp: adp,
              ...(finite(row.value?.adpStandardDeviation ?? null) === null
                ? {}
                : { standardDeviation: row.value?.adpStandardDeviation as number }),
              ...(row.value?.adpSampleSize === null || row.value?.adpSampleSize === undefined
                ? {}
                : { distributionSampleSize: row.value.adpSampleSize }),
              currentPick: input.currentPick,
              nextPick: input.nextPick,
            })
          : null;
      const waitRiskAdjustment = availability
        ? availability.probabilitySelectedBeforeNextPick * 6
        : 0;
      return [
        {
          ...row,
          baseRank,
          adjustedRank: baseRank - Math.min(12, need.score * 3) - waitRiskAdjustment,
          needScore: need.score,
          needLabel: need.label,
          availability,
          waitRiskAdjustment,
        },
      ];
    })
    .sort(
      (left, right) =>
        left.adjustedRank - right.adjustedRank ||
        left.baseRank - right.baseRank ||
        left.player.name.localeCompare(right.player.name),
    )
    .slice(0, input.limit ?? 5);
}

export interface AuctionNominationRow<Player extends DraftBoardPlayer = DraftBoardPlayer> {
  readonly player: Player;
  readonly rank: number;
  readonly strategy: "target" | "drain";
  readonly adjustedValue: number;
  readonly expectedMarketPrice: number;
  readonly edge: number;
  readonly reason: string;
}

/**
 * Builds nomination advice only from explicit user-authored target prices and
 * market AAV. Missing values stay missing instead of being synthesized.
 */
export function buildAuctionNominationQueue<Player extends DraftBoardPlayer>(input: {
  readonly availablePlayers: readonly Player[];
  readonly values: readonly DraftBoardValue[];
  readonly limit?: number;
}): readonly AuctionNominationRow<Player>[] {
  const players = new Map(input.availablePlayers.map((player) => [player.id, player]));
  const candidates = input.values.flatMap((value) => {
    const candidate = players.get(value.playerId);
    const dollarValue = finite(value.targetPrice);
    const expectedMarketPrice = finite(value.aav);
    if (!candidate || dollarValue === null || expectedMarketPrice === null) return [];
    return [
      {
        playerId: playerId(value.playerId),
        dollarValue,
        expectedMarketPrice,
      },
    ];
  });
  const recommendations = recommendAuctionNominations(candidates, input.limit ?? 5);
  return recommendations.flatMap((recommendation) => {
    if (recommendation.edge <= 0) return [];
    const candidate = players.get(recommendation.playerId);
    return candidate ? [{ ...recommendation, player: candidate }] : [];
  });
}

export interface AuctionTeamBudget {
  readonly teamId: string;
  readonly remainingBudget: number | null | undefined;
  readonly openSlots: number;
}

export type AuctionBoardAnalysis =
  | {
      readonly available: false;
      readonly code: "NO_SELECTED_VALUE" | "INSUFFICIENT_COVERAGE" | "INVALID_TEAM_STATE";
      readonly coveredPlayers: number;
      readonly requiredPlayers: number;
      readonly message: string;
    }
  | {
      readonly available: true;
      readonly coveredPlayers: number;
      readonly requiredPlayers: number;
      readonly inflationFactor: number;
      readonly fairValue: number;
      readonly targetPrice: number;
      readonly legalMaximumBid: number;
    };

export function analyzeAuctionBoard(input: {
  readonly availablePlayerIds: readonly string[];
  readonly values: readonly DraftBoardValue[];
  readonly teams: readonly AuctionTeamBudget[];
  readonly selectedPlayerId: string;
  readonly selectedTeamId: string;
  readonly minimumBid: number;
}): AuctionBoardAnalysis {
  const requiredPlayers = input.teams.reduce((sum, team) => sum + team.openSlots, 0);
  const available = new Set(input.availablePlayerIds);
  const valued = input.values.filter(
    (value) => available.has(value.playerId) && finite(value.aav) !== null,
  );
  const unavailable = (
    code: Exclude<AuctionBoardAnalysis, { available: true }>["code"],
    message: string,
  ): AuctionBoardAnalysis => ({
    available: false,
    code,
    coveredPlayers: valued.length,
    requiredPlayers,
    message,
  });

  if (
    !Number.isSafeInteger(input.minimumBid) ||
    input.minimumBid < 0 ||
    input.teams.some(
      (team) =>
        !Number.isSafeInteger(team.remainingBudget) ||
        (team.remainingBudget ?? -1) < 0 ||
        !Number.isSafeInteger(team.openSlots) ||
        team.openSlots < 0,
    )
  ) {
    return unavailable("INVALID_TEAM_STATE", "Live team budgets are incomplete.");
  }
  if (valued.length < requiredPlayers) {
    return unavailable(
      "INSUFFICIENT_COVERAGE",
      `AAV is available for ${valued.length} players; ${requiredPlayers} are needed to price every open slot.`,
    );
  }
  const selected = valued.find((value) => value.playerId === input.selectedPlayerId);
  if (selected?.aav === null || selected?.aav === undefined) {
    return unavailable("NO_SELECTED_VALUE", "The selected player has no AAV on this board.");
  }
  const selectedTeam = input.teams.find((team) => team.teamId === input.selectedTeamId);
  if (
    !selectedTeam ||
    selectedTeam.remainingBudget === null ||
    selectedTeam.remainingBudget === undefined
  ) {
    return unavailable("INVALID_TEAM_STATE", "The selected team's live budget is unavailable.");
  }

  const pricedPlayers = [...valued]
    .sort(
      (left, right) =>
        (right.aav ?? 0) - (left.aav ?? 0) || left.playerId.localeCompare(right.playerId),
    )
    .slice(0, requiredPlayers);
  const inflation = calculateAuctionInflation({
    teams: input.teams.map((team) => ({
      remainingBudget: team.remainingBudget ?? 0,
      openSlots: team.openSlots,
    })),
    remainingPlayers: pricedPlayers.map((value) => ({
      playerId: playerId(value.playerId),
      baseValue: value.aav ?? 0,
    })),
    minimumBid: input.minimumBid,
  });
  const bid = recommendBid({
    baseValue: selected.aav,
    inflationFactor: inflation.inflationFactor,
    minimumBid: input.minimumBid,
    remainingBudget: selectedTeam.remainingBudget,
    openSlots: selectedTeam.openSlots,
  });
  return {
    available: true,
    coveredPlayers: valued.length,
    requiredPlayers,
    inflationFactor: inflation.inflationFactor,
    fairValue: bid.fairValue,
    targetPrice: bid.targetPrice,
    legalMaximumBid: bid.legalMaximumBid,
  };
}
