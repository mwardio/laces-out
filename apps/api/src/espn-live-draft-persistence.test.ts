import type { EspnLiveDraftPickOwnership } from "@fantasy/contracts";
import { playerId, rosterSlotId, teamId, type RosterSlot } from "@fantasy/domain";
import type { DraftConfig } from "@fantasy/engine-draft";
import { describe, expect, it } from "vitest";

import {
  DraftSessionService,
  type AppendStoredEventsResult,
  type CreateStoredDraftResult,
  type DraftSessionRepository,
  type LeagueDraftSource,
  type StoredDraft,
  type StoredDraftEvent,
} from "./draft-session.js";
import type { ProviderTeamCandidate } from "./espn-live-draft-identity.js";
import {
  espnLiveDraftSessionSettings,
  espnPlayerCrosswalk,
  projectEspnLiveDraftFeedStatus,
  providerSnakePickOrder,
  type EspnLiveDraftFeedProjection,
} from "./espn-live-draft-persistence.js";
import { ESPN_SELF_ASSERTED_PLAYER_SOURCE } from "./espn-sync-persistence.js";

const NOW = new Date("2026-08-24T18:05:00.000Z");
const LEAGUE_SEASON = "30000000-0000-4000-8000-000000000001";
const DRAFT_ID = "20000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const TEAM_A = "40000000-0000-4000-8000-00000000000a";
const TEAM_B = "40000000-0000-4000-8000-00000000000b";
const PLAYER_1 = "50000000-0000-4000-8000-000000000001";
const PLAYER_2 = "50000000-0000-4000-8000-000000000002";

function feed(overrides: Partial<EspnLiveDraftFeedProjection> = {}): EspnLiveDraftFeedProjection {
  return {
    providerLeagueId: "1234567",
    season: 2026,
    state: "live",
    lastObservedAt: new Date(NOW.getTime() - 3_000),
    lastReceivedAt: new Date(NOW.getTime() - 2_000),
    lastMaterialEventAt: new Date(NOW.getTime() - 8_000),
    lastPickCount: 14,
    manualBackupActive: false,
    verification: "verified",
    lastErrorCode: null,
    currentAuctionState: null,
    unresolvedTeams: 0,
    unresolvedPlayers: 0,
    pendingReconciliation: 0,
    standbySources: 1,
    ...overrides,
  };
}

describe("projectEspnLiveDraftFeedStatus", () => {
  it("reports a recently received feed as fresh with its age in seconds", () => {
    const status = projectEspnLiveDraftFeedStatus(feed(), NOW);
    expect(status).toMatchObject({
      provider: "espn",
      state: "live",
      fresh: true,
      ageSeconds: 2,
      pickCount: 14,
      lastAcceptedAt: "2026-08-24T18:04:57.000Z",
      lastMaterialEventAt: "2026-08-24T18:04:52.000Z",
    });
  });

  it("stops calling a feed fresh once it passes the fresh window but keeps its state", () => {
    const quiet = feed({ lastReceivedAt: new Date(NOW.getTime() - 20_000) });
    const status = projectEspnLiveDraftFeedStatus(quiet, NOW);
    expect(status.fresh).toBe(false);
    expect(status.state).toBe("live");
    expect(status.ageSeconds).toBe(20);
  });

  it("reports a feed nobody has fed past the disconnect window as stale", () => {
    const gone = feed({ lastReceivedAt: new Date(NOW.getTime() - 90_000) });
    expect(projectEspnLiveDraftFeedStatus(gone, NOW).state).toBe("stale");
  });

  it("keeps a completed draft complete no matter how long it has been quiet", () => {
    const done = feed({ state: "complete", lastReceivedAt: new Date(NOW.getTime() - 900_000) });
    const status = projectEspnLiveDraftFeedStatus(done, NOW);
    expect(status.state).toBe("complete");
    expect(status.fresh).toBe(false);
  });

  it("reports a feed that has never been fed without inventing an age", () => {
    const waiting = feed({ state: "waiting", lastReceivedAt: null, lastObservedAt: null });
    const status = projectEspnLiveDraftFeedStatus(waiting, NOW);
    expect(status).toMatchObject({ state: "waiting", fresh: false, ageSeconds: null });
    expect(status.lastAcceptedAt).toBeNull();
  });

  it("never lets a browser clock produce a negative age", () => {
    const skewed = feed({ lastReceivedAt: new Date(NOW.getTime() + 5_000) });
    expect(projectEspnLiveDraftFeedStatus(skewed, NOW).ageSeconds).toBe(0);
  });

  it("surfaces a known issue code and drops an unrecognized one", () => {
    expect(
      projectEspnLiveDraftFeedStatus(feed({ lastErrorCode: "UNRESOLVED_PLAYER" }), NOW)
        .lastIssueCode,
    ).toBe("UNRESOLVED_PLAYER");
    expect(
      projectEspnLiveDraftFeedStatus(feed({ lastErrorCode: "something-else" }), NOW).lastIssueCode,
    ).toBeNull();
  });

  it("surfaces a valid transient auction and drops a malformed one", () => {
    const auction = {
      nominationNumber: 3,
      nominatingTeamId: TEAM_A,
      playerId: PLAYER_1,
      playerName: "Patrick Mahomes",
      proTeam: "KC",
      position: "QB",
      highBidTeamId: TEAM_B,
      highBid: 42,
      observedAt: NOW.toISOString(),
    };
    expect(
      projectEspnLiveDraftFeedStatus(feed({ currentAuctionState: auction }), NOW).currentAuction,
    ).toEqual(auction);
    expect(
      projectEspnLiveDraftFeedStatus(feed({ currentAuctionState: { nominationNumber: 3 } }), NOW)
        .currentAuction,
    ).toBeNull();
  });

  it("exposes only the shared status contract, never who is supplying the board", () => {
    const status = projectEspnLiveDraftFeedStatus(feed(), NOW);
    expect(Object.keys(status).sort()).toEqual(
      [
        "ageSeconds",
        "currentAuction",
        "fresh",
        "lastAcceptedAt",
        "lastIssueCode",
        "lastMaterialEventAt",
        "manualBackupActive",
        "pendingReconciliation",
        "pickCount",
        "provider",
        "providerLeagueId",
        "season",
        "standbySources",
        "state",
        "unresolvedPlayers",
        "unresolvedTeams",
        "verification",
      ].sort(),
    );
    expect(JSON.stringify(status)).not.toMatch(/device|token|cookie|swid|espn_s2|lease/iu);
  });
});

function slot(index: number): RosterSlot {
  return {
    id: rosterSlotId(`slot-${index}`),
    type: "BENCH",
    label: `Bench ${index}`,
    kind: "BENCH",
    eligiblePositions: ["QB", "RB", "WR", "TE"],
  };
}

const snakeConfig: DraftConfig = {
  mode: "SNAKE",
  teams: [
    { id: teamId(TEAM_A), name: "Ditka's Revenge", rosterSlots: [slot(1)] },
    { id: teamId(TEAM_B), name: "Finkle Is Einhorn", rosterSlots: [slot(1)] },
  ],
  players: [
    { id: playerId(PLAYER_1), name: "Patrick Mahomes", positions: ["QB"], nflTeam: "KC" },
    { id: playerId(PLAYER_2), name: "Ja'Marr Chase", positions: ["WR"], nflTeam: "CIN" },
  ],
  pickOrder: [teamId(TEAM_A), teamId(TEAM_B)],
};

/**
 * Hydrating through the real DraftSessionService is the only way to prove the settings this module
 * writes satisfy the strict schema that owns them, without standing up a database.
 */
class SettingsProbeRepository implements DraftSessionRepository {
  readonly #settings: Record<string, unknown>;

  constructor(settings: Record<string, unknown>) {
    this.#settings = settings;
  }

  loadLeagueDraftSource(): Promise<LeagueDraftSource | undefined> {
    throw new Error("not used");
  }

  createDraft(): Promise<CreateStoredDraftResult> {
    throw new Error("not used");
  }

  loadDraft(): Promise<StoredDraft | undefined> {
    return Promise.resolve({
      id: DRAFT_ID,
      leagueSeasonId: LEAGUE_SEASON,
      type: "snake",
      state: "live",
      budgetPerTeam: null,
      minimumBid: null,
      settings: this.#settings,
      createdAt: NOW,
      updatedAt: NOW,
      accessRole: "owner",
      archived: false,
    });
  }

  listEvents(): Promise<readonly StoredDraftEvent[]> {
    return Promise.resolve([]);
  }

  appendEvents(): Promise<AppendStoredEventsResult> {
    throw new Error("not used");
  }
}

describe("espnLiveDraftSessionSettings", () => {
  const settings = espnLiveDraftSessionSettings({
    leagueSeasonId: LEAGUE_SEASON,
    sourceDraftType: "Snake",
    excludedRosterSlotCodes: ["IR"],
    config: snakeConfig,
  });

  it("produces exactly the keys the stored settings schema allows", () => {
    expect(Object.keys(settings).sort()).toEqual([
      "config",
      "providerPolling",
      "schemaVersion",
      "source",
      "transport",
    ]);
    expect(settings).toMatchObject({
      schemaVersion: 1,
      transport: "espn-live",
      providerPolling: true,
      source: {
        leagueSeasonId: LEAGUE_SEASON,
        provider: "espn",
        sourceDraftType: "Snake",
        excludedRosterSlotCodes: ["IR"],
      },
    });
  });

  it("hydrates through the manual draft service without corrupting the stream", async () => {
    const service = new DraftSessionService(new SettingsProbeRepository(settings), () => NOW);
    const session = await service.getSession(USER_ID, DRAFT_ID);
    expect(session.transport).toBe("espn-live");
    expect(session.config).toEqual(snakeConfig);
    // No feed row is attached here, so the room must not claim a live provider connection.
    expect(session.providerPolling).toBe(false);
    expect(session.providerFeed).toBeNull();
  });

  it("rejects an extra key rather than letting a live room throw on every hydrate", async () => {
    const service = new DraftSessionService(
      new SettingsProbeRepository({ ...settings, feedId: "extra" }),
      () => NOW,
    );
    await expect(service.getSession(USER_ID, DRAFT_ID)).rejects.toMatchObject({
      code: "DRAFT_STREAM_CORRUPT",
    });
  });
});

const candidates: readonly ProviderTeamCandidate[] = [
  { id: TEAM_A, name: "Ditka's Revenge", externalKey: "1" },
  { id: TEAM_B, name: "Finkle Is Einhorn", externalKey: "2" },
];

function ownership(
  entries: readonly (readonly [number, string | null, string])[],
): readonly EspnLiveDraftPickOwnership[] {
  return entries.map(([overallPick, providerTeamId, teamName]) => ({
    overallPick,
    providerTeamId,
    teamName,
  }));
}

describe("providerSnakePickOrder", () => {
  it("builds the observed order, including a traded pick that breaks the snake pattern", () => {
    const order = providerSnakePickOrder(
      ownership([
        [1, "1", "Ditka's Revenge"],
        [2, "2", "Finkle Is Einhorn"],
        [3, "1", "Ditka's Revenge"],
        [4, "1", "Ditka's Revenge"],
      ]),
      candidates,
      4,
    );
    expect(order).toEqual([TEAM_A, TEAM_B, TEAM_A, TEAM_A]);
  });

  it("resolves by unique team name when ESPN renders no team ID", () => {
    const order = providerSnakePickOrder(
      ownership([
        [1, null, "Finkle Is Einhorn"],
        [2, null, "Ditka's Revenge"],
      ]),
      [
        { id: TEAM_A, name: "Ditka's Revenge", externalKey: null },
        { id: TEAM_B, name: "Finkle Is Einhorn", externalKey: null },
      ],
      2,
    );
    expect(order).toEqual([TEAM_B, TEAM_A]);
  });

  it("refuses a board that does not cover every slot", () => {
    expect(
      providerSnakePickOrder(ownership([[1, "1", "Ditka's Revenge"]]), candidates, 2),
    ).toBeUndefined();
  });

  it("refuses a gap in the slots it does cover", () => {
    const gapped = providerSnakePickOrder(
      ownership([
        [1, "1", "Ditka's Revenge"],
        [3, "2", "Finkle Is Einhorn"],
      ]),
      candidates,
      2,
    );
    expect(gapped).toBeUndefined();
  });

  it("refuses an owner it cannot map instead of guessing", () => {
    const unknown = providerSnakePickOrder(
      ownership([
        [1, "1", "Ditka's Revenge"],
        [2, "99", "Some Other Team"],
      ]),
      candidates,
      2,
    );
    expect(unknown).toBeUndefined();
  });

  it("refuses a room with no picks at all", () => {
    expect(providerSnakePickOrder([], candidates, 0)).toBeUndefined();
  });
});

describe("espnPlayerCrosswalk", () => {
  const pool = new Set([PLAYER_1, PLAYER_2]);

  it("maps verified global IDs and league-scoped observations together", () => {
    const crosswalk = espnPlayerCrosswalk({
      leagueSeasonId: LEAGUE_SEASON,
      rows: [
        { source: "espn", externalId: "3139477", playerId: PLAYER_1 },
        {
          source: ESPN_SELF_ASSERTED_PLAYER_SOURCE,
          externalId: `${LEAGUE_SEASON}:4362628`,
          playerId: PLAYER_2,
        },
      ],
      poolPlayerIds: pool,
    });
    expect(crosswalk.get("3139477")).toBe(PLAYER_1);
    expect(crosswalk.get("4362628")).toBe(PLAYER_2);
  });

  it("keeps ESPN's negative D/ST identifiers intact", () => {
    const crosswalk = espnPlayerCrosswalk({
      leagueSeasonId: LEAGUE_SEASON,
      rows: [
        { source: "espn", externalId: "-16", playerId: PLAYER_1 },
        {
          source: ESPN_SELF_ASSERTED_PLAYER_SOURCE,
          externalId: `${LEAGUE_SEASON}:-11`,
          playerId: PLAYER_2,
        },
      ],
      poolPlayerIds: pool,
    });
    expect(crosswalk.get("-16")).toBe(PLAYER_1);
    expect(crosswalk.get("-11")).toBe(PLAYER_2);
  });

  it("lets the verified global mapping win over a self-asserted one", () => {
    const crosswalk = espnPlayerCrosswalk({
      leagueSeasonId: LEAGUE_SEASON,
      rows: [
        {
          source: ESPN_SELF_ASSERTED_PLAYER_SOURCE,
          externalId: `${LEAGUE_SEASON}:3139477`,
          playerId: PLAYER_2,
        },
        { source: "espn", externalId: "3139477", playerId: PLAYER_1 },
      ],
      poolPlayerIds: pool,
    });
    expect(crosswalk.get("3139477")).toBe(PLAYER_1);
  });

  it("ignores another league season's self-asserted observations", () => {
    const crosswalk = espnPlayerCrosswalk({
      leagueSeasonId: LEAGUE_SEASON,
      rows: [
        {
          source: ESPN_SELF_ASSERTED_PLAYER_SOURCE,
          externalId: "30000000-0000-4000-8000-0000000000ff:4362628",
          playerId: PLAYER_2,
        },
      ],
      poolPlayerIds: pool,
    });
    expect(crosswalk.size).toBe(0);
  });

  it("drops mappings that point outside the session's immutable player pool", () => {
    const crosswalk = espnPlayerCrosswalk({
      leagueSeasonId: LEAGUE_SEASON,
      rows: [
        { source: "espn", externalId: "3139477", playerId: PLAYER_1 },
        {
          source: "espn",
          externalId: "4426515",
          playerId: "50000000-0000-4000-8000-0000000000ff",
        },
      ],
      poolPlayerIds: pool,
    });
    expect([...crosswalk.keys()]).toEqual(["3139477"]);
  });
});
