import { describe, expect, it, vi } from "vitest";

import {
  createNotificationSweepService,
  NotificationSender,
  type NotificationDevice,
  type NotificationRepository,
  type PendingNotification,
  type PushSendOutcome,
} from "./push-notifications.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "10000000-0000-4000-8000-00000000000f";

function notification(overrides: Partial<PendingNotification> = {}): PendingNotification {
  return {
    userId: USER_ID,
    kind: "lineup-lock",
    idempotencyKey: `lineup-lock:${USER_ID}:league:2026:8:t-2h`,
    payload: {
      title: "1 starter needs attention",
      body: "Ja'Marr Chase is OUT. First kickoff in about 2 hours.",
      url: "/decisions",
      tag: "lineup-lock:league:8",
    },
    ...overrides,
  };
}

/** Mirrors the unique-index behaviour the real ledger relies on for idempotency. */
class MemoryNotificationRepository implements NotificationRepository {
  readonly claims = new Set<string>();
  readonly deliveries = new Map<string, number>();
  readonly deleted: string[] = [];
  readonly failures: string[] = [];
  readonly successes: string[] = [];
  devices: NotificationDevice[];

  constructor(devices: readonly NotificationDevice[]) {
    this.devices = [...devices];
  }

  listDevices(userId: string, limit: number): Promise<readonly NotificationDevice[]> {
    return Promise.resolve(
      userId === USER_ID ? this.devices.slice(0, limit) : ([] as NotificationDevice[]),
    );
  }

  claim(pending: PendingNotification): Promise<boolean> {
    if (this.claims.has(pending.idempotencyKey)) return Promise.resolve(false);
    this.claims.add(pending.idempotencyKey);
    return Promise.resolve(true);
  }

  releaseClaim(idempotencyKey: string): Promise<void> {
    this.claims.delete(idempotencyKey);
    return Promise.resolve();
  }

  recordDeliveries(idempotencyKey: string, deviceCount: number): Promise<void> {
    this.deliveries.set(idempotencyKey, deviceCount);
    return Promise.resolve();
  }

  deleteByEndpoint(endpoint: string): Promise<void> {
    this.deleted.push(endpoint);
    this.devices = this.devices.filter((device) => device.endpoint !== endpoint);
    return Promise.resolve();
  }

  markSuccess(subscriptionId: string): Promise<void> {
    this.successes.push(subscriptionId);
    return Promise.resolve();
  }

  markFailure(subscriptionId: string): Promise<void> {
    this.failures.push(subscriptionId);
    return Promise.resolve();
  }
}

function device(suffix: string): NotificationDevice {
  return {
    id: `device-${suffix}`,
    endpoint: `https://push.example.com/send/${suffix}`,
    p256dh: "p".repeat(87),
    auth: "a".repeat(22),
  };
}

function senderWith(
  repository: NotificationRepository,
  outcome: (endpoint: string) => PushSendOutcome,
) {
  const send = vi.fn((target: NotificationDevice) => Promise.resolve(outcome(target.endpoint)));
  return {
    sender: new NotificationSender({ repository, transport: { send } }),
    send,
  };
}

describe("NotificationSender idempotency", () => {
  it("sends once no matter how many times the same occasion is dispatched", async () => {
    const repository = new MemoryNotificationRepository([device("alpha")]);
    const { sender, send } = senderWith(repository, () => "sent");

    const first = await sender.dispatch([notification()]);
    const second = await sender.dispatch([notification()]);

    expect(first).toMatchObject({ considered: 1, sent: 1, duplicates: 0, deliveries: 1 });
    expect(second).toMatchObject({ considered: 1, sent: 0, duplicates: 1, deliveries: 0 });
    expect(send).toHaveBeenCalledOnce();
    expect(repository.deliveries.get(notification().idempotencyKey)).toBe(1);
  });

  it("treats a different window in the same week as a different occasion", async () => {
    const repository = new MemoryNotificationRepository([device("alpha")]);
    const { sender, send } = senderWith(repository, () => "sent");

    await sender.dispatch([
      notification({ idempotencyKey: `lineup-lock:${USER_ID}:league:2026:8:t-24h` }),
    ]);
    await sender.dispatch([
      notification({ idempotencyKey: `lineup-lock:${USER_ID}:league:2026:8:t-2h` }),
    ]);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("never claims an occasion for a member with no registered device", async () => {
    const repository = new MemoryNotificationRepository([]);
    const { sender, send } = senderWith(repository, () => "sent");

    const result = await sender.dispatch([notification({ userId: OTHER_USER_ID })]);

    expect(result).toMatchObject({ sent: 0, withoutDevices: 1 });
    expect(repository.claims.size).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("releases the occasion only when nothing was delivered and a send failed transiently", async () => {
    const repository = new MemoryNotificationRepository([device("alpha")]);
    const { sender } = senderWith(repository, () => "failed");

    const result = await sender.dispatch([notification()]);

    expect(result).toMatchObject({ sent: 0, deliveries: 0, failures: 1 });
    expect(repository.claims.size).toBe(0);
    expect(repository.failures).toEqual(["device-alpha"]);

    const { sender: retry, send } = senderWith(repository, () => "sent");
    expect(await retry.dispatch([notification()])).toMatchObject({ sent: 1 });
    expect(send).toHaveBeenCalledOnce();
  });

  it("keeps a partially delivered occasion consumed rather than risking a duplicate", async () => {
    const repository = new MemoryNotificationRepository([device("alpha"), device("beta")]);
    const { sender } = senderWith(repository, (endpoint) =>
      endpoint.endsWith("alpha") ? "sent" : "failed",
    );

    const first = await sender.dispatch([notification()]);
    const second = await sender.dispatch([notification()]);

    expect(first).toMatchObject({ sent: 1, deliveries: 1, failures: 1 });
    expect(second).toMatchObject({ sent: 0, duplicates: 1 });
  });
});

describe("NotificationSender pruning", () => {
  it("deletes an endpoint the push service reports as gone", async () => {
    const repository = new MemoryNotificationRepository([device("alpha"), device("beta")]);
    const { sender } = senderWith(repository, (endpoint) =>
      endpoint.endsWith("beta") ? "expired" : "sent",
    );

    const result = await sender.dispatch([notification()]);

    expect(result).toMatchObject({ sent: 1, deliveries: 1, pruned: 1 });
    expect(repository.deleted).toEqual(["https://push.example.com/send/beta"]);
    expect(repository.devices.map((entry) => entry.id)).toEqual(["device-alpha"]);
  });

  it("consumes the occasion when every endpoint was gone, because nothing is retryable", async () => {
    const repository = new MemoryNotificationRepository([device("alpha")]);
    const { sender } = senderWith(repository, () => "expired");

    const result = await sender.dispatch([notification()]);

    expect(result).toMatchObject({ sent: 1, deliveries: 0, pruned: 1, failures: 0 });
    expect(repository.claims.size).toBe(1);
  });
});

describe("notification sweep service", () => {
  it("no-ops with a stated reason when the operator configured no VAPID keys", async () => {
    const collect = vi.fn(() => Promise.resolve([notification()]));
    const service = createNotificationSweepService({
      collectors: { "lineup-lock": { collect } },
    });

    const result = await service.sweep(
      { kind: "lineup-lock", reason: "scheduled" },
      { jobId: "job-1", signal: new AbortController().signal },
    );

    expect(result).toEqual({
      considered: 0,
      sent: 0,
      duplicates: 0,
      withoutDevices: 0,
      deliveries: 0,
      pruned: 0,
      failures: 0,
      skipped: "vapid-keys-not-configured",
    });
    expect(collect).not.toHaveBeenCalled();
  });

  it("dispatches the collector's notifications when a sender is configured", async () => {
    const repository = new MemoryNotificationRepository([device("alpha")]);
    const { sender, send } = senderWith(repository, () => "sent");
    const service = createNotificationSweepService({
      collectors: { "lineup-lock": { collect: () => Promise.resolve([notification()]) } },
      sender,
    });

    const result = await service.sweep(
      { kind: "lineup-lock", reason: "scheduled" },
      { jobId: "job-1", signal: new AbortController().signal },
    );

    expect(result).toMatchObject({ considered: 1, sent: 1, skipped: null });
    expect(send).toHaveBeenCalledOnce();
  });
});
