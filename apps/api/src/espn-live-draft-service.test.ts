import { createHash } from "node:crypto";

import {
  espnLiveDraftDigestSource,
  type EspnLiveDraftCurrentAuction,
  type EspnLiveDraftIngestRequest,
  type EspnLiveDraftObservation,
} from "@laces-out/contracts";
import { draftEventId, playerId, rosterSlotId, teamId, type RosterSlot } from "@laces-out/domain";
import type { DraftConfig } from "@laces-out/engine-draft";
import { beforeEach, describe, expect, it } from "vitest";

import type { DraftSessionEventRecord } from "./draft-session.js";
import {
  EspnLiveDraftError,
  EspnLiveDraftService,
  observationCompletenessIssue,
  projectEspnLiveDraftPulse,
  type CommitProviderEventsInput,
  type EspnLiveDraftRepository,
  type LiveDraftDeviceScope,
  type LiveDraftFeedRow,
  type LiveDraftPulseContext,
  type LiveDraftPulseScope,
  type LiveDraftSessionContext,
  type ManualBackupContext,
  type SetManualBackupInput,
  type SetManualBackupResult,
} from "./espn-live-draft-service.js";

const NOW = new Date("2026-08-24T18:05:00.000Z");
const DEVICE_TOKEN = `lo_espn_${"a".repeat(43)}`;
const PAGE_SESSION = "7f1a2b3c-4d5e-4f60-8a71-9b2c3d4e5f60";
const DRAFT_ID = "20000000-0000-4000-8000-000000000001";
const TEAM_A = "40000000-0000-4000-8000-00000000000a";
const TEAM_B = "40000000-0000-4000-8000-00000000000b";
const PLAYER_1 = "50000000-0000-4000-8000-000000000001";
const PLAYER_2 = "50000000-0000-4000-8000-000000000002";

const scope: LiveDraftDeviceScope = {
  deviceId: "60000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000001",
  leagueSeasonId: "30000000-0000-4000-8000-000000000001",
  providerLeagueId: "1234567",
  season: 2026,
};

function slots(count: number): readonly RosterSlot[] {
  return Array.from({ length: count }, (_, index) => ({
    id: rosterSlotId(`slot-${index + 1}`),
    type: "BENCH" as const,
    label: `Bench ${index + 1}`,
    kind: "BENCH" as const,
    eligiblePositions: ["QB", "RB", "WR", "TE"] as const,
  }));
}

const config: DraftConfig = {
  mode: "SNAKE",
  teams: [
    { id: teamId(TEAM_A), name: "Ditka's Revenge", rosterSlots: slots(1) },
    { id: teamId(TEAM_B), name: "Finkle Is Einhorn", rosterSlots: slots(1) },
  ],
  players: [
    { id: playerId(PLAYER_1), name: "Patrick Mahomes", positions: ["QB"], nflTeam: "KC" },
    { id: playerId(PLAYER_2), name: "Ja'Marr Chase", positions: ["WR"], nflTeam: "CIN" },
  ],
  pickOrder: [teamId(TEAM_A), teamId(TEAM_B)],
};

const auctionConfig: DraftConfig = {
  mode: "AUCTION",
  minimumBid: 1,
  teams: [
    { id: teamId(TEAM_A), name: "Ditka's Revenge", rosterSlots: slots(2), budget: 20 },
    { id: teamId(TEAM_B), name: "Finkle Is Einhorn", rosterSlots: slots(2), budget: 20 },
  ],
  players: config.players,
};

const auctionSale: DraftSessionEventRecord = {
  sequence: 1,
  idempotencyKey: "espn-sale-mahomes",
  source: "espn",
  occurredAt: "2026-08-24T18:04:40.000Z",
  revertsSequence: null,
  event: {
    id: draftEventId("espn-sale-mahomes"),
    type: "AUCTION_PLAYER_SOLD",
    teamId: teamId(TEAM_A),
    playerId: playerId(PLAYER_1),
    price: 5,
    occurredAt: "2026-08-24T18:04:40.000Z",
  },
};

const snakePickEvent: DraftSessionEventRecord = {
  sequence: 1,
  idempotencyKey: "espn-pick-mahomes",
  source: "espn",
  occurredAt: "2026-08-24T18:04:40.000Z",
  revertsSequence: null,
  event: {
    id: draftEventId("espn-pick-mahomes"),
    type: "SNAKE_PLAYER_SELECTED",
    teamId: teamId(TEAM_A),
    playerId: playerId(PLAYER_1),
    overallPick: 1,
    occurredAt: "2026-08-24T18:04:40.000Z",
  },
};

function providerAuction(highBid: number | null): EspnLiveDraftCurrentAuction {
  return {
    nominationNumber: 2,
    nominatingProviderTeamId: "2",
    providerPlayerId: "2",
    playerName: "Ja'Marr Chase",
    proTeam: "CIN",
    position: "WR",
    highBidProviderTeamId: highBid === null ? null : "2",
    highBidTeamName: highBid === null ? null : "Finkle Is Einhorn",
    highBid,
  };
}

function pulseContext(
  overrides: {
    readonly config?: DraftConfig;
    readonly feed?: Partial<LiveDraftFeedRow>;
    readonly controlledTeamId?: string | null;
    readonly transitionObservations?: LiveDraftPulseContext["transitionObservations"];
  } = {},
): LiveDraftPulseContext {
  const pulseConfig = overrides.config ?? auctionConfig;
  return {
    feed: {
      ...feed,
      state: "live",
      activeDeviceId: scope.deviceId,
      activePageSessionId: PAGE_SESSION,
      lastPageRevision: 8,
      leaseGeneration: 2,
      lastChecksum: "a".repeat(64),
      lastObservedAt: new Date(NOW.getTime() - 1_000),
      lastReceivedAt: new Date(NOW.getTime() - 2_000),
      currentAuctionState: {
        nominationNumber: 2,
        nominatingTeamId: TEAM_B,
        playerId: PLAYER_2,
        playerName: "Ja'Marr Chase",
        proTeam: "CIN",
        position: "WR",
        highBidTeamId: TEAM_B,
        highBid: 6,
        observedAt: "2026-08-24T18:04:59.000Z",
      },
      ...overrides.feed,
    },
    draftId: DRAFT_ID,
    config: pulseConfig,
    events: [auctionSale],
    sequence: 1,
    teams: [
      { id: TEAM_A, name: "Ditka's Revenge", externalKey: "1" },
      { id: TEAM_B, name: "Finkle Is Einhorn", externalKey: "2" },
    ],
    players: [
      { id: PLAYER_1, name: "Patrick Mahomes", positions: ["QB"], nflTeam: "KC" },
      { id: PLAYER_2, name: "Ja'Marr Chase", positions: ["WR"], nflTeam: "CIN" },
    ],
    playerCrosswalk: new Map([
      ["1", PLAYER_1],
      ["2", PLAYER_2],
    ]),
    persistedState: "live",
    controlledTeamId:
      overrides.controlledTeamId === undefined ? TEAM_A : overrides.controlledTeamId,
    transitionObservations: overrides.transitionObservations ?? [],
  };
}

const feed: LiveDraftFeedRow = {
  id: "70000000-0000-4000-8000-000000000001",
  draftId: DRAFT_ID,
  state: "live",
  activeDeviceId: null,
  activePageSessionId: null,
  lastPageRevision: null,
  leaseExpiresAt: null,
  leaseGeneration: 0,
  lastChecksum: null,
  lastObservedAt: null,
  lastReceivedAt: null,
  currentAuctionState: null,
  pendingDestructiveChecksum: null,
  pendingDestructiveSeenCount: 0,
  manualBackupActive: false,
};

function pick(sequence: number, team: string, name: string, proTeam: string, position: string) {
  return {
    sequence,
    round: 1,
    roundPick: sequence,
    keeper: false,
    providerTeamId: team,
    teamName: team === "1" ? "Ditka's Revenge" : "Finkle Is Einhorn",
    providerPlayerId: null,
    playerName: name,
    proTeam,
    position,
    price: null,
    nominatingProviderTeamId: null,
  };
}

function observation(overrides: Partial<EspnLiveDraftObservation> = {}): EspnLiveDraftObservation {
  const picks = overrides.picks ?? [pick(1, "1", "Patrick Mahomes", "KC", "QB")];
  const draft = {
    schemaVersion: 1 as const,
    kind: "espn-live-draft" as const,
    leagueId: "1234567",
    season: 2026,
    pageSessionId: PAGE_SESSION,
    revision: 4,
    capturedAt: "2026-08-24T18:04:58.000Z",
    state: "live" as const,
    draftType: "snake" as const,
    expectedTeamCount: 2,
    expectedRosterSize: 1,
    pickOwnership: [
      { overallPick: 1, providerTeamId: "1", teamName: "Ditka's Revenge" },
      { overallPick: 2, providerTeamId: "2", teamName: "Finkle Is Einhorn" },
    ],
    currentAuction: null,
    ...overrides,
    picks,
    completeness: overrides.completeness ?? {
      contiguousThrough: picks.length,
      duplicateSequences: 0,
      unresolvedRows: 0,
    },
    checksumSha256: "0".repeat(64),
  };
  return {
    ...draft,
    checksumSha256: createHash("sha256")
      .update(espnLiveDraftDigestSource(draft), "utf8")
      .digest("hex"),
  };
}

class FakeRepository implements EspnLiveDraftRepository {
  context: LiveDraftSessionContext | undefined;
  leaseGranted = true;
  claimedLeaseGeneration: number | undefined;
  commitSucceeds = true;
  authorized = true;
  pendingReconciliation = 0;
  readonly commits: CommitProviderEventsInput[] = [];
  heartbeatInput: Parameters<EspnLiveDraftRepository["recordHeartbeat"]>[0] | undefined;
  pulseAuthorization:
    | { readonly token: string; readonly providerLeagueId: string; readonly season: number }
    | undefined;
  readonly memberAuthorizations: {
    readonly userId: string;
    readonly providerLeagueId: string;
    readonly season: number;
  }[] = [];
  events: DraftSessionEventRecord[] = [];

  constructor() {
    this.context = {
      feed,
      draftId: DRAFT_ID,
      config,
      events: [],
      sequence: 0,
      teams: [
        { id: TEAM_A, name: "Ditka's Revenge", externalKey: "1" },
        { id: TEAM_B, name: "Finkle Is Einhorn", externalKey: "2" },
      ],
      players: [
        { id: PLAYER_1, name: "Patrick Mahomes", positions: ["QB"], nflTeam: "KC" },
        { id: PLAYER_2, name: "Ja'Marr Chase", positions: ["WR"], nflTeam: "CIN" },
      ],
      playerCrosswalk: new Map(),
    };
  }

  withFeed(overrides: Partial<LiveDraftFeedRow>): void {
    this.context = { ...this.context!, feed: { ...this.context!.feed, ...overrides } };
  }

  authorizeDevice(): Promise<LiveDraftDeviceScope | undefined> {
    return Promise.resolve(this.authorized ? scope : undefined);
  }

  authorizePulseDevice(
    token: string,
    providerLeagueId: string,
    season: number,
  ): Promise<LiveDraftDeviceScope | undefined> {
    this.pulseAuthorization = { token, providerLeagueId, season };
    return Promise.resolve(this.authorized ? scope : undefined);
  }

  authorizePulseMember(
    userId: string,
    providerLeagueId: string,
    season: number,
  ): Promise<LiveDraftPulseScope | undefined> {
    this.memberAuthorizations.push({ userId, providerLeagueId, season });
    return Promise.resolve(this.authorized ? scope : undefined);
  }

  loadSessionContext(): Promise<LiveDraftSessionContext | undefined> {
    return Promise.resolve(this.context);
  }

  claimLease(): Promise<{ granted: boolean; expiresAt: Date | null; generation: number }> {
    return Promise.resolve({
      granted: this.leaseGranted,
      expiresAt: new Date(NOW.getTime() + 25_000),
      generation: this.claimedLeaseGeneration ?? this.context?.feed.leaseGeneration ?? 0,
    });
  }

  commitObservation(
    input: CommitProviderEventsInput,
  ): Promise<{ sequence: number; committed: boolean }> {
    this.commits.push(input);
    return Promise.resolve({
      sequence: input.expectedSequence + input.append.length,
      committed: this.commitSucceeds,
    });
  }

  recordHeartbeat(
    input: Parameters<EspnLiveDraftRepository["recordHeartbeat"]>[0],
  ): Promise<undefined> {
    this.heartbeatInput = input;
    return Promise.resolve(undefined);
  }

  loadFeedStatus(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  loadPulseContext() {
    return Promise.resolve(
      this.context
        ? {
            ...this.context,
            persistedState: "live" as const,
            controlledTeamId: TEAM_A,
            transitionObservations: [],
          }
        : undefined,
    );
  }

  loadManualBackupContext(): Promise<ManualBackupContext | undefined> {
    if (!this.context) return Promise.resolve(undefined);
    return Promise.resolve({
      feedId: this.context.feed.id,
      accessRole: "owner",
      archived: false,
      manualBackupActive: this.context.feed.manualBackupActive,
      sequence: this.context.sequence,
      pendingReconciliation: this.pendingReconciliation,
    });
  }

  setManualBackupActive(input: SetManualBackupInput): Promise<SetManualBackupResult> {
    this.withFeed({ manualBackupActive: input.active });
    return Promise.resolve({ status: "updated" });
  }
}

let repository: FakeRepository;

function service(enabled = true): EspnLiveDraftService {
  return new EspnLiveDraftService(repository, { enabled, now: () => NOW });
}

beforeEach(() => {
  repository = new FakeRepository();
});

describe("live draft pulse projection", () => {
  it("exposes deterministic budget math, completed sales, identity, next bid, and roster fit", () => {
    const pulse = projectEspnLiveDraftPulse(scope, pulseContext(), NOW);
    expect(pulse).toMatchObject({
      cursor: "2000010",
      pageRevision: 8,
      fresh: true,
      ageSeconds: 2,
      feedState: "live",
      controlledTeamId: TEAM_A,
      currentAuction: {
        playerId: PLAYER_2,
        playerPositions: ["WR"],
        highBidTeamId: TEAM_B,
        highBid: 6,
        nextBid: 7,
        nextBidSource: "ESPN_MINIMUM_INCREMENT",
        rosterFit: true,
        marketInflationFactor: null,
      },
      draft: {
        sequence: 1,
        minimumBid: 1,
        completedSales: [
          {
            sequence: 1,
            playerId: PLAYER_1,
            teamId: TEAM_A,
            price: 5,
          },
        ],
      },
    });
    expect(pulse.draft.teams[0]).toMatchObject({
      id: TEAM_A,
      budget: 20,
      spent: 5,
      remainingBudget: 15,
      openSlots: 1,
      maximumBid: 15,
      rosterPlayerIds: [PLAYER_1],
      rosterPlayers: [
        {
          playerId: PLAYER_1,
          playerName: "Patrick Mahomes",
          positions: ["QB"],
        },
      ],
      rosterSlots: [
        {
          id: "slot-1",
          type: "BENCH",
          label: "Bench 1",
          kind: "BENCH",
          eligiblePositions: ["QB", "RB", "WR", "TE"],
        },
        {
          id: "slot-2",
          type: "BENCH",
          label: "Bench 2",
          kind: "BENCH",
          eligiblePositions: ["QB", "RB", "WR", "TE"],
        },
      ],
    });
    expect(pulse.draft.teams[1]).toMatchObject({
      id: TEAM_B,
      remainingBudget: 20,
      openSlots: 2,
      maximumBid: 19,
    });
  });

  it("uses the configured minimum as the first offer and never invents identity-dependent fit", () => {
    const noBid = pulseContext({
      controlledTeamId: null,
      feed: {
        currentAuctionState: {
          nominationNumber: 2,
          nominatingTeamId: TEAM_B,
          playerId: PLAYER_2,
          playerName: "Ja'Marr Chase",
          proTeam: "CIN",
          position: "WR",
          highBidTeamId: null,
          highBid: null,
          observedAt: "2026-08-24T18:04:59.000Z",
        },
      },
    });
    expect(projectEspnLiveDraftPulse(scope, noBid, NOW).currentAuction).toMatchObject({
      nextBid: 1,
      nextBidSource: "ESPN_MINIMUM_INCREMENT",
      rosterFit: null,
    });
  });

  it("reports a hard false when the controlled roster has no legal slot for the player", () => {
    const fullControlledTeam: DraftConfig = {
      ...auctionConfig,
      teams: [{ ...auctionConfig.teams[0]!, rosterSlots: slots(1) }, auctionConfig.teams[1]!],
    };
    const pulse = projectEspnLiveDraftPulse(
      scope,
      pulseContext({ config: fullControlledTeam }),
      NOW,
    );
    expect(pulse.currentAuction?.rosterFit).toBe(false);
  });

  it("fails closed while manual backup freezes provider application", () => {
    const live = projectEspnLiveDraftPulse(scope, pulseContext(), NOW);
    const frozen = projectEspnLiveDraftPulse(
      scope,
      pulseContext({ feed: { manualBackupActive: true, leaseGeneration: 3 } }),
      NOW,
    );
    expect(frozen).toMatchObject({ manualBackupActive: true, currentAuction: null });
    expect(BigInt(frozen.cursor)).toBeGreaterThan(BigInt(live.cursor));
    const restoredWithoutObservation = projectEspnLiveDraftPulse(
      scope,
      pulseContext({
        feed: { manualBackupActive: false, leaseGeneration: 4, currentAuctionState: null },
      }),
      new Date(NOW.getTime() + 5_000),
    );
    expect(restoredWithoutObservation).toMatchObject({
      manualBackupActive: false,
      fresh: true,
      currentAuction: null,
    });
  });

  it("deduplicates transitions in time order and labels the bounded recent sample", () => {
    const transitions = Array.from({ length: 256 }, (_, index) => {
      const pageRevision = index === 255 ? 255 : index + 1;
      return {
        pageRevision,
        receivedAt: new Date(NOW.getTime() - (256 - index) * 100),
        currentAuction: providerAuction(index === 255 ? 255 : index + 1),
      };
    });
    const pulse = projectEspnLiveDraftPulse(
      scope,
      pulseContext({ transitionObservations: transitions }),
      NOW,
    );
    expect(pulse.auctionTransitions).toMatchObject({
      sampling: "sampled",
      maximumItems: 64,
      observationsScanned: 256,
    });
    expect(pulse.auctionTransitions.items).toHaveLength(64);
    expect(pulse.auctionTransitions.items[0]).toMatchObject({
      pageRevision: 192,
      highBid: 192,
    });
    expect(pulse.auctionTransitions.items.at(-1)).toMatchObject({
      pageRevision: 255,
      highBid: 255,
    });
  });

  it("uses server receipt time for freshness and makes cursor progress revision then generation", () => {
    const context = pulseContext();
    const fresh = projectEspnLiveDraftPulse(scope, context, NOW);
    const quiet = projectEspnLiveDraftPulse(scope, context, new Date(NOW.getTime() + 20_000));
    const stale = projectEspnLiveDraftPulse(scope, context, new Date(NOW.getTime() + 61_000));
    expect(fresh.fresh).toBe(true);
    expect(quiet).toMatchObject({ fresh: false, feedState: "live", ageSeconds: 22 });
    expect(stale).toMatchObject({ fresh: false, feedState: "stale", ageSeconds: 63 });

    const nextRevision = projectEspnLiveDraftPulse(
      scope,
      pulseContext({ feed: { lastPageRevision: 9 } }),
      NOW,
    );
    const nextGeneration = projectEspnLiveDraftPulse(
      scope,
      pulseContext({ feed: { leaseGeneration: 3, lastPageRevision: 0 } }),
      NOW,
    );
    expect(BigInt(nextRevision.cursor)).toBeGreaterThan(BigInt(fresh.cursor));
    expect(BigInt(nextGeneration.cursor)).toBeGreaterThan(BigInt(nextRevision.cursor));
    expect(nextRevision.draft.sequence).toBe(fresh.draft.sequence);
  });

  it("authorizes the exact requested league season before loading the pulse", async () => {
    const live = service();
    await live.latest(DEVICE_TOKEN, "1234567", 2026);
    expect(repository.pulseAuthorization).toEqual({
      token: DEVICE_TOKEN,
      providerLeagueId: "1234567",
      season: 2026,
    });
    repository.authorized = false;
    await expect(live.latest(DEVICE_TOKEN, "7654321", 2026)).rejects.toMatchObject({
      code: "OUT_OF_SCOPE",
      statusCode: 403,
    });
  });

  it("rechecks current membership on every member capability pulse", async () => {
    const live = service();
    await live.latestForMember(scope.userId, "1234567", 2026);
    repository.authorized = false;
    await expect(live.latestForMember(scope.userId, "1234567", 2026)).rejects.toMatchObject({
      code: "OUT_OF_SCOPE",
      statusCode: 403,
    });
    expect(repository.memberAuthorizations).toEqual([
      { userId: scope.userId, providerLeagueId: "1234567", season: 2026 },
      { userId: scope.userId, providerLeagueId: "1234567", season: 2026 },
    ]);
  });
});

describe("ingest authorization and payload integrity", () => {
  it("refuses to run when the server flag is off", async () => {
    await expect(service(false).ingest(DEVICE_TOKEN, observation())).rejects.toMatchObject({
      code: "DISABLED",
      statusCode: 503,
    });
  });

  it("rejects a league outside the device scope", async () => {
    repository.authorized = false;
    await expect(service().ingest(DEVICE_TOKEN, observation())).rejects.toMatchObject({
      code: "OUT_OF_SCOPE",
      statusCode: 403,
    });
  });

  it("rejects a tampered checksum", async () => {
    const tampered = { ...observation(), checksumSha256: "b".repeat(64) };
    await expect(service().ingest(DEVICE_TOKEN, tampered)).rejects.toBeInstanceOf(
      EspnLiveDraftError,
    );
  });

  it("rejects a stale capture time", async () => {
    const old = observation({ capturedAt: "2026-08-24T17:00:00.000Z" });
    await expect(service().ingest(DEVICE_TOKEN, old)).rejects.toMatchObject({ code: "STALE" });
  });

  it("does not mutate the draft when the observation is unauthorized", async () => {
    repository.authorized = false;
    await service()
      .ingest(DEVICE_TOKEN, observation())
      .catch(() => undefined);
    expect(repository.commits).toHaveLength(0);
  });
});

describe("structural completeness", () => {
  it("flags a gap in the pick sequence", () => {
    const gapped = observation({
      picks: [pick(2, "2", "Ja'Marr Chase", "CIN", "WR")],
      completeness: { contiguousThrough: 1, duplicateSequences: 0, unresolvedRows: 0 },
    });
    expect(observationCompletenessIssue(gapped)).toBe("PICK_SEQUENCE_GAP");
  });

  it("flags duplicated rows", () => {
    const duplicated = observation({
      picks: [
        pick(1, "1", "Patrick Mahomes", "KC", "QB"),
        pick(1, "2", "Ja'Marr Chase", "CIN", "WR"),
      ],
    });
    expect(observationCompletenessIssue(duplicated)).toBe("DUPLICATE_PICK_SEQUENCE");
  });

  it("flags rows the adapter could not interpret", () => {
    const unresolved = observation({
      completeness: { contiguousThrough: 1, duplicateSequences: 0, unresolvedRows: 2 },
    });
    expect(observationCompletenessIssue(unresolved)).toBe("EMPTY_RENDER");
  });

  it("accepts a clean board", () => {
    expect(observationCompletenessIssue(observation())).toBeNull();
  });

  it("flags every auction acquisition whose price is absent, including keepers", () => {
    const keeperWithoutPrice = observation({
      draftType: "auction",
      picks: [{ ...pick(1, "1", "Patrick Mahomes", "KC", "QB"), keeper: true }],
    });
    expect(observationCompletenessIssue(keeperWithoutPrice)).toBe("EMPTY_RENDER");
  });
});

describe("lease and standby", () => {
  it("returns standby without touching the board when another source holds the lease", async () => {
    repository.leaseGranted = false;
    const response = await service().ingest(DEVICE_TOKEN, observation());
    expect(response.status).toBe("standby");
    expect(repository.commits).toHaveLength(0);
  });

  it("rejects a page revision that rewinds within the same page session", async () => {
    repository.withFeed({
      activePageSessionId: PAGE_SESSION,
      lastPageRevision: 12,
      lastChecksum: "c".repeat(64),
    });
    const response = await service().ingest(DEVICE_TOKEN, observation());
    expect(response).toMatchObject({ status: "rejected", issueCode: "STALE_PAGE_REVISION" });
  });

  it("accepts only a checksum-matching replay at the current page revision", async () => {
    const exactReplay = observation();
    repository.withFeed({
      activePageSessionId: PAGE_SESSION,
      lastPageRevision: exactReplay.revision,
      lastChecksum: exactReplay.checksumSha256,
    });

    await expect(service().ingest(DEVICE_TOKEN, exactReplay)).resolves.toMatchObject({
      status: "idempotent",
      acceptedChecksum: exactReplay.checksumSha256,
      feedCursor: "4",
    });
    expect(repository.commits).toHaveLength(0);

    const changedBoard = observation({ state: "paused" });
    expect(changedBoard.checksumSha256).not.toBe(exactReplay.checksumSha256);
    await expect(service().ingest(DEVICE_TOKEN, changedBoard)).resolves.toMatchObject({
      status: "rejected",
      issueCode: "STALE_PAGE_REVISION",
    });
  });

  it("keeps the feed cursor monotonic when a takeover resets the page revision", async () => {
    repository.withFeed({
      activePageSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      lastPageRevision: 30,
      leaseGeneration: 1,
    });
    repository.claimedLeaseGeneration = 2;

    const response = await service().ingest(DEVICE_TOKEN, observation({ revision: 1 }));

    expect(response).toMatchObject({
      status: "accepted",
      feedCursor: "2000003",
    });
    expect(BigInt(response.feedCursor!)).toBeGreaterThan(BigInt("1000031"));
  });
});

describe("identity holds", () => {
  it("holds a pick whose player cannot be mapped and appends nothing", async () => {
    const unknown = observation({
      picks: [pick(1, "1", "Some Undrafted Rookie", "SEA", "RB")],
    });
    const response = await service().ingest(DEVICE_TOKEN, unknown);
    expect(response).toMatchObject({
      status: "held",
      issueCode: "UNRESOLVED_PLAYER",
      unresolvedPlayers: 1,
      feedState: "degraded",
    });
    expect(repository.commits.at(-1)?.append).toHaveLength(0);
  });

  it("holds a pick whose team cannot be mapped", async () => {
    const unknown = observation({
      picks: [{ ...pick(1, "1", "Patrick Mahomes", "KC", "QB"), providerTeamId: "99" }],
    });
    const response = await service().ingest(DEVICE_TOKEN, unknown);
    expect(response).toMatchObject({ status: "held", issueCode: "UNRESOLVED_TEAM" });
  });

  it("returns standby when an identity hold loses the atomic commit fence", async () => {
    repository.commitSucceeds = false;
    const unknown = observation({
      picks: [pick(1, "1", "Some Undrafted Rookie", "SEA", "RB")],
    });
    await expect(service().ingest(DEVICE_TOKEN, unknown)).resolves.toMatchObject({
      status: "standby",
      draftId: DRAFT_ID,
    });
  });
});

describe("configuration guards", () => {
  it("rejects an auction observation against a snake room", async () => {
    const mismatched = observation({
      draftType: "auction",
      picks: [{ ...pick(1, "1", "Patrick Mahomes", "KC", "QB"), price: 5 }],
    });
    const response = await service().ingest(DEVICE_TOKEN, mismatched);
    expect(response).toMatchObject({ status: "rejected", issueCode: "DRAFT_TYPE_MISMATCH" });
  });

  it("rejects a team count the room does not have", async () => {
    const mismatched = observation({ expectedTeamCount: 12 });
    const response = await service().ingest(DEVICE_TOKEN, mismatched);
    expect(response).toMatchObject({ status: "rejected", issueCode: "TEAM_COUNT_MISMATCH" });
  });

  it("waits rather than inventing a session when the league is not ready", async () => {
    repository.context = undefined;
    const response = await service().ingest(DEVICE_TOKEN, observation());
    expect(response).toMatchObject({ status: "rejected", issueCode: "SESSION_NOT_READY" });
  });
});

describe("acceptance", () => {
  it("accepts a clean first pick and appends one provider event", async () => {
    const response = await service().ingest(DEVICE_TOKEN, observation());
    expect(response.status).toBe("accepted");
    expect(response.serverSequence).toBe(1);
    const commit = repository.commits.at(-1)!;
    expect(commit.append).toHaveLength(1);
    expect(commit.append[0]!.source).toBe("espn");
    expect(commit.result).toBe("accepted");
  });

  it("resolves a name-only highest bidder by exact unique fantasy-team name", async () => {
    repository.context = { ...repository.context!, config: auctionConfig };
    const response = await service().ingest(
      DEVICE_TOKEN,
      observation({
        draftType: "auction",
        picks: [],
        pickOwnership: [],
        currentAuction: {
          nominationNumber: 2,
          nominatingProviderTeamId: null,
          providerPlayerId: "2",
          playerName: "Ja'Marr Chase",
          proTeam: "CIN",
          position: "WR",
          highBidProviderTeamId: null,
          highBidTeamName: "Finkle Is Einhorn",
          highBid: 6,
        },
      }),
    );
    expect(response.status).toBe("idempotent");
    expect(repository.commits.at(-1)?.transientAuction).toMatchObject({
      highBidTeamId: TEAM_B,
      highBid: 6,
    });
  });

  it("does not report acceptance when the atomic revision fence loses to a newer transient", async () => {
    repository.commitSucceeds = false;
    const response = await service().ingest(DEVICE_TOKEN, observation());
    expect(response).toMatchObject({ status: "standby", draftId: DRAFT_ID });
  });

  it("reports complete when ESPN says the room is done", async () => {
    const response = await service().ingest(DEVICE_TOKEN, observation({ state: "complete" }));
    expect(response.feedState).toBe("complete");
  });

  it("reports paused without discarding the board", async () => {
    const response = await service().ingest(DEVICE_TOKEN, observation({ state: "paused" }));
    expect(response.feedState).toBe("paused");
    expect(response.status).toBe("accepted");
  });

  it("holds while manual backup mode is active", async () => {
    repository.withFeed({ manualBackupActive: true });
    const response = await service().ingest(DEVICE_TOKEN, observation());
    expect(response).toMatchObject({ status: "held", issueCode: "MANUAL_BACKUP_ACTIVE" });
    // Still recorded: the operator needs to see how far the provider board has diverged.
    expect(repository.commits.at(-1)).toMatchObject({ result: "held", append: [] });
  });

  it("returns standby when a manual-backup hold loses the atomic commit fence", async () => {
    repository.withFeed({ manualBackupActive: true });
    repository.commitSucceeds = false;
    await expect(service().ingest(DEVICE_TOKEN, observation())).resolves.toMatchObject({
      status: "standby",
      draftId: DRAFT_ID,
    });
  });
});

describe("held and idempotent commit fencing", () => {
  it("returns standby when a reconciler hold is not committed", async () => {
    repository.commitSucceeds = false;
    const wrongOwner = observation({
      picks: [pick(1, "2", "Patrick Mahomes", "KC", "QB")],
    });

    await expect(service().ingest(DEVICE_TOKEN, wrongOwner)).resolves.toMatchObject({
      status: "standby",
      draftId: DRAFT_ID,
    });
    expect(repository.commits.at(-1)).toMatchObject({ result: "held", issue: "REDUCER_INVARIANT" });
  });

  it("returns standby when a destructive hold is not committed", async () => {
    repository.context = {
      ...repository.context!,
      events: [snakePickEvent],
      sequence: 1,
    };
    repository.commitSucceeds = false;

    await expect(service().ingest(DEVICE_TOKEN, observation({ picks: [] }))).resolves.toMatchObject(
      { status: "standby", draftId: DRAFT_ID },
    );
    expect(repository.commits.at(-1)).toMatchObject({
      result: "held",
      issue: "DESTRUCTIVE_PENDING",
    });
  });

  it("returns standby when an idempotent observation is not committed", async () => {
    repository.context = {
      ...repository.context!,
      events: [snakePickEvent],
      sequence: 1,
    };
    repository.commitSucceeds = false;

    await expect(service().ingest(DEVICE_TOKEN, observation())).resolves.toMatchObject({
      status: "standby",
      draftId: DRAFT_ID,
    });
    expect(repository.commits.at(-1)).toMatchObject({ result: "idempotent", append: [] });
  });
});

describe("manual backup mode", () => {
  const toggle = { expectedSequence: 0, idempotencyKey: "manual-backup-9f2c" } as const;

  it("freezes provider application and resumes it without touching the ledger", async () => {
    const live = service();
    expect(await live.setManualBackup(scope.userId, DRAFT_ID, { ...toggle, active: true })).toEqual(
      {
        draftId: DRAFT_ID,
        active: true,
        changed: true,
        reconciliation: null,
        pendingReconciliation: 0,
      },
    );

    const frozen = await live.ingest(DEVICE_TOKEN, observation());
    expect(frozen).toMatchObject({ status: "held", issueCode: "MANUAL_BACKUP_ACTIVE" });
    expect(repository.commits).toMatchObject([{ result: "held", append: [] }]);

    // Returning to provider sync is a flag, not a write: the toggle itself appends and reverts
    // nothing, so no manual entry can disappear behind it.
    await live.setManualBackup(scope.userId, DRAFT_ID, {
      ...toggle,
      active: false,
      reconciliation: "keep-manual",
    });
    expect(repository.commits).toHaveLength(1);

    const resumed = await live.ingest(DEVICE_TOKEN, observation());
    expect(resumed.status).toBe("accepted");
  });

  it("demands a choice before unfreezing a room with held snapshots", async () => {
    repository.withFeed({ manualBackupActive: true });
    repository.pendingReconciliation = 2;
    const live = service();

    await expect(
      live.setManualBackup(scope.userId, DRAFT_ID, { ...toggle, active: false }),
    ).rejects.toMatchObject({ code: "DRAFT_RECONCILIATION_REQUIRED", statusCode: 409 });

    const resumed = await live.setManualBackup(scope.userId, DRAFT_ID, {
      ...toggle,
      active: false,
      reconciliation: "accept-provider",
    });
    expect(resumed).toMatchObject({ changed: true, reconciliation: "accept-provider" });
  });

  it("is a no-op when the room is already in the requested mode", async () => {
    const live = service();
    expect(
      await live.setManualBackup(scope.userId, DRAFT_ID, { ...toggle, active: false }),
    ).toMatchObject({ active: false, changed: false });
  });

  it("does not require the ingest feature flag to unfreeze a room", async () => {
    repository.withFeed({ manualBackupActive: true });
    const disabled = service(false);
    await expect(disabled.ingest(DEVICE_TOKEN, observation())).rejects.toBeInstanceOf(
      EspnLiveDraftError,
    );
    expect(
      await disabled.setManualBackup(scope.userId, DRAFT_ID, { ...toggle, active: false }),
    ).toMatchObject({ active: false, changed: true });
  });
});

describe("heartbeats", () => {
  it("does not require a draft session", async () => {
    const heartbeat: EspnLiveDraftIngestRequest = {
      schemaVersion: 1,
      kind: "espn-live-draft-heartbeat",
      leagueId: "1234567",
      season: 2026,
      pageSessionId: PAGE_SESSION,
      revision: 9,
      capturedAt: "2026-08-24T18:04:59.000Z",
      state: "live",
      lastChecksumSha256: null,
    };
    const response = await service().ingest(DEVICE_TOKEN, heartbeat);
    expect(response.status).toBe("standby");
    expect(repository.heartbeatInput).toMatchObject({
      pageSessionId: PAGE_SESSION,
      revision: 9,
      lastChecksumSha256: null,
    });
    expect(repository.commits).toHaveLength(0);
  });
});
