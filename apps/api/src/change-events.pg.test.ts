/**
 * Real disposable-PostgreSQL isolation tests for the change-event feed.
 *
 * The visibility rule is one SQL predicate, so it can only be proved against real PostgreSQL: an
 * in-memory fake would prove the fake agrees with itself. This suite drives the actual
 * `DrizzleChangeEventRepository` and `ChangeEventService` against seeded users, leagues, and
 * memberships, and asserts the four things WP5's exit criteria name — cross-user isolation,
 * cross-league isolation, a dismissal that survives a re-sync, and the retention read window.
 *
 * Safety: the container is created with an explicit, freshly generated, task-specific connection
 * string on a docker-assigned host port. No code here reads `process.env.DATABASE_URL` or any
 * `.env` file, and the container is force-removed in `afterAll` even if setup or a test throws.
 * The suite skips itself cleanly (via `describe.skipIf`) when docker is unavailable.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { emitChangeEvents, type ChangeEventDraft } from "@fantasy/change-events";
import {
  changeEvents,
  createDatabase,
  leagueMemberships,
  leagues,
  users,
  type Database,
} from "@fantasy/db";
import { desc, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ChangeEventService,
  DrizzleChangeEventRepository,
  type ChangeEventRepositoryQuery,
} from "./change-events.js";

function dockerIsAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = dockerIsAvailable();

if (!dockerAvailable) {
  console.warn(
    "[change-events.pg.test] Skipping disposable-PostgreSQL isolation tests: docker is unavailable.",
  );
}

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

interface DisposablePostgres {
  readonly containerName: string;
  readonly url: string;
}

async function startDisposablePostgres(): Promise<DisposablePostgres> {
  const containerName = `laces-out-change-feed-pg-${randomUUID().slice(0, 8)}`;
  const user = "laces_test";
  const password = randomBytes(16).toString("hex");
  const databaseName = "laces_test";

  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "-e",
      `POSTGRES_USER=${user}`,
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-e",
      `POSTGRES_DB=${databaseName}`,
      "-p",
      "127.0.0.1::5432",
      "postgres:16",
    ],
    { stdio: "ignore" },
  );

  const readyDeadline = Date.now() + 30_000;
  for (;;) {
    try {
      execFileSync(
        "docker",
        ["exec", containerName, "pg_isready", "-U", user, "-d", databaseName],
        { stdio: "ignore" },
      );
      break;
    } catch {
      if (Date.now() > readyDeadline) {
        throw new Error(`Disposable PostgreSQL container ${containerName} did not become ready`);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  const portMapping = execFileSync("docker", ["port", containerName, "5432/tcp"], {
    encoding: "utf8",
  }).trim();
  const port = Number(portMapping.split(":").pop());
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Could not determine the published host port for ${containerName}`);
  }
  const url = `postgres://${user}:${password}@127.0.0.1:${port}/${databaseName}`;

  const connectDeadline = Date.now() + 20_000;
  for (;;) {
    const probe = postgres(url, { max: 1, prepare: false, connect_timeout: 2 });
    try {
      await probe`select 1`;
      await probe.end({ timeout: 1 });
      break;
    } catch (error) {
      await probe.end({ timeout: 1 }).catch(() => {});
      if (Date.now() > connectDeadline) {
        throw new Error(`Could not connect to ${containerName}: ${String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  return { containerName, url };
}

const NOW = new Date("2031-09-16T12:00:00.000Z");
const LATER = new Date("2031-09-16T18:00:00.000Z");
/** Comfortably outside `CHANGE_EVENT_RETENTION_DAYS`. */
const LONG_AGO = new Date("2031-01-01T12:00:00.000Z");

const ownerId = "10000000-0000-4000-8000-0000000000e1";
const managerId = "10000000-0000-4000-8000-0000000000e2";
const outsiderId = "10000000-0000-4000-8000-0000000000e3";
const leagueId = "20000000-0000-4000-8000-0000000000f1";
const otherLeagueId = "20000000-0000-4000-8000-0000000000f2";
const teamId = "30000000-0000-4000-8000-0000000000f9";

let keyCounter = 0;
function uniqueKey(prefix: string): string {
  keyCounter += 1;
  return `${prefix}:${keyCounter.toString(16).padStart(64, "0")}`;
}

function rosterPayload() {
  return {
    v: 1,
    teamId,
    teamName: "Gridiron Ghosts",
    season: 2031,
    week: 4,
    added: [],
    removed: [],
    promoted: [],
    benched: [],
    moreCount: 0,
  };
}

function privateDraft(overrides: Partial<ChangeEventDraft> = {}): ChangeEventDraft {
  return {
    source: "roster-diff",
    eventType: "roster.changed",
    deduplicationKey: uniqueKey("roster.changed"),
    aggregateType: "fantasy-team",
    aggregateId: teamId,
    leagueId,
    actorUserId: null,
    visibility: "private",
    severity: "action",
    payload: rosterPayload(),
    occurredAt: NOW,
    recipientUserIds: [ownerId],
    ...overrides,
  };
}

function leagueDraft(overrides: Partial<ChangeEventDraft> = {}): ChangeEventDraft {
  return { ...privateDraft(overrides), visibility: "league", severity: "info", ...overrides };
}

const feedQuery: ChangeEventRepositoryQuery = {
  limit: 20,
  leagueId: null,
  cursorOccurredAt: null,
  cursorId: null,
  retentionFloor: new Date(NOW.getTime() - 45 * 24 * 60 * 60 * 1000),
};

describe.skipIf(!dockerAvailable)("change-event feed isolation against real PostgreSQL", () => {
  let container: DisposablePostgres;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let repository: DrizzleChangeEventRepository;
  let service: ChangeEventService;

  async function latestEventId(draft: ChangeEventDraft): Promise<string> {
    const [row] = await db
      .select({ id: changeEvents.id })
      .from(changeEvents)
      .where(eq(changeEvents.deduplicationKey, draft.deduplicationKey))
      .orderBy(desc(changeEvents.occurredAt))
      .limit(1);
    if (!row) throw new Error("Expected a stored change event");
    return row.id;
  }

  beforeAll(async () => {
    container = await startDisposablePostgres();
    const migrationHandle = createDatabase(container.url, 1);
    try {
      await migrate(migrationHandle.db, { migrationsFolder });
    } finally {
      await migrationHandle.close();
    }
    handle = createDatabase(container.url, 5);
    db = handle.db;
    repository = new DrizzleChangeEventRepository(db);
    service = new ChangeEventService(repository, () => NOW);

    await db.insert(users).values([
      { id: ownerId, email: "owner@example.test", displayName: "Owner" },
      { id: managerId, email: "manager@example.test", displayName: "Manager" },
      { id: outsiderId, email: "outsider@example.test", displayName: "Outsider" },
    ]);
    await db.insert(leagues).values([
      { id: leagueId, ownerUserId: ownerId, name: "Disposable League" },
      { id: otherLeagueId, ownerUserId: outsiderId, name: "Another League" },
    ]);
    // Inserting a league already creates its canonical owner membership, and
    // `enforce_league_membership_integrity` refuses to delete one — so only the manager row is
    // seeded and reset here.
  }, 90_000);

  beforeEach(async () => {
    // `change_events` is append-only, so each test uses fresh deduplication keys rather than
    // truncating the ledger.
    await db.delete(leagueMemberships).where(eq(leagueMemberships.userId, managerId));
    await db.insert(leagueMemberships).values({ leagueId, userId: managerId, role: "manager" });
  });

  afterAll(async () => {
    await handle?.close();
    if (container?.containerName) {
      try {
        execFileSync("docker", ["rm", "-f", container.containerName], { stdio: "ignore" });
      } catch {
        // Best-effort; the container was started with --rm.
      }
    }
  }, 30_000);

  it("never lets a private event cross a user boundary", async () => {
    const draft = privateDraft();
    await emitChangeEvents(db, [draft], NOW);
    const eventId = await latestEventId(draft);

    const mine = await repository.listVisibleEvents(ownerId, feedQuery);
    const theirs = await repository.listVisibleEvents(outsiderId, feedQuery);

    expect(mine.map((row) => row.id)).toContain(eventId);
    expect(theirs.map((row) => row.id)).not.toContain(eventId);
    expect(await repository.countUnread(outsiderId, feedQuery.retentionFloor)).toBe(0);
    expect(
      await repository.findVisibleEvent(outsiderId, eventId, feedQuery.retentionFloor),
    ).toBeUndefined();
    // A league co-member is not a recipient either: a private event reaches its receipt holder only.
    expect(
      (await repository.listVisibleEvents(managerId, feedQuery)).map((row) => row.id),
    ).not.toContain(eventId);
    // The route's 404 is the same for an unknown event and one the caller cannot see.
    await expect(service.markRead(outsiderId, eventId)).resolves.toBeUndefined();
    await expect(service.dismiss(outsiderId, eventId)).resolves.toBeUndefined();
  });

  it("never lets a league event cross a league boundary", async () => {
    const draft = leagueDraft({ recipientUserIds: [ownerId, managerId] });
    await emitChangeEvents(db, [draft], NOW);
    const eventId = await latestEventId(draft);

    expect(
      (await repository.listVisibleEvents(managerId, feedQuery)).map((row) => row.id),
    ).toContain(eventId);
    expect(
      (await repository.listVisibleEvents(outsiderId, feedQuery)).map((row) => row.id),
    ).not.toContain(eventId);
    expect(
      await repository.findVisibleEvent(outsiderId, eventId, feedQuery.retentionFloor),
    ).toBeUndefined();
  });

  it("stops showing a league event to a removed member", async () => {
    const draft = leagueDraft({ recipientUserIds: [managerId] });
    await emitChangeEvents(db, [draft], NOW);
    const eventId = await latestEventId(draft);
    expect(
      (await repository.listVisibleEvents(managerId, feedQuery)).map((row) => row.id),
    ).toContain(eventId);

    await db.delete(leagueMemberships).where(eq(leagueMemberships.userId, managerId));

    expect(
      (await repository.listVisibleEvents(managerId, feedQuery)).map((row) => row.id),
    ).not.toContain(eventId);
  });

  it("keeps a dismissal after a re-sync emits the same transition", async () => {
    const draft = privateDraft();
    await emitChangeEvents(db, [draft], NOW);
    const eventId = await latestEventId(draft);

    const dismissed = await service.dismiss(ownerId, eventId);
    expect(dismissed).toMatchObject({ eventId, state: "dismissed" });

    // The same transition arrives again: the partial unique index collapses it and no receipt is
    // rebuilt, which is what makes the dismissal permanent.
    const replay = await emitChangeEvents(db, [draft], LATER);
    expect(replay).toEqual({ inserted: 0, duplicates: 1, receiptsCreated: 0 });

    expect(
      (await repository.listVisibleEvents(ownerId, feedQuery)).map((row) => row.id),
    ).not.toContain(eventId);
    const feed = await service.list(ownerId, { limit: null, cursor: null, leagueId: null });
    expect(feed.events.map((event) => event.id)).not.toContain(eventId);
  });

  it("marks read idempotently and satisfies the first-seen check constraints", async () => {
    const draft = leagueDraft({ recipientUserIds: [] });
    await emitChangeEvents(db, [draft], NOW);
    const eventId = await latestEventId(draft);

    // A league event has no receipt until the member touches it; the mark creates one lazily.
    const first = await service.markRead(ownerId, eventId);
    const second = await service.markRead(ownerId, eventId);
    expect(first).toEqual(second);

    const rows = await db.execute<{ readonly first_seen_at: Date | string | null }>(
      sql`select first_seen_at from change_event_receipts where event_id = ${eventId}::uuid`,
    );
    expect(rows[0]?.first_seen_at).not.toBeNull();
  });

  it("serves nothing outside the retention window", async () => {
    const draft = privateDraft({ occurredAt: LONG_AGO });
    await emitChangeEvents(db, [draft], NOW);
    const eventId = await latestEventId(draft);

    expect(
      (await repository.listVisibleEvents(ownerId, feedQuery)).map((row) => row.id),
    ).not.toContain(eventId);
    expect(
      await repository.findVisibleEvent(ownerId, eventId, feedQuery.retentionFloor),
    ).toBeUndefined();
  });

  it("paginates deterministically and returns the same order on a repeated read", async () => {
    const drafts = [0, 1, 2].map((offset) =>
      privateDraft({ occurredAt: new Date(NOW.getTime() - offset * 60_000) }),
    );
    await emitChangeEvents(db, drafts, NOW);

    const firstPage = await service.list(ownerId, { limit: 2, cursor: null, leagueId: null });
    expect(firstPage.events).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();

    const repeated = await service.list(ownerId, { limit: 2, cursor: null, leagueId: null });
    expect(repeated.events.map((event) => event.id)).toEqual(
      firstPage.events.map((event) => event.id),
    );

    const secondPage = await service.list(ownerId, {
      limit: 2,
      cursor: firstPage.nextCursor,
      leagueId: null,
    });
    const firstIds = new Set(firstPage.events.map((event) => event.id));
    expect(secondPage.events.every((event) => !firstIds.has(event.id))).toBe(true);
  });

  it("ignores a forged cursor instead of letting it reach SQL", async () => {
    const feed = await service.list(ownerId, {
      limit: 5,
      cursor: "'; drop table change_events; --",
      leagueId: null,
    });
    expect(Array.isArray(feed.events)).toBe(true);
    const rows = await db.execute<{ readonly alive: number }>(
      sql`select count(*)::int as alive from change_events`,
    );
    expect(rows[0]?.alive).toBeGreaterThan(0);
  });
});
