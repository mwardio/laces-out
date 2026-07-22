import type { PlayerId } from "@fantasy/domain";

export interface AuctionValuePlayer {
  readonly playerId: PlayerId;
  readonly valueOverReplacement: number;
}

export interface AuctionLeagueBudget {
  readonly budget: number;
  readonly rosterSlots: number;
}

export interface AuctionDollarValue {
  readonly playerId: PlayerId;
  readonly valueOverReplacement: number;
  readonly dollarValue: number;
  readonly draftable: boolean;
}

export interface AuctionDollarValueInput {
  readonly players: readonly AuctionValuePlayer[];
  readonly teams: readonly AuctionLeagueBudget[];
  readonly minimumBid: number;
}

/**
 * Allocates the league's exact draft budget across the expected drafted player
 * pool. Minimum bids are reserved first; discretionary dollars are distributed
 * by positive value over replacement, with deterministic largest-remainder
 * rounding so the published integer values sum to the league budget.
 */
export function generateAuctionDollarValues(
  input: AuctionDollarValueInput,
): readonly AuctionDollarValue[] {
  if (!Number.isSafeInteger(input.minimumBid) || input.minimumBid < 0) {
    throw new RangeError("Minimum bid must be a non-negative integer");
  }
  if (input.teams.length < 2) throw new RangeError("Auction values require at least two teams");
  for (const team of input.teams) {
    if (
      !Number.isSafeInteger(team.budget) ||
      !Number.isSafeInteger(team.rosterSlots) ||
      team.budget < 0 ||
      team.rosterSlots <= 0 ||
      team.budget < team.rosterSlots * input.minimumBid
    ) {
      throw new RangeError("Each team must be able to fund every roster slot at the minimum bid");
    }
  }
  for (const player of input.players) {
    if (!Number.isFinite(player.valueOverReplacement)) {
      throw new RangeError(`Value over replacement for ${player.playerId} must be finite`);
    }
  }
  if (new Set(input.players.map((player) => player.playerId)).size !== input.players.length) {
    throw new Error("Auction value players must be unique");
  }

  const totalBudget = input.teams.reduce((total, team) => total + team.budget, 0);
  const draftedCount = input.teams.reduce((total, team) => total + team.rosterSlots, 0);
  if (input.players.length < draftedCount) {
    throw new RangeError("Auction player pool is smaller than the league's roster demand");
  }
  const ordered = [...input.players].sort(
    (left, right) =>
      right.valueOverReplacement - left.valueOverReplacement ||
      left.playerId.localeCompare(right.playerId),
  );
  const drafted = ordered.slice(0, draftedCount);
  const discretionary = totalBudget - draftedCount * input.minimumBid;
  const positiveTotal = drafted.reduce(
    (total, player) => total + Math.max(0, player.valueOverReplacement),
    0,
  );
  const equalWeight = positiveTotal === 0 ? 1 / drafted.length : 0;
  const raw = drafted.map((player) => {
    const weight =
      positiveTotal === 0 ? equalWeight : Math.max(0, player.valueOverReplacement) / positiveTotal;
    const value = input.minimumBid + discretionary * weight;
    return { player, value, floor: Math.floor(value), fraction: value - Math.floor(value) };
  });
  let remainder = totalBudget - raw.reduce((total, item) => total + item.floor, 0);
  const remainderOrder = [...raw].sort(
    (left, right) =>
      right.fraction - left.fraction || left.player.playerId.localeCompare(right.player.playerId),
  );
  const bonus = new Set<PlayerId>();
  for (const item of remainderOrder) {
    if (remainder <= 0) break;
    bonus.add(item.player.playerId);
    remainder -= 1;
  }
  const values = new Map(
    raw.map((item) => [
      item.player.playerId,
      item.floor + (bonus.has(item.player.playerId) ? 1 : 0),
    ]),
  );

  return ordered.map((player, index) => ({
    playerId: player.playerId,
    valueOverReplacement: player.valueOverReplacement,
    dollarValue: values.get(player.playerId) ?? 0,
    draftable: index < draftedCount,
  }));
}

export interface AuctionNominationCandidate {
  readonly playerId: PlayerId;
  readonly dollarValue: number;
  readonly expectedMarketPrice: number;
  readonly needMultiplier?: number;
  readonly riskDiscount?: number;
}

export interface AuctionNominationRecommendation {
  readonly rank: number;
  readonly playerId: PlayerId;
  readonly strategy: "target" | "drain";
  readonly adjustedValue: number;
  readonly expectedMarketPrice: number;
  readonly edge: number;
  readonly reason: string;
}

export function recommendAuctionNominations(
  candidates: readonly AuctionNominationCandidate[],
  limit = 8,
): readonly AuctionNominationRecommendation[] {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
    throw new RangeError("Nomination recommendation limit must be between 1 and 100");
  }
  const rows = candidates.map((candidate) => {
    const need = candidate.needMultiplier ?? 1;
    const risk = candidate.riskDiscount ?? 0;
    if (
      !Number.isFinite(candidate.dollarValue) ||
      !Number.isFinite(candidate.expectedMarketPrice) ||
      !Number.isFinite(need) ||
      !Number.isFinite(risk) ||
      candidate.dollarValue < 0 ||
      candidate.expectedMarketPrice < 0 ||
      need < 0 ||
      risk < 0 ||
      risk > 1
    ) {
      throw new RangeError("Nomination values must be bounded non-negative numbers");
    }
    const adjustedValue = candidate.dollarValue * need * (1 - risk);
    const targetEdge = adjustedValue - candidate.expectedMarketPrice;
    const strategy = targetEdge >= 0 ? "target" : "drain";
    const edge = Math.abs(targetEdge);
    return {
      playerId: candidate.playerId,
      strategy,
      adjustedValue,
      expectedMarketPrice: candidate.expectedMarketPrice,
      edge,
      reason:
        strategy === "target"
          ? `Projected value is $${edge.toFixed(1)} above the expected market price`
          : `Expected market price is $${edge.toFixed(1)} above this roster's adjusted value`,
    } as const;
  });
  return rows
    .sort((left, right) => right.edge - left.edge || left.playerId.localeCompare(right.playerId))
    .slice(0, limit)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}
