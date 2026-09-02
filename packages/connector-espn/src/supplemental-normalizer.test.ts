import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  EspnSupplementalNormalizationError,
  normalizeEspnSupplementalSnapshot,
} from "./supplemental-normalizer.js";

function checksum(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function endpoint(input: {
  readonly leagueId?: string;
  readonly season?: number;
  readonly views: readonly string[];
  readonly week?: number;
  readonly history?: boolean;
}): string {
  const leagueId = input.leagueId ?? "7654321";
  const season = input.season ?? 2025;
  const url = new URL(
    input.history
      ? `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/leagueHistory/${leagueId}`
      : `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`,
  );
  if (input.history) url.searchParams.set("seasonId", String(season));
  for (const view of input.views) url.searchParams.append("view", view);
  if (input.week !== undefined) url.searchParams.set("scoringPeriodId", String(input.week));
  return url.toString();
}

function envelope(input: {
  readonly kind:
    | "available-free-agents"
    | "available-waivers"
    | "weekly-box-scores"
    | "structured-transactions"
    | "completed-draft";
  readonly week: number | null;
  readonly views: readonly string[];
  readonly payload: unknown;
  readonly history?: boolean;
  readonly matchupPeriodId?: number;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: "espn",
    authority: "browser-local",
    readOnly: true,
    kind: input.kind,
    leagueId: "7654321",
    season: 2025,
    week: input.week,
    ...(input.matchupPeriodId === undefined ? {} : { matchupPeriodId: input.matchupPeriodId }),
    capturedAt: "2026-07-24T13:00:00.000Z",
    endpoint: endpoint({
      views: input.views,
      ...(input.week === null ? {} : { week: input.week }),
      ...(input.history === undefined ? {} : { history: input.history }),
    }),
    checksumSha256: checksum(input.payload),
    payload: input.payload,
  };
}

function availablePlayer(id: number, status: "FREEAGENT" | "WAIVERS"): Record<string, unknown> {
  return {
    id,
    onTeamId: 0,
    status,
    player: {
      id,
      fullName: id < 0 ? "Invented Bay Defense" : "Example Runner",
      eligibleSlots: id < 0 ? [16, 20] : [2, 3, 23, 20],
      proTeamId: id < 0 ? 27 : 8,
      injuryStatus: "ACTIVE",
      ownership: {
        percentOwned: 37.5,
        percentStarted: 12.25,
        percentChange: 4.5,
      },
    },
  };
}

function weeklyPlayer(input: {
  readonly id: number;
  readonly teamId: number;
  readonly lineupSlotId: number;
  readonly actual?: number;
  readonly projected?: number;
  readonly currentTeamId?: number;
  readonly poolStatus?: "ONTEAM" | "FREEAGENT" | "WAIVERS";
}): Record<string, unknown> {
  const stats = [
    ...(input.actual === undefined
      ? []
      : [
          {
            seasonId: 2025,
            scoringPeriodId: 7,
            statSourceId: 0,
            statSplitTypeId: 1,
            appliedTotal: input.actual,
            appliedStats: { "3": input.actual },
          },
        ]),
    ...(input.projected === undefined
      ? []
      : [
          {
            seasonId: 2025,
            scoringPeriodId: 7,
            statSourceId: 1,
            statSplitTypeId: 1,
            appliedTotal: input.projected,
            appliedStats: {},
          },
        ]),
  ];
  return {
    lineupSlotId: input.lineupSlotId,
    playerId: input.id,
    playerPoolEntry: {
      id: input.id,
      onTeamId: input.currentTeamId ?? input.teamId,
      status: input.poolStatus ?? "ONTEAM",
      player: {
        id: input.id,
        fullName: input.id < 0 ? "Invented City Defense" : "Example Quarterback",
        eligibleSlots: input.id < 0 ? [16, 20] : [0, 7, 20],
        proTeamId: input.id < 0 ? 33 : 12,
        injuryStatus: "ACTIVE",
        stats,
      },
    },
  };
}

function transactionItem(input: {
  readonly type: "ADD" | "DROP" | "TRADE";
  readonly playerId: number;
  readonly fromTeamId: number;
  readonly toTeamId: number;
}): Record<string, unknown> {
  return {
    type: input.type,
    playerId: input.playerId,
    fromTeamId: input.fromTeamId,
    toTeamId: input.toTeamId,
    fromLineupSlotId: input.fromTeamId === 0 ? -1 : 20,
    toLineupSlotId: input.toTeamId === 0 ? -1 : 20,
  };
}

function transaction(input: {
  readonly id: string;
  readonly type: "WAIVER" | "TRADE_ACCEPT";
  readonly status: "EXECUTED" | "FAILED_ROSTERLIMIT";
  readonly teamId: number;
  readonly bidAmount: number;
  readonly items: readonly Record<string, unknown>[];
}): Record<string, unknown> {
  return {
    id: input.id,
    scoringPeriodId: 7,
    type: input.type,
    status: input.status,
    executionType: "PROCESS",
    teamId: input.teamId,
    bidAmount: input.bidAmount,
    proposedDate: 1_757_000_000_000,
    processDate: 1_757_000_100_000,
    items: input.items,
  };
}

function draftPayload(type: "AUCTION" | "SNAKE"): Record<string, unknown> {
  return {
    id: "7654321",
    seasonId: 2025,
    settings: {
      draftSettings: {
        type,
        auctionBudget: 200,
      },
    },
    draftDetail: {
      completeDate: 1_756_000_000_000,
      drafted: true,
      inProgress: false,
      picks: [
        {
          id: 9001,
          bidAmount: type === "AUCTION" ? 42 : 0,
          keeper: false,
          nominatingTeamId: type === "AUCTION" ? 2 : 0,
          overallPickNumber: 1,
          playerId: -16033,
          roundId: 1,
          roundPickNumber: 1,
          teamId: 1,
        },
      ],
    },
  };
}

function captureError(value: unknown): EspnSupplementalNormalizationError {
  try {
    normalizeEspnSupplementalSnapshot(value);
  } catch (error) {
    expect(error).toBeInstanceOf(EspnSupplementalNormalizationError);
    return error as EspnSupplementalNormalizationError;
  }
  throw new Error("Expected supplemental normalization to fail");
}

describe("ESPN supplemental snapshot normalizer", () => {
  it("normalizes bounded free-agent and empty waiver pools, including defense IDs", () => {
    const freeAgentPayload = {
      players: [availablePlayer(-16027, "FREEAGENT"), availablePlayer(5012345, "FREEAGENT")],
    };
    const freeAgents = normalizeEspnSupplementalSnapshot(
      envelope({
        kind: "available-free-agents",
        week: 18,
        views: ["kona_player_info"],
        payload: freeAgentPayload,
      }),
    );

    expect(freeAgents).toMatchObject({
      kind: "available-players",
      providerLeagueId: "7654321",
      season: 2025,
      asOfWeek: 18,
      availability: "free-agent",
      truncated: false,
      players: [
        {
          externalId: "espn:2025:player:-16027",
          providerPlayerId: "-16027",
          primaryPosition: "D/ST",
          availability: "free-agent",
          percentOwned: 37.5,
        },
        {
          providerPlayerId: "5012345",
          primaryPosition: "RB",
          eligiblePositions: ["RB", "RB/WR", "FLEX", "BN"],
        },
      ],
    });

    const waivers = normalizeEspnSupplementalSnapshot(
      envelope({
        kind: "available-waivers",
        week: 18,
        views: ["kona_player_info"],
        payload: { players: [] },
      }),
    );
    expect(waivers).toMatchObject({
      kind: "available-players",
      availability: "waivers",
      players: [],
    });
  });

  it("retains weekly actuals and projections without converting missing actual rows to zero", () => {
    const payload = {
      id: "7654321",
      seasonId: 2025,
      scoringPeriodId: 7,
      schedule: [
        {
          id: 7001,
          matchupPeriodId: 7,
          home: {
            teamId: 1,
            totalPoints: 123.5,
            rosterForCurrentScoringPeriod: {
              entries: [
                weeklyPlayer({
                  id: 5001,
                  teamId: 1,
                  lineupSlotId: 0,
                  actual: 24.5,
                  projected: 21.25,
                }),
              ],
            },
          },
          away: {
            teamId: 2,
            totalPoints: 111,
            rosterForCurrentScoringPeriod: {
              entries: [
                weeklyPlayer({
                  id: -16033,
                  teamId: 2,
                  lineupSlotId: 20,
                  projected: 7,
                  currentTeamId: 0,
                  poolStatus: "FREEAGENT",
                }),
              ],
            },
          },
        },
      ],
    };
    const result = normalizeEspnSupplementalSnapshot(
      envelope({
        kind: "weekly-box-scores",
        week: 7,
        matchupPeriodId: 7,
        views: ["mMatchupScore", "mScoreboard"],
        payload,
      }),
    );

    expect(result).toMatchObject({
      kind: "weekly-box-scores",
      week: 7,
      matchups: [
        {
          providerMatchupId: "7001",
          home: { providerTeamId: "1", totalPoints: 123.5 },
          away: { providerTeamId: "2", totalPoints: 111 },
        },
      ],
      playerScores: [
        {
          providerPlayerId: "5001",
          lineupSlot: "QB",
          starter: true,
          actualPoints: 24.5,
          projectedPoints: 21.25,
          appliedStats: { "3": 24.5 },
        },
        {
          providerPlayerId: "-16033",
          lineupSlot: "BN",
          starter: false,
          actualPoints: null,
          projectedPoints: 7,
        },
      ],
      warnings: ["ACTUAL_STAT_ROWS_MISSING:1"],
    });
  });

  it("preserves executed and failed waiver evidence plus structured trade items", () => {
    const payload = [
      {
        id: "7654321",
        seasonId: 2025,
        scoringPeriodId: 7,
        transactions: [
          transaction({
            id: "00000000-0000-4000-8000-000000008101",
            type: "WAIVER",
            status: "EXECUTED",
            teamId: 1,
            bidAmount: 17,
            items: [
              transactionItem({
                type: "ADD",
                playerId: -16033,
                fromTeamId: 0,
                toTeamId: 1,
              }),
              transactionItem({
                type: "DROP",
                playerId: 5002,
                fromTeamId: 1,
                toTeamId: 0,
              }),
            ],
          }),
          transaction({
            id: "00000000-0000-4000-8000-000000008102",
            type: "WAIVER",
            status: "FAILED_ROSTERLIMIT",
            teamId: 2,
            bidAmount: 11,
            items: [
              transactionItem({
                type: "ADD",
                playerId: 5003,
                fromTeamId: 0,
                toTeamId: 2,
              }),
            ],
          }),
          transaction({
            id: "00000000-0000-4000-8000-000000008103",
            type: "TRADE_ACCEPT",
            status: "EXECUTED",
            teamId: 1,
            bidAmount: 0,
            items: [
              transactionItem({
                type: "TRADE",
                playerId: 5004,
                fromTeamId: 1,
                toTeamId: 2,
              }),
            ],
          }),
        ],
      },
    ];
    const result = normalizeEspnSupplementalSnapshot(
      envelope({
        kind: "structured-transactions",
        week: 7,
        views: ["mTransactions2"],
        payload,
        history: true,
      }),
    );

    expect(result).toMatchObject({
      kind: "transactions",
      week: 7,
      transactions: [
        {
          providerTransactionId: "00000000-0000-4000-8000-000000008101",
          type: "waiver",
          status: "executed",
          bidAmount: 17,
          items: [
            {
              type: "add",
              providerPlayerId: "-16033",
              fromProviderTeamId: null,
              toProviderTeamId: "1",
            },
            {
              type: "drop",
              fromProviderTeamId: "1",
              toProviderTeamId: null,
            },
          ],
        },
        {
          providerTransactionId: "00000000-0000-4000-8000-000000008102",
          type: "waiver",
          status: "failed",
          bidAmount: 11,
        },
        {
          providerTransactionId: "00000000-0000-4000-8000-000000008103",
          type: "trade",
          status: "executed",
          bidAmount: null,
        },
      ],
    });
  });

  it("preserves transactions whose pending metadata and item list are omitted", () => {
    const payload = {
      id: "7654321",
      seasonId: 2025,
      scoringPeriodId: 7,
      transactions: [
        {
          id: "00000000-0000-4000-8000-000000008104",
          scoringPeriodId: 7,
          type: "TRADE_PROPOSAL",
          executionType: "EXECUTE",
          teamId: 1,
          bidAmount: 0,
          proposedDate: 1_757_000_000_000,
        },
      ],
    };
    const result = normalizeEspnSupplementalSnapshot(
      envelope({
        kind: "structured-transactions",
        week: 7,
        views: ["mTransactions2"],
        payload,
      }),
    );

    expect(result).toMatchObject({
      kind: "transactions",
      transactions: [
        {
          providerTransactionId: "00000000-0000-4000-8000-000000008104",
          status: "unknown",
          providerStatus: null,
          processedAt: null,
          items: [],
        },
      ],
    });
  });

  it.each([
    ["AUCTION", "auction", 42, 200],
    ["SNAKE", "snake", null, null],
  ] as const)(
    "normalizes completed %s draft results",
    (providerType, draftType, amount, budgetPerTeam) => {
      const payload = draftPayload(providerType);
      const result = normalizeEspnSupplementalSnapshot(
        envelope({
          kind: "completed-draft",
          week: null,
          views: ["mDraftDetail"],
          payload,
        }),
      );

      expect(result).toMatchObject({
        kind: "completed-draft",
        draftType,
        budgetPerTeam,
        state: "complete",
        picks: [
          {
            providerPickId: "9001",
            sequence: 1,
            providerTeamId: "1",
            providerPlayerId: "-16033",
            amount,
            keeper: false,
          },
        ],
      });
    },
  );

  it("normalizes an omitted draft completion time as unknown", () => {
    const payload = draftPayload("SNAKE");
    delete (payload.draftDetail as Record<string, unknown>).completeDate;

    const result = normalizeEspnSupplementalSnapshot(
      envelope({
        kind: "completed-draft",
        week: null,
        views: ["mDraftDetail"],
        payload,
      }),
    );

    expect(result).toMatchObject({
      kind: "completed-draft",
      state: "complete",
      completedAt: null,
    });
  });

  it("omits ESPN's empty auction placeholders before a draft starts", () => {
    const payload = draftPayload("AUCTION");
    const draftDetail = payload.draftDetail as {
      drafted: boolean;
      inProgress: boolean;
      picks: Array<Record<string, unknown>>;
    };
    draftDetail.drafted = false;
    draftDetail.inProgress = false;
    draftDetail.picks[0] = {
      ...draftDetail.picks[0],
      teamId: -1,
      playerId: -1,
      bidAmount: 0,
      keeper: false,
    };

    const result = normalizeEspnSupplementalSnapshot(
      envelope({
        kind: "completed-draft",
        week: null,
        views: ["mDraftDetail"],
        payload,
      }),
    );

    expect(result).toMatchObject({
      kind: "completed-draft",
      state: "in-progress",
      picks: [],
    });
  });

  it("rejects an assigned draft player with ESPN's unassigned team sentinel", () => {
    const payload = draftPayload("AUCTION");
    const draftDetail = payload.draftDetail as { picks: Array<Record<string, unknown>> };
    draftDetail.picks[0] = { ...draftDetail.picks[0], teamId: -1 };

    expect(
      captureError(
        envelope({
          kind: "completed-draft",
          week: null,
          views: ["mDraftDetail"],
          payload,
        }),
      ),
    ).toMatchObject({
      code: "SCHEMA_DRIFT",
      issues: [
        expect.objectContaining({
          path: "draftDetail.picks.0.teamId",
          message: "unassigned draft slots must remain empty placeholders",
        }),
      ],
    });
  });

  it("fails closed on endpoint, checksum, and provider-enum drift", () => {
    const payload = { players: [availablePlayer(5001, "FREEAGENT")] };
    const wrongView = envelope({
      kind: "available-free-agents",
      week: 18,
      views: ["mRoster"],
      payload,
    });
    expect(captureError(wrongView)).toMatchObject({ code: "INVALID_ENDPOINT" });

    const wrongChecksum = envelope({
      kind: "available-free-agents",
      week: 18,
      views: ["kona_player_info"],
      payload,
    });
    wrongChecksum.checksumSha256 = "0".repeat(64);
    expect(captureError(wrongChecksum)).toMatchObject({ code: "CHECKSUM_MISMATCH" });

    const driftPayload = {
      players: [{ ...availablePlayer(5001, "FREEAGENT"), status: "PRIVATE_VALUE_DO_NOT_COPY" }],
    };
    const drift = captureError(
      envelope({
        kind: "available-free-agents",
        week: 18,
        views: ["kona_player_info"],
        payload: driftPayload,
      }),
    );
    expect(drift.code).toBe("SCHEMA_DRIFT");
    expect(JSON.stringify(drift.issues)).not.toContain("PRIVATE_VALUE_DO_NOT_COPY");
  });
});
