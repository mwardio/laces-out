import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  DRAFT_READ_TOKEN_LIMITS,
  ESPN_LIVE_DRAFT_LIMITS,
  draftReadTokenClaimsSchema,
  espnLiveDraftDigestGolden,
  espnLiveDraftDigestSource,
  espnLiveDraftHeartbeatSchema,
  espnLiveDraftIngestRequestSchema,
  espnLiveDraftObservationSchema,
  espnLiveDraftPulseResponseSchema,
  draftSessionSnapshotSchema,
  type EspnLiveDraftObservation,
} from "./index.js";

const PAGE_SESSION = "7f1a2b3c-4d5e-4f60-8a71-9b2c3d4e5f60";
const USER_ID = "10000000-0000-4000-8000-000000000001";

function draftReadClaims(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    userId: USER_ID,
    leagues: [{ leagueId: "1234567", season: 2026 }],
    permission: "espn-live-draft-pulse:read",
    iat: 1_787_595_600,
    exp: 1_787_599_200,
    nonce: "abcdefghijklmnopqrstuv",
    ...overrides,
  };
}

describe("DraftRead capability claims", () => {
  it("accepts only the versioned read permission and explicit bounded scopes", () => {
    expect(draftReadTokenClaimsSchema.safeParse(draftReadClaims()).success).toBe(true);
    expect(
      draftReadTokenClaimsSchema.safeParse(
        draftReadClaims({ permission: "espn-live-draft-pulse:write" }),
      ).success,
    ).toBe(false);
    expect(draftReadTokenClaimsSchema.safeParse(draftReadClaims({ leagues: [] })).success).toBe(
      false,
    );
    expect(draftReadTokenClaimsSchema.safeParse(draftReadClaims({ version: 2 })).success).toBe(
      false,
    );
  });

  it("rejects duplicate league-season scopes and unknown claims", () => {
    const scope = { leagueId: "1234567", season: 2026 };
    expect(
      draftReadTokenClaimsSchema.safeParse(draftReadClaims({ leagues: [scope, scope] })).success,
    ).toBe(false);
    expect(
      draftReadTokenClaimsSchema.safeParse(draftReadClaims({ administrator: true })).success,
    ).toBe(false);
  });

  it("requires positive lifetimes no longer than twelve hours", () => {
    const iat = 1_787_595_600;
    expect(draftReadTokenClaimsSchema.safeParse(draftReadClaims({ iat, exp: iat })).success).toBe(
      false,
    );
    expect(
      draftReadTokenClaimsSchema.safeParse(
        draftReadClaims({
          iat,
          exp: iat + DRAFT_READ_TOKEN_LIMITS.maximumLifetimeSeconds + 1,
        }),
      ).success,
    ).toBe(false);
  });
});

function observation(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "espn-live-draft",
    leagueId: "1234567",
    season: 2026,
    pageSessionId: PAGE_SESSION,
    revision: 4,
    capturedAt: "2026-08-24T18:05:00.000Z",
    state: "live",
    draftType: "snake",
    expectedTeamCount: 12,
    expectedRosterSize: 16,
    pickOwnership: [{ overallPick: 1, providerTeamId: "1", teamName: "Ditka's Revenge" }],
    picks: [
      {
        sequence: 1,
        round: 1,
        roundPick: 1,
        keeper: false,
        providerTeamId: "1",
        teamName: "Ditka's Revenge",
        providerPlayerId: "3139477",
        playerName: "Patrick Mahomes",
        proTeam: "KC",
        position: "QB",
        price: null,
        nominatingProviderTeamId: null,
      },
    ],
    currentAuction: null,
    completeness: { contiguousThrough: 1, duplicateSequences: 0, unresolvedRows: 0 },
    checksumSha256: "a".repeat(64),
    ...overrides,
  };
}

describe("ESPN live draft observation contract", () => {
  it("accepts a well-formed snake observation", () => {
    expect(espnLiveDraftObservationSchema.safeParse(observation()).success).toBe(true);
  });

  it("rejects unknown fields so provider drift fails closed", () => {
    const result = espnLiveDraftObservationSchema.safeParse(
      observation({ rawHtml: "<table>...</table>" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects control characters lifted from a hostile page", () => {
    const hostile = observation();
    hostile.picks[0]!.playerName = "Patrick\u0000 Mahomes";
    expect(espnLiveDraftObservationSchema.safeParse(hostile).success).toBe(false);
  });

  it("permits negative provider player IDs because ESPN encodes D/ST that way", () => {
    const defense = observation();
    defense.picks[0]!.providerPlayerId = "-16033";
    defense.picks[0]!.playerName = "Chiefs D/ST";
    defense.picks[0]!.position = "DST";
    expect(espnLiveDraftObservationSchema.safeParse(defense).success).toBe(true);
  });

  it("refuses auction nomination state on a snake draft", () => {
    const mixed = observation({
      currentAuction: {
        nominationNumber: 1,
        nominatingProviderTeamId: "1",
        providerPlayerId: "3139477",
        playerName: "Patrick Mahomes",
        proTeam: "KC",
        position: "QB",
        highBidProviderTeamId: "2",
        highBidTeamName: "Finkle Is Einhorn",
        highBid: 40,
      },
    });
    expect(espnLiveDraftObservationSchema.safeParse(mixed).success).toBe(false);
  });

  it("defaults the backward-compatible high-bid team name and bounds new values", () => {
    const legacyAuction = {
      nominationNumber: 1,
      nominatingProviderTeamId: null,
      providerPlayerId: "3139477",
      playerName: "Patrick Mahomes",
      proTeam: "KC",
      position: "QB",
      highBidProviderTeamId: null,
      highBid: 40,
    };
    const legacy = espnLiveDraftObservationSchema.safeParse(
      observation({ draftType: "auction", currentAuction: legacyAuction }),
    );
    expect(legacy.success && legacy.data.currentAuction?.highBidTeamName).toBeNull();
    expect(
      espnLiveDraftObservationSchema.safeParse(
        observation({
          draftType: "auction",
          currentAuction: { ...legacyAuction, highBidTeamName: "Finkle Is Einhorn" },
        }),
      ).success,
    ).toBe(true);
    expect(
      espnLiveDraftObservationSchema.safeParse(
        observation({
          draftType: "auction",
          currentAuction: { ...legacyAuction, highBidTeamName: "T".repeat(81) },
        }),
      ).success,
    ).toBe(false);
  });

  it("refuses a completeness claim larger than the reported picks", () => {
    const overclaimed = observation({
      completeness: { contiguousThrough: 9, duplicateSequences: 0, unresolvedRows: 0 },
    });
    expect(espnLiveDraftObservationSchema.safeParse(overclaimed).success).toBe(false);
  });

  it("refuses duplicate pick ownership entries", () => {
    const duplicated = observation({
      pickOwnership: [
        { overallPick: 1, providerTeamId: "1", teamName: "Ditka's Revenge" },
        { overallPick: 1, providerTeamId: "2", teamName: "Finkle Is Einhorn" },
      ],
    });
    expect(espnLiveDraftObservationSchema.safeParse(duplicated).success).toBe(false);
  });

  it("bounds picks and teams at the published limits", () => {
    const tooMany = observation({ expectedTeamCount: ESPN_LIVE_DRAFT_LIMITS.maximumTeams + 1 });
    expect(espnLiveDraftObservationSchema.safeParse(tooMany).success).toBe(false);
  });

  it("discriminates observations from heartbeats", () => {
    const heartbeat = {
      schemaVersion: 1,
      kind: "espn-live-draft-heartbeat",
      leagueId: "1234567",
      season: 2026,
      pageSessionId: PAGE_SESSION,
      revision: 5,
      capturedAt: "2026-08-24T18:05:05.000Z",
      state: "live",
      lastChecksumSha256: "b".repeat(64),
    };
    expect(espnLiveDraftHeartbeatSchema.safeParse(heartbeat).success).toBe(true);
    const parsed = espnLiveDraftIngestRequestSchema.safeParse(heartbeat);
    expect(parsed.success && parsed.data.kind).toBe("espn-live-draft-heartbeat");
  });
});

/**
 * The digest is taken over a parsed observation, so these tests go through the schema rather than
 * casting a loose literal — that keeps them honest about what the server will actually hash.
 */
function parsedObservation(overrides: Record<string, unknown> = {}): EspnLiveDraftObservation {
  const result = espnLiveDraftObservationSchema.safeParse(observation(overrides));
  if (!result.success)
    throw new Error(`fixture is not a valid observation: ${result.error.message}`);
  return result.data;
}

describe("ESPN live draft canonical digest", () => {
  it("matches the golden serialization shared with the browser companion", () => {
    expect(espnLiveDraftDigestSource(espnLiveDraftDigestGolden.observation)).toBe(
      espnLiveDraftDigestGolden.source,
    );
  });

  it("ignores capture time, revision, and page session so replays stay idempotent", () => {
    const first = parsedObservation();
    const second = parsedObservation({
      capturedAt: "2026-08-24T19:30:00.000Z",
      revision: 91,
      pageSessionId: "11111111-2222-4333-8444-555555555555",
    });
    expect(espnLiveDraftDigestSource(first)).toBe(espnLiveDraftDigestSource(second));
  });

  it("ignores transient auction state so a bidding war is not material history", () => {
    const auction = parsedObservation({ draftType: "auction" });
    const bidding = parsedObservation({
      draftType: "auction",
      currentAuction: {
        nominationNumber: 2,
        nominatingProviderTeamId: "1",
        providerPlayerId: "4241389",
        playerName: "Ja'Marr Chase",
        proTeam: "CIN",
        position: "WR",
        highBidProviderTeamId: "2",
        highBidTeamName: "Finkle Is Einhorn",
        highBid: 57,
      },
    });
    expect(espnLiveDraftDigestSource(auction)).toBe(espnLiveDraftDigestSource(bidding));
  });

  it("changes when the board changes", () => {
    const before = parsedObservation();
    const after = parsedObservation({
      picks: [],
      completeness: { contiguousThrough: 0, duplicateSequences: 0, unresolvedRows: 0 },
    });
    expect(espnLiveDraftDigestSource(before)).not.toBe(espnLiveDraftDigestSource(after));
  });

  it("changes when the draft is paused, so feed state still reaches viewers", () => {
    expect(espnLiveDraftDigestSource(parsedObservation())).not.toBe(
      espnLiveDraftDigestSource(parsedObservation({ state: "paused" })),
    );
  });

  it("produces a hex sha-256 the server can recompute", () => {
    const digest = createHash("sha256")
      .update(espnLiveDraftDigestSource(parsedObservation()), "utf8")
      .digest("hex");
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe("ESPN live draft pulse contract", () => {
  const pulse = {
    schemaVersion: 1,
    provider: "espn",
    providerLeagueId: "1234567",
    season: 2026,
    cursor: "1000005",
    pageRevision: 4,
    generatedAt: "2026-08-24T18:05:01.000Z",
    observedAt: "2026-08-24T18:05:00.000Z",
    lastReceivedAt: "2026-08-24T18:05:01.000Z",
    fresh: true,
    ageSeconds: 0,
    feedState: "live",
    manualBackupActive: false,
    draft: {
      id: "20000000-0000-4000-8000-000000000001",
      sequence: 1,
      persistedState: "live",
      mode: "AUCTION",
      minimumBid: 1,
      complete: false,
      teams: [
        {
          id: "40000000-0000-4000-8000-000000000001",
          name: "Ditka's Revenge",
          budget: 200,
          spent: 42,
          remainingBudget: 158,
          openSlots: 1,
          maximumBid: 158,
          rosterPlayerIds: ["50000000-0000-4000-8000-000000000001"],
          rosterPlayers: [
            {
              playerId: "50000000-0000-4000-8000-000000000001",
              playerName: "Patrick Mahomes",
              positions: ["QB"],
            },
          ],
          rosterSlots: [
            {
              id: "qb-1",
              type: "QB",
              label: "QB",
              kind: "STARTER",
              eligiblePositions: ["QB"],
            },
          ],
        },
        {
          id: "40000000-0000-4000-8000-000000000002",
          name: "Finkle Is Einhorn",
          budget: 200,
          spent: 0,
          remainingBudget: 200,
          openSlots: 2,
          maximumBid: 199,
          rosterPlayerIds: [],
          rosterPlayers: [],
          rosterSlots: [
            {
              id: "qb-1",
              type: "QB",
              label: "QB",
              kind: "STARTER",
              eligiblePositions: ["QB"],
            },
          ],
        },
      ],
      completedSales: [],
    },
    controlledTeamId: "40000000-0000-4000-8000-000000000001",
    currentAuction: null,
    auctionTransitions: {
      sampling: "sampled",
      maximumItems: 64,
      observationsScanned: 0,
      items: [],
    },
  };

  it("carries bounded internal roster identities for advisory need analysis", () => {
    const parsed = espnLiveDraftPulseResponseSchema.parse(pulse);
    expect(parsed.draft.teams[0]?.rosterPlayers).toEqual([
      {
        playerId: "50000000-0000-4000-8000-000000000001",
        playerName: "Patrick Mahomes",
        positions: ["QB"],
      },
    ]);
    expect(parsed.draft.teams[0]?.rosterSlots).toEqual([
      {
        id: "qb-1",
        type: "QB",
        label: "QB",
        kind: "STARTER",
        eligiblePositions: ["QB"],
      },
    ]);
  });

  it("rejects provider identity or unbounded roster data in compact roster entries", () => {
    const withProviderIdentity = structuredClone(pulse);
    Object.assign(withProviderIdentity.draft.teams[0]!.rosterPlayers[0]!, {
      providerPlayerId: "3139477",
    });
    expect(espnLiveDraftPulseResponseSchema.safeParse(withProviderIdentity).success).toBe(false);

    const oversized = structuredClone(pulse);
    oversized.draft.teams[0]!.rosterPlayers = Array.from({ length: 101 }, () => ({
      playerId: "50000000-0000-4000-8000-000000000001",
      playerName: "Patrick Mahomes",
      positions: ["QB"],
    }));
    expect(espnLiveDraftPulseResponseSchema.safeParse(oversized).success).toBe(false);
  });
});

describe("draft session transport widening", () => {
  const base = {
    id: "20000000-0000-4000-8000-000000000001",
    leagueSeasonId: "30000000-0000-4000-8000-000000000001",
    accessRole: "owner",
    sequence: 0,
    persistedState: "created",
    config: {
      mode: "SNAKE",
      teams: [
        {
          id: "40000000-0000-4000-8000-000000000001",
          name: "Ditka's Revenge",
          rosterSlots: [
            {
              id: "qb-1",
              type: "QB",
              label: "QB",
              kind: "STARTER",
              eligiblePositions: ["QB"],
            },
          ],
        },
        {
          id: "40000000-0000-4000-8000-000000000002",
          name: "Finkle Is Einhorn",
          rosterSlots: [
            {
              id: "qb-1",
              type: "QB",
              label: "QB",
              kind: "STARTER",
              eligiblePositions: ["QB"],
            },
          ],
        },
      ],
      players: [
        {
          id: "50000000-0000-4000-8000-000000000001",
          name: "Patrick Mahomes",
          positions: ["QB"],
        },
      ],
      pickOrder: ["40000000-0000-4000-8000-000000000001"],
    },
    state: {
      mode: "SNAKE",
      teams: [
        {
          teamId: "40000000-0000-4000-8000-000000000001",
          name: "Ditka's Revenge",
          roster: [],
          openSlots: 1,
        },
        {
          teamId: "40000000-0000-4000-8000-000000000002",
          name: "Finkle Is Einhorn",
          roster: [],
          openSlots: 1,
        },
      ],
      draftedPlayerIds: [],
      activeEventIds: [],
      revertedEventIds: [],
      nextPick: null,
      activeNomination: null,
      complete: false,
    },
    events: [],
    createdAt: "2026-08-24T18:00:00.000Z",
    updatedAt: "2026-08-24T18:00:00.000Z",
  };

  it("still accepts an existing manual session", () => {
    const result = draftSessionSnapshotSchema.safeParse({
      ...base,
      transport: "manual",
      providerPolling: false,
      providerFeed: null,
    });
    expect(result.success).toBe(true);
  });

  it("refuses a manual session that claims a provider feed", () => {
    const result = draftSessionSnapshotSchema.safeParse({
      ...base,
      transport: "manual",
      providerPolling: true,
      providerFeed: {
        provider: "espn",
        state: "live",
        providerLeagueId: "1234567",
        season: 2026,
        fresh: true,
        ageSeconds: 2,
        lastAcceptedAt: "2026-08-24T18:00:00.000Z",
        lastMaterialEventAt: null,
        pickCount: 0,
        unresolvedTeams: 0,
        unresolvedPlayers: 0,
        manualBackupActive: false,
        pendingReconciliation: 0,
        standbySources: 0,
        verification: "pending",
        lastIssueCode: null,
        currentAuction: null,
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts an ESPN-live session carrying provider-sourced events", () => {
    const result = draftSessionSnapshotSchema.safeParse({
      ...base,
      transport: "espn-live",
      providerPolling: true,
      providerFeed: {
        provider: "espn",
        state: "live",
        providerLeagueId: "1234567",
        season: 2026,
        fresh: true,
        ageSeconds: 1.5,
        lastAcceptedAt: "2026-08-24T18:00:00.000Z",
        lastMaterialEventAt: "2026-08-24T18:00:00.000Z",
        pickCount: 1,
        unresolvedTeams: 0,
        unresolvedPlayers: 0,
        manualBackupActive: false,
        pendingReconciliation: 0,
        standbySources: 1,
        verification: "pending",
        lastIssueCode: null,
        currentAuction: null,
      },
      sequence: 1,
      events: [
        {
          sequence: 1,
          idempotencyKey: "espn-live:feed:snake-pick:1:abcdef01",
          source: "espn",
          occurredAt: "2026-08-24T18:00:00.000Z",
          revertsSequence: null,
          event: {
            id: "espn:1234567:1",
            type: "SNAKE_PLAYER_SELECTED",
            teamId: "40000000-0000-4000-8000-000000000001",
            playerId: "50000000-0000-4000-8000-000000000001",
            overallPick: 1,
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});
