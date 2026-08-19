import { describe, expect, it } from "vitest";

import type { LeagueDashboard } from "./api-client";
import {
  claimCalloutMode,
  defaultClaimChoice,
  leagueIsUnclaimed,
  providerMappedTeamState,
  resolvedMemberTeam,
  selectableClaimTeams,
  settingsTeamChoice,
} from "./team-claim";

const freshness = { state: "fresh", observedAt: null, label: "Fresh" } as const;

function team(
  overrides: Partial<LeagueDashboard["teams"][number]>,
): LeagueDashboard["teams"][number] {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Team One",
    abbreviation: null,
    managerDisplayName: null,
    faabRemaining: null,
    waiverPriority: null,
    claimStatus: "available",
    latestRoster: null,
    ...overrides,
  };
}

function dashboard(overrides: Partial<LeagueDashboard> = {}): LeagueDashboard {
  return {
    generatedAt: "2026-07-28T00:00:00.000Z",
    league: { id: "00000000-0000-0000-0000-0000000000aa", name: "Test League", archived: false },
    membership: {
      role: "manager",
      claimedFantasyTeamId: null,
      claimedTeamName: null,
      claimedAt: null,
    },
    teamClaim: {
      mode: "self-asserted",
      provider: "manual",
      claimableTeamId: null,
      claimableTeamName: null,
      explanation: "Pick your team to unlock roster-aware analysis.",
    },
    season: null,
    latestSyncRun: null,
    overview: {
      configuredTeamCount: 0,
      storedTeamCount: 0,
      teamsWithRosterSnapshots: 0,
      rosteredPlayerCount: 0,
      starterCount: 0,
      availableTeamClaims: 0,
      positionCounts: {},
    },
    teams: [team({})],
    standings: { state: "unavailable", asOfWeek: null, effectiveAt: null, freshness, entries: [] },
    weeklyInsights: {
      state: "unavailable",
      week: null,
      snapshotAsOfWeek: null,
      effectiveAt: null,
      freshness,
      matchups: [],
      metrics: {
        matchupCount: 0,
        completedMatchupCount: 0,
        inProgressMatchupCount: 0,
        scheduledMatchupCount: 0,
        scoredTeamCount: 0,
        totalPoints: null,
        averageTeamScore: null,
        highestTeamScore: null,
        lowestTeamScore: null,
        smallestScoreMargin: null,
        largestScoreMargin: null,
      },
      scoreLeaders: [],
    },
    memberWeek: {
      state: "team-unclaimed",
      week: null,
      teamId: null,
      teamName: null,
      teamLogoUrl: null,
      standingRank: null,
      wins: null,
      losses: null,
      ties: null,
      opponentTeamId: null,
      opponentTeamName: null,
      opponentLogoUrl: null,
      opponentManagerDisplayName: null,
      opponentStandingRank: null,
      opponentWins: null,
      opponentLosses: null,
      opponentTies: null,
      matchupId: null,
      matchupStatus: null,
      isHome: null,
      teamScore: null,
      opponentScore: null,
      scoreState: null,
    },
    dataSources: [],
    notices: [],
    ...overrides,
  };
}

describe("leagueIsUnclaimed", () => {
  it("is true for a self-asserted league with no claimed team", () => {
    const dash = dashboard({
      teams: [team({ id: "team-a", claimStatus: "available" })],
    });
    expect(leagueIsUnclaimed(dash)).toBe(true);
  });

  it("is false once a team carries claimStatus current-user", () => {
    const dash = dashboard({
      teams: [team({ id: "team-a", claimStatus: "current-user" })],
    });
    expect(leagueIsUnclaimed(dash)).toBe(false);
  });

  it("is false once membership.claimedFantasyTeamId is set", () => {
    const dash = dashboard({
      membership: {
        role: "manager",
        claimedFantasyTeamId: "team-a",
        claimedTeamName: "Team One",
        claimedAt: "2026-07-01T00:00:00.000Z",
      },
      teams: [team({ id: "team-a", claimStatus: "available" })],
    });
    expect(leagueIsUnclaimed(dash)).toBe(false);
  });
});

describe("selectableClaimTeams", () => {
  it("keeps current-user and available teams, drops taken and not-claimable", () => {
    const dash = dashboard({
      teams: [
        team({ id: "team-a", claimStatus: "current-user" }),
        team({ id: "team-b", claimStatus: "available" }),
        team({ id: "team-c", claimStatus: "taken" }),
        team({ id: "team-d", claimStatus: "not-claimable" }),
      ],
    });
    expect(selectableClaimTeams(dash).map((t) => t.id)).toEqual(["team-a", "team-b"]);
  });
});

describe("defaultClaimChoice", () => {
  it("prefers the membership's claimed team id above all else", () => {
    const dash = dashboard({
      membership: {
        role: "manager",
        claimedFantasyTeamId: "team-a",
        claimedTeamName: "Team One",
        claimedAt: "2026-07-01T00:00:00.000Z",
      },
      teamClaim: {
        mode: "provider-mapped",
        provider: "yahoo",
        claimableTeamId: "team-b",
        claimableTeamName: "Team Two",
        explanation: "Yahoo says this is your team.",
      },
      teams: [team({ id: "team-a", claimStatus: "current-user" })],
    });
    expect(defaultClaimChoice(dash)).toBe("team-a");
  });

  it("falls back to the provider-mapped claimable team id", () => {
    const dash = dashboard({
      teamClaim: {
        mode: "provider-mapped",
        provider: "yahoo",
        claimableTeamId: "team-b",
        claimableTeamName: "Team Two",
        explanation: "Yahoo says this is your team.",
      },
      teams: [
        team({ id: "team-b", claimStatus: "available" }),
        team({ id: "team-c", claimStatus: "available" }),
      ],
    });
    expect(defaultClaimChoice(dash)).toBe("team-b");
  });

  it("falls back to the first available team when self-asserted", () => {
    const dash = dashboard({
      teams: [
        team({ id: "team-b", claimStatus: "taken" }),
        team({ id: "team-c", claimStatus: "available" }),
      ],
    });
    expect(defaultClaimChoice(dash)).toBe("team-c");
  });

  it("falls back to an empty string when nothing is selectable", () => {
    const dash = dashboard({ teams: [team({ id: "team-a", claimStatus: "taken" })] });
    expect(defaultClaimChoice(dash)).toBe("");
  });
});

describe("settingsTeamChoice", () => {
  it("targets an exact provider match when an older selection differs", () => {
    const dash = dashboard({
      membership: {
        role: "manager",
        claimedFantasyTeamId: "team-a",
        claimedTeamName: "Team One",
        claimedAt: "2026-07-01T00:00:00.000Z",
      },
      teamClaim: {
        mode: "provider-mapped",
        provider: "espn",
        claimableTeamId: "team-b",
        claimableTeamName: "Team Two",
        explanation: "ESPN matched Team Two.",
      },
      teams: [
        team({ id: "team-a", claimStatus: "current-user" }),
        team({ id: "team-b", claimStatus: "available" }),
      ],
    });

    expect(settingsTeamChoice(dash)).toBe("team-b");
  });
});

describe("providerMappedTeamState", () => {
  it("marks a provider target assigned to another member as a conflict", () => {
    const dash = dashboard({
      teamClaim: {
        mode: "provider-mapped",
        provider: "espn",
        claimableTeamId: "team-b",
        claimableTeamName: "Team Two",
        explanation: "ESPN matched Team Two.",
      },
      teams: [team({ id: "team-b", claimStatus: "taken" })],
    });

    expect(providerMappedTeamState(dash)).toBe("conflict");
  });

  it("marks the current member's provider target as matched", () => {
    const dash = dashboard({
      membership: {
        role: "manager",
        claimedFantasyTeamId: "team-b",
        claimedTeamName: "Team Two",
        claimedAt: "2026-07-01T00:00:00.000Z",
      },
      teamClaim: {
        mode: "provider-mapped",
        provider: "yahoo",
        claimableTeamId: "team-b",
        claimableTeamName: "Team Two",
        explanation: "Yahoo matched Team Two.",
      },
      teams: [team({ id: "team-b", claimStatus: "current-user" })],
    });

    expect(providerMappedTeamState(dash)).toBe("matched");
  });
});

describe("resolvedMemberTeam", () => {
  it("does not present the first league team as the member's team when identity is unresolved", () => {
    const firstTeam = team({ id: "team-a", claimStatus: "available" });
    expect(resolvedMemberTeam(dashboard({ teams: [firstTeam] }))).toBeUndefined();
  });

  it("uses a non-conflicting exact provider match", () => {
    const mappedTeam = team({ id: "team-b", claimStatus: "available" });
    const dash = dashboard({
      teamClaim: {
        mode: "provider-mapped",
        provider: "espn",
        claimableTeamId: "team-b",
        claimableTeamName: "Team Two",
        explanation: "ESPN matched Team Two.",
      },
      teams: [team({ id: "team-a", claimStatus: "not-claimable" }), mappedTeam],
    });

    expect(resolvedMemberTeam(dash)).toBe(mappedTeam);
  });

  it("does not present a provider match assigned to another member as the member's team", () => {
    const dash = dashboard({
      teamClaim: {
        mode: "provider-mapped",
        provider: "yahoo",
        claimableTeamId: "team-b",
        claimableTeamName: "Team Two",
        explanation: "Yahoo matched Team Two.",
      },
      teams: [team({ id: "team-b", claimStatus: "taken" })],
    });

    expect(resolvedMemberTeam(dash)).toBeUndefined();
  });
});

describe("claimCalloutMode", () => {
  it("is 'choose' for a self-asserted unclaimed league", () => {
    const dash = dashboard({ teams: [team({ id: "team-a", claimStatus: "available" })] });
    expect(claimCalloutMode(dash)).toBe("choose");
  });

  it.each(["espn", "yahoo"] as const)(
    "is 'hidden' for a provider-mapped unclaimed %s league",
    (provider) => {
      const dash = dashboard({
        teamClaim: {
          mode: "provider-mapped",
          provider,
          claimableTeamId: "team-a",
          claimableTeamName: "Team One",
          explanation: `${provider} says this is your team.`,
        },
        teams: [team({ id: "team-a", claimStatus: "available" })],
      });
      expect(claimCalloutMode(dash)).toBe("hidden");
    },
  );

  it("preselects the provider-mapped team via defaultClaimChoice", () => {
    const dash = dashboard({
      teamClaim: {
        mode: "provider-mapped",
        provider: "yahoo",
        claimableTeamId: "team-a",
        claimableTeamName: "Team One",
        explanation: "Yahoo says this is your team.",
      },
      teams: [team({ id: "team-a", claimStatus: "available" })],
    });
    expect(defaultClaimChoice(dash)).toBe("team-a");
  });

  it("is 'hidden' once a team is already claimed", () => {
    const dash = dashboard({
      membership: {
        role: "manager",
        claimedFantasyTeamId: "team-a",
        claimedTeamName: "Team One",
        claimedAt: "2026-07-01T00:00:00.000Z",
      },
      teams: [team({ id: "team-a", claimStatus: "current-user" })],
    });
    expect(claimCalloutMode(dash)).toBe("hidden");
  });

  it("is 'hidden' when the provider marks the claim unavailable", () => {
    const dash = dashboard({
      teamClaim: {
        mode: "unavailable",
        provider: null,
        claimableTeamId: null,
        claimableTeamName: null,
        explanation: "Team claiming is not available for this league.",
      },
      teams: [team({ id: "team-a", claimStatus: "available" })],
    });
    expect(claimCalloutMode(dash)).toBe("hidden");
  });

  it("is 'hidden' when there are no selectable teams", () => {
    const dash = dashboard({ teams: [team({ id: "team-a", claimStatus: "taken" })] });
    expect(claimCalloutMode(dash)).toBe("hidden");
  });
});
