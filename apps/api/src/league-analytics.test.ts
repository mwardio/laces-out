import { leagueAnalyticsSnapshotSchema } from "@fantasy/contracts";
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

const USER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "10000000-0000-4000-8000-000000000002";
const LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const SEASON_ID = "30000000-0000-4000-8000-000000000001";
const TEAM_A = "40000000-0000-4000-8000-000000000001";
const TEAM_B = "40000000-0000-4000-8000-000000000002";
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
  role: "manager",
  claimedFantasyTeamId: TEAM_A,
  claimedTeamName: "The Isotoners",
};

const season: AnalyticsSeasonRow = {
  id: SEASON_ID,
  provider: "espn",
  season: 2026,
  currentWeek: 2,
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
    homeTeamId: TEAM_A,
    awayTeamId: TEAM_B,
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
    return Promise.resolve(teams.slice(0, limit));
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
});
