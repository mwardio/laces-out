import {
  notificationDeliveries,
  pushSubscriptions,
  type Database,
  type NotificationKind,
} from "@fantasy/db";
import { asc, eq } from "drizzle-orm";
import webpush from "web-push";

import type {
  NotificationSweepJob,
  NotificationSweepKind,
  NotificationSweepService,
} from "./jobs.js";

/**
 * Generic outbound notification delivery. Everything here is deliberately independent of what a
 * notification says: a kind, an idempotency key, and a payload. Adding a second notification family
 * is a new payload builder plus a new key slot, never a change to this file.
 */

export interface NotificationDevice {
  readonly id: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export interface NotificationPayload {
  readonly title: string;
  readonly body: string;
  /** Application-relative deep link the service worker opens on click. */
  readonly url: string;
  /** Collapses a superseded notification on the device instead of stacking a second one. */
  readonly tag: string;
}

/** One addressed notification: who, which family, and the occasion that makes it send-once. */
export interface PendingNotification {
  readonly userId: string;
  readonly kind: NotificationKind;
  readonly idempotencyKey: string;
  readonly payload: NotificationPayload;
}

export interface NotificationDispatchResult {
  readonly considered: number;
  readonly sent: number;
  readonly duplicates: number;
  readonly withoutDevices: number;
  readonly deliveries: number;
  readonly pruned: number;
  readonly failures: number;
}

export type PushSendOutcome = "sent" | "expired" | "failed";

export interface PushTransport {
  send(device: NotificationDevice, payload: NotificationPayload): Promise<PushSendOutcome>;
}

export interface NotificationRepository {
  listDevices(userId: string, limit: number): Promise<readonly NotificationDevice[]>;
  /** Returns false when this occasion was already claimed, which is the whole idempotency rule. */
  claim(notification: PendingNotification, now: Date): Promise<boolean>;
  releaseClaim(idempotencyKey: string): Promise<void>;
  recordDeliveries(idempotencyKey: string, deviceCount: number): Promise<void>;
  deleteByEndpoint(endpoint: string): Promise<void>;
  markSuccess(subscriptionId: string, now: Date): Promise<void>;
  markFailure(subscriptionId: string, now: Date): Promise<void>;
}

const MAX_DEVICES_PER_MEMBER = 20;

/** A push service reports a dead endpoint with 410 Gone; some answer 404. Both mean delete. */
const GONE_STATUS_CODES: ReadonlySet<number> = new Set([404, 410]);

export interface VapidIdentity {
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

/**
 * The only code that touches an endpoint value. It returns a three-state outcome rather than
 * throwing so callers prune or record without inspecting transport internals — and so no endpoint,
 * key, or push-service body can reach a log line.
 */
export function createWebPushTransport(vapid: VapidIdentity, ttlSeconds = 3_600): PushTransport {
  return {
    async send(device, payload): Promise<PushSendOutcome> {
      try {
        await webpush.sendNotification(
          {
            endpoint: device.endpoint,
            keys: { p256dh: device.p256dh, auth: device.auth },
          },
          JSON.stringify(payload),
          { vapidDetails: vapid, TTL: ttlSeconds, urgency: "high" },
        );
        return "sent";
      } catch (error) {
        if (error instanceof webpush.WebPushError && GONE_STATUS_CODES.has(error.statusCode)) {
          return "expired";
        }
        return "failed";
      }
    },
  };
}

export class DrizzleNotificationRepository implements NotificationRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  listDevices(userId: string, limit: number): Promise<readonly NotificationDevice[]> {
    return this.#database
      .select({
        id: pushSubscriptions.id,
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .orderBy(asc(pushSubscriptions.createdAt), asc(pushSubscriptions.id))
      .limit(limit);
  }

  /**
   * The claim is a unique-index insert, so two workers racing the same occasion cannot both win
   * and a restart mid-sweep resumes without re-sending anything already claimed.
   */
  async claim(notification: PendingNotification, now: Date): Promise<boolean> {
    const claimed = await this.#database
      .insert(notificationDeliveries)
      .values({
        userId: notification.userId,
        kind: notification.kind,
        idempotencyKey: notification.idempotencyKey,
        createdAt: now,
      })
      .onConflictDoNothing({ target: notificationDeliveries.idempotencyKey })
      .returning({ id: notificationDeliveries.id });
    return claimed.length > 0;
  }

  async releaseClaim(idempotencyKey: string): Promise<void> {
    await this.#database
      .delete(notificationDeliveries)
      .where(eq(notificationDeliveries.idempotencyKey, idempotencyKey));
  }

  async recordDeliveries(idempotencyKey: string, deviceCount: number): Promise<void> {
    await this.#database
      .update(notificationDeliveries)
      .set({ deliveredDeviceCount: deviceCount })
      .where(eq(notificationDeliveries.idempotencyKey, idempotencyKey));
  }

  async deleteByEndpoint(endpoint: string): Promise<void> {
    await this.#database.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  }

  async markSuccess(subscriptionId: string, now: Date): Promise<void> {
    await this.#database
      .update(pushSubscriptions)
      .set({ lastSuccessAt: now, lastFailureAt: null })
      .where(eq(pushSubscriptions.id, subscriptionId));
  }

  async markFailure(subscriptionId: string, now: Date): Promise<void> {
    await this.#database
      .update(pushSubscriptions)
      .set({ lastFailureAt: now })
      .where(eq(pushSubscriptions.id, subscriptionId));
  }
}

export interface NotificationSenderOptions {
  readonly repository: NotificationRepository;
  readonly transport: PushTransport;
  readonly now?: () => Date;
}

export class NotificationSender {
  readonly #repository: NotificationRepository;
  readonly #transport: PushTransport;
  readonly #now: () => Date;

  constructor(options: NotificationSenderOptions) {
    this.#repository = options.repository;
    this.#transport = options.transport;
    this.#now = options.now ?? (() => new Date());
  }

  async dispatch(
    notifications: readonly PendingNotification[],
  ): Promise<NotificationDispatchResult> {
    let sent = 0;
    let duplicates = 0;
    let withoutDevices = 0;
    let deliveries = 0;
    let pruned = 0;
    let failures = 0;

    for (const notification of notifications) {
      const devices = await this.#repository.listDevices(
        notification.userId,
        MAX_DEVICES_PER_MEMBER,
      );
      // No device means no occasion was consumed: the member may register one before the window
      // closes, and a claim here would silently burn the alert.
      if (devices.length === 0) {
        withoutDevices += 1;
        continue;
      }
      if (!(await this.#repository.claim(notification, this.#now()))) {
        duplicates += 1;
        continue;
      }

      let delivered = 0;
      let transportFailures = 0;
      for (const device of devices) {
        const outcome = await this.#transport.send(device, notification.payload);
        if (outcome === "sent") {
          delivered += 1;
          await this.#repository.markSuccess(device.id, this.#now());
          continue;
        }
        if (outcome === "expired") {
          pruned += 1;
          await this.#repository.deleteByEndpoint(device.endpoint);
          continue;
        }
        transportFailures += 1;
        await this.#repository.markFailure(device.id, this.#now());
      }

      failures += transportFailures;
      deliveries += delivered;
      // Nothing arrived and at least one attempt failed transiently, so the occasion is released
      // and the next sweep may try again. A partial success is never retried: a duplicate alarm is
      // worse than a single missed device.
      if (delivered === 0 && transportFailures > 0) {
        await this.#repository.releaseClaim(notification.idempotencyKey);
        continue;
      }
      sent += 1;
      await this.#repository.recordDeliveries(notification.idempotencyKey, delivered);
    }

    return {
      considered: notifications.length,
      sent,
      duplicates,
      withoutDevices,
      deliveries,
      pruned,
      failures,
    };
  }
}

/** Builds the notifications that are due for one kind. One collector per notification family. */
export interface NotificationCollector {
  collect(): Promise<readonly PendingNotification[]>;
}

export interface NotificationSweepOptions {
  readonly collectors: Readonly<Partial<Record<NotificationSweepKind, NotificationCollector>>>;
  /** Absent when the operator configured no VAPID keys. The sweep then no-ops, it never throws. */
  readonly sender?: NotificationSender;
}

const EMPTY_SWEEP = {
  considered: 0,
  sent: 0,
  duplicates: 0,
  withoutDevices: 0,
  deliveries: 0,
  pruned: 0,
  failures: 0,
} as const;

/**
 * The one place a queued sweep turns into notifications. A deployment without VAPID keys — the
 * default for every existing install — completes the job with a stated reason instead of failing
 * it, so the queue never dead-letters over a feature the operator simply did not enable.
 */
export function createNotificationSweepService(
  options: NotificationSweepOptions,
): NotificationSweepService {
  return {
    async sweep(job: NotificationSweepJob) {
      const sender = options.sender;
      if (!sender) return { ...EMPTY_SWEEP, skipped: "vapid-keys-not-configured" };
      const collector = options.collectors[job.kind];
      if (!collector) return { ...EMPTY_SWEEP, skipped: `no-collector:${job.kind}` };
      const pending = await collector.collect();
      return { ...(await sender.dispatch(pending)), skipped: null };
    },
  };
}
