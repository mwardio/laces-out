import type { DecisionPlayer, InSeasonDecisionSnapshot } from "@laces-out/contracts";

export const INBOX_USER_ID = "10000000-0000-4000-8000-000000000001";
export const INBOX_OTHER_USER_ID = "10000000-0000-4000-8000-000000000002";
export const INBOX_LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
export const INBOX_TEAM_ID = "30000000-0000-4000-8000-000000000001";
export const INBOX_OTHER_TEAM_ID = "30000000-0000-4000-8000-000000000002";
export const INBOX_MEMBERSHIP_ID = "40000000-0000-4000-8000-000000000001";
export const INBOX_NOW = "2026-09-15T12:00:00.000Z";

export function decisionInboxSnapshot(
  overrides: Partial<InSeasonDecisionSnapshot> = {},
): InSeasonDecisionSnapshot {
  const unavailable = {
    state: "unavailable" as const,
    reasons: [
      {
        code: "PROJECTIONS_MISSING" as const,
        message: "Compatible projections are not available.",
      },
    ],
  };
  const player: Pick<DecisionPlayer, "positions" | "nflTeam" | "status"> = {
    positions: ["WR"],
    nflTeam: "CHI",
    status: "ACTIVE",
  };
  return {
    generatedAt: INBOX_NOW,
    league: { id: INBOX_LEAGUE_ID, name: "Test league", season: 2026, week: 2, provider: "espn" },
    team: { id: INBOX_TEAM_ID, name: "Test team", faabRemaining: 82 },
    provenance: {
      algorithmVersion: "in-season-decisions-v1",
      inputChecksum: "a".repeat(64),
      leagueLastSyncedAt: INBOX_NOW,
      rosterEffectiveAt: INBOX_NOW,
      projectionSet: null,
      projectionFreshness: { state: "missing", observedAt: null, label: "No projection set" },
    },
    providerVerification: {
      lockCoverage: "unavailable",
      storedTrueLocksHonored: true,
      storedFalseMeansUnlocked: false,
      storedLockedPlayerCount: 0,
      actionWarning: "Verify locks and transactions on ESPN before making changes.",
    },
    coverage: {
      leagueTeams: 2,
      teamsWithRosters: 2,
      leagueRosteredPlayers: 4,
      claimedRosterPlayers: 2,
      claimedRosterProjected: 2,
      claimedRosterProjectionRatio: 1,
      projectionSetPlayers: 8,
      projectionQueryLimited: false,
    },
    lineup: unavailable,
    trades: unavailable,
    waivers: {
      state: "available",
      candidateCount: 1,
      evaluatedMoveCount: 1,
      dropCandidates: [
        {
          ...player,
          id: "70000000-0000-4000-8000-000000000002",
          name: "Outgoing Player",
          projectedPoints: 8.1,
        },
      ],
      recommendations: [
        {
          add: {
            ...player,
            id: "70000000-0000-4000-8000-000000000001",
            name: "Incoming Player",
            projectedPoints: 12.4,
          },
          drop: {
            ...player,
            id: "70000000-0000-4000-8000-000000000002",
            name: "Outgoing Player",
            projectedPoints: 8.1,
          },
          weightedGain: 3.49,
          lineupGain: 1.2,
          faab: null,
          market: null,
          rationale: "This move improves the projected roster.",
          dropComparisons: [
            {
              dropPlayerId: "70000000-0000-4000-8000-000000000002",
              weightedGain: 3.49,
              lineupGain: 1.2,
              faab: null,
            },
          ],
        },
      ],
      execution: {
        mode: "provider-required",
        provider: "espn",
        label: "Open ESPN",
        url: "https://fantasy.espn.com/football/league?leagueId=1",
      },
      notes: [],
      restOfSeason: unavailable,
    },
    ...overrides,
  };
}
