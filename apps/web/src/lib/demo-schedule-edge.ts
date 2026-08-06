import type {
  ScheduleEdgeMatrixResponse,
  ScheduleEdgeMatchup,
  ScheduleEdgeResponse,
  ScheduleEdgeRosterPlayer,
  ScheduleEdgeSource,
  ScheduleEdgeStrength,
} from "@laces-out/contracts";

import { DEMO_LEAGUE_ID, DEMO_SEASON_ID } from "./demo-contract-data";
import { NFL_TEAM_CHOICES } from "./nfl-teams";

const GENERATED_AT = "2026-10-08T18:42:00.000Z";
const SOURCE_AT = "2026-10-08T17:55:00.000Z";
const USER_TEAM_ID = "71000000-0000-4000-8000-000000000010";
const HASH = "7c4a1d9e".repeat(8);
const EVIDENCE_HASH = "db143047024981db6afdf598d7f3eed3585cba62fa57e3f3dfd952d4ad19bdf6";
const PROFILE_HASH = "b58e30f1".repeat(8);
const selectedWeeks = [6, 7, 8, 9] as const;
const playoffWeeks = [15, 16, 17] as const;

type Confidence = "high" | "medium" | "low";

function matchup(percentile: number, confidence: Confidence = "high"): ScheduleEdgeMatchup {
  const differential = Math.round(((percentile - 50) / 10) * 10) / 10;
  return {
    state: "available",
    percentile,
    label: "unavailable",
    confidence,
    rawPointsAllowed: 19.4 + differential,
    adjustedPointsAllowed: 18.8 + differential,
    leagueAveragePoints: 18.8,
    pointDifferential: differential,
    currentGames: confidence === "low" ? 3 : 5,
    priorGames: confidence === "high" ? 0 : 8,
    incompleteGames: 0,
    reason: "Directional labels remain withheld; the percentile is descriptive context.",
  };
}

function strength(
  averagePercentile: number,
  rank: number,
  weeks: readonly number[],
  options: {
    readonly confidence?: Confidence;
    readonly byeWeek?: number;
    readonly opponentOffset?: number;
  } = {},
): ScheduleEdgeStrength {
  const opponents = ["CIN", "DAL", "SEA", "MIN", "BUF", "LAR", "CHI", "MIA", "SF", "NYJ"];
  const weekRows = weeks.map((week, index) => {
    if (week === options.byeWeek) {
      return {
        week,
        state: "bye" as const,
        opponent: null,
        percentile: null,
        label: "unavailable" as const,
        confidence: "unavailable" as const,
        reason: "The schedule affirms a bye for this team.",
      };
    }
    const percentile = Math.max(4, Math.min(96, averagePercentile + (index % 2 === 0 ? 5 : -5)));
    return {
      week,
      state: "game" as const,
      opponent: opponents[(index + (options.opponentOffset ?? 0)) % opponents.length]!,
      percentile,
      label: "unavailable" as const,
      confidence: options.confidence ?? ("high" as const),
      reason: "Directional labels remain withheld; the percentile is descriptive context.",
    };
  });
  return {
    state: "available",
    averagePercentile,
    rank,
    teamsRanked: 32,
    favorableWeeks: 0,
    neutralWeeks: 0,
    difficultWeeks: 0,
    byeWeeks: weekRows.filter((week) => week.state === "bye").length,
    unknownWeeks: 0,
    confidence: options.confidence ?? "high",
    weeks: weekRows,
    reason: null,
  };
}

interface DemoPlayerInput {
  readonly ordinal: number;
  readonly name: string;
  readonly position: "QB" | "RB" | "WR" | "TE";
  readonly team: string;
  readonly slot: string;
  readonly opponent: string;
  readonly percentile: number;
  readonly selectedPercentile: number;
  readonly selectedRank: number;
  readonly playoffPercentile: number;
  readonly playoffRank: number;
  readonly weeklyPoints: number;
  readonly rosPoints: number;
  readonly likelyStarter?: boolean;
  readonly byeWeek?: number;
}

function demoPlayer(input: DemoPlayerInput): ScheduleEdgeRosterPlayer {
  const playerId = `72000000-0000-4000-8000-${String(input.ordinal).padStart(12, "0")}`;
  return {
    playerId,
    name: input.name,
    primaryPosition: input.position,
    eligiblePositions: [input.position],
    nflTeam: input.team,
    status: "ACTIVE",
    isLikelyStarter: input.likelyStarter ?? true,
    currentSlot: input.slot,
    next: {
      week: 6,
      state: "game",
      opponent: input.opponent,
      kickoffAt: "2026-10-11T17:00:00.000Z",
      reason: null,
    },
    matchup: matchup(input.percentile),
    selectedWindow: strength(input.selectedPercentile, input.selectedRank, selectedWeeks, {
      ...(input.byeWeek === undefined ? {} : { byeWeek: input.byeWeek }),
      opponentOffset: input.ordinal,
    }),
    playoffWindow: strength(input.playoffPercentile, input.playoffRank, playoffWeeks, {
      opponentOffset: input.ordinal + 2,
    }),
    projection: {
      weeklyPoints: input.weeklyPoints,
      rosPoints: input.rosPoints,
      source: "Laces Out sample forecast",
      sourceObservedAt: SOURCE_AT,
    },
  };
}

const roster = [
  demoPlayer({
    ordinal: 1,
    name: "Lamar Jackson",
    position: "QB",
    team: "BAL",
    slot: "QB",
    opponent: "CIN",
    percentile: 72,
    selectedPercentile: 68,
    selectedRank: 9,
    playoffPercentile: 58,
    playoffRank: 15,
    weeklyPoints: 24.8,
    rosPoints: 267.4,
  }),
  demoPlayer({
    ordinal: 2,
    name: "Bijan Robinson",
    position: "RB",
    team: "ATL",
    slot: "RB",
    opponent: "TB",
    percentile: 84,
    selectedPercentile: 79,
    selectedRank: 3,
    playoffPercentile: 65,
    playoffRank: 10,
    weeklyPoints: 19.6,
    rosPoints: 211.8,
    byeWeek: 8,
  }),
  demoPlayer({
    ordinal: 3,
    name: "Jahmyr Gibbs",
    position: "RB",
    team: "DET",
    slot: "RB",
    opponent: "MIN",
    percentile: 38,
    selectedPercentile: 43,
    selectedRank: 24,
    playoffPercentile: 74,
    playoffRank: 6,
    weeklyPoints: 18.9,
    rosPoints: 205.1,
  }),
  demoPlayer({
    ordinal: 4,
    name: "Jayden Reed",
    position: "WR",
    team: "GB",
    slot: "WR",
    opponent: "CHI",
    percentile: 56,
    selectedPercentile: 62,
    selectedRank: 12,
    playoffPercentile: 29,
    playoffRank: 29,
    weeklyPoints: 15.8,
    rosPoints: 158.9,
  }),
  demoPlayer({
    ordinal: 5,
    name: "Trey McBride",
    position: "TE",
    team: "ARI",
    slot: "TE",
    opponent: "SEA",
    percentile: 89,
    selectedPercentile: 82,
    selectedRank: 2,
    playoffPercentile: 77,
    playoffRank: 4,
    weeklyPoints: 14.1,
    rosPoints: 151.6,
  }),
  demoPlayer({
    ordinal: 6,
    name: "Mike Evans",
    position: "WR",
    team: "TB",
    slot: "WR",
    opponent: "ATL",
    percentile: 28,
    selectedPercentile: 35,
    selectedRank: 28,
    playoffPercentile: 31,
    playoffRank: 27,
    weeklyPoints: 12.2,
    rosPoints: 137.2,
  }),
  demoPlayer({
    ordinal: 7,
    name: "Quentin Johnston",
    position: "WR",
    team: "LAC",
    slot: "FLEX",
    opponent: "MIA",
    percentile: 69,
    selectedPercentile: 71,
    selectedRank: 7,
    playoffPercentile: 52,
    playoffRank: 17,
    weeklyPoints: 13.7,
    rosPoints: 142.3,
  }),
  demoPlayer({
    ordinal: 9,
    name: "Breece Hall",
    position: "RB",
    team: "NYJ",
    slot: "Bench",
    opponent: "BUF",
    percentile: 47,
    selectedPercentile: 54,
    selectedRank: 18,
    playoffPercentile: 68,
    playoffRank: 9,
    weeklyPoints: 17.2,
    rosPoints: 184.6,
    likelyStarter: false,
    byeWeek: 8,
  }),
] satisfies readonly ScheduleEdgeRosterPlayer[];

const sources = [
  {
    dataset: "schedule",
    state: "available",
    key: "demo-schedule",
    name: "Illustrative schedule fixture",
    attribution: "Tour fixture",
    attributionUrl: null,
    fetchedAt: SOURCE_AT,
    checksumSha256: "1".repeat(64),
    coveredWeeks: [...selectedWeeks, ...playoffWeeks],
    quality: { rowsRead: 272, rowsRejected: 0, rowsUnmatched: 0, matchRate: 1 },
    reason: null,
  },
  {
    dataset: "weekly-stats",
    state: "available",
    key: "demo-weekly-stats",
    name: "Illustrative weekly production",
    attribution: "Tour fixture",
    attributionUrl: null,
    fetchedAt: SOURCE_AT,
    checksumSha256: "2".repeat(64),
    coveredWeeks: [1, 2, 3, 4, 5],
    quality: { rowsRead: 1_184, rowsRejected: 0, rowsUnmatched: 0, matchRate: 1 },
    reason: null,
  },
  {
    dataset: "weekly-rosters",
    state: "available",
    key: "demo-weekly-rosters",
    name: "Illustrative participation history",
    attribution: "Tour fixture",
    attributionUrl: null,
    fetchedAt: SOURCE_AT,
    checksumSha256: "3".repeat(64),
    coveredWeeks: [1, 2, 3, 4, 5],
    quality: { rowsRead: 1_420, rowsRejected: 0, rowsUnmatched: 0, matchRate: 1 },
    reason: null,
  },
  {
    dataset: "projections",
    state: "available",
    key: "demo-projections",
    name: "Laces Out sample forecast",
    attribution: null,
    attributionUrl: null,
    fetchedAt: SOURCE_AT,
    checksumSha256: "4".repeat(64),
    coveredWeeks: [6],
    quality: { rowsRead: 218, rowsRejected: 0, rowsUnmatched: 0, matchRate: 1 },
    reason: null,
  },
] satisfies readonly ScheduleEdgeSource[];

const definitions = {
  matchup:
    "Position percentile compares league-scored, opponent-adjusted fantasy points allowed within a position. It remains separate from the player projection.",
  scheduleStrength:
    "Window percentile is the simple mean of available position percentiles in the selected weeks. Byes are counted but omitted from the average.",
  confidence:
    "Confidence describes the amount and completeness of supporting data, not certainty about a player's result.",
  byeFeasibility:
    "Bye pressure tests whether the stored roster can still fill every starter slot under the league's eligibility rules.",
};

export const demoScheduleEdgeResponse: ScheduleEdgeResponse = {
  generatedAt: GENERATED_AT,
  algorithm: {
    version: "schedule-edge-tour-v1",
    inputHash: HASH,
    evidenceChecksum: EVIDENCE_HASH,
    validationStatus: "descriptive-only",
  },
  league: {
    id: DEMO_LEAGUE_ID,
    leagueSeasonId: DEMO_SEASON_ID,
    name: "North Loop Auction",
    provider: "espn",
    season: 2026,
    currentWeek: 6,
    claimedTeam: { id: USER_TEAM_ID, name: "Budget Ballers" },
  },
  windows: {
    selected: { startWeek: 6, endWeek: 9, label: "Weeks 6–9", source: "current-week" },
    playoff: { startWeek: 15, endWeek: 17, label: "Weeks 15–17", source: "provider" },
  },
  availability: {
    schedule: { state: "available", reason: null },
    scoring: { state: "available", reason: null },
    matchups: { state: "available", reason: null },
    roster: { state: "available", reason: null },
    projections: { state: "available", reason: null },
    byeFeasibility: { state: "available", reason: null },
  },
  scoring: { profileKeyHash: PROFILE_HASH, warnings: [] },
  findings: [
    {
      id: "week-8-rb-gap",
      kind: "bye-gap",
      severity: "critical",
      title: "Week 8 leaves an RB slot open",
      detail:
        "Bijan Robinson and Breece Hall are both off, and this roster cannot fill both starting RB slots.",
      week: 8,
      playerId: null,
      href: "/decisions",
      factors: ["2 running backs on bye", "1 starting slot unfilled"],
    },
  ],
  roster,
  byeWeeks: [
    {
      week: 8,
      status: "gap",
      affectedPlayers: [
        {
          playerId: roster[1]!.playerId,
          name: roster[1]!.name,
          position: roster[1]!.primaryPosition,
          nflTeam: roster[1]!.nflTeam,
        },
        {
          playerId: roster[7]!.playerId,
          name: roster[7]!.name,
          position: roster[7]!.primaryPosition,
          nflTeam: roster[7]!.nflTeam,
        },
      ],
      fragilePlayerIds: [],
      unfilledSlotLabels: ["RB"],
      detail: "No legal complete lineup remains with both running backs unavailable.",
    },
    {
      week: 9,
      status: "thin",
      affectedPlayers: [
        {
          playerId: roster[6]!.playerId,
          name: roster[6]!.name,
          position: roster[6]!.primaryPosition,
          nflTeam: roster[6]!.nflTeam,
        },
      ],
      fragilePlayerIds: [roster[3]!.playerId],
      unfilledSlotLabels: [],
      detail: "A legal lineup remains, but one additional wide-receiver absence creates a gap.",
    },
    {
      week: 7,
      status: "covered",
      affectedPlayers: [
        {
          playerId: roster[5]!.playerId,
          name: roster[5]!.name,
          position: roster[5]!.primaryPosition,
          nflTeam: roster[5]!.nflTeam,
        },
      ],
      fragilePlayerIds: [],
      unfilledSlotLabels: [],
      detail: "The remaining roster can still fill every starting slot.",
    },
  ],
  sources,
  definitions,
};

const positions = ["QB", "RB", "WR", "TE"] as const;

export const demoScheduleEdgeMatrixResponse: ScheduleEdgeMatrixResponse = {
  generatedAt: GENERATED_AT,
  algorithm: {
    version: "schedule-edge-tour-v1",
    inputHash: HASH,
    evidenceChecksum: EVIDENCE_HASH,
    validationStatus: "descriptive-only",
  },
  league: {
    id: DEMO_LEAGUE_ID,
    leagueSeasonId: DEMO_SEASON_ID,
    name: "North Loop Auction",
    season: 2026,
  },
  windows: demoScheduleEdgeResponse.windows,
  availability: {
    schedule: { state: "available", reason: null },
    scoring: { state: "available", reason: null },
    matchups: { state: "available", reason: null },
  },
  scoring: { profileKeyHash: PROFILE_HASH, warnings: [] },
  teams: NFL_TEAM_CHOICES.map((team, teamIndex) => ({
    team,
    positions: positions.map((position, positionIndex) => {
      const selectedRank = teamIndex + 1;
      const playoffRank = 1 + ((teamIndex * 11 + positionIndex * 5) % 32);
      const selectedPercentile = Math.max(3, Math.round(97 - selectedRank * 2.8 - positionIndex));
      const playoffPercentile = Math.max(3, Math.round(97 - playoffRank * 2.8 - positionIndex));
      return {
        position,
        selectedWindow: strength(selectedPercentile, selectedRank, selectedWeeks, {
          opponentOffset: teamIndex + positionIndex,
        }),
        playoffWindow: strength(playoffPercentile, playoffRank, playoffWeeks, {
          opponentOffset: teamIndex + positionIndex + 3,
        }),
      };
    }),
  })),
  sources: sources.filter((source) => source.dataset !== "projections"),
  definitions,
};
