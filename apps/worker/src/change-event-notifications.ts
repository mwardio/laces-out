import type { ChangeEventSeverity } from "@laces-out/contracts";
import {
  changeEventReceipts,
  changeEvents,
  notificationDeliveries,
  type Database,
} from "@laces-out/db";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import type { NotificationCollector, PendingNotification } from "./push-notifications.js";

/**
 * The change-event notification collector.
 *
 * **One digest per member per sweep, never one push per event.** Events are deduplicated without
 * duplicate alerts, and the member already has a prioritized feed
 * with read and dismiss state — so the push is a nudge toward that feed, not a second copy of it.
 * On a live Sunday a per-event collector would send several pushes per member for one wave of
 * injury news; a digest sends one. Severity ordering lives inside the digest body.
 *
 * **Send-once is the existing ledger, not new machinery.** The digest's idempotency key is
 * `change-event:${userId}:${newestEventId}` — 85 characters, inside
 * `notification_deliveries_key_check`'s 200 — and `NotificationSender.claim` is what actually makes
 * it send-once. This collector sends nothing and never touches a push endpoint.
 *
 * **`delivered_at` is reconciled from that ledger, using the newest event as a watermark.** The key
 * names the newest event in the digest, so every undelivered actionable receipt at or before that
 * event's `occurred_at` was covered by a digest that was already claimed. Marking exactly those rows
 * delivered is what stops the next sweep from repeating them, and is why an event that arrives
 * between two sweeps does not drag the previous batch along with it.
 *
 * Immediate-send for `critical` is available later without a schema change; it is deliberately not
 * built now.
 */

export const MAX_CHANGE_EVENT_NOTIFICATIONS = 200;
/** Named entries in one digest body; the remainder is counted. */
const MAX_DIGEST_LINES = 3;
/** Nothing older than this is worth a push — the feed already has it. */
const NOTIFICATION_WINDOW_HOURS = 24;

/** Only these merit a notification. An informational change belongs in the feed and nowhere else. */
const NOTIFIABLE_SEVERITIES: readonly ChangeEventSeverity[] = ["action", "warning", "critical"];

const SEVERITY_RANK: Readonly<Record<ChangeEventSeverity, number>> = {
  critical: 0,
  warning: 1,
  action: 2,
  info: 3,
};

export interface UndeliveredChangeEvent {
  readonly eventId: string;
  readonly userId: string;
  readonly eventType: string;
  readonly severity: ChangeEventSeverity;
  readonly headline: string;
  readonly detail: string | null;
  readonly occurredAt: Date;
}

export interface DeliveryWatermark {
  readonly userId: string;
  readonly watermark: Date;
}

export interface ChangeEventNotificationRepository {
  listUndelivered(limit: number, now: Date): Promise<readonly UndeliveredChangeEvent[]>;
  /** The newest change-event digest already claimed for each of these members. */
  listDeliveredWatermarks(userIds: readonly string[]): Promise<readonly DeliveryWatermark[]>;
  markDelivered(
    entries: readonly { readonly eventId: string; readonly userId: string }[],
    now: Date,
  ): Promise<number>;
}

export function changeEventDigestKey(userId: string, newestEventId: string): string {
  return `change-event:${userId}:${newestEventId}`;
}

/** Critical first, then warning, then action; newest first inside a severity; id last for totality. */
function prioritize(left: UndeliveredChangeEvent, right: UndeliveredChangeEvent): number {
  const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
  if (bySeverity !== 0) return bySeverity;
  const byTime = right.occurredAt.getTime() - left.occurredAt.getTime();
  if (byTime !== 0) return byTime;
  return left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0;
}

function digestBody(entries: readonly UndeliveredChangeEvent[]): string {
  const named = entries.slice(0, MAX_DIGEST_LINES).map((entry) => entry.headline);
  const remainder = entries.length - named.length;
  const body = remainder > 0 ? [...named, `and ${remainder} more`].join(" · ") : named.join(" · ");
  return body.length <= 300 ? body : `${body.slice(0, 299)}…`;
}

export interface ChangeEventNotificationCollectorOptions {
  readonly repository: ChangeEventNotificationRepository;
  readonly now?: () => Date;
}

export class ChangeEventNotificationCollector implements NotificationCollector {
  readonly #repository: ChangeEventNotificationRepository;
  readonly #now: () => Date;

  constructor(options: ChangeEventNotificationCollectorOptions) {
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date());
  }

  async collect(): Promise<readonly PendingNotification[]> {
    const now = this.#now();
    const rows = await this.#repository.listUndelivered(MAX_CHANGE_EVENT_NOTIFICATIONS, now);
    if (rows.length === 0) return [];

    const byUser = new Map<string, UndeliveredChangeEvent[]>();
    for (const row of rows) {
      byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);
    }

    const watermarks = new Map(
      (await this.#repository.listDeliveredWatermarks([...byUser.keys()])).map(
        (entry) => [entry.userId, entry.watermark] as const,
      ),
    );

    const pending: PendingNotification[] = [];
    const settled: { readonly eventId: string; readonly userId: string }[] = [];

    for (const [userId, entries] of byUser) {
      const watermark = watermarks.get(userId);
      const alreadySent =
        watermark === undefined
          ? []
          : entries.filter((entry) => entry.occurredAt.getTime() <= watermark.getTime());
      settled.push(
        ...alreadySent.map((entry) => ({ eventId: entry.eventId, userId: entry.userId })),
      );

      const fresh = entries.filter((entry) => !alreadySent.includes(entry)).toSorted(prioritize);
      if (fresh.length === 0) continue;

      // The watermark is the *newest* event in the digest, not the highest-severity one, so the
      // reconcile below can cover the whole batch with one comparison.
      const newest = fresh.toSorted(
        (left, right) => right.occurredAt.getTime() - left.occurredAt.getTime(),
      )[0];
      const lead = fresh[0];
      if (!newest || !lead) continue;

      pending.push({
        userId,
        kind: "change-event",
        idempotencyKey: changeEventDigestKey(userId, newest.eventId),
        payload: {
          title: fresh.length === 1 ? lead.headline : `${fresh.length} updates need your attention`,
          body: digestBody(fresh),
          // Application-relative: the service worker opens same-origin destinations only.
          url: "/app",
          tag: `change-event:${userId}`,
        },
      });
    }

    // Reconciled after the batch is built so `delivered_at` and `delivery_channels` stay truthful
    // without the generic sender needing to know these columns exist.
    if (settled.length > 0) await this.#repository.markDelivered(settled, now);
    return pending;
  }
}

export class DrizzleChangeEventNotificationRepository implements ChangeEventNotificationRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async listUndelivered(limit: number, now: Date): Promise<readonly UndeliveredChangeEvent[]> {
    const floor = new Date(now.getTime() - NOTIFICATION_WINDOW_HOURS * 60 * 60 * 1000);
    const rows = await this.#database
      .select({
        eventId: changeEventReceipts.eventId,
        userId: changeEventReceipts.userId,
        eventType: changeEvents.eventType,
        severity: changeEvents.severity,
        payload: changeEvents.payload,
        occurredAt: changeEvents.occurredAt,
      })
      .from(changeEventReceipts)
      .innerJoin(changeEvents, eq(changeEvents.id, changeEventReceipts.eventId))
      .where(
        and(
          isNull(changeEventReceipts.deliveredAt),
          isNull(changeEventReceipts.readAt),
          isNull(changeEventReceipts.dismissedAt),
          // Informational changes belong in the feed and nowhere else.
          inArray(changeEvents.severity, [...NOTIFIABLE_SEVERITIES]),
          gt(changeEvents.occurredAt, floor),
        ),
      )
      .orderBy(desc(changeEvents.occurredAt))
      .limit(limit);

    return rows.flatMap((row) => {
      const severity = row.severity as ChangeEventSeverity;
      if (!NOTIFIABLE_SEVERITIES.includes(severity)) return [];
      return [
        {
          eventId: row.eventId,
          userId: row.userId,
          eventType: row.eventType,
          severity,
          headline: headlineFromPayload(row.eventType, row.payload),
          detail: null,
          occurredAt: row.occurredAt,
        },
      ];
    });
  }

  async listDeliveredWatermarks(userIds: readonly string[]): Promise<readonly DeliveryWatermark[]> {
    if (userIds.length === 0) return [];
    // Joined on the composed key as *text*, so no cast can fail on a key this module did not write.
    const rows = await this.#database
      .select({
        userId: notificationDeliveries.userId,
        watermark: sql<string | Date>`max(${changeEvents.occurredAt})`,
      })
      .from(notificationDeliveries)
      .innerJoin(
        changeEvents,
        sql`${notificationDeliveries.idempotencyKey}
            = 'change-event:' || ${notificationDeliveries.userId}::text
              || ':' || ${changeEvents.id}::text`,
      )
      .where(
        and(
          eq(notificationDeliveries.kind, "change-event"),
          inArray(notificationDeliveries.userId, [...userIds]),
        ),
      )
      .groupBy(notificationDeliveries.userId);
    return rows.map((row) => ({
      userId: row.userId,
      watermark: row.watermark instanceof Date ? row.watermark : new Date(row.watermark),
    }));
  }

  async markDelivered(
    entries: readonly { readonly eventId: string; readonly userId: string }[],
    now: Date,
  ): Promise<number> {
    let updated = 0;
    for (const entry of entries) {
      const rows = await this.#database
        .update(changeEventReceipts)
        .set({
          deliveredAt: now,
          deliveryChannels: sql`case when 'web-push' = any(${changeEventReceipts.deliveryChannels})
            then ${changeEventReceipts.deliveryChannels}
            else array_append(${changeEventReceipts.deliveryChannels}, 'web-push') end`,
        })
        .where(
          and(
            eq(changeEventReceipts.eventId, entry.eventId),
            eq(changeEventReceipts.userId, entry.userId),
            sql`${changeEventReceipts.deliveredAt} is null`,
          ),
        )
        .returning({ eventId: changeEventReceipts.eventId });
      updated += rows.length;
    }
    return updated;
  }
}

/**
 * A short, payload-derived line. The push body is the only place a change event's text leaves the
 * server, so it names the player or team and nothing about another member's league.
 */
function headlineFromPayload(eventType: string, payload: Record<string, unknown>): string {
  const name = payload["playerName"];
  const status = payload["reportStatus"];
  if (eventType === "player.injury.changed" && typeof name === "string") {
    return typeof status === "string"
      ? `${name} is ${status.toUpperCase()}`
      : `${name} injury update`;
  }
  if (eventType === "recommendation.changed") {
    return "Your recommendations changed";
  }
  return "An update is available";
}
