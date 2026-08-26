import { describe, expect, it } from "vitest";

import type { LeagueMembershipRole } from "@laces-out/db";

import {
  DraftSessionService,
  effectiveRole,
  mayMutate,
  type AppendStoredEventsResult,
  type CreateDraftSessionInput,
  type CreateStoredDraftResult,
  type DraftSessionRepository,
  type LeagueDraftSource,
  type NewStoredDraft,
  type PendingDraftEvent,
  type StoredDraft,
  type StoredDraftEvent,
} from "./draft-session.js";
import type { DraftSessionError } from "./draft-session.js";

const ownerId = "00000000-0000-4000-8000-000000000001";
const commissionerId = "00000000-0000-4000-8000-000000000002";
const managerId = "00000000-0000-4000-8000-000000000003";
const viewerId = "00000000-0000-4000-8000-000000000004";
const outsiderId = "00000000-0000-4000-8000-000000000005";
const leagueId = "00000000-0000-4000-8000-000000000100";
const seasonId = "00000000-0000-4000-8000-000000000101";
const teamA = "00000000-0000-4000-8000-000000000201";
const teamB = "00000000-0000-4000-8000-000000000202";
const playerA = "00000000-0000-4000-8000-000000000301";
const playerB = "00000000-0000-4000-8000-000000000302";
const playerC = "00000000-0000-4000-8000-000000000303";
const playerD = "00000000-0000-4000-8000-000000000304";
const playerE = "00000000-0000-4000-8000-000000000305";
const clock = new Date("2026-07-16T23:00:00.000Z");

function leagueSource(
  options: {
    readonly draftType?: string;
    readonly settings?: Readonly<Record<string, unknown>>;
    readonly archived?: boolean;
  } = {},
): LeagueDraftSource {
  return {
    leagueId,
    leagueSeasonId: seasonId,
    provider: "manual",
    draftType: options.draftType ?? "snake",
    teamCount: 2,
    settings: options.settings ?? {},
    archived: options.archived ?? false,
    accessRole: "commissioner",
    teams: [
      { id: teamA, externalKey: "alpha", name: "Alpha" },
      { id: teamB, externalKey: "bravo", name: "Bravo" },
    ],
    rosterRules: [
      {
        id: "00000000-0000-4000-8000-000000000401",
        slotCode: "QB",
        count: 1,
        eligiblePositions: ["QB"],
        isStarter: true,
      },
      {
        id: "00000000-0000-4000-8000-000000000402",
        slotCode: "BN",
        count: 1,
        eligiblePositions: ["QB", "RB", "WR", "TE"],
        isStarter: false,
      },
      {
        id: "00000000-0000-4000-8000-000000000403",
        slotCode: "IR",
        count: 1,
        eligiblePositions: ["QB", "RB", "WR", "TE"],
        isStarter: false,
      },
    ],
    players: [
      {
        id: playerA,
        fullName: "Quarterback A",
        primaryPosition: "QB",
        eligiblePositions: ["QB"],
        nflTeam: "CHI",
        status: "ACTIVE",
      },
      {
        id: playerB,
        fullName: "Quarterback B",
        primaryPosition: "QB",
        eligiblePositions: ["QB"],
        nflTeam: "GB",
        status: "ACTIVE",
      },
      {
        id: playerC,
        fullName: "Quarterback C",
        primaryPosition: "QB",
        eligiblePositions: ["QB"],
        nflTeam: "MIN",
        status: "ACTIVE",
      },
      {
        id: playerD,
        fullName: "Quarterback D",
        primaryPosition: "QB",
        eligiblePositions: ["QB"],
        nflTeam: "DET",
        status: "ACTIVE",
      },
      {
        id: playerE,
        fullName: "Kicker E",
        primaryPosition: "K",
        eligiblePositions: ["K"],
        nflTeam: "DET",
        status: "ACTIVE",
      },
      {
        id: "00000000-0000-4000-8000-000000000399",
        fullName: "Unsupported Punter",
        primaryPosition: "P",
        eligiblePositions: ["P"],
        nflTeam: null,
        status: null,
      },
    ],
  };
}

class MemoryDraftRepository implements DraftSessionRepository {
  readonly roles = new Map<string, LeagueMembershipRole>([
    [ownerId, "commissioner"],
    [commissionerId, "commissioner"],
    [managerId, "member"],
    [viewerId, "member"],
  ]);
  readonly drafts = new Map<string, StoredDraft>();
  readonly events = new Map<string, StoredDraftEvent[]>();

  constructor(readonly source: LeagueDraftSource = leagueSource()) {}

  loadLeagueDraftSource(
    userId: string,
    requestedSeasonId: string,
  ): Promise<LeagueDraftSource | undefined> {
    const role = this.roles.get(userId);
    if (role === undefined || requestedSeasonId !== this.source.leagueSeasonId) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({ ...this.source, accessRole: role });
  }

  createDraft(input: NewStoredDraft): Promise<CreateStoredDraftResult> {
    const role = this.roles.get(input.actorUserId);
    if (role === undefined || input.leagueSeasonId !== this.source.leagueSeasonId) {
      return Promise.resolve({ status: "not-found" });
    }
    if (role !== "owner" && role !== "commissioner") {
      return Promise.resolve({ status: "forbidden" });
    }
    if (this.source.archived) return Promise.resolve({ status: "archived" });
    const draft: StoredDraft = {
      id: input.id,
      leagueSeasonId: input.leagueSeasonId,
      type: input.type,
      state: "created",
      budgetPerTeam: input.budgetPerTeam,
      minimumBid: input.minimumBid,
      settings: input.settings,
      createdAt: input.now,
      updatedAt: input.now,
      accessRole: role,
      archived: false,
    };
    this.drafts.set(draft.id, draft);
    this.events.set(draft.id, []);
    return Promise.resolve({ status: "saved", draft });
  }

  loadDraft(userId: string, draftId: string): Promise<StoredDraft | undefined> {
    const role = this.roles.get(userId);
    const draft = this.drafts.get(draftId);
    return Promise.resolve(
      role === undefined || draft === undefined
        ? undefined
        : { ...draft, accessRole: role, archived: this.source.archived },
    );
  }

  listEvents(draftId: string): Promise<readonly StoredDraftEvent[]> {
    return Promise.resolve(
      [...(this.events.get(draftId) ?? [])].sort((a, b) => a.sequence - b.sequence),
    );
  }

  appendEvents(input: {
    readonly actorUserId: string;
    readonly draftId: string;
    readonly expectedSequence: number;
    readonly events: readonly PendingDraftEvent[];
    readonly resultingState: "live" | "complete";
    readonly now: Date;
  }): Promise<AppendStoredEventsResult> {
    const role = this.roles.get(input.actorUserId);
    const draft = this.drafts.get(input.draftId);
    if (role === undefined || draft === undefined) return Promise.resolve({ status: "not-found" });
    if (role !== "owner" && role !== "commissioner") {
      return Promise.resolve({ status: "forbidden" });
    }
    if (this.source.archived) return Promise.resolve({ status: "archived" });
    const stream = this.events.get(input.draftId) ?? [];
    const matchingKeys = stream.filter((row) =>
      input.events.some((candidate) => candidate.idempotencyKey === row.idempotencyKey),
    );
    if (matchingKeys.length > 0) {
      return Promise.resolve(
        matchingKeys.length === input.events.length
          ? { status: "idempotent", events: matchingKeys }
          : { status: "idempotency-conflict" },
      );
    }
    if (stream.length !== input.expectedSequence) {
      return Promise.resolve({ status: "version-conflict", currentSequence: stream.length });
    }
    const inserted = input.events.map((event): StoredDraftEvent => ({
      draftId: input.draftId,
      sequence: event.sequence,
      idempotencyKey: event.idempotencyKey,
      type: event.type,
      occurredAt: event.occurredAt,
      source: event.source,
      payload: event.payload,
      revertsSequence: event.revertsSequence,
      createdAt: input.now,
    }));
    stream.push(...inserted);
    this.events.set(input.draftId, stream);
    this.drafts.set(input.draftId, {
      ...draft,
      state: input.resultingState,
      updatedAt: input.now,
    });
    return Promise.resolve({ status: "saved", events: inserted });
  }
}

function snakeCreateInput(): CreateDraftSessionInput {
  return { leagueSeasonId: seasonId, teamOrder: ["alpha", "bravo"] };
}

describe("DraftSessionService", () => {
  it("does not grant shared draft mutations from canonical ownership alone", () => {
    const ownerRole = effectiveRole(ownerId, ownerId, "owner");
    expect(ownerRole).toBe("member");
    expect(mayMutate(ownerRole!)).toBe(false);
    expect(mayMutate(effectiveRole(ownerId, ownerId, "owner", true)!)).toBe(true);
    expect(mayMutate(effectiveRole(ownerId, ownerId, "owner", false, true)!)).toBe(true);
  });

  it("snapshots snake settings and enforces league-scoped read/write authorization", async () => {
    const repository = new MemoryDraftRepository();
    const service = new DraftSessionService(repository, () => clock);

    await expect(service.createSession(outsiderId, snakeCreateInput())).rejects.toMatchObject({
      code: "DRAFT_NOT_FOUND",
    } satisfies Partial<DraftSessionError>);
    await expect(service.createSession(managerId, snakeCreateInput())).rejects.toMatchObject({
      code: "DRAFT_FORBIDDEN",
    } satisfies Partial<DraftSessionError>);

    const created = await service.createSession(ownerId, snakeCreateInput());

    expect(created).toMatchObject({
      transport: "manual",
      providerPolling: false,
      accessRole: "commissioner",
      sequence: 0,
      persistedState: "created",
      state: {
        mode: "SNAKE",
        nextPick: { overallPick: 1, teamId: teamA },
      },
    });
    expect(created.config.mode).toBe("SNAKE");
    if (created.config.mode !== "SNAKE") throw new Error("Expected snake config");
    expect(created.config.pickOrder).toEqual([teamA, teamB, teamB, teamA]);
    expect(created.config.teams[0]?.rosterSlots).toHaveLength(2);
    expect(created.config.players.map((player) => player.id)).not.toContain(
      "00000000-0000-4000-8000-000000000399",
    );
    expect(created.config.players.map((player) => player.id)).not.toContain(playerE);

    const viewerRead = await service.getSession(viewerId, created.id);
    expect(viewerRead.accessRole).toBe("member");
    await expect(
      service.appendEvent(viewerId, created.id, {
        expectedSequence: 0,
        idempotencyKey: "viewer-cannot-write",
        action: {
          type: "SNAKE_PLAYER_SELECTED",
          teamId: teamA,
          playerId: playerA,
          overallPick: 1,
        },
      }),
    ).rejects.toMatchObject({ code: "DRAFT_FORBIDDEN" } satisfies Partial<DraftSessionError>);
  });

  it("orders snake picks, blocks duplicates, and makes retries safe under optimistic concurrency", async () => {
    const repository = new MemoryDraftRepository();
    const service = new DraftSessionService(repository, () => clock);
    const created = await service.createSession(ownerId, snakeCreateInput());
    const firstInput = {
      expectedSequence: 0,
      idempotencyKey: "snake-pick-0001",
      action: {
        type: "SNAKE_PLAYER_SELECTED" as const,
        teamId: teamA,
        playerId: playerA,
        overallPick: 1,
      },
    };

    const first = await service.appendEvent(ownerId, created.id, firstInput);
    expect(first).toMatchObject({
      idempotent: false,
      appendedSequences: [1],
      session: { sequence: 1, state: { nextPick: { overallPick: 2, teamId: teamB } } },
    });
    const retried = await service.appendEvent(ownerId, created.id, firstInput);
    expect(retried).toMatchObject({ idempotent: true, appendedSequences: [1] });

    await expect(
      service.appendEvent(ownerId, created.id, {
        ...firstInput,
        action: { ...firstInput.action, playerId: playerB },
      }),
    ).rejects.toMatchObject({
      code: "DRAFT_IDEMPOTENCY_CONFLICT",
    } satisfies Partial<DraftSessionError>);
    await expect(
      service.appendEvent(ownerId, created.id, {
        expectedSequence: 0,
        idempotencyKey: "stale-snake-pick",
        action: {
          type: "SNAKE_PLAYER_SELECTED",
          teamId: teamB,
          playerId: playerB,
          overallPick: 2,
        },
      }),
    ).rejects.toMatchObject({
      code: "DRAFT_VERSION_CONFLICT",
      currentSequence: 1,
    } satisfies Partial<DraftSessionError>);
    await expect(
      service.appendEvent(ownerId, created.id, {
        expectedSequence: 1,
        idempotencyKey: "wrong-snake-turn",
        action: {
          type: "SNAKE_PLAYER_SELECTED",
          teamId: teamA,
          playerId: playerB,
          overallPick: 2,
        },
      }),
    ).rejects.toMatchObject({
      code: "DRAFT_INVARIANT",
      invariantCode: "WRONG_PICK",
    } satisfies Partial<DraftSessionError>);

    await service.appendEvent(ownerId, created.id, {
      expectedSequence: 1,
      idempotencyKey: "snake-pick-0002",
      action: {
        type: "SNAKE_PLAYER_SELECTED",
        teamId: teamB,
        playerId: playerB,
        overallPick: 2,
      },
    });
    await expect(
      service.appendEvent(ownerId, created.id, {
        expectedSequence: 2,
        idempotencyKey: "duplicate-player-pick",
        action: {
          type: "SNAKE_PLAYER_SELECTED",
          teamId: teamB,
          playerId: playerA,
          overallPick: 3,
        },
      }),
    ).rejects.toMatchObject({
      code: "DRAFT_INVARIANT",
      invariantCode: "PLAYER_ALREADY_DRAFTED",
    } satisfies Partial<DraftSessionError>);
  });

  it("derives auction budgets and enforces slot reserves, maximum bids, and unique players", async () => {
    const repository = new MemoryDraftRepository(
      leagueSource({ draftType: "auction", settings: { auctionBudget: 3, minimumBid: 1 } }),
    );
    const service = new DraftSessionService(repository, () => clock);
    const created = await service.createSession(commissionerId, { leagueSeasonId: seasonId });

    expect(created.state.teams[0]).toMatchObject({
      remainingBudget: 3,
      openSlots: 2,
      maximumBid: 2,
    });
    await expect(
      service.appendEvent(commissionerId, created.id, {
        expectedSequence: 0,
        idempotencyKey: "illegal-auction-sale",
        action: {
          type: "AUCTION_PLAYER_SOLD",
          teamId: teamA,
          playerId: playerA,
          price: 3,
        },
      }),
    ).rejects.toMatchObject({
      code: "DRAFT_INVARIANT",
      invariantCode: "BUDGET_EXCEEDED",
    } satisfies Partial<DraftSessionError>);

    const firstSale = await service.appendEvent(commissionerId, created.id, {
      expectedSequence: 0,
      idempotencyKey: "auction-sale-0001",
      action: {
        type: "AUCTION_PLAYER_SOLD",
        teamId: teamA,
        playerId: playerA,
        price: 2,
      },
    });
    expect(firstSale.session.state.teams[0]).toMatchObject({
      spent: 2,
      remainingBudget: 1,
      openSlots: 1,
      maximumBid: 1,
    });
    await expect(
      service.appendEvent(commissionerId, created.id, {
        expectedSequence: 1,
        idempotencyKey: "auction-overspend",
        action: {
          type: "AUCTION_PLAYER_SOLD",
          teamId: teamA,
          playerId: playerB,
          price: 2,
        },
      }),
    ).rejects.toMatchObject({ invariantCode: "BUDGET_EXCEEDED" });
    await expect(
      service.appendEvent(commissionerId, created.id, {
        expectedSequence: 1,
        idempotencyKey: "auction-duplicate-player",
        action: {
          type: "AUCTION_PLAYER_SOLD",
          teamId: teamB,
          playerId: playerA,
          price: 1,
        },
      }),
    ).rejects.toMatchObject({ invariantCode: "PLAYER_ALREADY_DRAFTED" });
  });

  it("persists correction and undo history append-only and replays it after reconnect", async () => {
    const repository = new MemoryDraftRepository();
    const service = new DraftSessionService(repository, () => clock);
    const created = await service.createSession(ownerId, snakeCreateInput());
    await service.appendEvent(ownerId, created.id, {
      expectedSequence: 0,
      idempotencyKey: "original-pick-0001",
      action: {
        type: "SNAKE_PLAYER_SELECTED",
        teamId: teamA,
        playerId: playerA,
        overallPick: 1,
      },
    });
    await service.appendEvent(ownerId, created.id, {
      expectedSequence: 1,
      idempotencyKey: "original-pick-0002",
      action: {
        type: "SNAKE_PLAYER_SELECTED",
        teamId: teamB,
        playerId: playerB,
        overallPick: 2,
      },
    });
    const correctionInput = {
      expectedSequence: 2,
      idempotencyKey: "correct-second-pick",
      targetSequence: 2,
      replacement: {
        type: "SNAKE_PLAYER_SELECTED" as const,
        teamId: teamB,
        playerId: playerC,
        overallPick: 2,
      },
    };

    const corrected = await service.correctEvent(ownerId, created.id, correctionInput);
    expect(corrected).toMatchObject({
      appendedSequences: [3, 4],
      session: { sequence: 4 },
    });
    expect(corrected.session.events.map((record) => record.sequence)).toEqual([1, 2, 3, 4]);
    expect(corrected.session.events[2]).toMatchObject({
      revertsSequence: 2,
      event: { type: "DRAFT_EVENT_REVERTED" },
    });
    expect(corrected.session.state.draftedPlayerIds).toEqual([playerA, playerC]);

    const retry = await service.correctEvent(ownerId, created.id, correctionInput);
    expect(retry).toMatchObject({ idempotent: true, appendedSequences: [3, 4] });
    const undone = await service.undoEvent(ownerId, created.id, {
      expectedSequence: 4,
      idempotencyKey: "undo-corrected-pick",
    });
    expect(undone).toMatchObject({
      appendedSequences: [5],
      session: { sequence: 5, state: { nextPick: { overallPick: 2, teamId: teamB } } },
    });
    expect(undone.session.state.draftedPlayerIds).toEqual([playerA]);

    const reconnected = await new DraftSessionService(repository, () => clock).getSession(
      viewerId,
      created.id,
    );
    expect(reconnected.state).toEqual(undone.session.state);
    expect(reconnected.events).toEqual(undone.session.events);
  });

  it("fails closed when stored event order or payload metadata is corrupt", async () => {
    const repository = new MemoryDraftRepository();
    const service = new DraftSessionService(repository, () => clock);
    const created = await service.createSession(ownerId, snakeCreateInput());
    repository.events.set(created.id, [
      {
        draftId: created.id,
        sequence: 2,
        idempotencyKey: "corrupt-gap-event",
        type: "SNAKE_PLAYER_SELECTED",
        occurredAt: clock,
        source: "manual",
        payload: {
          id: "manual:corrupt",
          type: "SNAKE_PLAYER_SELECTED",
          teamId: teamA,
          playerId: playerA,
          overallPick: 1,
        },
        revertsSequence: null,
        createdAt: clock,
      },
    ]);

    await expect(service.getSession(ownerId, created.id)).rejects.toMatchObject({
      code: "DRAFT_STREAM_CORRUPT",
      statusCode: 500,
    } satisfies Partial<DraftSessionError>);
  });

  it("requires an exact snake team order and refuses draft-mode conflicts", async () => {
    const repository = new MemoryDraftRepository();
    const service = new DraftSessionService(repository, () => clock);

    await expect(
      service.createSession(ownerId, { leagueSeasonId: seasonId }),
    ).rejects.toMatchObject({ code: "DRAFT_CONFIG_INVALID" } satisfies Partial<DraftSessionError>);
    await expect(
      service.createSession(ownerId, {
        leagueSeasonId: seasonId,
        teamOrder: ["alpha", "alpha"],
      }),
    ).rejects.toMatchObject({ code: "DRAFT_CONFIG_INVALID" } satisfies Partial<DraftSessionError>);
    await expect(
      service.createSession(ownerId, {
        leagueSeasonId: seasonId,
        mode: "auction",
        teamOrder: ["alpha", "bravo"],
      }),
    ).rejects.toMatchObject({ code: "DRAFT_CONFIG_INVALID" } satisfies Partial<DraftSessionError>);

    const underfundedAuction = new DraftSessionService(
      new MemoryDraftRepository(
        leagueSource({ draftType: "auction", settings: { auctionBudget: 1, minimumBid: 1 } }),
      ),
      () => clock,
    );
    await expect(
      underfundedAuction.createSession(ownerId, { leagueSeasonId: seasonId }),
    ).rejects.toMatchObject({
      code: "DRAFT_CONFIG_INVALID",
      invariantCode: "INVALID_CONFIG",
    } satisfies Partial<DraftSessionError>);
  });
});
