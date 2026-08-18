/**
 * Real disposable-PostgreSQL checks for the change-event notification repository.
 *
 * `change-event-notifications.test.ts` proves the digest *policy* against an in-memory repository.
 * What it cannot prove is the two statements that make the policy true in production: the watermark
 * join, which reconstructs "which receipts were covered by an already-claimed digest" from the
 * `notification_deliveries` ledger by composing the idempotency key in SQL, and the
 * `delivery_channels` append, which must not duplicate `web-push` on a repeat.
 *
 * Safety: the container is created with an explicit, freshly generated, task-specific connection
 * string on a docker-assigned host port. No code here reads `process.env.DATABASE_URL` or any
 * `.env` file, and the container is force-removed in `afterAll` even if setup or a test throws.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { emitChangeEvents, type ChangeEventDraft } from "@laces-out/change-events";
import {
  changeEventReceipts,
  changeEvents,
  createDatabase,
  leagues,
  notificationDeliveries,
  users,
  type Database,
} from "@laces-out/db";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  changeEventDigestKey,
  DrizzleChangeEventNotificationRepository,
} from "./change-event-notifications.js";

function dockerIsAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = dockerIsAvailable();

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

interface DisposablePostgres {
  readonly containerName: string;
  readonly url: string;
}

async function startDisposablePostgres(): Promise<DisposablePostgres> {
  const containerName = `laces-out-change-notify-pg-${randomUUID().slice(0, 8)}`;
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
const userId = "10000000-0000-4000-8000-0000000000d1";
const otherUserId = "10000000-0000-4000-8000-0000000000d2";
const leagueId = "20000000-0000-4000-8000-0000000000d9";
const playerId = "40000000-0000-4000-8000-0000000000d8";

function injuryDraft(key: string, occurredAt: Date, recipient: string): ChangeEventDraft {
  return {
    source: "injury-report",
    eventType: "player.injury.changed",
    deduplicationKey: key,
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
    occurredAt,
    recipientUserIds: [recipient],
  };
}

describe.skipIf(!dockerAvailable)(
  "DrizzleChangeEventNotificationRepository against real PostgreSQL",
  () => {
    let container: DisposablePostgres;
    let handle: ReturnType<typeof createDatabase>;
    let db: Database;
    let repository: DrizzleChangeEventNotificationRepository;

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
      repository = new DrizzleChangeEventNotificationRepository(db);

      await db.insert(users).values([
        { id: userId, email: "member@example.test", displayName: "Member" },
        { id: otherUserId, email: "other@example.test", displayName: "Other" },
      ]);
      await db.insert(leagues).values({ id: leagueId, ownerUserId: userId, name: "Notify League" });
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

    it("accepts the change-event notification kind the migration widened the check for", async () => {
      await db.insert(notificationDeliveries).values({
        userId,
        kind: "change-event",
        idempotencyKey: "change-event:probe",
        createdAt: NOW,
      });
      const rows = await db
        .select({ id: notificationDeliveries.id })
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.idempotencyKey, "change-event:probe"));
      expect(rows).toHaveLength(1);
    });

    it("lists only actionable, undelivered receipts inside the window", async () => {
      await emitChangeEvents(
        db,
        [injuryDraft("player.injury.changed:" + "a".repeat(64), NOW, userId)],
        NOW,
      );

      const rows = await repository.listUndelivered(50, NOW);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ userId, severity: "warning", headline: "A. Back is OUT" });
    });

    it("reconstructs the delivered watermark from the ledger and appends the channel once", async () => {
      const draft = injuryDraft("player.injury.changed:" + "b".repeat(64), NOW, otherUserId);
      await emitChangeEvents(db, [draft], NOW);
      const [event] = await db
        .select({ id: changeEvents.id })
        .from(changeEvents)
        .where(eq(changeEvents.deduplicationKey, draft.deduplicationKey));
      const eventId = event?.id ?? "";

      // No digest claimed yet.
      expect(await repository.listDeliveredWatermarks([otherUserId])).toEqual([]);

      await db.insert(notificationDeliveries).values({
        userId: otherUserId,
        kind: "change-event",
        idempotencyKey: changeEventDigestKey(otherUserId, eventId),
        createdAt: NOW,
      });

      const watermarks = await repository.listDeliveredWatermarks([otherUserId]);
      expect(watermarks).toHaveLength(1);
      expect(watermarks[0]?.watermark.toISOString()).toBe(NOW.toISOString());

      expect(await repository.markDelivered([{ eventId, userId: otherUserId }], NOW)).toBe(1);
      // Idempotent: a second reconcile updates nothing and cannot duplicate the channel.
      expect(await repository.markDelivered([{ eventId, userId: otherUserId }], NOW)).toBe(0);

      const [receipt] = await db
        .select({
          deliveredAt: changeEventReceipts.deliveredAt,
          deliveryChannels: changeEventReceipts.deliveryChannels,
        })
        .from(changeEventReceipts)
        .where(
          and(
            eq(changeEventReceipts.eventId, eventId),
            eq(changeEventReceipts.userId, otherUserId),
          ),
        );
      expect(receipt?.deliveredAt).not.toBeNull();
      expect(receipt?.deliveryChannels).toEqual(["web-push"]);

      // A delivered receipt is no longer pending, so the next sweep cannot repeat it.
      const pending = await repository.listUndelivered(50, NOW);
      expect(pending.map((row) => row.userId)).not.toContain(otherUserId);
    });
  },
);
