/**
 * Real disposable-PostgreSQL tests for the change-event writer.
 *
 * Nothing that matters here can be proved by an in-memory Drizzle fake. The partial unique index
 * `change_events_source_deduplication_unique`, the `change_events_append_only_trigger` that raises
 * on UPDATE and DELETE, and the two `first_seen_at` receipt check constraints are all PostgreSQL
 * behaviour; a fake would only prove that the fake agrees with itself.
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

import { changeEventReceipts, changeEvents, createDatabase, leagues, users } from "@laces-out/db";
import type { Database } from "@laces-out/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emitChangeEvents, type ChangeEventDraft } from "./writer.js";

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
    "[change-events/writer.pg.test] Skipping disposable-PostgreSQL tests: docker is not available.",
  );
}

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);

interface DisposablePostgres {
  readonly containerName: string;
  readonly url: string;
}

async function startDisposablePostgres(): Promise<DisposablePostgres> {
  const containerName = `laces-out-change-events-pg-${randomUUID().slice(0, 8)}`;
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
      "--tmpfs",
      "/var/lib/postgresql/data",
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
        throw new Error(
          `Disposable PostgreSQL container ${containerName} did not become ready in time`,
        );
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
        throw new Error(
          `Could not connect to ${containerName} via its published port: ${String(error)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  return { containerName, url };
}

/**
 * Drizzle wraps a driver error in `Failed query: …` and hangs the PostgreSQL error off `cause`, so
 * the constraint name a test cares about is one level down.
 */
async function rejectionText(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    const causeMessage =
      error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    return `${error instanceof Error ? error.message : String(error)} ${causeMessage}`;
  }
  throw new Error("Expected the statement to be rejected");
}

const NOW = new Date("2031-09-16T12:00:00.000Z");
const LATER = new Date("2031-09-16T18:00:00.000Z");

const ownerId = "10000000-0000-4000-8000-0000000000a1";
const managerId = "10000000-0000-4000-8000-0000000000a2";
const leagueId = "20000000-0000-4000-8000-0000000000b1";
const teamId = "30000000-0000-4000-8000-0000000000c1";
const playerId = "40000000-0000-4000-8000-0000000000d1";

function rosterDraft(
  overrides: Partial<ChangeEventDraft> & { readonly recipientUserIds: readonly string[] },
): ChangeEventDraft {
  return {
    source: "roster-diff",
    eventType: "roster.changed",
    deduplicationKey: "roster.changed:" + "1".repeat(64),
    aggregateType: "fantasy-team",
    aggregateId: teamId,
    leagueId,
    actorUserId: ownerId,
    visibility: "league",
    severity: "info",
    payload: {
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
    },
    occurredAt: NOW,
    ...overrides,
  };
}

function injuryDraft(prior: string, next: string): ChangeEventDraft {
  return {
    source: "injury-report",
    eventType: "player.injury.changed",
    deduplicationKey: `player.injury.changed:${prior.padEnd(64, "0")}${next}`.slice(0, 87),
    aggregateType: "player",
    aggregateId: playerId,
    leagueId,
    actorUserId: null,
    visibility: "private",
    severity: "warning",
    payload: {
      v: 1,
      playerId,
      playerName: "A. Back",
      teamName: "Gridiron Ghosts",
      season: 2031,
      week: 4,
      reportStatus: "out",
      practiceStatus: null,
    },
    occurredAt: NOW,
    recipientUserIds: [ownerId],
  };
}

describe.skipIf(!dockerAvailable)("emitChangeEvents against real PostgreSQL", () => {
  let container: DisposablePostgres;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;

  async function latestEventId(draft: ChangeEventDraft): Promise<{ readonly id: string }> {
    const [row] = await db
      .select({ id: changeEvents.id })
      .from(changeEvents)
      .where(eq(changeEvents.deduplicationKey, draft.deduplicationKey))
      .orderBy(desc(changeEvents.occurredAt))
      .limit(1);
    if (!row) throw new Error("Expected a stored change event");
    return row;
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

    await db.insert(users).values([
      { id: ownerId, email: "owner@example.test", displayName: "Owner" },
      { id: managerId, email: "manager@example.test", displayName: "Manager" },
    ]);
    await db
      .insert(leagues)
      .values({ id: leagueId, ownerUserId: ownerId, name: "Disposable League" });
  }, 90_000);

  afterAll(async () => {
    await handle?.close();
    if (container?.containerName) {
      try {
        execFileSync("docker", ["rm", "-f", "-v", container.containerName], {
          stdio: "ignore",
        });
      } catch {
        // Best-effort; the container was started with --rm.
      }
    }
  }, 30_000);

  it("writes an event once and fans receipts out to the named recipients", async () => {
    const draft = rosterDraft({
      deduplicationKey: "roster.changed:" + "a".repeat(64),
      recipientUserIds: [ownerId, managerId],
    });

    const first = await emitChangeEvents(db, [draft], NOW);
    const second = await emitChangeEvents(db, [draft], NOW);

    expect(first).toEqual({ inserted: 1, duplicates: 0, receiptsCreated: 2 });
    // The partial unique index, not application memory, is what makes the replay a no-op.
    expect(second).toEqual({ inserted: 0, duplicates: 1, receiptsCreated: 0 });

    const rows = await db
      .select({ id: changeEvents.id })
      .from(changeEvents)
      .where(eq(changeEvents.deduplicationKey, draft.deduplicationKey));
    expect(rows).toHaveLength(1);
  });

  it("emits a second row for a genuinely different transition", async () => {
    await emitChangeEvents(db, [injuryDraft("none", "aaa")], NOW);
    await emitChangeEvents(db, [injuryDraft("aaa", "bbb")], NOW);

    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(changeEvents)
      .where(eq(changeEvents.eventType, "player.injury.changed"));
    expect(row?.count).toBe(2);
  });

  it("never resurrects a dismissed event", async () => {
    const draft = rosterDraft({
      deduplicationKey: "roster.changed:" + "b".repeat(64),
      recipientUserIds: [ownerId],
    });
    await emitChangeEvents(db, [draft], NOW);
    const { id } = await latestEventId(draft);

    await db
      .update(changeEventReceipts)
      .set({ firstSeenAt: NOW, dismissedAt: NOW })
      .where(and(eq(changeEventReceipts.eventId, id), eq(changeEventReceipts.userId, ownerId)));

    const replay = await emitChangeEvents(db, [draft], LATER);
    expect(replay).toEqual({ inserted: 0, duplicates: 1, receiptsCreated: 0 });

    const [receipt] = await db
      .select({ dismissedAt: changeEventReceipts.dismissedAt })
      .from(changeEventReceipts)
      .where(and(eq(changeEventReceipts.eventId, id), eq(changeEventReceipts.userId, ownerId)));
    expect(receipt?.dismissedAt).not.toBeNull();
  });

  it("cannot be updated or deleted", async () => {
    const draft = rosterDraft({
      deduplicationKey: "roster.changed:" + "c".repeat(64),
      recipientUserIds: [ownerId],
    });
    await emitChangeEvents(db, [draft], NOW);
    const { id } = await latestEventId(draft);

    expect(
      await rejectionText(
        db.update(changeEvents).set({ severity: "critical" }).where(eq(changeEvents.id, id)),
      ),
    ).toMatch(/append-only/u);
    expect(await rejectionText(db.delete(changeEvents).where(eq(changeEvents.id, id)))).toMatch(
      /append-only/u,
    );
  });

  it("rejects a read receipt that was never first seen", async () => {
    const draft = rosterDraft({
      deduplicationKey: "roster.changed:" + "d".repeat(64),
      recipientUserIds: [ownerId],
    });
    await emitChangeEvents(db, [draft], NOW);
    const { id } = await latestEventId(draft);

    expect(
      await rejectionText(
        db
          .update(changeEventReceipts)
          .set({ readAt: NOW })
          .where(and(eq(changeEventReceipts.eventId, id), eq(changeEventReceipts.userId, ownerId))),
      ),
    ).toMatch(/change_event_receipts_read_check/u);
  });

  it("rolls the event back with its producer's transaction", async () => {
    const draft = rosterDraft({
      deduplicationKey: "roster.changed:" + "e".repeat(64),
      recipientUserIds: [ownerId],
    });
    await expect(
      db.transaction(async (transaction) => {
        await emitChangeEvents(transaction, [draft], NOW);
        throw new Error("producer failed after emitting");
      }),
    ).rejects.toThrow(/producer failed/u);

    const rows = await db
      .select({ id: changeEvents.id })
      .from(changeEvents)
      .where(eq(changeEvents.deduplicationKey, draft.deduplicationKey));
    expect(rows).toHaveLength(0);
  });

  it("refuses a payload the reader could not parse", async () => {
    await expect(
      emitChangeEvents(
        db,
        [
          rosterDraft({
            deduplicationKey: "roster.changed:" + "f".repeat(64),
            recipientUserIds: [ownerId],
            payload: { v: 1, teamId },
          }),
        ],
        NOW,
      ),
    ).rejects.toThrow(/malformed/u);
  });

  it("is order-insensitive: the same drafts in reverse produce the same stored set", async () => {
    const one = rosterDraft({
      deduplicationKey: "roster.changed:" + "1a".repeat(32),
      recipientUserIds: [ownerId],
    });
    const two = rosterDraft({
      deduplicationKey: "roster.changed:" + "2b".repeat(32),
      recipientUserIds: [managerId],
    });

    const forward = await emitChangeEvents(db, [one, two], NOW);
    const reversed = await emitChangeEvents(db, [two, one], LATER);

    expect(forward).toEqual({ inserted: 2, duplicates: 0, receiptsCreated: 2 });
    expect(reversed).toEqual({ inserted: 0, duplicates: 2, receiptsCreated: 0 });
  });
});
