import {
  canonicalEspnPayloadChecksumV1,
  type EspnSessionCredential,
  type EspnSessionSupplementalArtifact,
} from "@laces-out/connector-espn";
import { playerId, rosterSlotId, teamId } from "@laces-out/domain";
import { describe, expect, it, vi } from "vitest";

import type { DraftSessionSnapshot } from "./draft-session.js";
import {
  ESPN_DRAFT_ACTIVE_POLL_INTERVAL_SECONDS,
  EspnDraftPollService,
  type CommitServerPollInput,
  type DrizzleEspnDraftPollRepository,
  type EspnDraftCredentialPort,
  type EspnDraftReadPort,
  type EspnDraftSessionPort,
} from "./espn-draft-service.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const LEAGUE_SEASON_ID = "20000000-0000-4000-8000-000000000001";
const DRAFT_ID = "30000000-0000-4000-8000-000000000001";
const TEAM_A_ID = "40000000-0000-4000-8000-000000000001";
const TEAM_B_ID = "40000000-0000-4000-8000-000000000002";
const PLAYER_ID = "50000000-0000-4000-8000-000000000001";
const FEED_ID = "60000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "70000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-08T23:55:00.000Z");
const ESPN_CREDENTIAL: EspnSessionCredential = {
  swid: "{123e4567-e89b-42d3-a456-426614174000}",
  espnS2: "session-value-that-is-long-enough-for-validation",
};

function espnSession(): DraftSessionSnapshot {
  const teamA = teamId(TEAM_A_ID);
  const teamB = teamId(TEAM_B_ID);
  const player = playerId(PLAYER_ID);
  const slot = {
    id: rosterSlotId("slot:bench:1"),
    type: "BENCH" as const,
    label: "Bench 1",
    kind: "BENCH" as const,
    eligiblePositions: ["RB" as const],
  };
  return {
    id: DRAFT_ID,
    leagueSeasonId: LEAGUE_SEASON_ID,
    transport: "espn-live",
    providerPolling: true,
    providerFeed: {
      provider: "espn",
      state: "waiting",
      providerLeagueId: "704283",
      season: 2026,
      fresh: false,
      ageSeconds: null,
      lastAcceptedAt: null,
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
      sourceMode: "none",
      browserFresh: false,
      serverResultsFresh: false,
      pollIntervalSeconds: ESPN_DRAFT_ACTIVE_POLL_INTERVAL_SECONDS,
    },
    accessRole: "commissioner",
    sequence: 0,
    persistedState: "created",
    config: {
      mode: "AUCTION",
      teams: [
        { id: teamA, name: "Alpha", rosterSlots: [slot], budget: 200 },
        { id: teamB, name: "Bravo", rosterSlots: [slot], budget: 200 },
      ],
      players: [{ id: player, name: "Example Runner", positions: ["RB"], nflTeam: "CHI" }],
      minimumBid: 1,
    },
    state: {
      mode: "AUCTION",
      teams: [
        { teamId: teamA, name: "Alpha", roster: [], openSlots: 1, remainingBudget: 200 },
        { teamId: teamB, name: "Bravo", roster: [], openSlots: 1, remainingBudget: 200 },
      ],
      draftedPlayerIds: [],
      activeEventIds: [],
      revertedEventIds: [],
      nextPick: null,
      activeNomination: null,
      complete: false,
    },
    events: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function claim(manualBackupActive = false) {
  return {
    feedId: FEED_ID,
    draftId: DRAFT_ID,
    leagueSeasonId: LEAGUE_SEASON_ID,
    providerLeagueId: "704283",
    season: 2026,
    generation: 7,
    previousChecksum: null,
    pendingDestructiveChecksum: null,
    pendingDestructiveSeenCount: 0,
    manualBackupActive,
  };
}

function repositoryFakes() {
  return {
    duePolls: vi.fn(),
    claimPoll: vi.fn(),
    connectionForLeague: vi.fn(() =>
      Promise.resolve({ connectionId: CONNECTION_ID, userId: USER_ID }),
    ),
    teamMappings: vi.fn(() =>
      Promise.resolve(
        new Map([
          ["1", TEAM_A_ID],
          ["2", TEAM_B_ID],
        ]),
      ),
    ),
    playerMappings: vi.fn(() => Promise.resolve(new Map([["3139477", PLAYER_ID]]))),
    releaseClaim: vi.fn(() => Promise.resolve()),
    recordFailure: vi.fn(() => Promise.resolve()),
    commitPoll: vi.fn((input: CommitServerPollInput) => {
      void input;
      return Promise.resolve(true);
    }),
  };
}

function sessionPort(session: DraftSessionSnapshot) {
  return {
    getSession: vi.fn(() => Promise.resolve(session)),
  } satisfies EspnDraftSessionPort;
}

function credentialPort() {
  return {
    getSession: vi.fn(() => Promise.resolve(ESPN_CREDENTIAL)),
  } satisfies EspnDraftCredentialPort;
}

function draftPayload(input: {
  readonly state: "predraft" | "in-progress" | "complete";
  readonly scheduledAt?: number;
}): Record<string, unknown> {
  const hasPick = input.state !== "predraft";
  return {
    id: 704283,
    seasonId: 2026,
    settings: {
      draftSettings: {
        type: "AUCTION",
        auctionBudget: 200,
        date: input.scheduledAt ?? NOW.getTime() + 10 * 60_000,
        availableDate: NOW.getTime(),
        timePerSelection: 45,
      },
    },
    draftDetail: {
      ...(input.state === "complete" ? { completeDate: NOW.getTime() } : {}),
      drafted: input.state === "complete",
      inProgress: input.state === "in-progress",
      picks: hasPick
        ? [
            {
              id: 9001,
              bidAmount: 37,
              keeper: false,
              nominatingTeamId: 2,
              overallPickNumber: 1,
              playerId: 3139477,
              roundId: 1,
              roundPickNumber: 1,
              teamId: 1,
            },
          ]
        : [],
    },
  };
}

function artifact(payload: unknown): EspnSessionSupplementalArtifact {
  return {
    leagueId: "704283",
    season: 2026,
    endpoint:
      "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/704283?view=mDraftDetail",
    capturedAt: NOW.toISOString(),
    checksumSha256: canonicalEspnPayloadChecksumV1(payload),
    payload,
    kind: "completed-draft",
    week: null,
  };
}

function readPort(payload: unknown) {
  return {
    fetchCompletedDraft: vi.fn(() => Promise.resolve(artifact(payload))),
  } satisfies EspnDraftReadPort;
}

function service(input: {
  readonly session?: DraftSessionSnapshot;
  readonly repository: ReturnType<typeof repositoryFakes>;
  readonly payload: unknown;
}) {
  const sessions = sessionPort(input.session ?? espnSession());
  const credentials = credentialPort();
  const client = readPort(input.payload);
  return {
    sessions,
    credentials,
    client,
    poller: new EspnDraftPollService({
      repository: input.repository as unknown as DrizzleEspnDraftPollRepository,
      sessions,
      credentials,
      client,
      now: () => NOW,
    }),
  };
}

describe("EspnDraftPollService", () => {
  it("coalesces a refresh when another caller owns the database lease", async () => {
    const repository = repositoryFakes();
    repository.claimPoll.mockResolvedValue(undefined);
    const setup = service({ repository, payload: draftPayload({ state: "predraft" }) });

    await expect(setup.poller.refresh(USER_ID, DRAFT_ID)).resolves.toBeDefined();
    expect(repository.claimPoll).toHaveBeenCalledWith(DRAFT_ID, NOW);
    expect(setup.credentials.getSession).not.toHaveBeenCalled();
    expect(setup.client.fetchCompletedDraft).not.toHaveBeenCalled();
    expect(repository.commitPoll).not.toHaveBeenCalled();
  });

  it("turns a completed ESPN auction purchase into an append-only provider event", async () => {
    const repository = repositoryFakes();
    repository.claimPoll.mockResolvedValue(claim());
    const setup = service({ repository, payload: draftPayload({ state: "in-progress" }) });

    await setup.poller.refresh(USER_ID, DRAFT_ID);

    expect(setup.client.fetchCompletedDraft).toHaveBeenCalledWith({
      credential: ESPN_CREDENTIAL,
      leagueId: "704283",
      season: 2026,
    });
    expect(repository.commitPoll).toHaveBeenCalledOnce();
    const committed = repository.commitPoll.mock.calls[0]?.[0];
    expect(committed).toMatchObject({
      expectedSequence: 0,
      feedState: "live",
      resultingDraftState: "live",
      pickCount: 1,
      issue: null,
      unresolvedTeams: 0,
      unresolvedPlayers: 0,
      nextPollAt: new Date(NOW.getTime() + ESPN_DRAFT_ACTIVE_POLL_INTERVAL_SECONDS * 1_000),
    });
    expect(committed?.append).toHaveLength(1);
    expect(committed?.append[0]).toMatchObject({
      source: "espn",
      event: {
        type: "AUCTION_PLAYER_SOLD",
        teamId: TEAM_A_ID,
        playerId: PLAYER_ID,
        price: 37,
      },
    });
  });

  it("sleeps until five minutes before a scheduled draft instead of hammering ESPN", async () => {
    const scheduledAt = NOW.getTime() + 30 * 60_000;
    const repository = repositoryFakes();
    repository.claimPoll.mockResolvedValue(claim());
    const setup = service({
      repository,
      payload: draftPayload({ state: "predraft", scheduledAt }),
    });

    await setup.poller.refresh(USER_ID, DRAFT_ID);

    expect(repository.commitPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        append: [],
        feedState: "waiting",
        resultingDraftState: "created",
        issue: null,
        nextPollAt: new Date(scheduledAt - 5 * 60_000),
      }),
    );
  });

  it("keeps provider facts out of the ledger while commissioner manual backup is active", async () => {
    const repository = repositoryFakes();
    repository.claimPoll.mockResolvedValue(claim(true));
    const baseSession = espnSession();
    if (baseSession.providerFeed?.provider !== "espn") throw new Error("Expected ESPN feed");
    const session: DraftSessionSnapshot = {
      ...baseSession,
      providerFeed: { ...baseSession.providerFeed, manualBackupActive: true },
    };
    const setup = service({
      session,
      repository,
      payload: draftPayload({ state: "in-progress" }),
    });

    await setup.poller.refresh(USER_ID, DRAFT_ID);

    expect(repository.commitPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        append: [],
        resultingDraftState: "created",
        issue: "MANUAL_BACKUP_ACTIVE",
      }),
    );
  });

  it("fails closed when an observed ESPN player does not have an exact roster-pool identity", async () => {
    const repository = repositoryFakes();
    repository.claimPoll.mockResolvedValue(claim());
    repository.playerMappings.mockResolvedValue(new Map());
    const setup = service({ repository, payload: draftPayload({ state: "in-progress" }) });

    await setup.poller.refresh(USER_ID, DRAFT_ID);

    expect(repository.commitPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        append: [],
        feedState: "degraded",
        issue: "UNRESOLVED_PLAYER",
        unresolvedPlayers: 1,
      }),
    );
  });
});
