import { describe, expect, it } from "vitest";

import {
  ChangeEventService,
  type ChangeEventRepository,
  type ChangeEventRepositoryQuery,
  type ChangeEventRow,
} from "./change-events.js";

const USER = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-00000000000f";
const LEAGUE = "20000000-0000-4000-8000-000000000001";
const OTHER_LEAGUE = "20000000-0000-4000-8000-00000000000f";
const NOW = new Date("2026-09-16T12:00:00.000Z");

const rows: readonly ChangeEventRow[] = [
  {
    id: "50000000-0000-4000-8000-000000000001",
    eventType: "roster.changed",
    severity: "info",
    visibility: "league",
    leagueId: LEAGUE,
    occurredAt: new Date("2026-09-16T11:00:00.000Z"),
    payload: {
      v: 1,
      teamId: "30000000-0000-4000-8000-000000000001",
      teamName: "Ghosts",
      season: 2026,
      week: 4,
      added: [],
      removed: [],
      promoted: [],
      benched: [],
      moreCount: 0,
    },
    firstSeenAt: null,
    readAt: null,
    dismissedAt: null,
  },
];

function repository(overrides: Partial<ChangeEventRepository> = {}): ChangeEventRepository {
  return {
    listVisibleEvents: () => Promise.resolve(rows),
    countUnread: () => Promise.resolve(1),
    findVisibleEvent: () => Promise.resolve(rows[0]),
    upsertReceipt: () => Promise.resolve(NOW),
    updateReceipt: () => Promise.resolve(NOW),
    ...overrides,
  };
}

describe("ChangeEventService.list", () => {
  it("returns a bounded page with an unread count", async () => {
    const service = new ChangeEventService(repository(), () => NOW);

    const feed = await service.list(USER, { limit: null, cursor: null, leagueId: null });

    expect(feed.generatedAt).toBe("2026-09-16T12:00:00.000Z");
    expect(feed.unreadCount).toBe(1);
    expect(feed.events).toHaveLength(1);
    expect(feed.events[0]).toMatchObject({ state: "unread", eventType: "roster.changed" });
    expect(feed.nextCursor).toBeNull();
  });

  it("bounds the read window by retention as well as by limit", async () => {
    let seenFloor: Date | null = null;
    const service = new ChangeEventService(
      repository({
        listVisibleEvents: (_user: string, query: ChangeEventRepositoryQuery) => {
          seenFloor = query.retentionFloor;
          return Promise.resolve([]);
        },
      }),
      () => NOW,
    );

    await service.list(USER, { limit: null, cursor: null, leagueId: null });
    expect(seenFloor).toEqual(new Date("2026-08-02T12:00:00.000Z"));
  });

  it("clamps an oversized limit and rejects a forged cursor without querying", async () => {
    let seenLimit = 0;
    let seenCursor: Date | null = null;
    const service = new ChangeEventService(
      repository({
        listVisibleEvents: (_user: string, query: ChangeEventRepositoryQuery) => {
          seenLimit = query.limit;
          seenCursor = query.cursorOccurredAt;
          return Promise.resolve([]);
        },
      }),
      () => NOW,
    );

    await service.list(USER, { limit: 5_000, cursor: null, leagueId: null });
    expect(seenLimit).toBeLessThanOrEqual(50);

    const forged = await service.list(USER, { limit: null, cursor: "../../etc", leagueId: null });
    expect(forged.events).toEqual([]);
    expect(forged.nextCursor).toBeNull();
    // The forged cursor never becomes a bound; the caller simply gets the first page.
    expect(seenCursor).toBeNull();
  });

  it("emits a next cursor only when the page is full", async () => {
    const service = new ChangeEventService(repository(), () => NOW);

    const full = await service.list(USER, { limit: 1, cursor: null, leagueId: null });
    expect(full.nextCursor).not.toBeNull();

    const short = await service.list(USER, { limit: 20, cursor: null, leagueId: null });
    expect(short.nextCursor).toBeNull();
  });

  it("counts unread over the same league scope the page is drawn from", async () => {
    // The badge and the rows beneath it have to answer the same question. Counting unread across
    // every league while listing one league's rows produced "4 unread" above "Nothing new since
    // your last sync" on the overview page.
    let countedLeague: string | null | undefined;
    let listedLeague: string | null | undefined;
    const service = new ChangeEventService(
      repository({
        listVisibleEvents: (_user: string, query: ChangeEventRepositoryQuery) => {
          listedLeague = query.leagueId;
          return Promise.resolve([]);
        },
        countUnread: (_user: string, leagueId: string | null) => {
          countedLeague = leagueId;
          return Promise.resolve(0);
        },
      }),
      () => NOW,
    );

    await service.list(USER, { limit: null, cursor: null, leagueId: LEAGUE });
    expect(countedLeague).toBe(LEAGUE);
    expect(listedLeague).toBe(LEAGUE);

    await service.list(USER, { limit: null, cursor: null, leagueId: null });
    expect(countedLeague).toBeNull();
    expect(listedLeague).toBeNull();
  });

  it("renders an unparseable legacy payload without dropping the row", async () => {
    const service = new ChangeEventService(
      repository({
        listVisibleEvents: () => Promise.resolve([{ ...rows[0]!, payload: { v: 99 } }]),
      }),
      () => NOW,
    );

    const feed = await service.list(USER, { limit: null, cursor: null, leagueId: null });

    expect(feed.events).toHaveLength(1);
    expect(feed.events[0]!.headline).toBe("An update is available");
    expect(feed.events[0]!.detail).toBeNull();
  });
});

describe("ChangeEventService isolation", () => {
  it("never widens the query beyond the calling user", async () => {
    let seenUser: string | null = null;
    const service = new ChangeEventService(
      repository({
        listVisibleEvents: (user: string) => {
          seenUser = user;
          return Promise.resolve([]);
        },
      }),
      () => NOW,
    );

    // The repository predicate, not the service, is what excludes another member's private event —
    // so what this asserts is that the service asks for the caller only.
    const feed = await service.list(OTHER, { limit: null, cursor: null, leagueId: LEAGUE });
    expect(feed.events).toEqual([]);
    expect(seenUser).toBe(OTHER);
  });

  it("returns undefined for an event the caller cannot see", async () => {
    const service = new ChangeEventService(
      repository({ findVisibleEvent: () => Promise.resolve(undefined) }),
      () => NOW,
    );

    await expect(
      service.markRead(OTHER, "50000000-0000-4000-8000-000000000001"),
    ).resolves.toBeUndefined();
    await expect(
      service.dismiss(OTHER, "50000000-0000-4000-8000-000000000001"),
    ).resolves.toBeUndefined();
  });

  it("passes a league filter straight through rather than treating it as authorization", async () => {
    let seenLeague: string | null = null;
    const service = new ChangeEventService(
      repository({
        listVisibleEvents: (_user: string, query: ChangeEventRepositoryQuery) => {
          seenLeague = query.leagueId;
          return Promise.resolve([]);
        },
      }),
      () => NOW,
    );

    await service.list(USER, { limit: null, cursor: null, leagueId: OTHER_LEAGUE });
    expect(seenLeague).toBe(OTHER_LEAGUE);
  });

  it("updates rather than inserts a receipt for a private event", async () => {
    const calls: string[] = [];
    const privateRow: ChangeEventRow = { ...rows[0]!, visibility: "private" };
    const service = new ChangeEventService(
      repository({
        findVisibleEvent: () => Promise.resolve(privateRow),
        updateReceipt: () => {
          calls.push("update");
          return Promise.resolve(NOW);
        },
        upsertReceipt: () => {
          calls.push("upsert");
          return Promise.resolve(NOW);
        },
      }),
      () => NOW,
    );

    await service.dismiss(USER, privateRow.id);
    // An insert here would let a caller manufacture a receipt for an event they cannot see.
    expect(calls).toEqual(["update"]);
  });

  it("creates a receipt lazily for a league or global event", async () => {
    const calls: string[] = [];
    const service = new ChangeEventService(
      repository({
        updateReceipt: () => {
          calls.push("update");
          return Promise.resolve(NOW);
        },
        upsertReceipt: () => {
          calls.push("upsert");
          return Promise.resolve(NOW);
        },
      }),
      () => NOW,
    );

    const receipt = await service.markRead(USER, rows[0]!.id);
    expect(calls).toEqual(["upsert"]);
    expect(receipt).toEqual({
      eventId: rows[0]!.id,
      state: "read",
      at: "2026-09-16T12:00:00.000Z",
    });
  });
});
