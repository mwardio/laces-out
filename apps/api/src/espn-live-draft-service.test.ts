import { createHash } from "node:crypto";

import {
  espnLiveDraftDigestSource,
  type EspnLiveDraftIngestRequest,
  type EspnLiveDraftObservation,
} from "@laces-out/contracts";
import { playerId, rosterSlotId, teamId, type RosterSlot } from "@laces-out/domain";
import type { DraftConfig } from "@laces-out/engine-draft";
import { beforeEach, describe, expect, it } from "vitest";

import type { DraftSessionEventRecord } from "./draft-session.js";
import {
  EspnLiveDraftError,
  EspnLiveDraftService,
  observationCompletenessIssue,
  type CommitProviderEventsInput,
  type EspnLiveDraftRepository,
  type LiveDraftDeviceScope,
  type LiveDraftFeedRow,
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
  authorized = true;
  pendingReconciliation = 0;
  readonly commits: CommitProviderEventsInput[] = [];
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

  loadSessionContext(): Promise<LiveDraftSessionContext | undefined> {
    return Promise.resolve(this.context);
  }

  claimLease(): Promise<{ granted: boolean; expiresAt: Date | null }> {
    return Promise.resolve({
      granted: this.leaseGranted,
      expiresAt: new Date(NOW.getTime() + 25_000),
    });
  }

  commitObservation(input: CommitProviderEventsInput): Promise<{ sequence: number }> {
    this.commits.push(input);
    return Promise.resolve({ sequence: input.expectedSequence + input.append.length });
  }

  recordHeartbeat(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  loadFeedStatus(): Promise<undefined> {
    return Promise.resolve(undefined);
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
});

describe("configuration guards", () => {
  it("rejects an auction observation against a snake room", async () => {
    const mismatched = observation({ draftType: "auction" });
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
    expect(repository.commits).toHaveLength(0);
  });
});
