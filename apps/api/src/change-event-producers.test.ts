import { describe, expect, it, vi } from "vitest";

import type { ChangeEventDraft, ChangeEventEmitResult } from "@laces-out/change-events";

import {
  emitProviderSyncChangeEvents,
  emitRosterChangeEvents,
  type ChangeEventProducerRepository,
} from "./change-event-producers.js";

type EmitCall = (drafts: readonly ChangeEventDraft[], now: Date) => Promise<ChangeEventEmitResult>;

const LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const SEASON_ID = "60000000-0000-4000-8000-000000000001";
const OWNER = "10000000-0000-4000-8000-000000000001";
const MANAGER = "10000000-0000-4000-8000-000000000002";
const TEAM = "30000000-0000-4000-8000-000000000001";
const A = "40000000-0000-4000-8000-00000000000a";
const B = "40000000-0000-4000-8000-00000000000b";
const CHECKSUM = "a".repeat(64);
const OCCURRED_AT = new Date("2026-09-16T12:00:00.000Z");

const input = {
  provider: "espn" as const,
  state: "accepted" as const,
  leagueId: LEAGUE_ID,
  leagueSeasonId: SEASON_ID,
  actorUserId: OWNER,
  artifactId: CHECKSUM,
  occurredAt: OCCURRED_AT,
};

function repository(
  overrides: Partial<ChangeEventProducerRepository> = {},
): ChangeEventProducerRepository {
  return {
    listLeagueMembers: () =>
      Promise.resolve([
        { userId: OWNER, claimedFantasyTeamId: TEAM },
        { userId: MANAGER, claimedFantasyTeamId: null },
      ]),
    describeLeagueSeason: () => Promise.resolve({ season: 2026, week: 4 }),
    listSeasonTeams: () => Promise.resolve([{ teamId: TEAM, teamName: "Gridiron Ghosts" }]),
    listLatestRosterSnapshotPair: () => Promise.resolve([]),
    listRosterEntries: () => Promise.resolve([]),
    ...overrides,
  };
}

function rosterRepository(
  pair: readonly { readonly id: string }[],
  entries: Record<
    string,
    readonly { playerId: string; slotCode: string; isStarter: boolean; name: string }[]
  >,
): ChangeEventProducerRepository {
  return repository({
    listLatestRosterSnapshotPair: () => Promise.resolve(pair),
    listRosterEntries: (snapshotId: string) => Promise.resolve(entries[snapshotId] ?? []),
  });
}

describe("emitRosterChangeEvents", () => {
  it("emits one event describing the difference from the prior snapshot", async () => {
    const emit = vi.fn<EmitCall>(() =>
      Promise.resolve({ inserted: 1, duplicates: 0, receiptsCreated: 1 }),
    );
    const repo = rosterRepository([{ id: "next" }, { id: "prior" }], {
      prior: [{ playerId: A, slotCode: "RB", isStarter: true, name: "A. Back" }],
      next: [{ playerId: B, slotCode: "RB", isStarter: true, name: "B. Back" }],
    });

    await emitRosterChangeEvents({ repository: repo, emit }, input);

    const [drafts] = emit.mock.calls[0]!;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      source: "roster-diff",
      eventType: "roster.changed",
      aggregateType: "fantasy-team",
      aggregateId: TEAM,
      visibility: "league",
      severity: "info",
    });
    expect(drafts[0]!.payload).toMatchObject({
      added: [{ playerId: B, name: "B. Back" }],
      removed: [{ playerId: A, name: "A. Back" }],
      moreCount: 0,
    });
  });

  it("emits nothing when the roster is byte-identical to the prior snapshot", async () => {
    const emit = vi.fn();
    const same = [{ playerId: A, slotCode: "RB", isStarter: true, name: "A. Back" }];
    const repo = rosterRepository([{ id: "next" }, { id: "prior" }], {
      prior: same,
      next: [...same],
    });

    await emitRosterChangeEvents({ repository: repo, emit }, input);

    expect(emit).not.toHaveBeenCalled();
  });

  it("treats a first-ever snapshot as a baseline, not fifteen additions", async () => {
    const emit = vi.fn();
    const repo = rosterRepository([{ id: "next" }], {
      next: [{ playerId: A, slotCode: "RB", isStarter: true, name: "A. Back" }],
    });

    await emitRosterChangeEvents({ repository: repo, emit }, input);

    expect(emit).not.toHaveBeenCalled();
  });

  it("separates a repeated transition by the artifact that produced it", async () => {
    const keys: string[] = [];
    const emit = vi.fn<EmitCall>((drafts) => {
      keys.push(drafts[0]!.deduplicationKey);
      return Promise.resolve({ inserted: 1, duplicates: 0, receiptsCreated: 1 });
    });
    const repo = rosterRepository([{ id: "next" }, { id: "prior" }], {
      prior: [{ playerId: A, slotCode: "RB", isStarter: true, name: "A. Back" }],
      next: [{ playerId: B, slotCode: "RB", isStarter: true, name: "B. Back" }],
    });

    await emitRosterChangeEvents({ repository: repo, emit }, input);
    await emitRosterChangeEvents(
      { repository: repo, emit },
      { ...input, artifactId: "b".repeat(64) },
    );

    expect(new Set(keys).size).toBe(2);
  });
});

describe("emitProviderSyncChangeEvents", () => {
  it("does not turn a routine accepted sync into member activity", async () => {
    const emit = vi.fn();
    const onError = vi.fn();

    await emitProviderSyncChangeEvents({ repository: repository(), emit }, input, onError);

    expect(emit).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("swallows a failure so a committed ingestion still reports success", async () => {
    const onError = vi.fn();

    await emitProviderSyncChangeEvents(
      {
        repository: repository({
          listLeagueMembers: () => Promise.reject(new Error("database is down")),
        }),
        emit: vi.fn(),
      },
      input,
      onError,
    );

    expect(onError).toHaveBeenCalledTimes(1);
  });
});
