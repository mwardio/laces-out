import { pushSubscriptions, type Database } from "@fantasy/db";
import { and, asc, desc, eq, notInArray } from "drizzle-orm";
import webpush from "web-push";

/**
 * Web push devices, modeled on the ESPN bridge device: the member sees their own list and can
 * revoke any entry. The endpoint and its two keys are bearer material for that browser's push
 * service, so they leave this module only on their way to the push service — never to a response,
 * never to a log line.
 */
export interface PushSubscriptionRow {
  readonly id: string;
  readonly userId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly userAgentLabel: string | null;
  readonly createdAt: Date;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
}

export interface PushSubscriptionInput {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly userAgentLabel: string | null;
}

export interface PushSubscriptionRepository {
  listForUser(userId: string, limit: number): Promise<readonly PushSubscriptionRow[]>;
  upsert(userId: string, input: PushSubscriptionInput, now: Date): Promise<PushSubscriptionRow>;
  trimForUser(userId: string, limit: number): Promise<void>;
  deleteForUser(userId: string, subscriptionId: string): Promise<PushSubscriptionRow | undefined>;
  deleteByEndpoint(endpoint: string): Promise<void>;
  markSuccess(subscriptionId: string, now: Date): Promise<void>;
  markFailure(subscriptionId: string, now: Date): Promise<void>;
}

const columns = {
  id: pushSubscriptions.id,
  userId: pushSubscriptions.userId,
  endpoint: pushSubscriptions.endpoint,
  p256dh: pushSubscriptions.p256dh,
  auth: pushSubscriptions.auth,
  userAgentLabel: pushSubscriptions.userAgentLabel,
  createdAt: pushSubscriptions.createdAt,
  lastSuccessAt: pushSubscriptions.lastSuccessAt,
  lastFailureAt: pushSubscriptions.lastFailureAt,
} as const;

export class DrizzlePushSubscriptionRepository implements PushSubscriptionRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  listForUser(userId: string, limit: number): Promise<readonly PushSubscriptionRow[]> {
    return this.#database
      .select(columns)
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .orderBy(asc(pushSubscriptions.createdAt), asc(pushSubscriptions.id))
      .limit(limit);
  }

  /**
   * Conflict target is the endpoint, so re-subscribing the same browser refreshes its keys instead
   * of accumulating rows — and a device that moves to another account is re-bound to the caller
   * rather than left pointing at the previous owner.
   */
  async upsert(
    userId: string,
    input: PushSubscriptionInput,
    now: Date,
  ): Promise<PushSubscriptionRow> {
    const [row] = await this.#database
      .insert(pushSubscriptions)
      .values({
        userId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgentLabel: input.userAgentLabel,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          userId,
          p256dh: input.p256dh,
          auth: input.auth,
          userAgentLabel: input.userAgentLabel,
          createdAt: now,
          lastFailureAt: null,
        },
      })
      .returning(columns);
    if (!row) throw new Error("Push subscription upsert returned no row");
    return row;
  }

  async trimForUser(userId: string, limit: number): Promise<void> {
    const keep = await this.#database
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .orderBy(desc(pushSubscriptions.createdAt), desc(pushSubscriptions.id))
      .limit(limit);
    if (keep.length === 0) return;
    await this.#database.delete(pushSubscriptions).where(
      and(
        eq(pushSubscriptions.userId, userId),
        notInArray(
          pushSubscriptions.id,
          keep.map((row) => row.id),
        ),
      ),
    );
  }

  async deleteForUser(
    userId: string,
    subscriptionId: string,
  ): Promise<PushSubscriptionRow | undefined> {
    const [row] = await this.#database
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.id, subscriptionId)))
      .returning(columns);
    return row;
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

/** What a member is allowed to see about their own device. Never the endpoint or its keys. */
export interface PushDeviceStatus {
  readonly subscriptionId: string;
  readonly label: string | null;
  readonly createdAt: string;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
}

export interface PushDeviceListResult {
  readonly generatedAt: string;
  readonly devices: readonly PushDeviceStatus[];
}

export interface PushConfigurationResult {
  readonly available: boolean;
  readonly publicKey: string | null;
}

export interface PushTestResult {
  readonly attempted: number;
  readonly delivered: number;
  readonly pruned: number;
}

/**
 * The single outbound door. `expired` means the push service reported the endpoint gone (410, or
 * 404 for a service that answers that way) and the row must be deleted rather than retried.
 */
export type PushSendOutcome = "sent" | "expired" | "failed";

export interface PushNotificationPayload {
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly tag: string;
}

export interface PushSender {
  send(
    subscription: {
      readonly endpoint: string;
      readonly p256dh: string;
      readonly auth: string;
    },
    payload: PushNotificationPayload,
  ): Promise<PushSendOutcome>;
}

export interface VapidIdentity {
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

/** A push service reports a dead endpoint with 410 Gone; some answer 404. Both mean delete. */
const GONE_STATUS_CODES: ReadonlySet<number> = new Set([404, 410]);

/**
 * The web-push transport. It is the only code that touches an endpoint value, and it deliberately
 * returns a three-state outcome instead of throwing, so callers prune or record without inspecting
 * transport internals — and without any chance of an endpoint reaching a log line.
 */
export function createWebPushSender(vapid: VapidIdentity, ttlSeconds = 3_600): PushSender {
  return {
    async send(subscription, payload): Promise<PushSendOutcome> {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
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

export interface PushSubscriptionServiceOptions {
  readonly repository: PushSubscriptionRepository;
  /** Absent whenever the operator has not configured VAPID keys; every route degrades on it. */
  readonly publicKey?: string;
  readonly sender?: PushSender;
  readonly now?: () => Date;
}

const MAX_DEVICES_PER_MEMBER = 20;

function status(row: PushSubscriptionRow): PushDeviceStatus {
  return {
    subscriptionId: row.id,
    label: row.userAgentLabel,
    createdAt: row.createdAt.toISOString(),
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
  };
}

export class PushSubscriptionService {
  readonly #repository: PushSubscriptionRepository;
  readonly #publicKey: string | undefined;
  readonly #sender: PushSender | undefined;
  readonly #now: () => Date;

  constructor(options: PushSubscriptionServiceOptions) {
    this.#repository = options.repository;
    this.#publicKey = options.publicKey;
    this.#sender = options.sender;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * The one place the UI asks whether the operator configured push at all. A deployment without
   * VAPID keys is the default, not an error: it answers `available: false` and the settings panel
   * renders a labeled disabled state.
   */
  configuration(): PushConfigurationResult {
    return {
      available: this.#publicKey !== undefined,
      publicKey: this.#publicKey ?? null,
    };
  }

  async list(userId: string): Promise<PushDeviceListResult> {
    const rows = await this.#repository.listForUser(userId, MAX_DEVICES_PER_MEMBER);
    return { generatedAt: this.#now().toISOString(), devices: rows.map(status) };
  }

  async register(userId: string, input: PushSubscriptionInput): Promise<PushDeviceStatus> {
    const row = await this.#repository.upsert(userId, input, this.#now());
    await this.#repository.trimForUser(userId, MAX_DEVICES_PER_MEMBER);
    return status(row);
  }

  async revoke(
    userId: string,
    subscriptionId: string,
  ): Promise<{ readonly subscriptionId: string; readonly revokedAt: string } | undefined> {
    const row = await this.#repository.deleteForUser(userId, subscriptionId);
    if (!row) return undefined;
    return { subscriptionId: row.id, revokedAt: this.#now().toISOString() };
  }

  /**
   * Sends one test notification to every device the caller registered. A push service that reports
   * the endpoint gone prunes the row here, exactly as the scheduled sender does, so a stale device
   * disappears from the member's own list the first time they test it.
   */
  async sendTest(userId: string, payload: PushNotificationPayload): Promise<PushTestResult> {
    const sender = this.#sender;
    if (!sender) return { attempted: 0, delivered: 0, pruned: 0 };
    const rows = await this.#repository.listForUser(userId, MAX_DEVICES_PER_MEMBER);
    let delivered = 0;
    let pruned = 0;
    for (const row of rows) {
      const outcome = await sender.send(
        { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
        payload,
      );
      if (outcome === "sent") {
        delivered += 1;
        await this.#repository.markSuccess(row.id, this.#now());
        continue;
      }
      if (outcome === "expired") {
        pruned += 1;
        await this.#repository.deleteByEndpoint(row.endpoint);
        continue;
      }
      await this.#repository.markFailure(row.id, this.#now());
    }
    return { attempted: rows.length, delivered, pruned };
  }
}
