import type {
  InSeasonDecisionSnapshot,
  LeagueAnalyticsSnapshot,
  LeagueListResponse,
} from "@fantasy/contracts";

export const DEMO_LEAGUE_ID = "71000000-0000-4000-8000-000000000001";
export const DEMO_SEASON_ID = "71000000-0000-4000-8000-000000000002";
const USER_TEAM_ID = "71000000-0000-4000-8000-000000000010";
const OPPONENT_TEAM_ID = "71000000-0000-4000-8000-000000000011";
const THIRD_TEAM_ID = "71000000-0000-4000-8000-000000000012";
const FOURTH_TEAM_ID = "71000000-0000-4000-8000-000000000013";
const GENERATED_AT = "2026-10-08T18:42:00.000Z";
const SOURCE_AT = "2026-10-08T17:55:00.000Z";

export const demoLeaguePortfolio: LeagueListResponse = {
  generatedAt: GENERATED_AT,
  leagues: [
    {
      id: DEMO_LEAGUE_ID,
      name: "North Loop Auction",
      archived: false,
      membership: {
        role: "manager",
        claimedFantasyTeamId: USER_TEAM_ID,
        claimedTeamName: "Budget Ballers",
        claimedAt: "2026-08-20T14:00:00.000Z",
      },
      season: {
        id: DEMO_SEASON_ID,
        provider: "espn",
        season: 2026,
        status: "active",
        teamCount: 10,
        draftType: "auction",
        waiverType: "faab",
        currentWeek: 6,
        lastSyncedAt: GENERATED_AT,
        providerFreshness: { state: "fresh", observedAt: GENERATED_AT, label: "Demo · 8 min old" },
      },
    },
  ],
};

function decisionPlayer(
  id: number,
  name: string,
  position: "QB" | "RB" | "WR" | "TE" | "DST",
  nflTeam: "BAL" | "ATL" | "DET" | "GB" | "ARI" | "TB" | "LAC" | "CLE" | "NYJ" | "MIA",
  projectedPoints: number,
) {
  return {
    id: `72000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    name,
    positions: [position],
    nflTeam,
    status: "ACTIVE" as const,
    projectedPoints,
  };
}

const lamar = decisionPlayer(1, "Lamar Jackson", "QB", "BAL", 24.8);
const bijan = decisionPlayer(2, "Bijan Robinson", "RB", "ATL", 19.6);
const gibbs = decisionPlayer(3, "Jahmyr Gibbs", "RB", "DET", 18.9);
const reed = decisionPlayer(4, "Jayden Reed", "WR", "GB", 15.8);
const mcbride = decisionPlayer(5, "Trey McBride", "TE", "ARI", 14.1);
const evans = decisionPlayer(6, "Mike Evans", "WR", "TB", 12.2);
const johnston = decisionPlayer(7, "Quentin Johnston", "WR", "LAC", 13.7);
const browns = decisionPlayer(8, "Cleveland Browns", "DST", "CLE", 6.1);
const breece = decisionPlayer(9, "Breece Hall", "RB", "NYJ", 17.2);
const wright = decisionPlayer(10, "Jaylen Wright", "RB", "MIA", 11.4);

const execution = {
  mode: "provider-required" as const,
  provider: "espn" as const,
  label: "Verify and complete at ESPN",
  url: null,
};

const demoTrade = {
  id: "demo-trade-1",
  partner: { id: OPPONENT_TEAM_ID, name: "Gridiron Dept." },
  shape: "1-for-1" as const,
  send: [evans],
  receive: [gibbs],
  forcedDropsForUser: [],
  forcedDropsForPartner: [],
  userGain: 3.6,
  partnerGain: 2.4,
  totalGain: 6,
  fairnessGap: 1.2,
  mutuallyBeneficial: true,
};

const fairTrade = {
  id: "demo-trade-2",
  partner: { id: THIRD_TEAM_ID, name: "Sunday Scaries" },
  shape: "1-for-1" as const,
  send: [reed],
  receive: [breece],
  forcedDropsForUser: [],
  forcedDropsForPartner: [],
  userGain: 1.8,
  partnerGain: 1.5,
  totalGain: 3.3,
  fairnessGap: 0.3,
  mutuallyBeneficial: true,
};

export const demoDecisionSnapshot: InSeasonDecisionSnapshot = {
  generatedAt: GENERATED_AT,
  league: {
    id: DEMO_LEAGUE_ID,
    name: "North Loop Auction",
    season: 2026,
    week: 6,
    provider: "espn",
  },
  team: { id: USER_TEAM_ID, name: "Budget Ballers", faabRemaining: 67 },
  provenance: {
    algorithmVersion: "in-season-decisions-v1",
    // Sample data, so a sample digest: the tour must never look like a reproducible real run.
    inputChecksum: "d".repeat(64),
    leagueLastSyncedAt: GENERATED_AT,
    rosterEffectiveAt: GENERATED_AT,
    projectionSet: {
      id: "73000000-0000-4000-8000-000000000001",
      source: "Demo blended projections",
      version: "week-6-sample",
      horizon: "week",
      sourceObservedAt: SOURCE_AT,
      sourceObservedAtStatus: "verified",
      importedAt: "2026-10-08T18:02:00.000Z",
    },
    projectionFreshness: { state: "fresh", observedAt: SOURCE_AT, label: "Demo · 47 min old" },
  },
  providerVerification: {
    lockCoverage: "unavailable",
    storedTrueLocksHonored: true,
    storedFalseMeansUnlocked: false,
    storedLockedPlayerCount: 0,
    actionWarning:
      "Sample only. In live mode, verify locks and transactions at ESPN before making a move.",
  },
  coverage: {
    leagueTeams: 10,
    teamsWithRosters: 10,
    leagueRosteredPlayers: 158,
    claimedRosterPlayers: 16,
    claimedRosterProjected: 16,
    claimedRosterProjectionRatio: 1,
    projectionSetPlayers: 218,
    projectionQueryLimited: false,
  },
  lineup: {
    state: "available",
    metric: "mean",
    feasible: true,
    currentProjectedPoints: 111.8,
    optimalProjectedPoints: 115.4,
    projectedGain: 3.6,
    assignments: [
      { slotId: "QB", slotLabel: "QB", player: lamar, locked: false },
      { slotId: "RB1", slotLabel: "RB", player: bijan, locked: false },
      { slotId: "WR1", slotLabel: "WR", player: reed, locked: false },
      { slotId: "TE", slotLabel: "TE", player: mcbride, locked: false },
      { slotId: "FLEX", slotLabel: "FLEX", player: johnston, locked: false },
    ],
    changes: [
      {
        slotId: "FLEX",
        slotLabel: "FLEX",
        remove: evans,
        add: johnston,
        projectedPointDelta: 1.5,
      },
    ],
    execution,
    notes: ["Sample lineup uses mean projections and the displayed roster rules."],
  },
  waivers: {
    state: "available",
    candidateCount: 42,
    evaluatedMoveCount: 117,
    recommendations: [
      {
        add: wright,
        drop: browns,
        weightedGain: 3.2,
        lineupGain: 0,
        faab: { low: 5, recommended: 8, high: 11 },
        market: {
          addCount: 38,
          dropCount: 2,
          lookbackHours: 24,
          observedAt: "2026-09-30T15:00:00.000Z",
        },
        rationale: "Adds contingent running-back upside while removing a redundant second defense.",
      },
    ],
    execution,
    notes: ["FAAB is scaled to the sample team's remaining $67 budget."],
  },
  trades: {
    state: "available",
    evaluatedPackageCount: 186,
    eligibleOpponentCount: 9,
    bestForMe: [demoTrade],
    fairest: [fairTrade],
    execution,
    notes: ["Both rosters are re-optimized after the sample exchange."],
  },
};

const analyticsTeams = [
  {
    id: USER_TEAM_ID,
    name: "Budget Ballers",
    abbreviation: "BB",
    managerDisplayName: "You",
    logoUrl: null,
    isCurrentUser: true,
  },
  {
    id: OPPONENT_TEAM_ID,
    name: "Gridiron Dept.",
    abbreviation: "GRD",
    managerDisplayName: "M. Lewis",
    logoUrl: null,
    isCurrentUser: false,
  },
  {
    id: THIRD_TEAM_ID,
    name: "Sunday Scaries",
    abbreviation: "SUN",
    managerDisplayName: "A. Patel",
    logoUrl: null,
    isCurrentUser: false,
  },
  {
    id: FOURTH_TEAM_ID,
    name: "Waiver Theory",
    abbreviation: "WVT",
    managerDisplayName: "J. Kim",
    logoUrl: null,
    isCurrentUser: false,
  },
] as const;

const teamMetrics = [
  { wins: 4, losses: 1, points: 628.4, against: 579.1, allPlayWins: 13, power: 88.7 },
  { wins: 3, losses: 2, points: 601.2, against: 593.8, allPlayWins: 10, power: 78.3 },
  { wins: 3, losses: 2, points: 582.6, against: 566.2, allPlayWins: 9, power: 73.1 },
  { wins: 2, losses: 3, points: 552.8, against: 604.7, allPlayWins: 6, power: 61.4 },
] as const;

const positions = ["QB", "RB", "WR", "TE"] as const;
const positionalPercentiles = [
  [86, 92, 58, 75],
  [78, 64, 88, 44],
  [52, 81, 67, 61],
  [71, 38, 49, 89],
] as const;

export const demoAnalyticsSnapshot: LeagueAnalyticsSnapshot = {
  generatedAt: GENERATED_AT,
  league: {
    id: DEMO_LEAGUE_ID,
    name: "North Loop Auction",
    season: 2026,
    currentWeek: 6,
    provider: "espn",
  },
  membership: {
    role: "manager",
    claimedTeamId: USER_TEAM_ID,
    claimedTeamName: "Budget Ballers",
  },
  provenance: {
    leagueLastSyncedAt: GENERATED_AT,
    latestMatchupObservedAt: GENERATED_AT,
    matchupFreshness: { state: "fresh", observedAt: GENERATED_AT, label: "Demo · 8 min old" },
    matchupObservationsRead: 30,
    deduplicatedMatchups: 15,
    projectionSet: {
      id: "73000000-0000-4000-8000-000000000001",
      source: "demo",
      version: "week-6-sample",
      sourceLabel: "Demo blended projections",
      visibility: "private",
      creatorDisplayName: "Sample member",
      season: 2026,
      week: 6,
      horizon: "week",
      sourceObservedAt: SOURCE_AT,
      sourceObservedAtStatus: "verified",
      importedAt: "2026-10-08T18:02:00.000Z",
    },
    projectionFreshness: { state: "fresh", observedAt: SOURCE_AT, label: "Demo · 47 min old" },
  },
  coverage: {
    leagueTeams: 10,
    teamsWithLatestRoster: 10,
    rosterPlayers: 158,
    rosterPlayersProjected: 158,
    officialScoreWeeks: 5,
  },
  scores: {
    state: "available",
    weeks: [1, 2, 3, 4, 5],
    officialFinalMatchups: 15,
    incompleteFinalMatchups: 0,
    teams: analyticsTeams.map((team, index) => {
      const metric = teamMetrics[index]!;
      return {
        team,
        scoringWeeks: 5,
        missingScoringWeeks: [],
        completedMatchups: 5,
        incompleteMatchups: 0,
        pointsFor: { total: metric.points, average: metric.points / 5, sampleSize: 5 },
        pointsAgainst: { total: metric.against, average: metric.against / 5, sampleSize: 5 },
        actualRecord: {
          wins: metric.wins,
          losses: metric.losses,
          ties: 0,
          games: 5,
          winPercentage: metric.wins / 5,
        },
        allPlay: {
          wins: metric.allPlayWins,
          losses: 15 - metric.allPlayWins,
          ties: 0,
          games: 15,
          winPercentage: metric.allPlayWins / 15,
        },
        expectedWins: metric.allPlayWins / 3,
        actualWinEquivalents: metric.wins,
        luckWins: metric.wins - metric.allPlayWins / 3,
        eligibleExpectedMatchups: 15,
      };
    }),
    definitions: [
      {
        id: "luck",
        label: "Luck wins",
        definition: "Actual wins minus schedule-neutral expected wins from all-play results.",
      },
    ],
    warnings: ["Tour data is illustrative and never mixed with a connected league."],
  },
  power: {
    state: "available",
    factors: [
      {
        id: "points",
        label: "Scoring",
        definition: "Points per week relative to the sample league.",
        configuredWeight: 0.55,
      },
      {
        id: "roster",
        label: "Roster strength",
        definition: "Projection-backed starter strength.",
        configuredWeight: 0.45,
      },
    ],
    rankings: analyticsTeams.map((team, index) => ({
      team,
      rank: index + 1,
      score: teamMetrics[index]!.power,
      tiedOnScore: false,
      dataCoverage: 1,
      contributions: [],
    })),
    definition: "A sample weighted composite of scoring results and projected roster strength.",
    tieBreaker: "Sample ties break on score precision, then team name.",
  },
  positional: {
    state: "available",
    basis: {
      id: "weekly-dedicated-starters",
      label: "Dedicated starters",
      definition: "Percentiles compare projected points from each roster's dedicated starters.",
      starterCounts: { QB: 1, RB: 2, WR: 2, TE: 1 },
    },
    positions: [...positions],
    teams: analyticsTeams.map((team, teamIndex) => ({
      team,
      averagePercentile:
        positionalPercentiles[teamIndex]!.reduce((sum, value) => sum + value, 0) / 4,
      coverage: 1,
      strengths: positions.filter((_, index) => positionalPercentiles[teamIndex]![index]! >= 67),
      weaknesses: positions.filter((_, index) => positionalPercentiles[teamIndex]![index]! <= 40),
      entries: positions.map((position, positionIndex) => ({
        position,
        status: "available" as const,
        projectedPoints: 20 - positionIndex * 2 + teamIndex,
        leagueMean: 18,
        strengthPercentile: positionalPercentiles[teamIndex]![positionIndex]!,
        strengthZScore: (positionalPercentiles[teamIndex]![positionIndex]! - 50) / 20,
        rank:
          [...positionalPercentiles]
            .map((values) => values[positionIndex]!)
            .sort((left, right) => right - left)
            .indexOf(positionalPercentiles[teamIndex]![positionIndex]!) + 1,
        starterCount: position === "RB" || position === "WR" ? 2 : 1,
        rosterPlayerCount: position === "RB" || position === "WR" ? 4 : 2,
        projectedPlayerCount: position === "RB" || position === "WR" ? 4 : 2,
      })),
    })),
    definition: "Sample percentiles use the displayed week-six projection set.",
  },
  opponentScout: {
    state: "available",
    week: 6,
    matchupStatus: "scheduled",
    subject: analyticsTeams[0],
    opponent: analyticsTeams[1],
    metrics: [
      {
        id: "projected-starters",
        label: "Projected starters",
        definition: "Sum of sample optimal-starter projections.",
        unit: "pts",
        subjectValue: 115.4,
        opponentValue: 111.2,
        leagueAverage: 109.8,
        subjectAdvantage: 4.2,
        edgeOwner: "subject",
      },
      {
        id: "season-average",
        label: "Season average",
        definition: "Official sample points per scoring week.",
        unit: "pts",
        subjectValue: 125.7,
        opponentValue: 120.2,
        leagueAverage: 116.4,
        subjectAdvantage: 5.5,
        edgeOwner: "subject",
      },
      {
        id: "power-score",
        label: "Power score",
        definition: "Availability-weighted composite on a 0–100 scale.",
        unit: null,
        subjectValue: 88.7,
        opponentValue: 78.3,
        leagueAverage: 75.4,
        subjectAdvantage: 10.4,
        edgeOwner: "subject",
      },
    ],
    subjectAdvantages: ["QB", "RB", "projection coverage"],
    opponentAdvantages: ["WR depth"],
    definition: "Tour matchup metrics use illustrative league and projection snapshots.",
  },
  weeklyAwards: {
    state: "available",
    week: 5,
    awards: [
      {
        id: "bad-beat",
        label: "Bad Beat of the Week",
        definition:
          "Highest all-play win rate among teams that lost their head-to-head matchup this week.",
        team: analyticsTeams[0],
        value: 0.778,
        unit: "percent",
        detail: {
          opponentTeam: analyticsTeams[1],
          teamPoints: 128.4,
          opponentPoints: 131.2,
          allPlayWins: 7,
          allPlayGames: 9,
        },
      },
      {
        id: "horseshoe",
        label: "The Horseshoe",
        definition:
          "Lowest all-play win rate among teams that won their head-to-head matchup this week.",
        team: analyticsTeams[2],
        value: 0.444,
        unit: "percent",
        detail: {
          opponentTeam: analyticsTeams[3],
          teamPoints: 107.9,
          opponentPoints: 71.6,
          allPlayWins: 4,
          allPlayGames: 9,
        },
      },
      {
        id: "beatdown",
        label: "Beatdown of the Week",
        definition: "Largest margin of victory in a completed matchup this week.",
        team: analyticsTeams[2],
        value: 36.3,
        unit: "points",
        detail: {
          opponentTeam: analyticsTeams[3],
          teamPoints: 107.9,
          opponentPoints: 71.6,
          allPlayWins: null,
          allPlayGames: null,
        },
      },
      {
        id: "photo-finish",
        label: "Photo Finish",
        definition:
          "Smallest non-tie margin in a completed matchup, when it lands inside 3 points.",
        team: analyticsTeams[1],
        value: 2.8,
        unit: "points",
        detail: {
          opponentTeam: analyticsTeams[0],
          teamPoints: 131.2,
          opponentPoints: 128.4,
          allPlayWins: null,
          allPlayGames: null,
        },
      },
    ],
    withheld: [
      {
        id: "bench-warmer",
        label: "Bench Warmer",
        reasons: [
          {
            code: "LINEUP_POINTS_MISSING",
            message:
              "Optimal starter points are not stored for this week, so points left on the bench cannot be measured.",
          },
        ],
      },
    ],
    definitions: [
      {
        id: "weekly-awards",
        label: "The Weekly Reckoning",
        definition:
          "Awards read the same admitted final scores as the season ledger. An award the evidence does not support is withheld with its reason rather than shown as a zero.",
      },
    ],
  },
  playoffOdds: {
    state: "available",
    playoffTeamCount: 2,
    seed: `playoff-odds:v1:${DEMO_SEASON_ID}:week-6:snapshot-71000000-0000-4000-8000-000000000031`,
    simulations: 20_000,
    matchupSnapshotId: "71000000-0000-4000-8000-000000000031",
    remainingMatchups: 18,
    forecastBasis: {
      id: "playoff-odds-forecast-basis",
      label: "Future weekly scoring",
      definition:
        "Each team's future weekly mean and volatility come from its own completed scores this season. No projection set is mixed in, so a sample league and a synced league are read the same way.",
    },
    teams: [
      {
        team: analyticsTeams[0],
        playoffProbability: 0.71,
        monteCarloStandardError: 0.0032,
        expectedSeed: 1.96,
        seedProbabilities: [
          { seed: 1, probability: 0.44 },
          { seed: 2, probability: 0.27 },
          { seed: 3, probability: 0.18 },
          { seed: 4, probability: 0.11 },
        ],
        averageFinalWins: 9.2,
        averageFinalLosses: 4.8,
        averageFinalTies: 0,
        averageFinalPointsFor: 1759.7,
        scoringMean: 125.7,
        scoringStandardDeviation: 26.4,
      },
      {
        team: analyticsTeams[1],
        playoffProbability: 0.54,
        monteCarloStandardError: 0.0035,
        expectedSeed: 2.41,
        seedProbabilities: [
          { seed: 1, probability: 0.25 },
          { seed: 2, probability: 0.29 },
          { seed: 3, probability: 0.26 },
          { seed: 4, probability: 0.2 },
        ],
        averageFinalWins: 7.6,
        averageFinalLosses: 6.4,
        averageFinalTies: 0,
        averageFinalPointsFor: 1683,
        scoringMean: 120.2,
        scoringStandardDeviation: 24.9,
      },
      {
        team: analyticsTeams[2],
        playoffProbability: 0.46,
        monteCarloStandardError: 0.0035,
        expectedSeed: 2.6,
        seedProbabilities: [
          { seed: 1, probability: 0.19 },
          { seed: 2, probability: 0.27 },
          { seed: 3, probability: 0.29 },
          { seed: 4, probability: 0.25 },
        ],
        averageFinalWins: 7.3,
        averageFinalLosses: 6.7,
        averageFinalTies: 0,
        averageFinalPointsFor: 1648.2,
        scoringMean: 118.4,
        scoringStandardDeviation: 25.7,
      },
      {
        team: analyticsTeams[3],
        playoffProbability: 0.29,
        monteCarloStandardError: 0.0032,
        expectedSeed: 3.03,
        seedProbabilities: [
          { seed: 1, probability: 0.12 },
          { seed: 2, probability: 0.17 },
          { seed: 3, probability: 0.27 },
          { seed: 4, probability: 0.44 },
        ],
        averageFinalWins: 5.9,
        averageFinalLosses: 8.1,
        averageFinalTies: 0,
        averageFinalPointsFor: 1595.1,
        scoringMean: 114.8,
        scoringStandardDeviation: 23.6,
      },
    ],
    definition:
      "Playoff odds simulate every remaining matchup from each team's own scoring history and count how often it finishes inside the playoff field. The seed and simulation count are shown so the same stored state replays the same numbers.",
    factors: [
      "Current record and points for",
      "Each team's own weekly scoring mean and volatility",
      "The exact remaining schedule from the admitted matchup snapshot",
      "League playoff field size",
    ],
    tieBreakers: ["Head-to-head record", "Total points for"],
    samplingErrorDefinition:
      "Standard error describes how much this probability would move if the simulation were re-run with a different seed. It does not describe how likely the forecast is to be right.",
  },
};
