import { describe, expect, it } from "vitest";

import {
  draftEventSourceSchema,
  draftProviderFeedStatusSchema,
  draftSessionCreateRequestSchema,
  draftSessionSnapshotSchema,
  draftTransportSchema,
  yahooDraftFeedStatusSchema,
} from "./index.js";

const LEAGUE_SEASON_ID = "20000000-0000-4000-8000-000000000001";
const DRAFT_ID = "30000000-0000-4000-8000-000000000001";
const TEAM_A_ID = "40000000-0000-4000-8000-000000000001";
const TEAM_B_ID = "40000000-0000-4000-8000-000000000002";
const PLAYER_ID = "50000000-0000-4000-8000-000000000001";
const NOW = "2026-09-05T14:00:00.000Z";

function yahooFeed(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    provider: "yahoo",
    state: "live",
    providerLeagueId: "449.l.12345",
    season: 2026,
    fresh: true,
    ageSeconds: 12,
    lastAcceptedAt: NOW,
    lastMaterialEventAt: NOW,
    pickCount: 1,
    unresolvedTeams: 0,
    unresolvedPlayers: 0,
    manualBackupActive: false,
    pendingReconciliation: 0,
    standbySources: 0,
    verification: "pending",
    lastIssueCode: null,
    currentAuction: null,
    applicationMode: "shadow",
    releaseState: "shadow-only",
    pollIntervalSeconds: 60,
    ...overrides,
  };
}

function yahooSession(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: DRAFT_ID,
    leagueSeasonId: LEAGUE_SEASON_ID,
    transport: "yahoo-assisted",
    providerPolling: true,
    accessRole: "commissioner",
    sequence: 1,
    persistedState: "live",
    config: {
      mode: "SNAKE",
      teams: [
        {
          id: TEAM_A_ID,
          name: "Alpha",
          rosterSlots: [
            {
              id: "slot:qb:1",
              type: "QB",
              label: "QB 1",
              kind: "STARTER",
              eligiblePositions: ["QB"],
            },
          ],
        },
        {
          id: TEAM_B_ID,
          name: "Bravo",
          rosterSlots: [
            {
              id: "slot:qb:1",
              type: "QB",
              label: "QB 1",
              kind: "STARTER",
              eligiblePositions: ["QB"],
            },
          ],
        },
      ],
      players: [{ id: PLAYER_ID, name: "Alpha Arm", positions: ["QB"], nflTeam: "CHI" }],
      pickOrder: [TEAM_A_ID, TEAM_B_ID],
    },
    state: {
      mode: "SNAKE",
      teams: [
        {
          teamId: TEAM_A_ID,
          name: "Alpha",
          roster: [
            {
              playerId: PLAYER_ID,
              eventId: "yahoo:event:1",
              acquisition: "SNAKE_PICK",
              overallPick: 1,
            },
          ],
          openSlots: 0,
        },
        { teamId: TEAM_B_ID, name: "Bravo", roster: [], openSlots: 1 },
      ],
      draftedPlayerIds: [PLAYER_ID],
      activeEventIds: ["yahoo:event:1"],
      revertedEventIds: [],
      nextPick: { overallPick: 2, teamId: TEAM_B_ID },
      activeNomination: null,
      complete: false,
    },
    events: [
      {
        sequence: 1,
        idempotencyKey: "yahoo-draft:1234567890abcdef",
        source: "yahoo",
        occurredAt: NOW,
        revertsSequence: null,
        event: {
          id: "yahoo:event:1",
          type: "SNAKE_PLAYER_SELECTED",
          teamId: TEAM_A_ID,
          playerId: PLAYER_ID,
          overallPick: 1,
        },
      },
    ],
    providerFeed: yahooFeed(),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("Yahoo-assisted draft contracts", () => {
  it("admits only the explicit Yahoo transport, event provenance, and create opt-in", () => {
    expect(draftTransportSchema.parse("yahoo-assisted")).toBe("yahoo-assisted");
    expect(draftEventSourceSchema.parse("yahoo")).toBe("yahoo");
    expect(
      draftSessionCreateRequestSchema.parse({
        leagueSeasonId: LEAGUE_SEASON_ID,
        providerAssist: "yahoo",
        yahooScopeConfirmation: "no-keepers-or-traded-picks",
        teamOrder: ["449.l.12345.t.1", "449.l.12345.t.2"],
      }),
    ).toEqual({
      leagueSeasonId: LEAGUE_SEASON_ID,
      providerAssist: "yahoo",
      yahooScopeConfirmation: "no-keepers-or-traded-picks",
      teamOrder: ["449.l.12345.t.1", "449.l.12345.t.2"],
    });

    expect(draftTransportSchema.safeParse("yahoo-live").success).toBe(false);
    expect(draftEventSourceSchema.safeParse("yahoo-poll").success).toBe(false);
    expect(
      draftSessionCreateRequestSchema.safeParse({
        leagueSeasonId: LEAGUE_SEASON_ID,
        providerAssist: "espn",
      }).success,
    ).toBe(false);
    expect(
      draftSessionCreateRequestSchema.safeParse({
        leagueSeasonId: LEAGUE_SEASON_ID,
        providerAssist: "yahoo",
      }).success,
    ).toBe(false);
    expect(
      draftSessionCreateRequestSchema.safeParse({
        leagueSeasonId: LEAGUE_SEASON_ID,
        yahooScopeConfirmation: "no-keepers-or-traded-picks",
      }).success,
    ).toBe(false);
  });

  it("accepts a Yahoo feed and Yahoo-sourced event in a session snapshot", () => {
    expect(yahooDraftFeedStatusSchema.safeParse(yahooFeed()).success).toBe(true);
    expect(draftProviderFeedStatusSchema.safeParse(yahooFeed()).success).toBe(true);
    expect(draftSessionSnapshotSchema.safeParse(yahooSession()).success).toBe(true);
  });

  it("binds the Yahoo-assisted transport to a Yahoo feed", () => {
    expect(draftSessionSnapshotSchema.safeParse(yahooSession({ providerFeed: null })).success).toBe(
      false,
    );
    expect(
      draftSessionSnapshotSchema.safeParse(
        yahooSession({ transport: "espn-live", providerFeed: yahooFeed() }),
      ).success,
    ).toBe(false);
  });

  it.each([
    ["non-Yahoo league key", { providerLeagueId: "12345" }],
    ["cadence faster than the active-draft floor", { pollIntervalSeconds: 14 }],
    ["negative unresolved count", { unresolvedPlayers: -1 }],
    ["unbounded issue detail", { lastIssueCode: "RAW_PROVIDER_ERROR" }],
    ["ESPN-only auction payload", { currentAuction: {} }],
    [
      "inconsistent release and application states",
      { applicationMode: "append", releaseState: "shadow-only" },
    ],
    ["unknown response field", { rawXml: "<fantasy_content />" }],
  ])("rejects %s", (_label, malformed) => {
    expect(yahooDraftFeedStatusSchema.safeParse(yahooFeed(malformed)).success).toBe(false);
  });
});
