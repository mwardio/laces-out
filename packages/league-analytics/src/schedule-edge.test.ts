import {
  playerId,
  rosterSlotId,
  type NflTeam,
  type Player,
  type Position,
  type RosterSlot,
} from "@fantasy/domain";
import type { ProjectionScoringProfile } from "@fantasy/projections";
import { describe, expect, it } from "vitest";

import {
  buildScheduleEdgeGamePositionTotals,
  calculateScheduleEdgeDefenseRatings,
  deriveByeWeekFeasibility,
  deriveScheduleStrength,
  type ScheduleEdgeDefenseRatingsResult,
  type ScheduleEdgeGamePositionTotal,
  type ScheduleEdgeGamePositionTotalsResult,
  type ScheduleEdgePolicy,
  type ScheduleEdgeWeeklyRosterFact,
  type ScheduleEdgeWeeklyStatFact,
} from "./schedule-edge.js";
import type { TeamScheduleGame, TeamScheduleResult, TeamScheduleWeek } from "./schedule.js";

function player(id: string, positions: readonly Position[], team?: NflTeam): Player {
  return {
    id: playerId(id),
    name: id,
    positions,
    ...(team ? { nflTeam: team } : {}),
  };
}

function starter(id: string, positions: readonly Position[]): RosterSlot {
  return {
    id: rosterSlotId(id),
    type:
      positions.length === 1
        ? (positions[0] as "QB" | "RB" | "WR" | "TE")
        : positions.includes("QB")
          ? "SUPER_FLEX"
          : "FLEX",
    label: id,
    kind: "STARTER",
    eligiblePositions: positions,
  };
}

function gameWeek(week: number, team: string, opponent: string): TeamScheduleWeek {
  const game: TeamScheduleGame = {
    externalGameId: `2025_${week}_${team}_${opponent}`,
    week,
    gameDate: "2025-09-01",
    startTimeEastern: "13:00",
    timeTbd: false,
    kickoffAt: new Date("2025-09-01T17:00:00.000Z"),
    opponent,
    venue: "home",
    status: "scheduled",
    restDays: 7,
    teamScore: null,
    opponentScore: null,
  };
  return { state: "game", week, game };
}

function schedule(
  teamWeeks: Readonly<Record<string, readonly ("game" | "bye" | "unknown")[]>>,
): TeamScheduleResult {
  const teams = Object.keys(teamWeeks).sort();
  const coveredWeeks = Array.from(
    { length: Math.max(...Object.values(teamWeeks).map((weeks) => weeks.length)) },
    (_, index) => index + 1,
  );
  return {
    season: 2025,
    coveredWeeks,
    teams: teams.map((team) => {
      const opponent = teams.find((candidate) => candidate !== team) ?? "MIA";
      const weeks = (teamWeeks[team] ?? []).map((state, index): TeamScheduleWeek => {
        const week = index + 1;
        if (state === "game") return gameWeek(week, team, opponent);
        if (state === "bye") return { state, week };
        return { state, week, reason: "Schedule coverage is incomplete." };
      });
      const byeWeeks = weeks.flatMap((week) => (week.state === "bye" ? [week.week] : []));
      return {
        team,
        weeks,
        bye: { status: "available" as const, byeWeeks },
      };
    }),
    definitions: { bye: "Affirmed bye.", venue: "Stored venue." },
  };
}

describe("deriveByeWeekFeasibility", () => {
  const slots = [starter("qb", ["QB"]), starter("flex", ["RB", "WR", "TE"])];

  it("uses exact eligibility matching and distinguishes gap, thin, and covered depth", () => {
    const result = deriveByeWeekFeasibility({
      season: 2025,
      startWeek: 1,
      endWeek: 3,
      schedule: schedule({
        BUF: ["bye", "game", "game"],
        MIA: ["game", "game", "game"],
        CHI: ["game", "game", "game"],
        GB: ["game", "game", "game"],
      }),
      roster: [
        { player: player("qb-1", ["QB"], "BUF"), rosterState: "available" },
        { player: player("qb-2", ["QB"], "MIA"), rosterState: "injured-reserve" },
        { player: player("rb", ["RB"], "CHI"), rosterState: "available" },
        { player: player("wr", ["WR"], "GB"), rosterState: "available" },
      ],
      slots,
    });

    expect(result.weeks.map((week) => week.status)).toEqual(["gap", "thin", "thin"]);
    expect(result.weeks[0]?.byePlayerIds).toEqual([playerId("qb-1")]);
    expect(result.weeks[1]?.criticalPlayerIds).toEqual([playerId("qb-1")]);

    const covered = deriveByeWeekFeasibility({
      season: 2025,
      startWeek: 1,
      endWeek: 1,
      schedule: schedule({
        BUF: ["game"],
        MIA: ["game"],
        CHI: ["game"],
        GB: ["game"],
      }),
      roster: [
        { player: player("qb-1", ["QB"], "BUF"), rosterState: "available" },
        { player: player("qb-2", ["QB"], "MIA"), rosterState: "available" },
        { player: player("rb", ["RB"], "CHI"), rosterState: "available" },
        { player: player("wr", ["WR"], "GB"), rosterState: "available" },
      ],
      slots,
    });
    expect(covered.weeks[0]).toMatchObject({
      status: "covered",
      criticalPlayerIds: [],
      unfilledSlotIds: [],
    });
  });

  it("handles superflex, duplicate slot types, and multi-position players", () => {
    const result = deriveByeWeekFeasibility({
      season: 2025,
      startWeek: 1,
      endWeek: 1,
      schedule: schedule({ BUF: ["game"], CHI: ["game"], GB: ["game"] }),
      roster: [
        { player: player("qb", ["QB"], "BUF"), rosterState: "available" },
        { player: player("hybrid", ["RB", "WR"], "CHI"), rosterState: "available" },
        { player: player("wr", ["WR"], "GB"), rosterState: "available" },
      ],
      slots: [
        starter("superflex", ["QB", "RB", "WR", "TE"]),
        starter("flex-1", ["RB", "WR", "TE"]),
        starter("flex-2", ["RB", "WR", "TE"]),
      ],
    });
    expect(result.weeks[0]).toMatchObject({ status: "thin", unfilledSlotIds: [] });
    expect(result.weeks[0]?.assignments).toHaveLength(3);
  });

  it("returns unknown instead of guessing through schedule, roster, or optimizer gaps", () => {
    const unknownSchedule = deriveByeWeekFeasibility({
      season: 2025,
      startWeek: 1,
      endWeek: 1,
      schedule: schedule({ BUF: ["unknown"], CHI: ["game"] }),
      roster: [
        { player: player("qb", ["QB"], "BUF"), rosterState: "available" },
        { player: player("rb", ["RB"], "CHI"), rosterState: "available" },
      ],
      slots,
    });
    expect(unknownSchedule.weeks[0]?.status).toBe("unknown");

    const tooManySlots = deriveByeWeekFeasibility({
      season: 2025,
      startWeek: 1,
      endWeek: 1,
      schedule: schedule({ BUF: ["game"] }),
      roster: [{ player: player("qb", ["QB"], "BUF"), rosterState: "available" }],
      slots: Array.from({ length: 31 }, (_, index) => starter(`qb-${index}`, ["QB"])),
    });
    expect(tooManySlots.weeks[0]?.status).toBe("unknown");
    expect(tooManySlots.weeks[0]?.reasons.join(" ")).toContain("30 starter slots");
  });

  it("is invariant to roster and slot order", () => {
    const input = {
      season: 2025,
      startWeek: 1,
      endWeek: 1,
      schedule: schedule({ BUF: ["game"], CHI: ["game"], GB: ["game"] }),
      roster: [
        { player: player("qb", ["QB"], "BUF"), rosterState: "available" as const },
        { player: player("rb", ["RB"], "CHI"), rosterState: "available" as const },
        { player: player("wr", ["WR"], "GB"), rosterState: "available" as const },
      ],
      slots,
    };
    const first = deriveByeWeekFeasibility(input);
    const reordered = deriveByeWeekFeasibility({
      ...input,
      roster: [...input.roster].reverse(),
      slots: [...slots].reverse(),
    });
    expect(reordered).toEqual(first);
  });
});

const scoringProfile: ProjectionScoringProfile = {
  id: "test-scoring",
  rules: [
    { statId: "passing_yards", points: 0.04 },
    { statId: "rushing_yards", points: 0.1 },
    { statId: "receptions", points: 1 },
    { statId: "fumbles_lost", points: -2 },
  ],
};

function roster(
  playerKey: string,
  team: string,
  position: string,
  playerIdValue: string | null = playerKey,
): ScheduleEdgeWeeklyRosterFact {
  return {
    externalPlayerId: playerKey,
    playerId: playerIdValue,
    season: 2024,
    week: 1,
    team,
    position,
    status: "ACT",
  };
}

function stat(
  playerKey: string,
  team: string,
  opponentTeam: string,
  components: Record<string, number>,
  playerIdValue: string | null = playerKey,
): ScheduleEdgeWeeklyStatFact {
  return {
    externalPlayerId: playerKey,
    playerId: playerIdValue,
    season: 2024,
    week: 1,
    gameId: "2024_01_ARI_ATL",
    team,
    opponentTeam,
    components,
  };
}

const completeRosters: readonly ScheduleEdgeWeeklyRosterFact[] = [
  roster("ari-qb", "ARI", "QB"),
  roster("ari-rb", "ARI", "RB"),
  roster("ari-wr", "ARI", "WR"),
  roster("ari-te", "ARI", "TE"),
  roster("ari-k", "ARI", "K"),
  roster("atl-qb", "ATL", "QB"),
  roster("atl-rb", "ATL", "RB"),
  roster("atl-wr", "ATL", "WR"),
  roster("atl-te", "ATL", "TE"),
];

const completeStats: readonly ScheduleEdgeWeeklyStatFact[] = [
  stat("ari-qb", "ARI", "ATL", { passing_yards: 250, fumbles_lost_total: 1 }),
  stat("ari-rb", "ARI", "ATL", { rushing_yards: 80 }),
  stat("ari-k", "ARI", "ATL", { field_goals_made_0_19: 1 }),
  stat("atl-qb", "ATL", "ARI", { passing_yards: 200 }),
];

describe("buildScheduleEdgeGamePositionTotals", () => {
  const games = [
    {
      season: 2024,
      week: 1,
      gameId: "2024_01_ARI_ATL",
      awayTeam: "ARI",
      homeTeam: "ATL",
      status: "final" as const,
    },
  ];

  it("enumerates schedule sides, uses weekly positions, and affirms real zero slices", () => {
    const result = buildScheduleEdgeGamePositionTotals({
      games,
      weeklyStats: completeStats,
      weeklyRosters: completeRosters,
      scoringProfile,
    });
    const ariQb = result.totals.find(
      (total) => total.offenseTeam === "ARI" && total.position === "QB",
    );
    const ariWr = result.totals.find(
      (total) => total.offenseTeam === "ARI" && total.position === "WR",
    );
    expect(result.totals).toHaveLength(8);
    expect(ariQb).toMatchObject({
      status: "available",
      points: 8,
      rosterPlayers: 1,
      scoredPlayers: 1,
      zeroStatPlayers: 0,
    });
    expect(ariWr).toMatchObject({
      status: "available",
      points: 0,
      rosterPlayers: 1,
      scoredPlayers: 0,
      zeroStatPlayers: 1,
    });
    expect(result.scoringProfileKey).toContain("passing_yards");
  });

  it("does not let kickers or other unsupported positions invalidate offensive slices", () => {
    const result = buildScheduleEdgeGamePositionTotals({
      games,
      weeklyStats: completeStats,
      weeklyRosters: completeRosters,
      scoringProfile,
    });
    expect(
      result.totals
        .filter((total) => total.offenseTeam === "ARI")
        .every((total) => total.status === "available"),
    ).toBe(true);
  });

  it("withholds empty games, unmatched positions, and unmatched stat identities", () => {
    const noStats = buildScheduleEdgeGamePositionTotals({
      games,
      weeklyStats: [],
      weeklyRosters: completeRosters,
      scoringProfile,
      positions: ["QB"],
    });
    expect(noStats.totals).toHaveLength(2);
    expect(noStats.totals.every((total) => total.status === "unavailable")).toBe(true);

    const unmatchedRoster = buildScheduleEdgeGamePositionTotals({
      games,
      weeklyStats: completeStats,
      weeklyRosters: completeRosters.map((row) =>
        row.externalPlayerId === "ari-wr" ? { ...row, playerId: null } : row,
      ),
      scoringProfile,
    });
    expect(
      unmatchedRoster.totals.find(
        (total) => total.offenseTeam === "ARI" && total.position === "WR",
      ),
    ).toMatchObject({ status: "unavailable", unmatchedRosterRows: 1 });
    expect(
      unmatchedRoster.totals.find((total) => total.offenseTeam === "ARI" && total.position === "RB")
        ?.status,
    ).toBe("available");

    const unmatchedStat = buildScheduleEdgeGamePositionTotals({
      games,
      weeklyStats: [...completeStats, stat("unknown", "ARI", "ATL", { receptions: 1 }, null)],
      weeklyRosters: completeRosters,
      scoringProfile,
    });
    expect(
      unmatchedStat.totals
        .filter((total) => total.offenseTeam === "ARI")
        .every((total) => total.status === "unavailable"),
    ).toBe(true);
  });

  it("is deterministic under input reordering", () => {
    const first = buildScheduleEdgeGamePositionTotals({
      games,
      weeklyStats: completeStats,
      weeklyRosters: completeRosters,
      scoringProfile,
    });
    const reordered = buildScheduleEdgeGamePositionTotals({
      games: [...games].reverse(),
      weeklyStats: [...completeStats].reverse(),
      weeklyRosters: [...completeRosters].reverse(),
      scoringProfile,
      positions: ["TE", "WR", "RB", "QB"],
    });
    expect(reordered).toEqual(first);
  });
});

function total(
  season: number,
  week: number,
  gameId: string,
  offenseTeam: string,
  defenseTeam: string,
  points: number,
): ScheduleEdgeGamePositionTotal {
  return {
    season,
    week,
    gameId,
    offenseTeam,
    defenseTeam,
    position: "QB",
    status: "available",
    points,
    rosterPlayers: 1,
    scoredPlayers: 1,
    zeroStatPlayers: 0,
    unmatchedRosterRows: 0,
    unmatchedStatRows: 0,
    reasons: [],
  };
}

function totals(
  rows: readonly ScheduleEdgeGamePositionTotal[],
): ScheduleEdgeGamePositionTotalsResult {
  return {
    positions: ["QB"],
    scoringProfileKey: "test",
    totals: rows,
    completeSlices: rows.filter((row) => row.status === "available").length,
    incompleteSlices: rows.filter((row) => row.status === "unavailable").length,
    definition: "test",
  };
}

const policy: ScheduleEdgePolicy = {
  version: "test-v1",
  labelsEnabled: true,
  validatedPositions: ["QB"],
  offenseShrinkageGames: 1,
  defenseShrinkageGames: 0,
  priorSeasonPseudoGames: 1,
  highConfidenceGames: 2,
  minimumCurrentSeasonGamesForLabel: 1,
  recencyDecay: null,
  allowPriorOnlyLabels: false,
  minimumPointDifferentialByPosition: { QB: 0.1, RB: 0.1, WR: 0.1, TE: 0.1 },
};

const ratingRows = [
  total(2024, 1, "2024-a", "ARI", "ATL", 20),
  total(2024, 1, "2024-b", "BUF", "BAL", 10),
  total(2024, 2, "2024-c", "ARI", "BAL", 30),
  total(2024, 2, "2024-d", "BUF", "ATL", 20),
  total(2025, 1, "2025-a", "ARI", "ATL", 40),
  total(2025, 1, "2025-b", "BUF", "BAL", 10),
  total(2025, 2, "2025-c", "ARI", "BAL", 40),
  total(2025, 2, "2025-d", "BUF", "ATL", 10),
] as const;

describe("calculateScheduleEdgeDefenseRatings", () => {
  it("derives opponent-adjusted, prior-shrunk, versioned ratings and labels", () => {
    const result = calculateScheduleEdgeDefenseRatings({
      targetSeason: 2025,
      throughWeek: 4,
      totals: totals(ratingRows),
      policy,
    });
    const atl = result.ratings.find(
      (rating) => rating.defenseTeam === "ATL" && rating.position === "QB",
    );
    const bal = result.ratings.find(
      (rating) => rating.defenseTeam === "BAL" && rating.position === "QB",
    );
    expect(result.policyVersion).toBe("test-v1");
    expect(atl).toMatchObject({
      status: "available",
      currentGames: 2,
      confidence: "high",
    });
    expect(bal).toMatchObject({
      status: "available",
      currentGames: 2,
      confidence: "high",
    });
    expect(atl?.adjustedPointsPerGame).not.toBe(bal?.adjustedPointsPerGame);
    expect([atl?.percentile, bal?.percentile].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      0, 100,
    ]);
  });

  it("caps preseason and Weeks 1–4 context at low confidence", () => {
    const result = calculateScheduleEdgeDefenseRatings({
      targetSeason: 2025,
      throughWeek: 3,
      totals: totals(ratingRows),
      policy,
    });

    expect(
      result.ratings
        .filter((rating) => rating.status === "available")
        .every((rating) => rating.confidence === "low"),
    ).toBe(true);
  });

  it("does not let a later week alter a strictly earlier rating", () => {
    const first = calculateScheduleEdgeDefenseRatings({
      targetSeason: 2025,
      throughWeek: 1,
      totals: totals(ratingRows),
      policy,
    });
    const changedFuture = ratingRows.map((row) =>
      row.season === 2025 && row.week === 2 ? { ...row, points: (row.points ?? 0) + 500 } : row,
    );
    const second = calculateScheduleEdgeDefenseRatings({
      targetSeason: 2025,
      throughWeek: 1,
      totals: totals(changedFuture),
      policy,
    });
    expect(second).toEqual(first);
  });

  it("applies recency by week rather than arbitrarily ordering games within a week", () => {
    const recencyRows = [
      total(2025, 1, "same-week-a", "ARI", "ATL", 10),
      total(2025, 1, "same-week-b", "BUF", "ATL", 30),
      total(2025, 2, "newest", "ARI", "ATL", 50),
    ];
    const result = calculateScheduleEdgeDefenseRatings({
      targetSeason: 2025,
      throughWeek: 2,
      totals: totals(recencyRows),
      policy: {
        ...policy,
        priorSeasonPseudoGames: 0,
        recencyDecay: 0.5,
      },
    });
    expect(result.ratings.find((rating) => rating.defenseTeam === "ATL")?.rawPointsPerGame).toBe(
      35,
    );
  });

  it("keeps labels unavailable when the policy disables predictive language", () => {
    const result = calculateScheduleEdgeDefenseRatings({
      targetSeason: 2025,
      throughWeek: 2,
      totals: totals(ratingRows),
      policy: { ...policy, labelsEnabled: false },
    });
    expect(result.ratings.every((rating) => rating.label === "unavailable")).toBe(true);
    expect(result.ratings.every((rating) => rating.reason?.includes("disabled"))).toBe(true);
  });

  it("is deterministic under game-position input order", () => {
    const first = calculateScheduleEdgeDefenseRatings({
      targetSeason: 2025,
      throughWeek: 2,
      totals: totals(ratingRows),
      policy,
    });
    const reordered = calculateScheduleEdgeDefenseRatings({
      targetSeason: 2025,
      throughWeek: 2,
      totals: totals([...ratingRows].reverse()),
      policy,
    });
    expect(reordered).toEqual(first);
  });
});

function ratings(): ScheduleEdgeDefenseRatingsResult {
  return {
    targetSeason: 2025,
    throughWeek: 4,
    positions: ["QB"],
    scoringProfileKey: "test",
    policyVersion: "test-v1",
    ratings: [
      {
        defenseTeam: "ATL",
        position: "QB",
        status: "available",
        currentGames: 2,
        priorGames: 2,
        incompleteGames: 0,
        rawPointsPerGame: 30,
        adjustedPointsPerGame: 32,
        leagueMeanPointsPerGame: 20,
        pointDifferential: 12,
        percentile: 100,
        label: "favorable",
        confidence: "high",
        observedWeight: 0.5,
        priorWeight: 0.5,
        residualGames: 2,
        reason: null,
      },
      {
        defenseTeam: "BAL",
        position: "QB",
        status: "available",
        currentGames: 2,
        priorGames: 2,
        incompleteGames: 0,
        rawPointsPerGame: 10,
        adjustedPointsPerGame: 8,
        leagueMeanPointsPerGame: 20,
        pointDifferential: -12,
        percentile: 0,
        label: "difficult",
        confidence: "high",
        observedWeight: 0.5,
        priorWeight: 0.5,
        residualGames: 2,
        reason: null,
      },
    ],
    definition: "test",
  };
}

describe("deriveScheduleStrength", () => {
  it("averages available games, omits byes, preserves unknowns, and ranks stably", () => {
    const teamSchedule = schedule({
      ARI: ["game", "bye", "game"],
      ATL: ["game", "game", "game"],
      BAL: ["game", "unknown", "game"],
    });
    // The generic fixture uses the first other alphabetic team as opponent. Force the intended
    // opponents so the window includes both an easy and a difficult matchup.
    const ari = teamSchedule.teams.find((team) => team.team === "ARI");
    if (!ari) throw new Error("ARI schedule missing");
    const customSchedule: TeamScheduleResult = {
      ...teamSchedule,
      teams: teamSchedule.teams.map((team) =>
        team.team !== "ARI"
          ? team
          : {
              ...team,
              weeks: [
                gameWeek(1, "ARI", "ATL"),
                { state: "bye" as const, week: 2 },
                gameWeek(3, "ARI", "BAL"),
              ],
            },
      ),
    };
    const result = deriveScheduleStrength({
      season: 2025,
      startWeek: 1,
      endWeek: 3,
      schedule: customSchedule,
      ratings: ratings(),
      positions: ["QB"],
    });
    const arizona = result.entries.find((entry) => entry.team === "ARI" && entry.position === "QB");
    expect(arizona).toMatchObject({
      status: "available",
      averagePercentile: 50,
      favorableWeeks: 1,
      difficultWeeks: 1,
      byeWeeks: 1,
      availableWeeks: 2,
      expectedWeeks: 3,
      coverage: 1,
    });
    expect(arizona?.weeks.map((week) => week.state)).toEqual(["matchup", "bye", "matchup"]);
  });
});
