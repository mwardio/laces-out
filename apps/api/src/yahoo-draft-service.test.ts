import { draftEventId, playerId, rosterSlotId, teamId } from "@laces-out/domain";
import { YahooReadClientError } from "@laces-out/connector-yahoo";
import { describe, expect, it, vi } from "vitest";

import type { DraftSessionSnapshot } from "./draft-session.js";
import {
  YahooDraftPollService,
  type DrizzleYahooDraftPollRepository,
  type YahooDraftReadPort,
  type YahooDraftSessionPort,
  type YahooDraftTokenPort,
} from "./yahoo-draft-service.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const LEAGUE_SEASON_ID = "20000000-0000-4000-8000-000000000001";
const DRAFT_ID = "30000000-0000-4000-8000-000000000001";
const TEAM_A_ID = "40000000-0000-4000-8000-000000000001";
const TEAM_B_ID = "40000000-0000-4000-8000-000000000002";
const PLAYER_ID = "50000000-0000-4000-8000-000000000001";
const FEED_ID = "60000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "70000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-05T14:00:00.000Z");

function yahooSession(): DraftSessionSnapshot {
  const teamA = teamId(TEAM_A_ID);
  const teamB = teamId(TEAM_B_ID);
  const player = playerId(PLAYER_ID);
  const rosterSlot = {
    id: rosterSlotId("slot:qb:1"),
    type: "QB" as const,
    label: "QB 1",
    kind: "STARTER" as const,
    eligiblePositions: ["QB" as const],
  };
  return {
    id: DRAFT_ID,
    leagueSeasonId: LEAGUE_SEASON_ID,
    transport: "yahoo-assisted",
    providerPolling: true,
    providerFeed: {
      provider: "yahoo",
      state: "live",
      providerLeagueId: "449.l.12345",
      season: 2026,
      fresh: true,
      ageSeconds: 5,
      lastAcceptedAt: NOW.toISOString(),
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
      applicationMode: "shadow",
      releaseState: "shadow-only",
      pollIntervalSeconds: 60,
    },
    accessRole: "owner",
    sequence: 0,
    persistedState: "created",
    config: {
      mode: "SNAKE",
      teams: [
        { id: teamA, name: "Alpha", rosterSlots: [rosterSlot] },
        { id: teamB, name: "Bravo", rosterSlots: [rosterSlot] },
      ],
      players: [{ id: player, name: "Alpha Arm", positions: ["QB"], nflTeam: "CHI" }],
      pickOrder: [teamA, teamB],
    },
    state: {
      mode: "SNAKE",
      teams: [
        { teamId: teamA, name: "Alpha", roster: [], openSlots: 1 },
        { teamId: teamB, name: "Bravo", roster: [], openSlots: 1 },
      ],
      draftedPlayerIds: [],
      activeEventIds: [],
      revertedEventIds: [],
      nextPick: { overallPick: 1, teamId: teamA },
      activeNomination: null,
      complete: false,
    },
    events: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function repositoryFakes() {
  return {
    claimPoll: vi.fn(),
    connectionForLeague: vi.fn(),
    teamMappings: vi.fn(),
    playerMappings: vi.fn(),
    persistPlayerMappings: vi.fn(),
    recordFailure: vi.fn(() => Promise.resolve()),
    releaseClaim: vi.fn(() => Promise.resolve()),
    commitObservation: vi.fn((input: unknown) => {
      void input;
      return Promise.resolve();
    }),
  };
}

function sessionPort(session: DraftSessionSnapshot) {
  return {
    getSession: vi.fn(() => Promise.resolve(session)),
  } satisfies YahooDraftSessionPort;
}

function tokenPort() {
  return {
    getAccessToken: vi.fn(() => Promise.resolve("server-only-yahoo-token")),
  } satisfies YahooDraftTokenPort;
}

function readPort() {
  return {
    getLeagueDraftResults: vi.fn(),
    getLeaguePlayersByKeys: vi.fn(),
  } satisfies YahooDraftReadPort;
}

function pollClaim() {
  return {
    feedId: FEED_ID,
    draftId: DRAFT_ID,
    leagueSeasonId: LEAGUE_SEASON_ID,
    providerLeagueKey: "449.l.12345",
    season: 2026,
    format: "snake" as const,
    applicationMode: "shadow" as const,
    releaseArtifactChecksum: "a".repeat(64),
    standardScopeConfirmed: true,
    generation: 7,
    previousChecksum: null,
  };
}

function artifact(xml: string) {
  return {
    xml,
    endpoint: "/fantasy/v2/league/449.l.12345/draftresults",
    fetchedAt: NOW.toISOString(),
    contentType: "application/xml",
    etag: null,
    lastModified: null,
  };
}

function onePickXml(status = "drafting"): string {
  return `<?xml version="1.0"?>
    <fantasy_content refresh_rate="60">
      <league>
        <league_key>449.l.12345</league_key><league_id>12345</league_id>
        <draft_status>${status}</draft_status>
        <draft_results count="1"><draft_result>
          <pick>1</pick><round>1</round><team_key>449.l.12345.t.1</team_key>
          <player_key>449.p.9001</player_key>
        </draft_result></draft_results>
      </league>
    </fantasy_content>`;
}

function emptyDraftXml(status: string, refreshRateSeconds: number): string {
  return `<?xml version="1.0"?>
    <fantasy_content refresh_rate="${refreshRateSeconds}">
      <league>
        <league_key>449.l.12345</league_key><league_id>12345</league_id>
        <draft_status>${status}</draft_status>
        <draft_results count="0"></draft_results>
      </league>
    </fantasy_content>`;
}

function manyPickXml(count: number): string {
  const results = Array.from({ length: count }, (_, index) => {
    const pick = index + 1;
    const round = Math.ceil(pick / 2);
    const team = round % 2 === 1 ? (pick % 2 === 1 ? 1 : 2) : pick % 2 === 1 ? 2 : 1;
    return `<draft_result><pick>${pick}</pick><round>${round}</round><team_key>449.l.12345.t.${team}</team_key><player_key>449.p.${9000 + pick}</player_key></draft_result>`;
  }).join("");
  return `<?xml version="1.0"?><fantasy_content refresh_rate="60"><league><league_key>449.l.12345</league_key><league_id>12345</league_id><draft_status>drafting</draft_status><draft_results count="${count}">${results}</draft_results></league></fantasy_content>`;
}

describe("YahooDraftPollService", () => {
  it("coalesces a not-due refresh without reading Yahoo or refreshing a token", async () => {
    const session = yahooSession();
    const repository = repositoryFakes();
    repository.claimPoll.mockResolvedValue(undefined);
    const sessions = sessionPort(session);
    const tokens = tokenPort();
    const client = readPort();
    const service = new YahooDraftPollService({
      repository: repository as unknown as DrizzleYahooDraftPollRepository,
      sessions,
      tokens,
      client,
      now: () => NOW,
    });

    await expect(service.refresh(USER_ID, DRAFT_ID)).resolves.toBe(session);
    expect(sessions.getSession).toHaveBeenCalledOnce();
    expect(repository.claimPoll).toHaveBeenCalledWith(DRAFT_ID, NOW);
    expect(repository.connectionForLeague).not.toHaveBeenCalled();
    expect(tokens.getAccessToken).not.toHaveBeenCalled();
    expect(client.getLeagueDraftResults).not.toHaveBeenCalled();
    expect(repository.commitObservation).not.toHaveBeenCalled();
  });

  it("fails closed when no healthy authorized Yahoo connection can service a claimed poll", async () => {
    const session = yahooSession();
    const claim = pollClaim();
    const repository = repositoryFakes();
    repository.claimPoll.mockResolvedValue(claim);
    repository.connectionForLeague.mockResolvedValue(undefined);
    const sessions = sessionPort(session);
    const tokens = tokenPort();
    const client = readPort();
    const service = new YahooDraftPollService({
      repository: repository as unknown as DrizzleYahooDraftPollRepository,
      sessions,
      tokens,
      client,
      now: () => NOW,
    });

    await expect(service.refresh(USER_ID, DRAFT_ID)).resolves.toBe(session);
    expect(repository.recordFailure).toHaveBeenCalledWith({
      claim,
      connectionId: null,
      issue: "PROVIDER_UNAVAILABLE",
      failureClass: "connection-unavailable",
      checkedAt: NOW,
    });
    expect(sessions.getSession).toHaveBeenCalledTimes(2);
    expect(tokens.getAccessToken).not.toHaveBeenCalled();
    expect(client.getLeagueDraftResults).not.toHaveBeenCalled();
    expect(repository.commitObservation).not.toHaveBeenCalled();
  });

  it("records a bounded poll failure and never mutates the ledger when Yahoo rejects a read", async () => {
    const session = yahooSession();
    const claim = pollClaim();
    const repository = repositoryFakes();
    repository.claimPoll.mockResolvedValue(claim);
    repository.connectionForLeague.mockResolvedValue({
      connectionId: CONNECTION_ID,
      userId: USER_ID,
    });
    const sessions = sessionPort(session);
    const tokens = tokenPort();
    const client = readPort();
    client.getLeagueDraftResults.mockRejectedValue(
      new YahooReadClientError({
        code: "UPSTREAM_ERROR",
        message: "sensitive upstream response must not escape",
        status: 503,
        retryable: true,
      }),
    );
    const service = new YahooDraftPollService({
      repository: repository as unknown as DrizzleYahooDraftPollRepository,
      sessions,
      tokens,
      client,
      now: () => NOW,
    });

    const result = await service.refresh(USER_ID, DRAFT_ID);
    expect(result).toBe(session);
    expect(tokens.getAccessToken).toHaveBeenCalledWith(USER_ID, CONNECTION_ID, {
      minimumValiditySeconds: 120,
    });
    expect(client.getLeagueDraftResults).toHaveBeenCalledWith(
      { accessToken: "server-only-yahoo-token" },
      "449.l.12345",
    );
    expect(repository.recordFailure).toHaveBeenCalledWith({
      claim,
      connectionId: CONNECTION_ID,
      issue: "POLL_FAILED",
      failureClass: "transport",
      checkedAt: NOW,
      retryAfterMs: null,
    });
    expect(repository.teamMappings).not.toHaveBeenCalled();
    expect(repository.commitObservation).not.toHaveBeenCalled();
    expect(sessions.getSession).toHaveBeenCalledTimes(2);
  });

  it("classifies throttling for durable internal telemetry without exposing provider detail", async () => {
    const session = yahooSession();
    const claim = pollClaim();
    const repository = repositoryFakes();
    repository.claimPoll.mockResolvedValue(claim);
    repository.connectionForLeague.mockResolvedValue({
      connectionId: CONNECTION_ID,
      userId: USER_ID,
    });
    const client = readPort();
    client.getLeagueDraftResults.mockRejectedValue(
      new YahooReadClientError({
        code: "RATE_LIMITED",
        message: "sensitive Yahoo throttle body",
        status: 429,
        retryable: true,
        retryAfterMs: Number.MAX_SAFE_INTEGER,
      }),
    );
    const service = new YahooDraftPollService({
      repository: repository as unknown as DrizzleYahooDraftPollRepository,
      sessions: sessionPort(session),
      tokens: tokenPort(),
      client,
      now: () => NOW,
    });

    await service.refresh(USER_ID, DRAFT_ID);

    expect(repository.recordFailure).toHaveBeenCalledWith({
      claim,
      connectionId: CONNECTION_ID,
      issue: "POLL_FAILED",
      failureClass: "rate-limited",
      checkedAt: NOW,
      retryAfterMs: 15 * 60 * 1_000,
    });
  });

  it("uses a 15-second provider cadence only for a valid active-draft observation", async () => {
    const session = yahooSession();
    const claim = pollClaim();
    const repository = repositoryFakes();
    repository.claimPoll.mockResolvedValue(claim);
    repository.connectionForLeague.mockResolvedValue({
      connectionId: CONNECTION_ID,
      userId: USER_ID,
    });
    repository.teamMappings.mockResolvedValue(
      new Map([
        ["449.l.12345.t.1", TEAM_A_ID],
        ["449.l.12345.t.2", TEAM_B_ID],
      ]),
    );
    repository.playerMappings.mockResolvedValue(new Map([["449.p.9001", PLAYER_ID]]));
    const sessions = sessionPort(session);
    const client = readPort();
    client.getLeagueDraftResults.mockResolvedValue(artifact(onePickXml()));
    const service = new YahooDraftPollService({
      repository: repository as unknown as DrizzleYahooDraftPollRepository,
      sessions,
      tokens: tokenPort(),
      client,
      now: () => NOW,
    });

    await service.refresh(USER_ID, DRAFT_ID);

    expect(repository.commitObservation).toHaveBeenCalledOnce();
    expect(repository.commitObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        claim,
        expectedSequence: 0,
        resultingDraftState: "live",
        pollIntervalSeconds: 15,
      }),
    );
    expect(repository.commitObservation.mock.calls[0]?.[0]).toMatchObject({
      reconciliation: { kind: "append" },
    });
    expect(repository.recordFailure).not.toHaveBeenCalled();
  });

  it("holds an unknown provider status and keeps the slower cadence", async () => {
    const session = yahooSession();
    const repository = repositoryFakes();
    repository.claimPoll.mockResolvedValue(pollClaim());
    repository.connectionForLeague.mockResolvedValue({
      connectionId: CONNECTION_ID,
      userId: USER_ID,
    });
    repository.teamMappings.mockResolvedValue(new Map());
    repository.playerMappings.mockResolvedValue(new Map([["449.p.9001", PLAYER_ID]]));
    const client = readPort();
    client.getLeagueDraftResults.mockResolvedValue(artifact(onePickXml("new_status")));
    const service = new YahooDraftPollService({
      repository: repository as unknown as DrizzleYahooDraftPollRepository,
      sessions: sessionPort(session),
      tokens: tokenPort(),
      client,
      now: () => NOW,
    });

    await service.refresh(USER_ID, DRAFT_ID);

    expect(repository.commitObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        pollIntervalSeconds: 60,
      }),
    );
    expect(repository.commitObservation.mock.calls[0]?.[0]).toMatchObject({
      reconciliation: { kind: "held", issue: "PROVIDER_STATUS_UNSUPPORTED" },
    });
  });

  it("honors Yahoo's bounded refresh hint while waiting", async () => {
    const repository = repositoryFakes();
    repository.claimPoll.mockResolvedValue(pollClaim());
    repository.connectionForLeague.mockResolvedValue({
      connectionId: CONNECTION_ID,
      userId: USER_ID,
    });
    repository.teamMappings.mockResolvedValue(new Map());
    repository.playerMappings.mockResolvedValue(new Map());
    const client = readPort();
    client.getLeagueDraftResults.mockResolvedValue(artifact(emptyDraftXml("predraft", 900)));
    const service = new YahooDraftPollService({
      repository: repository as unknown as DrizzleYahooDraftPollRepository,
      sessions: sessionPort(yahooSession()),
      tokens: tokenPort(),
      client,
      now: () => NOW,
    });

    await service.refresh(USER_ID, DRAFT_ID);

    expect(repository.commitObservation).toHaveBeenCalledWith(
      expect.objectContaining({ pollIntervalSeconds: 900 }),
    );
  });

  it("bounds identity catch-up to one 25-player metadata request per poll", async () => {
    const session = yahooSession();
    const claim = pollClaim();
    const repository = repositoryFakes();
    repository.claimPoll.mockResolvedValue(claim);
    repository.connectionForLeague.mockResolvedValue({
      connectionId: CONNECTION_ID,
      userId: USER_ID,
    });
    repository.teamMappings.mockResolvedValue(
      new Map([
        ["449.l.12345.t.1", TEAM_A_ID],
        ["449.l.12345.t.2", TEAM_B_ID],
      ]),
    );
    repository.playerMappings.mockResolvedValue(new Map());
    const client = readPort();
    client.getLeagueDraftResults.mockResolvedValue(artifact(manyPickXml(26)));
    client.getLeaguePlayersByKeys.mockRejectedValue(
      new YahooReadClientError({
        code: "UPSTREAM_ERROR",
        message: "bounded test stop",
        status: 503,
        retryable: true,
      }),
    );
    const service = new YahooDraftPollService({
      repository: repository as unknown as DrizzleYahooDraftPollRepository,
      sessions: sessionPort(session),
      tokens: tokenPort(),
      client,
      now: () => NOW,
    });

    await service.refresh(USER_ID, DRAFT_ID);

    expect(client.getLeaguePlayersByKeys).toHaveBeenCalledOnce();
    expect(client.getLeaguePlayersByKeys).toHaveBeenCalledWith(
      { accessToken: "server-only-yahoo-token" },
      "449.l.12345",
      Array.from({ length: 25 }, (_, index) => `449.p.${9001 + index}`),
    );
    expect(repository.persistPlayerMappings).not.toHaveBeenCalled();
    expect(repository.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ claim, issue: "POLL_FAILED" }),
    );
  });

  it("holds after a commissioner reverts a Yahoo-authored pick instead of reapplying it", async () => {
    const selectedId = draftEventId("yahoo-selected-one");
    const session: DraftSessionSnapshot = {
      ...yahooSession(),
      sequence: 2,
      events: [
        {
          sequence: 1,
          idempotencyKey: "yahoo-draft:original-pick",
          source: "yahoo",
          occurredAt: NOW.toISOString(),
          revertsSequence: null,
          event: {
            id: selectedId,
            type: "SNAKE_PLAYER_SELECTED",
            teamId: teamId(TEAM_A_ID),
            playerId: playerId(PLAYER_ID),
            overallPick: 1,
            occurredAt: NOW.toISOString(),
          },
        },
        {
          sequence: 2,
          idempotencyKey: "manual:undo-yahoo-pick",
          source: "manual",
          occurredAt: NOW.toISOString(),
          revertsSequence: 1,
          event: {
            id: draftEventId("manual-revert-yahoo-pick"),
            type: "DRAFT_EVENT_REVERTED",
            targetEventId: selectedId,
            occurredAt: NOW.toISOString(),
          },
        },
      ],
    };
    const repository = repositoryFakes();
    repository.claimPoll.mockResolvedValue(pollClaim());
    repository.connectionForLeague.mockResolvedValue({
      connectionId: CONNECTION_ID,
      userId: USER_ID,
    });
    repository.teamMappings.mockResolvedValue(new Map([["449.l.12345.t.1", TEAM_A_ID]]));
    repository.playerMappings.mockResolvedValue(new Map([["449.p.9001", PLAYER_ID]]));
    const client = readPort();
    client.getLeagueDraftResults.mockResolvedValue(artifact(onePickXml()));
    const service = new YahooDraftPollService({
      repository: repository as unknown as DrizzleYahooDraftPollRepository,
      sessions: sessionPort(session),
      tokens: tokenPort(),
      client,
      now: () => NOW,
    });

    await service.refresh(USER_ID, DRAFT_ID);

    expect(repository.commitObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSequence: 2,
        pollIntervalSeconds: 60,
      }),
    );
    expect(repository.commitObservation.mock.calls[0]?.[0]).toMatchObject({
      reconciliation: { kind: "held", issue: "HISTORY_DIVERGED" },
    });
  });

  it("surfaces internal failures after safely releasing the provider lease", async () => {
    const session = yahooSession();
    const claim = pollClaim();
    const repository = repositoryFakes();
    repository.claimPoll.mockResolvedValue(claim);
    repository.connectionForLeague.mockResolvedValue({
      connectionId: CONNECTION_ID,
      userId: USER_ID,
    });
    repository.teamMappings.mockRejectedValue(new Error("database invariant failed"));
    const client = readPort();
    client.getLeagueDraftResults.mockResolvedValue(artifact(onePickXml()));
    const service = new YahooDraftPollService({
      repository: repository as unknown as DrizzleYahooDraftPollRepository,
      sessions: sessionPort(session),
      tokens: tokenPort(),
      client,
      now: () => NOW,
    });

    await expect(service.refresh(USER_ID, DRAFT_ID)).rejects.toThrow("database invariant failed");
    expect(repository.releaseClaim).toHaveBeenCalledWith(claim, NOW);
    expect(repository.recordFailure).not.toHaveBeenCalled();
    expect(repository.commitObservation).not.toHaveBeenCalled();
  });
});
