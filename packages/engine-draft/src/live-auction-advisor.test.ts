import { teamId } from "@laces-out/domain";
import { describe, expect, it } from "vitest";

import {
  adviseLiveAuctionBid,
  type LiveAuctionAction,
  type LiveAuctionAdvisorInput,
} from "./index.js";

const controlledTeamId = teamId("controlled");
const otherTeamId = teamId("other");

function input(overrides: Partial<LiveAuctionAdvisorInput> = {}): LiveAuctionAdvisorInput {
  return {
    controlledTeamId,
    highBidTeamId: otherTeamId,
    nextBid: 24,
    remainingBudget: 100,
    openSlots: 5,
    minimumBid: 1,
    aav: 20,
    inflationFactor: 1.25,
    avoid: false,
    rosterFit: true,
    stale: false,
    unresolved: false,
    ...overrides,
  };
}

describe("live auction advisor", () => {
  it("emits the caller-supplied minimum next offer when it clears both limits", () => {
    const advice = adviseLiveAuctionBid(input());

    expect(advice).toEqual({
      action: "BID",
      actionable: true,
      exactBid: 24,
      reasonCode: "NEXT_BID_WITHIN_LIMITS",
      reason: "The minimum next offer is within both the strategic and legal maximum bids.",
      inflatedAav: 24.75,
      strategicMaximumBid: 25,
      strategicMaximumBidSource: "INFLATED_AAV",
      legalMaximumBid: 96,
    });
  });

  it("uses explicit ceiling, then target, then inflated AAV as the strategic maximum", () => {
    const explicit = adviseLiveAuctionBid(
      input({ nextBid: 31, ceilingPrice: 31, targetPrice: 40, aav: 50 }),
    );
    const target = adviseLiveAuctionBid(
      input({ nextBid: 29, ceilingPrice: null, targetPrice: 29, aav: 50 }),
    );
    const inflated = adviseLiveAuctionBid(
      input({ nextBid: 24, ceilingPrice: null, targetPrice: null }),
    );

    expect(explicit).toMatchObject({
      action: "BID",
      strategicMaximumBid: 31,
      strategicMaximumBidSource: "EXPLICIT_CEILING",
    });
    expect(target).toMatchObject({
      action: "BID",
      strategicMaximumBid: 29,
      strategicMaximumBidSource: "TARGET_PRICE",
    });
    expect(inflated).toMatchObject({
      action: "BID",
      strategicMaximumBid: 25,
      strategicMaximumBidSource: "INFLATED_AAV",
    });
  });

  it("honors an explicit zero ceiling instead of treating it as absent", () => {
    expect(
      adviseLiveAuctionBid(input({ nextBid: 1, ceilingPrice: 0, targetPrice: 50 })),
    ).toMatchObject({
      action: "STOP",
      strategicMaximumBid: 0,
      strategicMaximumBidSource: "EXPLICIT_CEILING",
    });
  });

  it("floors fractional explicit ceilings and targets to whole-dollar bids", () => {
    expect(adviseLiveAuctionBid(input({ nextBid: 25, ceilingPrice: 25.99 }))).toMatchObject({
      action: "BID",
      strategicMaximumBid: 25,
    });
    expect(
      adviseLiveAuctionBid(input({ nextBid: 26, ceilingPrice: null, targetPrice: 25.99 })),
    ).toMatchObject({
      action: "STOP",
      strategicMaximumBid: 25,
    });
  });

  it("uses an explicit ceiling or target without AAV inputs", () => {
    expect(
      adviseLiveAuctionBid(
        input({ nextBid: 17, ceilingPrice: 17, aav: null, inflationFactor: null }),
      ),
    ).toMatchObject({
      action: "BID",
      strategicMaximumBid: 17,
      strategicMaximumBidSource: "EXPLICIT_CEILING",
      inflatedAav: null,
    });
    expect(
      adviseLiveAuctionBid(
        input({
          nextBid: 16,
          ceilingPrice: null,
          targetPrice: 16,
          aav: null,
          inflationFactor: null,
        }),
      ),
    ).toMatchObject({
      action: "BID",
      strategicMaximumBid: 16,
      strategicMaximumBidSource: "TARGET_PRICE",
      inflatedAav: null,
    });
  });

  it("bids at the strategic maximum and stops one dollar beyond it", () => {
    expect(adviseLiveAuctionBid(input({ nextBid: 25, ceilingPrice: 25 }))).toMatchObject({
      action: "BID",
      exactBid: 25,
    });
    const stopped = adviseLiveAuctionBid(input({ nextBid: 26, ceilingPrice: 25 }));
    expect(stopped).toMatchObject({
      action: "STOP",
      actionable: true,
      reasonCode: "NEXT_BID_EXCEEDS_STRATEGIC_MAXIMUM",
      strategicMaximumBid: 25,
      legalMaximumBid: 96,
    });
    expect(stopped).not.toHaveProperty("exactBid");
  });

  it("keeps the legal maximum separate and makes an overage a hard pass", () => {
    const atMaximum = adviseLiveAuctionBid(
      input({ nextBid: 8, remainingBudget: 10, openSlots: 3, ceilingPrice: 50 }),
    );
    const overMaximum = adviseLiveAuctionBid(
      input({ nextBid: 9, remainingBudget: 10, openSlots: 3, ceilingPrice: 50 }),
    );

    expect(atMaximum).toMatchObject({ action: "BID", exactBid: 8, legalMaximumBid: 8 });
    expect(overMaximum).toMatchObject({
      action: "MUST_PASS",
      actionable: true,
      reasonCode: "NEXT_BID_EXCEEDS_LEGAL_MAXIMUM",
      legalMaximumBid: 8,
      strategicMaximumBid: 50,
    });
    expect(overMaximum).not.toHaveProperty("exactBid");
  });

  it.each([
    ["avoid", { avoid: true }, "PLAYER_MARKED_AVOID"],
    ["roster fit", { rosterFit: false }, "PLAYER_DOES_NOT_FIT_ROSTER"],
  ] as const)(
    "makes %s a hard pass even when the price is attractive",
    (_label, override, code) => {
      const advice = adviseLiveAuctionBid(input({ nextBid: 1, ceilingPrice: 50, ...override }));

      expect(advice).toMatchObject({ action: "MUST_PASS", actionable: true, reasonCode: code });
      expect(advice).not.toHaveProperty("exactBid");
    },
  );

  it("keeps hard constraints authoritative when strategic value is unavailable", () => {
    const withoutValue = {
      aav: null,
      inflationFactor: null,
      ceilingPrice: null,
      targetPrice: null,
    } as const;

    expect(adviseLiveAuctionBid(input({ ...withoutValue, avoid: true }))).toMatchObject({
      action: "MUST_PASS",
      reasonCode: "PLAYER_MARKED_AVOID",
    });
    expect(adviseLiveAuctionBid(input({ ...withoutValue, rosterFit: false }))).toMatchObject({
      action: "MUST_PASS",
      reasonCode: "PLAYER_DOES_NOT_FIT_ROSTER",
    });
    expect(
      adviseLiveAuctionBid(
        input({ ...withoutValue, nextBid: 9, remainingBudget: 10, openSlots: 3 }),
      ),
    ).toMatchObject({
      action: "MUST_PASS",
      reasonCode: "NEXT_BID_EXCEEDS_LEGAL_MAXIMUM",
    });
  });

  it("holds when the controlled team is already the high bidder", () => {
    const advice = adviseLiveAuctionBid(
      input({ highBidTeamId: controlledTeamId, nextBid: 40, ceilingPrice: 25 }),
    );

    expect(advice).toMatchObject({
      action: "HOLD",
      actionable: true,
      reasonCode: "CONTROLLED_TEAM_IS_HIGH_BIDDER",
    });
    expect(advice).not.toHaveProperty("exactBid");
  });

  it("reports an existing winning bid before constraints on placing another bid", () => {
    const advice = adviseLiveAuctionBid(
      input({
        highBidTeamId: controlledTeamId,
        nextBid: 99,
        remainingBudget: 10,
        openSlots: 3,
        avoid: true,
        rosterFit: false,
        ceilingPrice: null,
        targetPrice: null,
        aav: null,
        inflationFactor: null,
      }),
    );

    expect(advice).toMatchObject({
      action: "HOLD",
      actionable: true,
      reasonCode: "CONTROLLED_TEAM_IS_HIGH_BIDDER",
    });
  });

  it("returns a non-actionable hold for a stale snapshot before hard constraints", () => {
    const advice = adviseLiveAuctionBid(
      input({ stale: true, avoid: true, rosterFit: false, nextBid: null }),
    );

    expect(advice).toMatchObject({
      action: "HOLD",
      actionable: false,
      reasonCode: "SNAPSHOT_STALE",
    });
    expect(advice).not.toHaveProperty("exactBid");
  });

  it("returns a non-actionable hold for unresolved state", () => {
    const advice = adviseLiveAuctionBid(input({ unresolved: true, nextBid: null }));

    expect(advice).toMatchObject({
      action: "HOLD",
      actionable: false,
      reasonCode: "SNAPSHOT_UNRESOLVED",
    });
    expect(advice).not.toHaveProperty("exactBid");
  });

  it("will not infer a bid when the exact next bid is absent", () => {
    const advice = adviseLiveAuctionBid(input({ nextBid: null }));

    expect(advice).toMatchObject({
      action: "HOLD",
      actionable: false,
      reasonCode: "NEXT_BID_UNRESOLVED",
    });
    expect(advice).not.toHaveProperty("exactBid");
  });

  it("holds without inventing a controlled team", () => {
    const advice = adviseLiveAuctionBid(input({ controlledTeamId: null }));

    expect(advice).toMatchObject({
      action: "HOLD",
      actionable: false,
      reasonCode: "CONTROLLED_TEAM_UNRESOLVED",
    });
    expect(advice).not.toHaveProperty("exactBid");
  });

  it("holds when ceiling, target, or complete inflated AAV inputs are all unavailable", () => {
    const noAav = adviseLiveAuctionBid(
      input({ aav: null, inflationFactor: null, ceilingPrice: null, targetPrice: null }),
    );
    const incompleteInflation = adviseLiveAuctionBid(
      input({ aav: 20, inflationFactor: null, ceilingPrice: null, targetPrice: null }),
    );

    for (const advice of [noAav, incompleteInflation]) {
      expect(advice).toMatchObject({
        action: "HOLD",
        actionable: false,
        reasonCode: "NO_STRATEGIC_VALUE",
        strategicMaximumBid: null,
        strategicMaximumBidSource: null,
      });
      expect(advice).not.toHaveProperty("exactBid");
    }
  });

  it("only includes exactBid on BID across every action", () => {
    const byAction: Record<LiveAuctionAction, LiveAuctionAdvisorInput> = {
      BID: input({ nextBid: 10, ceilingPrice: 10 }),
      HOLD: input({ nextBid: null }),
      STOP: input({ nextBid: 11, ceilingPrice: 10 }),
      MUST_PASS: input({ nextBid: 10, avoid: true }),
    };

    for (const [action, advisorInput] of Object.entries(byAction)) {
      const advice = adviseLiveAuctionBid(advisorInput);
      expect(advice.action).toBe(action);
      expect(Object.hasOwn(advice, "exactBid")).toBe(action === "BID");
    }
  });

  it.each([
    ["fractional", 2.5],
    ["zero", 0],
    ["negative", -1],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("rejects a %s resolved next bid", (_label, nextBid) => {
    expect(() => adviseLiveAuctionBid(input({ nextBid }))).toThrow(
      "Next bid must be a positive safe integer when resolved",
    );
  });

  it("rejects invalid price inputs rather than silently changing strategy", () => {
    expect(() => adviseLiveAuctionBid(input({ ceilingPrice: -1 }))).toThrow(
      "Ceiling price must be a non-negative finite number",
    );
    expect(() => adviseLiveAuctionBid(input({ targetPrice: Number.NaN }))).toThrow(
      "Target price must be a non-negative finite number",
    );
    expect(() => adviseLiveAuctionBid(input({ inflationFactor: -1 }))).toThrow(
      "Inflation factor must be a non-negative finite number",
    );
  });

  it("does not mutate its input and returns the same decision for the same snapshot", () => {
    const snapshot = Object.freeze(input({ nextBid: 18, targetPrice: 20 }));

    expect(adviseLiveAuctionBid(snapshot)).toEqual(adviseLiveAuctionBid(snapshot));
    expect(snapshot.nextBid).toBe(18);
  });
});
