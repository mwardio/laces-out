import type { PlayerId } from "@laces-out/domain";

export interface AuctionBudgetSnapshot {
  readonly remainingBudget: number;
  readonly openSlots: number;
}

export function maximumLegalBid(
  remainingBudget: number,
  openSlots: number,
  minimumBid: number,
): number {
  if (
    !Number.isSafeInteger(remainingBudget) ||
    !Number.isSafeInteger(openSlots) ||
    !Number.isSafeInteger(minimumBid) ||
    remainingBudget < 0 ||
    openSlots < 0 ||
    minimumBid < 0
  ) {
    throw new RangeError("Budget, open slots, and minimum bid must be non-negative integers");
  }
  if (openSlots === 0) {
    return 0;
  }

  return Math.max(0, remainingBudget - minimumBid * (openSlots - 1));
}

export interface AuctionValueInput {
  readonly playerId: PlayerId;
  readonly baseValue: number;
}

export interface AuctionInflationInput {
  readonly teams: readonly AuctionBudgetSnapshot[];
  readonly remainingPlayers: readonly AuctionValueInput[];
  readonly minimumBid: number;
}

export interface AuctionInflationResult {
  readonly inflationFactor: number;
  readonly availableDollars: number;
  readonly reservedMinimumDollars: number;
  readonly discretionaryDollars: number;
  readonly baselineDiscretionaryValue: number;
}

/**
 * Inflation is computed only on dollars above the mandatory minimum-slot
 * reserve. This avoids overstating $1 players as budgets change.
 */
export function calculateAuctionInflation(input: AuctionInflationInput): AuctionInflationResult {
  if (!Number.isSafeInteger(input.minimumBid) || input.minimumBid < 0) {
    throw new RangeError("Minimum bid must be a non-negative integer");
  }
  const availableDollars = input.teams.reduce((sum, team) => sum + team.remainingBudget, 0);
  const reservedMinimumDollars = input.teams.reduce(
    (sum, team) => sum + team.openSlots * input.minimumBid,
    0,
  );
  const discretionaryDollars = Math.max(0, availableDollars - reservedMinimumDollars);
  const baselineDiscretionaryValue = input.remainingPlayers.reduce((sum, player) => {
    if (!Number.isFinite(player.baseValue) || player.baseValue < 0) {
      throw new RangeError(
        `Base auction value for ${player.playerId} must be non-negative and finite`,
      );
    }
    return sum + Math.max(0, player.baseValue - input.minimumBid);
  }, 0);

  return {
    inflationFactor:
      baselineDiscretionaryValue === 0 ? 1 : discretionaryDollars / baselineDiscretionaryValue,
    availableDollars,
    reservedMinimumDollars,
    discretionaryDollars,
    baselineDiscretionaryValue,
  };
}

export function inflatedAuctionValue(
  baseValue: number,
  inflationFactor: number,
  minimumBid: number,
): number {
  if (
    !Number.isFinite(baseValue) ||
    !Number.isFinite(inflationFactor) ||
    !Number.isFinite(minimumBid) ||
    baseValue < 0 ||
    inflationFactor < 0 ||
    minimumBid < 0
  ) {
    throw new RangeError("Auction value inputs must be non-negative finite numbers");
  }

  return minimumBid + Math.max(0, baseValue - minimumBid) * inflationFactor;
}

export interface BidRecommendationInput extends AuctionBudgetSnapshot {
  readonly baseValue: number;
  readonly inflationFactor: number;
  readonly minimumBid: number;
  readonly needMultiplier?: number;
  readonly riskDiscount?: number;
}

export interface BidRecommendation {
  readonly fairValue: number;
  readonly targetPrice: number;
  readonly maximumBid: number;
  readonly legalMaximumBid: number;
}

export function recommendBid(input: BidRecommendationInput): BidRecommendation {
  const needMultiplier = input.needMultiplier ?? 1;
  const riskDiscount = input.riskDiscount ?? 0;
  if (!Number.isFinite(needMultiplier) || needMultiplier < 0) {
    throw new RangeError("Need multiplier must be a non-negative finite number");
  }
  if (!Number.isFinite(riskDiscount) || riskDiscount < 0 || riskDiscount > 1) {
    throw new RangeError("Risk discount must be between zero and one");
  }
  const legalMaximumBid = maximumLegalBid(input.remainingBudget, input.openSlots, input.minimumBid);
  const fairValue = inflatedAuctionValue(input.baseValue, input.inflationFactor, input.minimumBid);
  const adjusted = fairValue * needMultiplier * (1 - riskDiscount);
  const targetPrice = Math.min(legalMaximumBid, Math.max(0, Math.round(adjusted)));

  return {
    fairValue,
    targetPrice,
    maximumBid: targetPrice,
    legalMaximumBid,
  };
}
