import type { TeamId } from "@laces-out/domain";

import { maximumLegalBid, recommendBid, type AuctionBudgetSnapshot } from "./auction.js";

export type LiveAuctionAction = "BID" | "HOLD" | "STOP" | "MUST_PASS";

/**
 * Explains how the challengeable strategy maximum was selected. `TARGET_PRICE`
 * means the target was promoted to that role because no explicit ceiling was
 * available; it never becomes a legal constraint.
 */
export type StrategicMaximumBidSource = "EXPLICIT_CEILING" | "TARGET_PRICE" | "INFLATED_AAV";

export type LiveAuctionAdviceReasonCode =
  | "SNAPSHOT_STALE"
  | "SNAPSHOT_UNRESOLVED"
  | "CONTROLLED_TEAM_UNRESOLVED"
  | "NEXT_BID_UNRESOLVED"
  | "NO_STRATEGIC_VALUE"
  | "PLAYER_MARKED_AVOID"
  | "PLAYER_DOES_NOT_FIT_ROSTER"
  | "NEXT_BID_EXCEEDS_LEGAL_MAXIMUM"
  | "CONTROLLED_TEAM_IS_HIGH_BIDDER"
  | "NEXT_BID_EXCEEDS_STRATEGIC_MAXIMUM"
  | "NEXT_BID_WITHIN_LIMITS";

/**
 * A scalar, serializable view of one live auction decision. `nextBid` is
 * supplied by the caller after applying the provider adapter's verified offer
 * rules; this provider-agnostic engine deliberately never guesses an increment.
 */
export interface LiveAuctionAdvisorInput extends AuctionBudgetSnapshot {
  readonly controlledTeamId: TeamId | null;
  readonly highBidTeamId: TeamId | null;
  /** The caller-supplied minimum permissible next offer, or null when unresolved. */
  readonly nextBid: number | null;
  readonly minimumBid: number;
  /** Pre-inflation average auction value. */
  readonly aav: number | null;
  readonly inflationFactor: number | null;
  /** User-authored strategy ceiling; it takes precedence over a target. */
  readonly ceilingPrice?: number | null;
  /** Becomes the challengeable strategy maximum only when no ceiling exists. */
  readonly targetPrice?: number | null;
  readonly avoid: boolean;
  /** False means the player cannot legally fill an open slot on the controlled roster. */
  readonly rosterFit: boolean;
  /** True when the observation is older than the caller's live-draft freshness bound. */
  readonly stale: boolean;
  /** True when any identity or auction fact needed for this decision is unresolved. */
  readonly unresolved: boolean;
}

interface LiveAuctionAdviceBase {
  readonly action: LiveAuctionAction;
  /** False only when incomplete live state prevents a decision. */
  readonly actionable: boolean;
  readonly reasonCode: LiveAuctionAdviceReasonCode;
  readonly reason: string;
  readonly inflatedAav: number | null;
  /** A strategy limit which a higher-level recommendation layer may question. */
  readonly strategicMaximumBid: number | null;
  readonly strategicMaximumBidSource: StrategicMaximumBidSource | null;
  /** A rules-and-budget limit which no higher-level recommendation may override. */
  readonly legalMaximumBid: number;
}

export interface LiveAuctionBidAdvice extends LiveAuctionAdviceBase {
  readonly action: "BID";
  readonly actionable: true;
  readonly exactBid: number;
}

export interface LiveAuctionHoldAdvice extends LiveAuctionAdviceBase {
  readonly action: "HOLD";
  readonly exactBid?: never;
}

export interface LiveAuctionStopAdvice extends LiveAuctionAdviceBase {
  readonly action: "STOP";
  readonly actionable: true;
  readonly exactBid?: never;
}

export interface LiveAuctionMustPassAdvice extends LiveAuctionAdviceBase {
  readonly action: "MUST_PASS";
  readonly actionable: true;
  readonly exactBid?: never;
}

export type LiveAuctionAdvice =
  LiveAuctionBidAdvice | LiveAuctionHoldAdvice | LiveAuctionStopAdvice | LiveAuctionMustPassAdvice;

interface AdviceValues {
  readonly inflatedAav: number | null;
  readonly strategicMaximumBid: number | null;
  readonly strategicMaximumBidSource: StrategicMaximumBidSource | null;
  readonly legalMaximumBid: number;
}

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite number`);
  }
}

function optionalPrice(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  assertNonNegativeFinite(value, label);
  return value;
}

function adviceBase(input: LiveAuctionAdvisorInput): AdviceValues {
  if (input.aav !== null) assertNonNegativeFinite(input.aav, "AAV");
  if (input.inflationFactor !== null) {
    assertNonNegativeFinite(input.inflationFactor, "Inflation factor");
  }
  const ceilingPrice = optionalPrice(input.ceilingPrice, "Ceiling price");
  const targetPrice = optionalPrice(input.targetPrice, "Target price");
  const legalMaximumBid = maximumLegalBid(input.remainingBudget, input.openSlots, input.minimumBid);
  // `recommendBid` owns the established inflated-value and whole-dollar
  // rounding semantics. A deliberately unconstrained budget keeps that
  // strategic calculation separate from the real legal maximum above.
  const aavRecommendation =
    input.aav === null || input.inflationFactor === null
      ? null
      : recommendBid({
          remainingBudget: Number.MAX_SAFE_INTEGER,
          openSlots: 1,
          minimumBid: input.minimumBid,
          baseValue: input.aav,
          inflationFactor: input.inflationFactor,
        });
  const inflatedAav = aavRecommendation?.fairValue ?? null;

  if (ceilingPrice !== null) {
    return {
      inflatedAav,
      strategicMaximumBid: Math.floor(ceilingPrice),
      strategicMaximumBidSource: "EXPLICIT_CEILING",
      legalMaximumBid,
    };
  }
  if (targetPrice !== null) {
    return {
      inflatedAav,
      strategicMaximumBid: Math.floor(targetPrice),
      strategicMaximumBidSource: "TARGET_PRICE",
      legalMaximumBid,
    };
  }
  return aavRecommendation === null
    ? {
        inflatedAav: null,
        strategicMaximumBid: null,
        strategicMaximumBidSource: null,
        legalMaximumBid,
      }
    : {
        inflatedAav,
        strategicMaximumBid: aavRecommendation.targetPrice,
        strategicMaximumBidSource: "INFLATED_AAV",
        legalMaximumBid,
      };
}

function hold(
  values: AdviceValues,
  reasonCode: Extract<
    LiveAuctionAdviceReasonCode,
    | "SNAPSHOT_STALE"
    | "SNAPSHOT_UNRESOLVED"
    | "CONTROLLED_TEAM_UNRESOLVED"
    | "NEXT_BID_UNRESOLVED"
    | "NO_STRATEGIC_VALUE"
    | "CONTROLLED_TEAM_IS_HIGH_BIDDER"
  >,
  reason: string,
  actionable: boolean,
): LiveAuctionHoldAdvice {
  return { action: "HOLD", actionable, reasonCode, reason, ...values };
}

/**
 * Produces the immediate salary-cap draft action without I/O or an external recommendation layer.
 *
 * Data-quality gates fail closed before any player recommendation. Once the
 * snapshot is decision-ready, avoid/fit/legal limits are hard `MUST_PASS`
 * constraints. The selected price ceiling is only strategic, so crossing it
 * returns `STOP` and may be reviewed by a separate strategy layer.
 */
export function adviseLiveAuctionBid(input: LiveAuctionAdvisorInput): LiveAuctionAdvice {
  const values = adviceBase(input);

  if (input.stale) {
    return hold(
      values,
      "SNAPSHOT_STALE",
      "The live auction snapshot is stale; wait for a fresh exact bid state.",
      false,
    );
  }
  if (input.unresolved) {
    return hold(
      values,
      "SNAPSHOT_UNRESOLVED",
      "The live auction snapshot has unresolved facts; do not act on it.",
      false,
    );
  }
  if (input.controlledTeamId === null) {
    return hold(
      values,
      "CONTROLLED_TEAM_UNRESOLVED",
      "The controlled team is unresolved; do not guess which budget or high bid applies.",
      false,
    );
  }
  if (input.nextBid === null || input.nextBid === undefined) {
    return hold(
      values,
      "NEXT_BID_UNRESOLVED",
      "The provider adapter did not resolve the minimum permissible next offer.",
      false,
    );
  }
  if (!Number.isSafeInteger(input.nextBid) || input.nextBid <= 0) {
    throw new RangeError("Next bid must be a positive safe integer when resolved");
  }
  if (input.nextBid < input.minimumBid) {
    throw new RangeError("Next bid cannot be below the auction minimum bid");
  }

  if (input.highBidTeamId === input.controlledTeamId) {
    return hold(
      values,
      "CONTROLLED_TEAM_IS_HIGH_BIDDER",
      "The controlled team already has the high bid, so no new bid is needed.",
      true,
    );
  }
  if (input.avoid) {
    return {
      action: "MUST_PASS",
      actionable: true,
      reasonCode: "PLAYER_MARKED_AVOID",
      reason: "The player is marked avoid, which is a hard no-bid constraint.",
      ...values,
    };
  }
  if (!input.rosterFit) {
    return {
      action: "MUST_PASS",
      actionable: true,
      reasonCode: "PLAYER_DOES_NOT_FIT_ROSTER",
      reason: "The player cannot fill an open slot on the controlled roster.",
      ...values,
    };
  }
  if (input.nextBid > values.legalMaximumBid) {
    return {
      action: "MUST_PASS",
      actionable: true,
      reasonCode: "NEXT_BID_EXCEEDS_LEGAL_MAXIMUM",
      reason: "The minimum next offer exceeds the controlled team's legal maximum bid.",
      ...values,
    };
  }
  if (values.strategicMaximumBid === null) {
    return hold(
      values,
      "NO_STRATEGIC_VALUE",
      "No ceiling, target, or complete AAV inflation input is available.",
      false,
    );
  }
  if (input.nextBid > values.strategicMaximumBid) {
    return {
      action: "STOP",
      actionable: true,
      reasonCode: "NEXT_BID_EXCEEDS_STRATEGIC_MAXIMUM",
      reason: "The minimum next offer exceeds the current strategic maximum bid.",
      ...values,
    };
  }

  return {
    action: "BID",
    actionable: true,
    exactBid: input.nextBid,
    reasonCode: "NEXT_BID_WITHIN_LIMITS",
    reason: "The minimum next offer is within both the strategic and legal maximum bids.",
    ...values,
  };
}
