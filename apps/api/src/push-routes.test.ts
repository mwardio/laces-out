import { loadEnvironment } from "@laces-out/config";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";
import {
  PushSubscriptionService,
  type PushSendOutcome,
  type PushSubscriptionInput,
  type PushSubscriptionRepository,
  type PushSubscriptionRow,
} from "./push-subscriptions.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "10000000-0000-4000-8000-00000000000f";
const SESSION_TOKEN = "s".repeat(32);
const COOKIE = `fantasy_session=${SESSION_TOKEN}`;
const PUBLIC_KEY = "B".repeat(87);
const NOW = new Date("2026-09-13T14:00:00.000Z");

function authenticatedService(): AuthService {
  const repository: AuthRepository = {
    findUserByEmail: () => Promise.resolve(undefined),
    createSession: () => Promise.resolve(),
    findSession: () =>
      Promise.resolve({
        user: { id: USER_ID, email: "member@example.com", displayName: "Member", role: "member" },
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        lastSeenAt: new Date(),
      }),
    touchSession: () => Promise.resolve(),
    deleteSession: () => Promise.resolve(),
    deleteExpiredSessions: () => Promise.resolve(),
  };
  return new AuthService(repository);
}

/** An in-memory stand-in with the same per-user scoping rules the Drizzle repository enforces. */
class MemoryPushRepository implements PushSubscriptionRepository {
  readonly rows: PushSubscriptionRow[] = [];
  #nextId = 1;

  listForUser(userId: string, limit: number): Promise<readonly PushSubscriptionRow[]> {
    return Promise.resolve(this.rows.filter((row) => row.userId === userId).slice(0, limit));
  }

  upsert(userId: string, input: PushSubscriptionInput, now: Date): Promise<PushSubscriptionRow> {
    const existing = this.rows.findIndex((row) => row.endpoint === input.endpoint);
    const row: PushSubscriptionRow = {
      id:
        existing === -1
          ? `20000000-0000-4000-8000-${String(this.#nextId++).padStart(12, "0")}`
          : this.rows[existing]!.id,
      userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgentLabel: input.userAgentLabel,
      createdAt: now,
      lastSuccessAt: null,
      lastFailureAt: null,
    };
    if (existing === -1) this.rows.push(row);
    else this.rows[existing] = row;
    return Promise.resolve(row);
  }

  trimForUser(userId: string, limit: number): Promise<void> {
    const keep = new Set(
      this.rows
        .filter((row) => row.userId === userId)
        .toSorted(
          (left, right) =>
            right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
        )
        .slice(0, limit)
        .map((row) => row.id),
    );
    for (let index = this.rows.length - 1; index >= 0; index -= 1) {
      const row = this.rows[index];
      if (row?.userId === userId && !keep.has(row.id)) this.rows.splice(index, 1);
    }
    return Promise.resolve();
  }

  deleteForUser(userId: string, id: string): Promise<PushSubscriptionRow | undefined> {
    const index = this.rows.findIndex((row) => row.userId === userId && row.id === id);
    if (index === -1) return Promise.resolve(undefined);
    return Promise.resolve(this.rows.splice(index, 1)[0]);
  }

  deleteByEndpoint(endpoint: string): Promise<void> {
    const index = this.rows.findIndex((row) => row.endpoint === endpoint);
    if (index !== -1) this.rows.splice(index, 1);
    return Promise.resolve();
  }

  markSuccess(id: string, now: Date): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row) {
      this.rows[this.rows.indexOf(row)] = { ...row, lastSuccessAt: now, lastFailureAt: null };
    }
    return Promise.resolve();
  }

  markFailure(id: string, now: Date): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row) this.rows[this.rows.indexOf(row)] = { ...row, lastFailureAt: now };
    return Promise.resolve();
  }
}

async function appWith(
  options: {
    readonly repository?: MemoryPushRepository;
    readonly withoutKeys?: boolean;
    readonly send?: (endpoint: string) => PushSendOutcome;
    readonly withoutService?: boolean;
  } = {},
) {
  const repository = options.repository ?? new MemoryPushRepository();
  const push = new PushSubscriptionService({
    repository,
    ...(options.withoutKeys ? {} : { publicKey: PUBLIC_KEY }),
    ...(options.send
      ? {
          sender: { send: (subscription) => Promise.resolve(options.send!(subscription.endpoint)) },
        }
      : {}),
    now: () => NOW,
  });
  const app = await buildApp({
    environment: loadEnvironment({ NODE_ENV: "test" }),
    logger: false,
    requireAuthentication: true,
    authService: authenticatedService(),
    ...(options.withoutService ? {} : { push }),
  });
  return { app, repository, push };
}

function subscriptionPayload(suffix = "alpha") {
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`,
    keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
    label: "Chrome on Android",
  };
}

describe("GET /v1/push/config", () => {
  it("requires authentication", async () => {
    const { app } = await appWith();
    expect((await app.inject({ method: "GET", url: "/v1/push/config" })).statusCode).toBe(401);
    await app.close();
  });

  it("serves the public key when the operator configured VAPID", async () => {
    const { app } = await appWith();
    const result = await app.inject({
      method: "GET",
      url: "/v1/push/config",
      headers: { cookie: COOKIE },
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ available: true, publicKey: PUBLIC_KEY });
    await app.close();
  });

  it("reports the feature unavailable without VAPID keys instead of failing", async () => {
    const { app } = await appWith({ withoutKeys: true });
    const result = await app.inject({
      method: "GET",
      url: "/v1/push/config",
      headers: { cookie: COOKIE },
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ available: false, publicKey: null });
    await app.close();
  });

  it("reports unavailable when no push service is wired at all", async () => {
    const { app } = await appWith({ withoutService: true });
    const result = await app.inject({
      method: "GET",
      url: "/v1/push/config",
      headers: { cookie: COOKIE },
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ available: false, publicKey: null });
    await app.close();
  });
});

describe("/v1/push/subscriptions", () => {
  it("requires authentication for every verb", async () => {
    const { app } = await appWith();
    expect((await app.inject({ method: "GET", url: "/v1/push/subscriptions" })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/push/subscriptions",
          payload: subscriptionPayload(),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/v1/push/subscriptions/20000000-0000-4000-8000-000000000001",
        })
      ).statusCode,
    ).toBe(401);
    await app.close();
  });

  it("registers a device, lists it without its endpoint or keys, and revokes it", async () => {
    const { app, repository } = await appWith();

    const created = await app.inject({
      method: "POST",
      url: "/v1/push/subscriptions",
      headers: { cookie: COOKIE },
      payload: subscriptionPayload(),
    });
    expect(created.statusCode).toBe(201);
    const device = created.json<{ subscriptionId: string }>();

    const listed = await app.inject({
      method: "GET",
      url: "/v1/push/subscriptions",
      headers: { cookie: COOKIE },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ devices: unknown[] }>().devices).toEqual([
      {
        subscriptionId: device.subscriptionId,
        label: "Chrome on Android",
        createdAt: NOW.toISOString(),
        lastSuccessAt: null,
        lastFailureAt: null,
      },
    ]);
    expect(listed.body).not.toContain("fcm.googleapis.com");
    expect(listed.body).not.toContain("p".repeat(87));

    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/push/subscriptions/${device.subscriptionId}`,
      headers: { cookie: COOKIE },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({
      subscriptionId: device.subscriptionId,
      revokedAt: NOW.toISOString(),
    });
    expect(repository.rows).toHaveLength(0);
    await app.close();
  });

  it("upserts by endpoint so re-registering one browser does not accumulate rows", async () => {
    const { app, repository } = await appWith();

    await app.inject({
      method: "POST",
      url: "/v1/push/subscriptions",
      headers: { cookie: COOKIE },
      payload: subscriptionPayload(),
    });
    await app.inject({
      method: "POST",
      url: "/v1/push/subscriptions",
      headers: { cookie: COOKIE },
      payload: { ...subscriptionPayload(), keys: { p256dh: "q".repeat(87), auth: "b".repeat(22) } },
    });

    expect(repository.rows).toHaveLength(1);
    expect(repository.rows[0]?.p256dh).toBe("q".repeat(87));
    await app.close();
  });

  it("keeps only the 20 most recently registered devices for one member", async () => {
    const { app, repository } = await appWith();

    for (let index = 1; index <= 22; index += 1) {
      const result = await app.inject({
        method: "POST",
        url: "/v1/push/subscriptions",
        headers: { cookie: COOKIE },
        payload: subscriptionPayload(`device-${String(index).padStart(2, "0")}`),
      });
      expect(result.statusCode).toBe(201);
    }

    expect(repository.rows).toHaveLength(20);
    expect(repository.rows.some((row) => row.endpoint.endsWith("/device-01"))).toBe(false);
    expect(repository.rows.some((row) => row.endpoint.endsWith("/device-02"))).toBe(false);
    expect(repository.rows.some((row) => row.endpoint.endsWith("/device-22"))).toBe(true);
    await app.close();
  });

  it("never lists or revokes another member's device", async () => {
    const repository = new MemoryPushRepository();
    await repository.upsert(
      OTHER_USER_ID,
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/theirs",
        p256dh: "z".repeat(87),
        auth: "z".repeat(22),
        userAgentLabel: "Their phone",
      },
      NOW,
    );
    const { app } = await appWith({ repository });

    const listed = await app.inject({
      method: "GET",
      url: "/v1/push/subscriptions",
      headers: { cookie: COOKIE },
    });
    expect(listed.json<{ devices: unknown[] }>().devices).toEqual([]);

    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/push/subscriptions/${repository.rows[0]!.id}`,
      headers: { cookie: COOKIE },
    });
    expect(revoked.statusCode).toBe(404);
    expect(repository.rows).toHaveLength(1);
    await app.close();
  });

  it("rejects a malformed subscription before it reaches storage", async () => {
    const { app, repository } = await appWith();

    const notHttps = await app.inject({
      method: "POST",
      url: "/v1/push/subscriptions",
      headers: { cookie: COOKIE },
      payload: { ...subscriptionPayload(), endpoint: "http://fcm.googleapis.com/fcm/send/alpha" },
    });
    expect(notHttps.statusCode).toBe(400);

    const untrustedDestination = await app.inject({
      method: "POST",
      url: "/v1/push/subscriptions",
      headers: { cookie: COOKIE },
      payload: { ...subscriptionPayload(), endpoint: "https://127.0.0.1/internal" },
    });
    expect(untrustedDestination.statusCode).toBe(400);

    const disguisedDestination = await app.inject({
      method: "POST",
      url: "/v1/push/subscriptions",
      headers: { cookie: COOKIE },
      payload: {
        ...subscriptionPayload(),
        endpoint: "https://fcm.googleapis.com@127.0.0.1/internal",
      },
    });
    expect(disguisedDestination.statusCode).toBe(400);

    const missingKeys = await app.inject({
      method: "POST",
      url: "/v1/push/subscriptions",
      headers: { cookie: COOKIE },
      payload: { endpoint: "https://push.example.com/send/alpha" },
    });
    expect(missingKeys.statusCode).toBe(400);

    const oversizedLabel = await app.inject({
      method: "POST",
      url: "/v1/push/subscriptions",
      headers: { cookie: COOKIE },
      payload: { ...subscriptionPayload(), label: "x".repeat(200) },
    });
    expect(oversizedLabel.statusCode).toBe(400);

    expect(repository.rows).toHaveLength(0);
    await app.close();
  });

  it("rejects a non-uuid subscription id before reaching the service", async () => {
    const { app } = await appWith();
    const result = await app.inject({
      method: "DELETE",
      url: "/v1/push/subscriptions/not-a-uuid",
      headers: { cookie: COOKIE },
    });

    expect(result.statusCode).toBe(400);
    await app.close();
  });

  it("refuses to register a device when the operator configured no VAPID keys", async () => {
    const { app, repository } = await appWith({ withoutKeys: true });

    const result = await app.inject({
      method: "POST",
      url: "/v1/push/subscriptions",
      headers: { cookie: COOKIE },
      payload: subscriptionPayload(),
    });

    expect(result.statusCode).toBe(503);
    expect(result.json<{ title: string }>().title).toBe("Game day alerts are unavailable");
    expect(repository.rows).toHaveLength(0);
    await app.close();
  });

  it("serves 503 for every push route when no service is configured", async () => {
    const { app } = await appWith({ withoutService: true });

    for (const request of [
      { method: "GET" as const, url: "/v1/push/subscriptions" },
      { method: "POST" as const, url: "/v1/push/test" },
    ]) {
      expect((await app.inject({ ...request, headers: { cookie: COOKIE } })).statusCode).toBe(503);
    }
    await app.close();
  });
});

describe("POST /v1/push/test", () => {
  it("sends to the caller's devices only and reports the delivery count", async () => {
    const repository = new MemoryPushRepository();
    await repository.upsert(
      OTHER_USER_ID,
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/theirs",
        p256dh: "z".repeat(87),
        auth: "z".repeat(22),
        userAgentLabel: null,
      },
      NOW,
    );
    const send = vi.fn(() => "sent" as const);
    const { app } = await appWith({ repository, send });

    await app.inject({
      method: "POST",
      url: "/v1/push/subscriptions",
      headers: { cookie: COOKIE },
      payload: subscriptionPayload(),
    });
    const result = await app.inject({
      method: "POST",
      url: "/v1/push/test",
      headers: { cookie: COOKIE },
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ attempted: 1, delivered: 1, pruned: 0 });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("https://fcm.googleapis.com/fcm/send/alpha");
    await app.close();
  });

  it("prunes an endpoint the push service reports as gone", async () => {
    const { app, repository } = await appWith({ send: () => "expired" });

    await app.inject({
      method: "POST",
      url: "/v1/push/subscriptions",
      headers: { cookie: COOKIE },
      payload: subscriptionPayload(),
    });
    const result = await app.inject({
      method: "POST",
      url: "/v1/push/test",
      headers: { cookie: COOKIE },
    });

    expect(result.json()).toEqual({ attempted: 1, delivered: 0, pruned: 1 });
    expect(repository.rows).toHaveLength(0);
    await app.close();
  });

  it("records a transient failure without deleting the device", async () => {
    const { app, repository } = await appWith({ send: () => "failed" });

    await app.inject({
      method: "POST",
      url: "/v1/push/subscriptions",
      headers: { cookie: COOKIE },
      payload: subscriptionPayload(),
    });
    const result = await app.inject({
      method: "POST",
      url: "/v1/push/test",
      headers: { cookie: COOKIE },
    });

    expect(result.json()).toEqual({ attempted: 1, delivered: 0, pruned: 0 });
    expect(repository.rows).toHaveLength(1);
    expect(repository.rows[0]?.lastFailureAt).toEqual(NOW);
    await app.close();
  });

  it("refuses the test when the operator configured no VAPID keys", async () => {
    const { app } = await appWith({ withoutKeys: true });
    const result = await app.inject({
      method: "POST",
      url: "/v1/push/test",
      headers: { cookie: COOKIE },
    });

    expect(result.statusCode).toBe(503);
    await app.close();
  });
});
