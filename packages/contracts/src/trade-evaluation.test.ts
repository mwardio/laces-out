import { describe, expect, it } from "vitest";

import {
  MAX_TRADE_BUILDER_PLAYERS_PER_SIDE,
  tradeEvaluationRequestSchema,
  tradeEvaluationResponseSchema,
} from "./trade-evaluation.js";

const OPPONENT = "40000000-0000-4000-8000-000000000002";
const PLAYERS = [
  "70000000-0000-4000-8000-000000000001",
  "70000000-0000-4000-8000-000000000002",
  "70000000-0000-4000-8000-000000000003",
  "70000000-0000-4000-8000-000000000004",
  "70000000-0000-4000-8000-000000000005",
] as const;

describe("tradeEvaluationRequestSchema", () => {
  it("accepts the maximum bounded package", () => {
    expect(MAX_TRADE_BUILDER_PLAYERS_PER_SIDE).toBe(4);
    expect(
      tradeEvaluationRequestSchema.safeParse({
        opponentTeamId: OPPONENT,
        sendsPlayerIds: PLAYERS.slice(0, 4),
        receivesPlayerIds: [PLAYERS[4]],
      }).success,
    ).toBe(true);
  });

  it("rejects more than four players on a side", () => {
    expect(
      tradeEvaluationRequestSchema.safeParse({
        opponentTeamId: OPPONENT,
        sendsPlayerIds: PLAYERS,
        receivesPlayerIds: [PLAYERS[0]],
      }).success,
    ).toBe(false);
  });

  it("rejects an empty side, a duplicate ID, a player on both sides, and an unknown field", () => {
    const base = {
      opponentTeamId: OPPONENT,
      sendsPlayerIds: [PLAYERS[0]],
      receivesPlayerIds: [PLAYERS[1]],
    };
    expect(tradeEvaluationRequestSchema.safeParse({ ...base, sendsPlayerIds: [] }).success).toBe(
      false,
    );
    expect(
      tradeEvaluationRequestSchema.safeParse({
        ...base,
        sendsPlayerIds: [PLAYERS[0], PLAYERS[0]],
      }).success,
    ).toBe(false);
    expect(
      tradeEvaluationRequestSchema.safeParse({ ...base, receivesPlayerIds: [PLAYERS[0]] }).success,
    ).toBe(false);
    expect(tradeEvaluationRequestSchema.safeParse({ ...base, leagueId: OPPONENT }).success).toBe(
      false,
    );
    expect(
      tradeEvaluationRequestSchema.safeParse({ ...base, sendsPlayerIds: ["nope"] }).success,
    ).toBe(false);
  });
});

describe("tradeEvaluationResponseSchema", () => {
  it("accepts an unavailable response", () => {
    expect(
      tradeEvaluationResponseSchema.safeParse({
        state: "unavailable",
        reasons: [{ code: "PROJECTIONS_MISSING", message: "No compatible projection set." }],
      }).success,
    ).toBe(true);
  });

  it("accepts a legal four-for-four package with an ADR 0003 provenance block", () => {
    const player = (id: string) => ({
      id,
      name: `Player ${id.slice(-1)}`,
      positions: ["RB"],
      nflTeam: "MIA",
      status: "ACTIVE",
      projectedPoints: 12.5,
    });
    const result = tradeEvaluationResponseSchema.safeParse({
      state: "available",
      generatedAt: "2026-09-15T12:00:00.000Z",
      league: { id: "20000000-0000-4000-8000-000000000001", name: "Fourth and Long" },
      algorithmVersion: "trade-builder-v1",
      inputChecksum: "a".repeat(64),
      legal: true,
      package: {
        id: `${OPPONENT}:built`,
        partner: { id: OPPONENT, name: "The Isotoners" },
        shape: "4-for-4",
        send: PLAYERS.slice(0, 4).map(player),
        receive: PLAYERS.slice(0, 4).map(player),
        forcedDropsForUser: [],
        forcedDropsForPartner: [],
        userGain: 1.25,
        partnerGain: -0.5,
        totalGain: 0.75,
        fairnessGap: 1.75,
        mutuallyBeneficial: false,
      },
      diagnostics: [],
      horizons: [{ id: "60000000-0000-4000-8000-000000000001", label: "Week 2", weight: 1 }],
      rosUnavailable: { code: "ROS_SET_UNAVAILABLE", message: "No compatible published ROS set." },
      provenance: {
        leagueLastSyncedAt: "2026-09-15T11:30:00.000Z",
        rosterEffectiveAt: "2026-09-15T12:00:00.000Z",
        projectionSet: {
          id: "60000000-0000-4000-8000-000000000001",
          source: "trusted-weekly-model",
          version: "2026-w02-v1",
          horizon: "Week 2",
          sourceObservedAt: "2026-09-15T10:00:00.000Z",
          sourceObservedAtStatus: "verified",
          importedAt: "2026-09-15T11:00:00.000Z",
        },
        projectionFreshness: {
          state: "fresh",
          observedAt: "2026-09-15T10:00:00.000Z",
          label: "Updated 2h ago",
        },
      },
      execution: {
        mode: "provider-required",
        provider: "espn",
        label: "Open ESPN to verify and apply manually",
        url: "https://fantasy.espn.com/football/league?leagueId=24681012",
      },
      notes: ["Weekly value only."],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an illegal package carrying a NO_LEGAL_FORCED_DROP diagnostic", () => {
    expect(
      tradeEvaluationResponseSchema.safeParse({
        state: "available",
        generatedAt: "2026-09-15T12:00:00.000Z",
        league: { id: "20000000-0000-4000-8000-000000000001", name: "Fourth and Long" },
        algorithmVersion: "trade-builder-v1",
        inputChecksum: "b".repeat(64),
        legal: false,
        package: null,
        diagnostics: [
          {
            code: "NO_LEGAL_FORCED_DROP",
            message: "Team cannot make the required legal forced drops",
            teamId: "40000000-0000-4000-8000-000000000001",
            playerId: null,
          },
        ],
        horizons: [{ id: "60000000-0000-4000-8000-000000000001", label: "Week 2", weight: 1 }],
        rosUnavailable: null,
        provenance: {
          leagueLastSyncedAt: null,
          rosterEffectiveAt: null,
          projectionSet: {
            id: "60000000-0000-4000-8000-000000000001",
            source: "trusted-weekly-model",
            version: "2026-w02-v1",
            horizon: "Week 2",
            sourceObservedAt: null,
            sourceObservedAtStatus: "unverified",
            importedAt: "2026-09-15T11:00:00.000Z",
          },
          projectionFreshness: { state: "missing", observedAt: null, label: "No projection set" },
        },
        execution: {
          mode: "provider-required",
          provider: "manual",
          label: "Verify and apply manually in your league host",
          url: null,
        },
        notes: [],
      }).success,
    ).toBe(true);
  });
});
