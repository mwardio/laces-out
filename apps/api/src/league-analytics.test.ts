import { leagueAnalyticsSnapshotSchema } from "@laces-out/contracts";
import { describe, expect, it } from "vitest";

import {
  LeagueAnalyticsService,
  deduplicateMatchupObservations,
  selectAccessibleProjectionSet,
  type AnalyticsMatchupObservationRow,
  type AnalyticsMembershipRow,
  type AnalyticsProjectionRow,
  type AnalyticsProjectionSetRow,
  type AnalyticsRosterEntryRow,
  type AnalyticsRosterSnapshotRow,
  type AnalyticsSeasonRow,
  type AnalyticsSlotRuleRow,
  type AnalyticsTeamRow,
  type LeagueAnalyticsRepository,
} from "./league-analytics.js";
import type { ManagedProjectionProfile } from "./managed-projection-profile.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "10000000-0000-4000-8000-000000000002";
const LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const SEASON_ID = "30000000-0000-4000-8000-000000000001";
const TEAM_A = "40000000-0000-4000-8000-000000000001";
const TEAM_B = "40000000-0000-4000-8000-000000000002";
const TEAM_C = "40000000-0000-4000-8000-000000000003";
const TEAM_D = "40000000-0000-4000-8000-000000000004";
const SNAPSHOT_A = "50000000-0000-4000-8000-000000000001";
const SNAPSHOT_B = "50000000-0000-4000-8000-000000000002";
const PLAYER_A = "60000000-0000-4000-8000-000000000001";
const PLAYER_B = "60000000-0000-4000-8000-000000000002";
const PROJECTION_PRIVATE = "70000000-0000-4000-8000-000000000001";
const PROJECTION_LEAGUE = "70000000-0000-4000-8000-000000000002";
const PROJECTION_OTHER = "70000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-09-16T12:00:00.000Z");

const membership: AnalyticsMembershipRow = {
  leagueId: LEAGUE_ID,
  leagueName: "Laces Out League",
  role: "member",
  claimedFantasyTeamId: TEAM_A,
  claimedTeamName: "The Isotoners",
};

const season: AnalyticsSeasonRow = {
  id: SEASON_ID,
  provider: "espn",
  season: 2026,
  currentWeek: 2,
  settings: { teamCount: 4, playoffTeamCount: 2 },
  lastSyncedAt: new Date("2026-09-16T11:55:00.000Z"),
};

const teams: readonly AnalyticsTeamRow[] = [
  {
    id: TEAM_A,
    name: "The Isotoners",
    abbreviation: "ISO",
    logoUrl: null,
    managerDisplayName: "Ace",
  },
  {
    id: TEAM_B,
    name: "Snowflake",
    abbreviation: "SNW",
    logoUrl: null,
    managerDisplayName: "Ray",
  },
];

function observation(input: {
  matchupId: string;
  snapshotId: string;
  effectiveAt: string;
  week: number;
  providerMatchupId: string;
  status?: "scheduled" | "in-progress" | "final";
  homeTeamId?: string;
  awayTeamId?: string;
  homeScore: string | null;
  awayScore: string | null;
}): AnalyticsMatchupObservationRow {
  return {
    matchupId: input.matchupId,
    snapshotId: input.snapshotId,
    effectiveAt: new Date(input.effectiveAt),
    externalKey: `${input.week}:${input.providerMatchupId}`,
    providerMatchupId: input.providerMatchupId,
    week: input.week,
    status: input.status ?? "final",
    homeTeamId: input.homeTeamId ?? TEAM_A,
    awayTeamId: input.awayTeamId ?? TEAM_B,
    homeScore: input.homeScore,
    awayScore: input.awayScore,
  };
}

const observations: readonly AnalyticsMatchupObservationRow[] = [
  observation({
    matchupId: "80000000-0000-4000-8000-000000000001",
    snapshotId: "81000000-0000-4000-8000-000000000001",
    effectiveAt: "2026-09-08T12:00:00.000Z",
    week: 1,
    providerMatchupId: "week-1-game-1",
    homeScore: "90",
    awayScore: "80",
  }),
  observation({
    matchupId: "80000000-0000-4000-8000-000000000002",
    snapshotId: "81000000-0000-4000-8000-000000000002",
    effectiveAt: "2026-09-09T12:00:00.000Z",
    week: 1,
    providerMatchupId: "week-1-game-1",
    homeScore: "100",
    awayScore: null,
  }),
  observation({
    matchupId: "80000000-0000-4000-8000-000000000003",
    snapshotId: "81000000-0000-4000-8000-000000000003",
    effectiveAt: "2026-09-16T10:00:00.000Z",
    week: 2,
    providerMatchupId: "week-2-game-1",
    homeScore: "90",
    awayScore: "110",
  }),
];

const playoffTeams: readonly AnalyticsTeamRow[] = [
  ...teams,
  {
    id: TEAM_C,
    name: "Cleat Chasers",
    abbreviation: "CLT",
    logoUrl: null,
    managerDisplayName: "Nia",
  },
  {
    id: TEAM_D,
    name: "Dune Runners",
    abbreviation: "DUN",
    logoUrl: null,
    managerDisplayName: "Otto",
  },
];

/**
 * Four teams, all 1–1, with two unplayed Week 3 games. Every team can still miss or make a
 * two-team field, so no probability is pinned at 0 or 1 by the fixture itself.
 */
function playoffSchedule(week3: {
  readonly snapshotId: string;
  readonly effectiveAt: string;
  readonly matchupIds: readonly [string, string];
}): readonly AnalyticsMatchupObservationRow[] {
  return [
    observation({
      matchupId: "90000000-0000-4000-8000-000000000001",
      snapshotId: "82000000-0000-4000-8000-000000000001",
      effectiveAt: "2026-09-08T12:00:00.000Z",
      week: 1,
      providerMatchupId: "week-1-game-1",
      homeTeamId: TEAM_A,
      awayTeamId: TEAM_B,
      homeScore: "110",
      awayScore: "100",
    }),
    observation({
      matchupId: "90000000-0000-4000-8000-000000000002",
      snapshotId: "82000000-0000-4000-8000-000000000001",
      effectiveAt: "2026-09-08T12:00:00.000Z",
      week: 1,
      providerMatchupId: "week-1-game-2",
      homeTeamId: TEAM_C,
      awayTeamId: TEAM_D,
      homeScore: "120",
      awayScore: "90",
    }),
    observation({
      matchupId: "90000000-0000-4000-8000-000000000003",
      snapshotId: "82000000-0000-4000-8000-000000000002",
      effectiveAt: "2026-09-15T12:00:00.000Z",
      week: 2,
      providerMatchupId: "week-2-game-1",
      homeTeamId: TEAM_B,
      awayTeamId: TEAM_A,
      homeScore: "115",
      awayScore: "95",
    }),
    observation({
      matchupId: "90000000-0000-4000-8000-000000000004",
      snapshotId: "82000000-0000-4000-8000-000000000002",
      effectiveAt: "2026-09-15T12:00:00.000Z",
      week: 2,
      providerMatchupId: "week-2-game-2",
      homeTeamId: TEAM_D,
      awayTeamId: TEAM_C,
      homeScore: "130",
      awayScore: "105",
    }),
    observation({
      matchupId: week3.matchupIds[0],
      snapshotId: week3.snapshotId,
      effectiveAt: week3.effectiveAt,
      week: 3,
      providerMatchupId: "week-3-game-1",
      status: "scheduled",
      homeTeamId: TEAM_A,
      awayTeamId: TEAM_C,
      homeScore: null,
      awayScore: null,
    }),
    observation({
      matchupId: week3.matchupIds[1],
      snapshotId: week3.snapshotId,
      effectiveAt: week3.effectiveAt,
      week: 3,
      providerMatchupId: "week-3-game-2",
      status: "scheduled",
      homeTeamId: TEAM_B,
      awayTeamId: TEAM_D,
      homeScore: null,
      awayScore: null,
    }),
  ];
}

const withRemainingSchedule = playoffSchedule({
  snapshotId: "82000000-0000-4000-8000-000000000003",
  effectiveAt: "2026-09-16T09:00:00.000Z",
  matchupIds: ["90000000-0000-4000-8000-000000000005", "90000000-0000-4000-8000-000000000006"],
});

/** Identical facts re-observed under a newer snapshot; only the snapshot identity moved. */
const resyncedSchedule = playoffSchedule({
  snapshotId: "82000000-0000-4000-8000-000000000004",
  effectiveAt: "2026-09-16T10:00:00.000Z",
  matchupIds: ["90000000-0000-4000-8000-000000000007", "90000000-0000-4000-8000-000000000008"],
});

/** Week 3 never scheduled, so the stored season has nothing left to simulate. */
const completedSchedule = withRemainingSchedule.filter((row) => row.week !== 3);

const slotRules: readonly AnalyticsSlotRuleRow[] = [
  { slotCode: "QB", count: 1, eligiblePositions: ["QB"], isStarter: true },
  { slotCode: "FLEX", count: 1, eligiblePositions: ["RB", "WR", "TE"], isStarter: true },
  { slotCode: "BN", count: 5, eligiblePositions: ["QB", "RB", "WR", "TE"], isStarter: false },
];

const rosterSnapshots: readonly AnalyticsRosterSnapshotRow[] = [
  { id: SNAPSHOT_A, teamId: TEAM_A, effectiveAt: NOW },
  { id: SNAPSHOT_B, teamId: TEAM_B, effectiveAt: NOW },
];

const rosterEntries: readonly AnalyticsRosterEntryRow[] = [
  { snapshotId: SNAPSHOT_A, playerId: PLAYER_A, primaryPosition: "QB" },
  { snapshotId: SNAPSHOT_B, playerId: PLAYER_B, primaryPosition: "QB" },
];

function projectionSet(input: {
  id: string;
  creator: string | null;
  visibility: "private" | "league";
  fetchedAt: string;
}): AnalyticsProjectionSetRow {
  return {
    id: input.id,
    leagueSeasonId: SEASON_ID,
    createdByUserId: input.creator,
    creatorDisplayName:
      input.creator === USER_ID
        ? "League Guru"
        : input.creator === null
          ? "Laces Out model"
          : "Other Manager",
    visibility: input.visibility,
    source: "user-csv",
    version: `v-${input.id}`,
    season: 2026,
    week: 2,
    horizon: "week",
    fetchedAt: new Date(input.fetchedAt),
    createdAt: new Date(input.fetchedAt),
    metadata: { sourceLabel: "Week 2 model" },
  };
}

const projectionCandidates: readonly AnalyticsProjectionSetRow[] = [
  projectionSet({
    id: "50000000-0000-4000-8000-000000000099",
    creator: null,
    visibility: "league",
    fetchedAt: "2026-09-16T12:00:00.000Z",
  }),
  projectionSet({
    id: PROJECTION_OTHER,
    creator: OTHER_USER_ID,
    visibility: "private",
    fetchedAt: "2026-09-16T11:30:00.000Z",
  }),
  projectionSet({
    id: PROJECTION_PRIVATE,
    creator: USER_ID,
    visibility: "private",
    fetchedAt: "2026-09-16T11:00:00.000Z",
  }),
  projectionSet({
    id: PROJECTION_LEAGUE,
    creator: OTHER_USER_ID,
    visibility: "league",
    fetchedAt: "2026-09-16T10:30:00.000Z",
  }),
];

const projectionRows: readonly AnalyticsProjectionRow[] = [
  { playerId: PLAYER_A, meanPoints: "24" },
  { playerId: PLAYER_B, meanPoints: "18" },
];

class FakeRepository implements LeagueAnalyticsRepository {
  membership: AnalyticsMembershipRow | undefined = membership;
  season: AnalyticsSeasonRow | undefined = season;
  teams: readonly AnalyticsTeamRow[] = teams;
  observations: readonly AnalyticsMatchupObservationRow[] = observations;
  projectionCandidates: readonly AnalyticsProjectionSetRow[] = projectionCandidates;
  projectionRows: readonly AnalyticsProjectionRow[] = projectionRows;
  downstreamReads = 0;

  findMembership(userId: string, leagueId: string) {
    return Promise.resolve(
      userId === USER_ID && leagueId === LEAGUE_ID ? this.membership : undefined,
    );
  }
  findLatestSeason() {
    this.downstreamReads += 1;
    return Promise.resolve(this.season);
  }
  listTeams(_leagueSeasonId: string, limit: number) {
    this.downstreamReads += 1;
    return Promise.resolve(this.teams.slice(0, limit));
  }
  listMatchupObservations(_leagueSeasonId: string, limit: number) {
    this.downstreamReads += 1;
    return Promise.resolve(this.observations.slice(0, limit));
  }
  listSlotRules(_leagueSeasonId: string, limit: number) {
    this.downstreamReads += 1;
    return Promise.resolve(slotRules.slice(0, limit));
  }
  listLatestRosterSnapshots(_leagueSeasonId: string, limit: number) {
    this.downstreamReads += 1;
    return Promise.resolve(rosterSnapshots.slice(0, limit));
  }
  listRosterEntries(snapshotIds: readonly string[], limit: number) {
    this.downstreamReads += 1;
    return Promise.resolve(
      rosterEntries.filter((row) => snapshotIds.includes(row.snapshotId)).slice(0, limit),
    );
  }
  listProjectionSetCandidates(
    _actorUserId: string,
    _leagueSeasonId: string,
    _season: number,
    _week: number,
    limit: number,
  ) {
    this.downstreamReads += 1;
    return Promise.resolve(this.projectionCandidates.slice(0, limit));
  }
  listProjectionRows(_projectionSetId: string, playerIds: readonly string[], limit: number) {
    this.downstreamReads += 1;
    return Promise.resolve(
      this.projectionRows.filter((row) => playerIds.includes(row.playerId)).slice(0, limit),
    );
  }
  findManagedProjectionProfile?: (leagueSeasonId: string) => Promise<ManagedProjectionProfile>;
}

describe("league analytics data preparation", () => {
  it("deduplicates matchup snapshots to the deterministic latest observation", () => {
    const reversed = deduplicateMatchupObservations([...observations].reverse());
    const ordered = deduplicateMatchupObservations(observations);

    expect(reversed).toEqual(ordered);
    expect(ordered).toHaveLength(2);
    expect(ordered[0]).toMatchObject({ week: 1, homeScore: "100", awayScore: null });
  });

  it("selects the newest actor-private or league-shared exact set without leaking another private set", () => {
    expect(
      selectAccessibleProjectionSet(projectionCandidates, USER_ID, SEASON_ID, 2026, 2)?.id,
    ).toBe(PROJECTION_PRIVATE);
    expect(
      selectAccessibleProjectionSet(
        projectionCandidates,
        "10000000-0000-4000-8000-000000000099",
        SEASON_ID,
        2026,
        2,
      )?.id,
    ).toBe(PROJECTION_LEAGUE);
  });
});

describe("LeagueAnalyticsService", () => {
  it("serializes internal ownership as commissioner access", async () => {
    const repository = new FakeRepository();
    repository.membership = { ...membership, role: "owner" };
    const service = new LeagueAnalyticsService(repository, () => NOW);

    const snapshot = leagueAnalyticsSnapshotSchema.parse(
      await service.getSnapshot(USER_ID, LEAGUE_ID),
    );

    expect(snapshot.membership.role).toBe("commissioner");
    expect(JSON.stringify(snapshot)).not.toMatch(/\b(owner|manager|viewer)\b/u);
  });

  it("isolates every downstream read behind authenticated league membership", async () => {
    const repository = new FakeRepository();
    const service = new LeagueAnalyticsService(repository, () => NOW);

    await expect(service.getSnapshot(OTHER_USER_ID, LEAGUE_ID)).resolves.toBeUndefined();
    expect(repository.downstreamReads).toBe(0);
  });

  it("builds official scores, transparent power, positional strengths, and an opponent scout", async () => {
    const service = new LeagueAnalyticsService(new FakeRepository(), () => NOW);
    const snapshot = await service.getSnapshot(USER_ID, LEAGUE_ID);
    const parsed = leagueAnalyticsSnapshotSchema.parse(snapshot);

    expect(parsed.provenance).toMatchObject({
      matchupObservationsRead: 3,
      deduplicatedMatchups: 2,
      projectionSet: {
        id: PROJECTION_PRIVATE,
        visibility: "private",
        sourceObservedAt: null,
        sourceObservedAtStatus: "unverified",
        importedAt: "2026-09-16T11:00:00.000Z",
      },
      projectionFreshness: {
        state: "missing",
        observedAt: null,
        label: "Projection source time missing / unverified",
      },
    });
    expect(parsed.scores.state).toBe("available");
    if (parsed.scores.state === "available") {
      const teamA = parsed.scores.teams.find((team) => team.team.id === TEAM_A);
      const teamB = parsed.scores.teams.find((team) => team.team.id === TEAM_B);
      // Week 1's missing away score creates no inferred win/loss; only Week 2 counts.
      expect(teamA?.actualRecord).toMatchObject({ wins: 0, losses: 1, games: 1 });
      expect(teamB?.actualRecord).toMatchObject({ wins: 1, losses: 0, games: 1 });
      expect(teamA?.pointsFor).toMatchObject({ total: 190, sampleSize: 2 });
      expect(teamB?.pointsFor).toMatchObject({ total: 110, sampleSize: 1 });
      expect(parsed.scores.incompleteFinalMatchups).toBe(1);
    }
    expect(parsed.positional.state).toBe("available");
    if (parsed.positional.state === "available") {
      expect(parsed.positional.positions).toEqual(["QB"]);
      expect(parsed.positional.basis.starterCounts).toEqual({ QB: 1 });
      expect(
        parsed.positional.teams.find((team) => team.team.id === TEAM_A)?.entries[0],
      ).toMatchObject({ projectedPoints: 24, rank: 1, strengthPercentile: 100 });
    }
    expect(parsed.power.state).toBe("available");
    expect(parsed.opponentScout).toMatchObject({
      state: "available",
      week: 2,
      subject: { id: TEAM_A },
      opponent: { id: TEAM_B },
    });
  });

  it("keeps official-score and score-only power analytics available without projections", async () => {
    const repository = new FakeRepository();
    repository.projectionCandidates = [];
    const snapshot = await new LeagueAnalyticsService(repository, () => NOW).getSnapshot(
      USER_ID,
      LEAGUE_ID,
    );

    expect(snapshot?.scores.state).toBe("available");
    expect(snapshot?.positional).toMatchObject({
      state: "unavailable",
      reasons: [{ code: "PROJECTIONS_MISSING" }],
    });
    expect(snapshot?.power.state).toBe("available");
    if (snapshot?.power.state === "available") {
      expect(snapshot.power.factors.map((factor) => factor.id)).toEqual([
        "actual-win-percentage",
        "all-play-win-percentage",
        "points-for-per-week",
      ]);
    }
  });

  it("explains a missing positional projection set when managed weekly scoring is unsupported", async () => {
    const repository = new FakeRepository();
    repository.projectionCandidates = [];
    repository.findManagedProjectionProfile = () => Promise.resolve({ key: null, positions: [] });
    const snapshot = await new LeagueAnalyticsService(repository, () => NOW).getSnapshot(
      USER_ID,
      LEAGUE_ID,
    );

    expect(snapshot?.positional.state).toBe("unavailable");
    if (snapshot?.positional.state === "unavailable") {
      expect(snapshot.positional.reasons[0]?.message).toContain(
        "managed weekly projections are withheld",
      );
    }
  });

  it("awards only the weeks the admitted scores cover and withholds the rest with reasons", async () => {
    const service = new LeagueAnalyticsService(new FakeRepository(), () => NOW);
    const snapshot = await service.getSnapshot(USER_ID, LEAGUE_ID);
    const awards = leagueAnalyticsSnapshotSchema.parse(snapshot).weeklyAwards;

    expect(awards.state).toBe("available");
    if (awards.state !== "available") return;

    // Week 1's latest observation is missing an away score, so week 2 is the only awardable week.
    expect(awards.week).toBe(2);
    expect(awards.awards.map((award) => award.id).sort()).toEqual([
      "bad-beat",
      "beatdown",
      "horseshoe",
    ]);

    const beatdown = awards.awards.find((award) => award.id === "beatdown");
    expect(beatdown).toMatchObject({ value: 20, unit: "points" });
    expect(beatdown?.detail).toMatchObject({ teamPoints: 110, opponentPoints: 90 });

    // The two awards the stored evidence cannot support are named with their reason, never zeroed.
    expect(
      awards.withheld.map((entry) => ({ id: entry.id, code: entry.reasons[0]?.code })),
    ).toEqual([
      { id: "bench-warmer", code: "LINEUP_POINTS_MISSING" },
      { id: "photo-finish", code: "NO_QUALIFYING_TEAM" },
    ]);
  });

  it("publishes an empty awardable week list when no week can be awarded", async () => {
    const repository = new FakeRepository();
    repository.observations = [];
    const snapshot = await new LeagueAnalyticsService(repository, () => NOW).getSnapshot(
      USER_ID,
      LEAGUE_ID,
    );

    expect(leagueAnalyticsSnapshotSchema.parse(snapshot).weeklyAwardWeeks).toEqual([]);
  });
});

/**
 * Weeks 1-3 are final; week 4 is scheduled with one missing score. A recap can be written for any
 * final week, so the snapshot has to name all three and refuse the fourth by name.
 */
const historicalObservations: readonly AnalyticsMatchupObservationRow[] = [
  observation({
    matchupId: "83000000-0000-4000-8000-000000000001",
    snapshotId: "84000000-0000-4000-8000-000000000001",
    effectiveAt: "2026-09-08T12:00:00.000Z",
    week: 1,
    providerMatchupId: "week-1-game-1",
    homeScore: "120",
    awayScore: "100",
  }),
  observation({
    matchupId: "83000000-0000-4000-8000-000000000002",
    snapshotId: "84000000-0000-4000-8000-000000000002",
    effectiveAt: "2026-09-15T12:00:00.000Z",
    week: 2,
    providerMatchupId: "week-2-game-1",
    homeScore: "90",
    awayScore: "110",
  }),
  observation({
    matchupId: "83000000-0000-4000-8000-000000000003",
    snapshotId: "84000000-0000-4000-8000-000000000003",
    effectiveAt: "2026-09-22T12:00:00.000Z",
    week: 3,
    providerMatchupId: "week-3-game-1",
    homeScore: "105",
    awayScore: "97",
  }),
  observation({
    matchupId: "83000000-0000-4000-8000-000000000004",
    snapshotId: "84000000-0000-4000-8000-000000000004",
    effectiveAt: "2026-09-29T12:00:00.000Z",
    week: 4,
    providerMatchupId: "week-4-game-1",
    status: "in-progress",
    homeScore: "40",
    awayScore: null,
  }),
];

async function historicalSnapshot(weeklyAwardsWeek?: number) {
  const repository = new FakeRepository();
  repository.observations = historicalObservations;
  const snapshot = await new LeagueAnalyticsService(repository, () => NOW).getSnapshot(
    USER_ID,
    LEAGUE_ID,
    ...(weeklyAwardsWeek === undefined ? [] : [{ weeklyAwardsWeek }]),
  );
  return leagueAnalyticsSnapshotSchema.parse(snapshot);
}

describe("LeagueAnalyticsService historical weekly awards", () => {
  it("lists every awardable week in ascending order", async () => {
    const parsed = await historicalSnapshot();

    expect(parsed.weeklyAwardWeeks).toEqual([1, 2, 3]);
  });

  it("still defaults to the latest awardable week", async () => {
    const parsed = await historicalSnapshot();

    expect(parsed.weeklyAwards.state).toBe("available");
    if (parsed.weeklyAwards.state !== "available") return;
    expect(parsed.weeklyAwards.week).toBe(3);
  });

  it("builds a requested prior week from that week's own evidence", async () => {
    const parsed = await historicalSnapshot(1);

    expect(parsed.weeklyAwards.state).toBe("available");
    if (parsed.weeklyAwards.state !== "available") return;
    expect(parsed.weeklyAwards.week).toBe(1);
    expect(parsed.weeklyAwards.awards.find((award) => award.id === "beatdown")).toMatchObject({
      value: 20,
      detail: { teamPoints: 120, opponentPoints: 100 },
    });
    // The list itself never narrows to the requested week.
    expect(parsed.weeklyAwardWeeks).toEqual([1, 2, 3]);
  });

  it("refuses an incomplete week rather than substituting the latest one", async () => {
    const parsed = await historicalSnapshot(4);

    expect(parsed.weeklyAwards).toMatchObject({
      state: "unavailable",
      reasons: [{ code: "AWARDS_WEEK_UNAVAILABLE" }],
    });
    if (parsed.weeklyAwards.state !== "unavailable") return;
    expect(parsed.weeklyAwards.reasons[0]?.message).toContain("Week 4");
  });

  it("refuses a week the season never carried", async () => {
    const parsed = await historicalSnapshot(9);

    expect(parsed.weeklyAwards).toMatchObject({
      state: "unavailable",
      reasons: [{ code: "AWARDS_WEEK_UNAVAILABLE" }],
    });
  });
});

/** Every playoff-odds case reads the same season facts; only the withheld rule or schedule moves. */
async function playoffSnapshot(
  overrides: {
    readonly observations?: readonly AnalyticsMatchupObservationRow[];
    readonly settings?: Record<string, unknown>;
  } = {},
) {
  const repository = new FakeRepository();
  repository.teams = playoffTeams;
  repository.observations = overrides.observations ?? withRemainingSchedule;
  if (overrides.settings) repository.season = { ...season, settings: overrides.settings };
  const snapshot = await new LeagueAnalyticsService(repository, () => NOW).getSnapshot(
    USER_ID,
    LEAGUE_ID,
  );
  return leagueAnalyticsSnapshotSchema.parse(snapshot);
}

describe("LeagueAnalyticsService playoff odds", () => {
  it("simulates seeded odds, seed distributions, and sampling error from the effective snapshot", async () => {
    const odds = (await playoffSnapshot()).playoffOdds;

    expect(odds?.state).toBe("available");
    if (odds?.state !== "available") return;
    expect(odds.playoffTeamCount).toBe(2);
    expect(odds.simulations).toBe(10_000);
    expect(odds.remainingMatchups).toBe(2);
    // The seed is a pure function of season, week, and the snapshot the deduplicator kept last.
    expect(odds.matchupSnapshotId).toBe("82000000-0000-4000-8000-000000000003");
    expect(odds.seed).toBe(
      `playoff-odds:v1:${SEASON_ID}:week-2:snapshot-82000000-0000-4000-8000-000000000003`,
    );
    expect(odds.forecastBasis.id).toBe("current-points-per-scored-week");
    expect(odds.samplingErrorDefinition).toContain("Monte Carlo");

    expect(odds.teams).toHaveLength(4);
    // Exactly two of four teams take the two-team field in every simulated season.
    expect(odds.teams.reduce((sum, team) => sum + team.playoffProbability, 0)).toBeCloseTo(2, 10);
    for (const team of odds.teams) {
      expect(team.playoffProbability).toBeGreaterThan(0);
      expect(team.playoffProbability).toBeLessThan(1);
      expect(team.monteCarloStandardError).toBeGreaterThan(0);
      expect(team.expectedSeed).toBeGreaterThanOrEqual(1);
      expect(team.expectedSeed).toBeLessThanOrEqual(4);
      expect(team.seedProbabilities.map((entry) => entry.seed)).toEqual([1, 2, 3, 4]);
      expect(team.seedProbabilities.reduce((sum, entry) => sum + entry.probability, 0)).toBeCloseTo(
        1,
        10,
      );
    }
  });

  it("names the unsupplied playoff rule and leaves every other section available", async () => {
    const parsed = await playoffSnapshot({ settings: { teamCount: 4 } });

    expect(parsed.playoffOdds).toMatchObject({
      state: "unavailable",
      reasons: [{ code: "PLAYOFF_RULES_MISSING" }],
    });
    const reasons = parsed.playoffOdds?.state === "unavailable" ? parsed.playoffOdds.reasons : [];
    expect(reasons[0]?.message).toContain("playoffTeamCount");

    // One unknown rule degrades one section; nothing else in the response notices.
    expect(parsed.scores.state).toBe("available");
    expect(parsed.power.state).toBe("available");
    expect(parsed.positional.state).toBe("available");
    expect(parsed.opponentScout.state).toBe("available");
    expect(parsed.weeklyAwards.state).toBe("available");
  });

  it("reports a completed season instead of simulating a schedule with nothing left", async () => {
    const parsed = await playoffSnapshot({ observations: completedSchedule });

    expect(parsed.playoffOdds).toMatchObject({
      state: "unavailable",
      reasons: [{ code: "PLAYOFF_SEASON_COMPLETE" }],
    });
  });

  it("replays identical probabilities for unchanged state and reseeds when the snapshot moves", async () => {
    const first = (await playoffSnapshot()).playoffOdds;
    const second = (await playoffSnapshot()).playoffOdds;
    const resynced = (await playoffSnapshot({ observations: resyncedSchedule })).playoffOdds;

    expect(second).toEqual(first);
    if (first?.state !== "available" || resynced?.state !== "available") {
      throw new Error("Expected both playoff simulations to be available");
    }
    expect(resynced.seed).not.toBe(first.seed);
    expect(resynced.teams.map((team) => team.playoffProbability)).not.toEqual(
      first.teams.map((team) => team.playoffProbability),
    );
  });
});
