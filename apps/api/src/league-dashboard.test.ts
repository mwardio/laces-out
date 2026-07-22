import { describe, expect, it, vi } from "vitest";
import { leagueDashboardSchema } from "@fantasy/contracts";

import { LeagueDashboardService, type LeagueDashboardRepository } from "./league-dashboard.js";
import type { LeagueDashboardError } from "./league-dashboard.js";

const now = new Date("2026-07-16T22:00:00.000Z");
const userId = "00000000-0000-4000-8000-000000000001";
const otherUserId = "00000000-0000-4000-8000-000000000002";
const leagueId = "00000000-0000-4000-8000-000000000101";
const seasonId = "00000000-0000-4000-8000-000000000102";
const teamId = "00000000-0000-4000-8000-000000000103";
const otherTeamId = "00000000-0000-4000-8000-000000000104";
const snapshotId = "00000000-0000-4000-8000-000000000105";
const playerId = "00000000-0000-4000-8000-000000000106";
const standingsSnapshotId = "00000000-0000-4000-8000-000000000108";
const matchupSnapshotId = "00000000-0000-4000-8000-000000000109";
const matchupId = "00000000-0000-4000-8000-000000000110";

function membership() {
  return {
    membershipId: "00000000-0000-4000-8000-000000000107",
    role: "manager" as const,
    claimedFantasyTeamId: teamId,
    claimedTeamName: "Tech Gurus",
    claimedAt: new Date("2026-07-16T21:30:00.000Z"),
    leagueId,
    leagueName: "Friends League",
    archived: false,
  };
}

function season() {
  return {
    id: seasonId,
    leagueId,
    provider: "espn" as const,
    season: 2026,
    status: "active",
    teamCount: 2,
    draftType: "auction",
    waiverType: "faab",
    currentWeek: 1,
    lastSyncedAt: new Date("2026-07-16T21:00:00.000Z"),
    updatedAt: new Date("2026-07-16T21:01:00.000Z"),
  };
}

function fakeRepository(
  overrides: Partial<LeagueDashboardRepository> = {},
): LeagueDashboardRepository {
  return {
    listMemberships: () => Promise.resolve([]),
    listSeasons: () => Promise.resolve([]),
    findMembership: () => Promise.resolve(undefined),
    listTeams: () => Promise.resolve([]),
    listProviderTeamMappings: () => Promise.resolve([]),
    listLatestRosterCandidates: () => Promise.resolve([]),
    listRosterEntries: () => Promise.resolve([]),
    listClaimedTeamIds: () => Promise.resolve([]),
    findLatestSyncRun: () => Promise.resolve(undefined),
    findLatestStandingsSnapshot: () => Promise.resolve(undefined),
    listStandingsEntries: () => Promise.resolve([]),
    findLatestMatchupSnapshot: () => Promise.resolve(undefined),
    listWeeklyMatchups: () => Promise.resolve([]),
    listDataSources: () => Promise.resolve([]),
    claimTeam: () => Promise.resolve({ state: "not-member" }),
    ...overrides,
  };
}

describe("LeagueDashboardService", () => {
  it("builds the portfolio only from the authenticated user's membership rows", async () => {
    const listMemberships = vi.fn((requestedUserId: string) =>
      Promise.resolve(requestedUserId === userId ? [membership()] : []),
    );
    const listSeasons = vi.fn(() =>
      Promise.resolve([
        season(),
        {
          ...season(),
          id: "00000000-0000-4000-8000-000000000999",
          leagueId: "00000000-0000-4000-8000-000000000998",
        },
      ]),
    );
    const service = new LeagueDashboardService(
      fakeRepository({ listMemberships, listSeasons }),
      () => now,
    );

    const result = await service.listLeagues(userId);

    expect(listMemberships).toHaveBeenCalledWith(userId);
    expect(listSeasons).toHaveBeenCalledWith([leagueId]);
    expect(result.leagues).toHaveLength(1);
    expect(result.leagues[0]).toMatchObject({
      id: leagueId,
      membership: { claimedFantasyTeamId: teamId },
      season: { provider: "espn", providerFreshness: { state: "fresh" } },
    });
  });

  it("stops before league data reads when the user is not a member", async () => {
    const listSeasons = vi.fn(() => Promise.resolve([season()]));
    const listDataSources = vi.fn(() => Promise.resolve([]));
    const findLatestStandingsSnapshot = vi.fn(() => Promise.resolve(undefined));
    const findLatestMatchupSnapshot = vi.fn(() => Promise.resolve(undefined));
    const service = new LeagueDashboardService(
      fakeRepository({
        findMembership: (requestedUserId) =>
          Promise.resolve(requestedUserId === userId ? membership() : undefined),
        listSeasons,
        listDataSources,
        findLatestStandingsSnapshot,
        findLatestMatchupSnapshot,
      }),
      () => now,
    );

    await expect(service.getDashboard(otherUserId, leagueId)).resolves.toBeUndefined();
    expect(listSeasons).not.toHaveBeenCalled();
    expect(listDataSources).not.toHaveBeenCalled();
    expect(findLatestStandingsSnapshot).not.toHaveBeenCalled();
    expect(findLatestMatchupSnapshot).not.toHaveBeenCalled();
  });

  it("returns synchronized facts and claim availability without inventing projections", async () => {
    const service = new LeagueDashboardService(
      fakeRepository({
        findMembership: () => Promise.resolve(membership()),
        listSeasons: () => Promise.resolve([season()]),
        listTeams: () =>
          Promise.resolve([
            {
              id: teamId,
              name: "Tech Gurus",
              abbreviation: "TG",
              managerDisplayName: "Mack",
              faabRemaining: 83,
              waiverPriority: 4,
            },
            {
              id: otherTeamId,
              name: "Sunday Scaries",
              abbreviation: "SS",
              managerDisplayName: "Friend",
              faabRemaining: 90,
              waiverPriority: 2,
            },
          ]),
        listLatestRosterCandidates: () =>
          Promise.resolve([
            {
              id: snapshotId,
              teamId,
              effectiveAt: new Date("2026-07-16T21:00:00.000Z"),
              week: 1,
            },
          ]),
        listRosterEntries: () =>
          Promise.resolve([
            {
              snapshotId,
              playerId,
              name: "Example Quarterback",
              position: "QB",
              eligiblePositions: ["QB"],
              nflTeam: "CHI",
              status: "ACTIVE",
              slotCode: "QB",
              isStarter: true,
              locked: false,
            },
          ]),
        listClaimedTeamIds: () => Promise.resolve([teamId]),
        findLatestSyncRun: () =>
          Promise.resolve({
            kind: "espn-bridge",
            state: "succeeded",
            startedAt: new Date("2026-07-16T20:59:00.000Z"),
            finishedAt: new Date("2026-07-16T21:00:00.000Z"),
            recordsRead: 1,
            recordsWritten: 1,
          }),
        findLatestStandingsSnapshot: () =>
          Promise.resolve({
            id: standingsSnapshotId,
            asOfWeek: 1,
            effectiveAt: new Date("2026-07-16T21:00:00.000Z"),
          }),
        listStandingsEntries: () =>
          Promise.resolve([
            {
              teamId,
              teamName: "Tech Gurus",
              abbreviation: "TG",
              managerDisplayName: "Mack",
              rank: 1,
              playoffSeed: 1,
              wins: 1,
              losses: 0,
              ties: 0,
              pointsFor: "121.5000",
              pointsAgainst: "110.2500",
              streakType: "win",
              streakLength: 1,
            },
            {
              teamId: otherTeamId,
              teamName: "Sunday Scaries",
              abbreviation: "SS",
              managerDisplayName: "Friend",
              rank: 2,
              playoffSeed: 2,
              wins: 0,
              losses: 1,
              ties: 0,
              pointsFor: "110.2500",
              pointsAgainst: "121.5000",
              streakType: "loss",
              streakLength: 1,
            },
          ]),
        findLatestMatchupSnapshot: () =>
          Promise.resolve({
            id: matchupSnapshotId,
            asOfWeek: 1,
            effectiveAt: new Date("2026-07-16T21:00:00.000Z"),
          }),
        listWeeklyMatchups: () =>
          Promise.resolve([
            {
              id: matchupId,
              week: 1,
              status: "final",
              homeTeamId: teamId,
              homeTeamName: "Tech Gurus",
              homeAbbreviation: "TG",
              homeManagerDisplayName: "Mack",
              awayTeamId: otherTeamId,
              awayTeamName: "Sunday Scaries",
              awayAbbreviation: "SS",
              awayManagerDisplayName: "Friend",
              homeScore: "121.5000",
              awayScore: "110.2500",
              winnerTeamId: teamId,
              tied: false,
            },
          ]),
        listDataSources: () =>
          Promise.resolve([
            {
              key: "nflverse.players",
              name: "nflverse players",
              kind: "player-catalog",
              attribution: "nflverse",
              attributionUrl: "https://github.com/nflverse",
              lastCheckedAt: new Date("2026-07-16T20:00:00.000Z"),
              lastSuccessfulAt: new Date("2026-07-16T20:00:00.000Z"),
              consecutiveFailures: 0,
            },
          ]),
      }),
      () => now,
    );

    const result = await service.getDashboard(userId, leagueId);

    expect(result).toMatchObject({
      membership: { claimedFantasyTeamId: teamId },
      teamClaim: { mode: "self-asserted", provider: "espn" },
      overview: {
        configuredTeamCount: 2,
        storedTeamCount: 2,
        teamsWithRosterSnapshots: 1,
        rosteredPlayerCount: 1,
        starterCount: 1,
        availableTeamClaims: 1,
        positionCounts: { QB: 1 },
      },
      teams: [
        { id: teamId, claimStatus: "current-user", latestRoster: { players: [{ id: playerId }] } },
        { id: otherTeamId, claimStatus: "available", latestRoster: null },
      ],
      latestSyncRun: { kind: "espn-bridge", state: "succeeded" },
      standings: {
        state: "available",
        asOfWeek: 1,
        freshness: { state: "fresh" },
        entries: [
          { teamId, rank: 1, pointDifferential: 11.25, isCurrentUser: true },
          { teamId: otherTeamId, rank: 2, pointDifferential: -11.25 },
        ],
      },
      weeklyInsights: {
        state: "available",
        week: 1,
        freshness: { state: "fresh" },
        metrics: {
          matchupCount: 1,
          completedMatchupCount: 1,
          scoredTeamCount: 2,
          totalPoints: 231.75,
          averageTeamScore: 115.875,
          highestTeamScore: 121.5,
          lowestTeamScore: 110.25,
          smallestScoreMargin: 11.25,
          largestScoreMargin: 11.25,
        },
        scoreLeaders: [
          { rank: 1, teamId, score: 121.5, outcome: "win", isCurrentUser: true },
          { rank: 2, teamId: otherTeamId, score: 110.25, outcome: "loss" },
        ],
      },
      memberWeek: {
        state: "available",
        week: 1,
        teamId,
        standingRank: 1,
        opponentTeamId: otherTeamId,
        opponentStandingRank: 2,
        matchupId,
        matchupStatus: "final",
        teamScore: 121.5,
        opponentScore: 110.25,
        scoreState: "won",
      },
      dataSources: [
        {
          key: "nflverse.players",
          freshness: { state: "fresh", label: "Successful check 2h ago" },
        },
      ],
    });
    expect(result).not.toHaveProperty("projectedFor");
    expect(leagueDashboardSchema.safeParse(result).success).toBe(true);
  });

  it("exposes only the exact provider-mapped Yahoo team as claimable", async () => {
    const service = new LeagueDashboardService(
      fakeRepository({
        findMembership: () =>
          Promise.resolve({
            ...membership(),
            claimedFantasyTeamId: null,
            claimedTeamName: null,
            claimedAt: null,
          }),
        listSeasons: () => Promise.resolve([{ ...season(), provider: "yahoo" as const }]),
        listTeams: () =>
          Promise.resolve([
            {
              id: teamId,
              name: "Tech Gurus",
              abbreviation: "TG",
              managerDisplayName: "Mack",
              faabRemaining: 83,
              waiverPriority: 4,
            },
            {
              id: otherTeamId,
              name: "Sunday Scaries",
              abbreviation: "SS",
              managerDisplayName: "Friend",
              faabRemaining: 90,
              waiverPriority: 2,
            },
          ]),
        listProviderTeamMappings: (requestedUserId, requestedSeasonId) =>
          Promise.resolve(
            requestedUserId === userId && requestedSeasonId === seasonId
              ? [
                  {
                    externalKey: "449.l.12345.t.1",
                    teamId,
                    teamName: "Tech Gurus",
                  },
                ]
              : [],
          ),
      }),
      () => now,
    );

    const result = await service.getDashboard(userId, leagueId);

    expect(result).toMatchObject({
      teamClaim: {
        mode: "provider-mapped",
        provider: "yahoo",
        claimableTeamId: teamId,
        claimableTeamName: "Tech Gurus",
      },
      overview: { availableTeamClaims: 1 },
      teams: [
        { id: teamId, claimStatus: "available" },
        { id: otherTeamId, claimStatus: "not-claimable" },
      ],
    });
    expect(leagueDashboardSchema.safeParse(result).success).toBe(true);
  });

  it("reports unavailable weekly facts explicitly instead of treating them as zero scores", async () => {
    const service = new LeagueDashboardService(
      fakeRepository({
        findMembership: () => Promise.resolve(membership()),
        listSeasons: () => Promise.resolve([season()]),
        listTeams: () =>
          Promise.resolve([
            {
              id: teamId,
              name: "Tech Gurus",
              abbreviation: "TG",
              managerDisplayName: "Mack",
              faabRemaining: null,
              waiverPriority: null,
            },
          ]),
      }),
      () => now,
    );

    const result = await service.getDashboard(userId, leagueId);

    expect(result).toMatchObject({
      standings: {
        state: "unavailable",
        asOfWeek: null,
        effectiveAt: null,
        freshness: { state: "missing" },
        entries: [],
      },
      weeklyInsights: {
        state: "unavailable",
        week: 1,
        effectiveAt: null,
        metrics: {
          matchupCount: 0,
          scoredTeamCount: 0,
          totalPoints: null,
          averageTeamScore: null,
        },
        scoreLeaders: [],
      },
      memberWeek: {
        state: "matchup-unavailable",
        week: 1,
        teamId,
        teamName: "Tech Gurus",
        opponentTeamId: null,
        teamScore: null,
        scoreState: null,
      },
    });
    expect(leagueDashboardSchema.safeParse(result).success).toBe(true);
  });

  it("maps membership and unique-team claim failures to safe errors", async () => {
    const nonMemberService = new LeagueDashboardService(
      fakeRepository({ claimTeam: () => Promise.resolve({ state: "not-member" }) }),
      () => now,
    );
    const takenService = new LeagueDashboardService(
      fakeRepository({ claimTeam: () => Promise.resolve({ state: "taken" }) }),
      () => now,
    );
    const wrongYahooTeamService = new LeagueDashboardService(
      fakeRepository({ claimTeam: () => Promise.resolve({ state: "provider-mismatch" }) }),
      () => now,
    );

    await expect(nonMemberService.claimTeam(userId, leagueId, teamId)).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    } satisfies Partial<LeagueDashboardError>);
    await expect(takenService.claimTeam(userId, leagueId, teamId)).rejects.toMatchObject({
      statusCode: 409,
      code: "TEAM_TAKEN",
    } satisfies Partial<LeagueDashboardError>);
    await expect(
      wrongYahooTeamService.claimTeam(userId, leagueId, otherTeamId),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "TEAM_NOT_CLAIMABLE",
    } satisfies Partial<LeagueDashboardError>);
  });
});
