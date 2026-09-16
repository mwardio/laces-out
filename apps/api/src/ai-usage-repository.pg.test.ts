/**
 * Real PostgreSQL regression for the AI daily-limit reservation lifecycle.
 * Uses only an ephemeral Docker database and full migrations, never DATABASE_URL.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  aiProviderCredentials,
  aiUsageLedger,
  createDatabase,
  users,
  type Database,
} from "@laces-out/db";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AI_USAGE_RECORDING_FAILURE_CODE,
  DrizzleAiRepository,
  type AiUsageFinalizeRequest,
  type AiUsageReservationRequest,
} from "./ai-service.js";

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
    "[ai-usage-repository.pg.test] Skipping disposable-PostgreSQL AI usage tests: docker is unavailable.",
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
  const containerName = `laces-out-ai-usage-pg-${randomUUID().slice(0, 8)}`;
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

const NOW = new Date("2031-10-07T23:59:59.000Z");
const SINCE = new Date("2031-10-07T00:00:00.000Z");
const NEXT_DAY = new Date("2031-10-08T00:00:01.000Z");

function completion(
  reservationId: string,
  overrides: Partial<AiUsageFinalizeRequest> = {},
): AiUsageFinalizeRequest {
  return {
    reservationId,
    requestIdHash: randomBytes(32).toString("hex"),
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 12,
    cacheWriteTokens: 8,
    latencyMs: 2400,
    succeeded: true,
    errorCode: null,
    occurredAt: NEXT_DAY,
    ...overrides,
  };
}

describe.skipIf(!dockerAvailable)("AI usage reservations against real PostgreSQL", () => {
  let container: DisposablePostgres;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let repository: DrizzleAiRepository;

  beforeAll(async () => {
    container = await startDisposablePostgres();
    handle = createDatabase(container.url, 8);
    db = handle.db;
    await migrate(db, { migrationsFolder });
    repository = new DrizzleAiRepository(db);
  }, 60_000);

  afterAll(async () => {
    await handle?.close();
    if (container) {
      execFileSync("docker", ["rm", "-f", container.containerName], { stdio: "ignore" });
    }
  });

  async function request(
    overrides: Partial<AiUsageReservationRequest> = {},
  ): Promise<AiUsageReservationRequest> {
    const userId = randomUUID();
    await db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, displayName: "Usage test" });
    return {
      userId,
      credentialId: null,
      provider: "grok",
      model: "grok-test",
      operation: "league-feature",
      dailyRequestLimit: 1,
      since: SINCE,
      metadata: { accessMode: "managed", feature: "recap", budgetScope: "recap-medium" },
      budgetScope: "recap-medium",
      occurredAt: NOW,
      ...overrides,
    };
  }

  async function reserve(input: AiUsageReservationRequest): Promise<string> {
    const reservation = await repository.reserveDailyRequest(input);
    expect(reservation).not.toBeNull();
    return reservation!.reservationId;
  }

  async function row(id: string) {
    const [value] = await db.select().from(aiUsageLedger).where(eq(aiUsageLedger.id, id));
    expect(value).toBeDefined();
    return value!;
  }

  async function credential(
    userId: string,
    provider: AiUsageReservationRequest["provider"] = "openai",
  ): Promise<string> {
    const [value] = await db
      .insert(aiProviderCredentials)
      .values({
        userId,
        provider,
        label: "Test credential",
        model: "gpt-test",
        credentialFingerprintHash: "f".repeat(64),
        credentialEnvelope: {
          version: 1,
          algorithm: "aes-256-gcm",
          keyId: "test-key",
          purpose: "ai-provider-api-key",
          createdAt: NOW.toISOString(),
          iv: "fixture-iv",
          ciphertext: "fixture-ciphertext",
          authTag: "fixture-auth-tag",
        },
        envelopeVersion: 1,
        encryptionKeyId: "test-key",
        credentialPurpose: "ai-provider-api-key",
      })
      .returning({ id: aiProviderCredentials.id });
    return value!.id;
  }

  it("finalizes a real managed reservation and retains its original day across midnight", async () => {
    const input = await request();
    const id = await reserve(input);
    const before = await row(id);
    expect(before).toMatchObject({
      latencyMs: null,
      succeeded: false,
      inputTokens: 0,
      errorCode: null,
    });
    const final = completion(id);
    await repository.finalizeUsage(final);
    expect(await row(id)).toEqual({
      ...before,
      requestIdHash: final.requestIdHash,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 12,
      cacheWriteTokens: 8,
      latencyMs: 2400,
      succeeded: true,
    });
    expect(await repository.countUsageSince(input.userId, input.provider, SINCE, null)).toBe(1);
    expect(
      await repository.countUsageSince(
        input.userId,
        input.provider,
        new Date("2031-10-08T00:00:00Z"),
        null,
      ),
    ).toBe(0);
    expect(await repository.reserveDailyRequest(input)).toBeNull();
  });

  it("records provider failures and preserves BYOK usage through credential and account deletion", async () => {
    const base = await request({ provider: "openai", model: "gpt-test" });
    const credentialId = await credential(base.userId);
    const input = { ...base, credentialId };
    const id = await reserve(input);
    await repository.finalizeUsage(
      completion(id, {
        requestIdHash: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        succeeded: false,
        errorCode: "PROVIDER_ERROR",
      }),
    );
    const before = await row(id);
    expect(before).toMatchObject({
      succeeded: false,
      errorCode: "PROVIDER_ERROR",
      latencyMs: 2400,
    });
    expect(
      await repository.countUsageSince(input.userId, input.provider, SINCE, credentialId),
    ).toBe(1);
    expect(await repository.reserveDailyRequest(input)).toBeNull();
    await db.delete(aiProviderCredentials).where(eq(aiProviderCredentials.id, credentialId));
    expect(await row(id)).toEqual({ ...before, credentialId: null });
    await db.delete(users).where(eq(users.id, input.userId));
    expect(await row(id)).toEqual({ ...before, credentialId: null, userId: null });
  });

  it("keeps deleted BYOK usage separate from the included allowance", async () => {
    const managed = await request({ provider: "gemini", model: "gemini-test" });
    const credentialId = await credential(managed.userId, "gemini");
    const byok = {
      ...managed,
      credentialId,
      metadata: { ...managed.metadata, accessMode: "byok" },
    };
    const byokId = await reserve(byok);
    await repository.finalizeUsage(completion(byokId));
    await db.delete(aiProviderCredentials).where(eq(aiProviderCredentials.id, credentialId));

    expect(await row(byokId)).toMatchObject({
      credentialId: null,
      metadata: { accessMode: "byok" },
    });
    expect(await repository.countUsageSince(managed.userId, "gemini", SINCE, null)).toBe(0);
    const managedId = await reserve(managed);
    expect(managedId).not.toBe(byokId);
    expect(await repository.countUsageSince(managed.userId, "gemini", SINCE, null)).toBe(1);
    expect(await repository.reserveDailyRequest(managed)).toBeNull();
  });

  it("keeps legacy null-credential usage without access-mode metadata counted", async () => {
    const input = await request({ metadata: { budgetScope: "recap-medium" } });
    await reserve(input);
    expect(await repository.countUsageSince(input.userId, input.provider, SINCE, null)).toBe(1);
    expect(await repository.reserveDailyRequest(input)).toBeNull();
  });

  it("refunds only a recorded server accounting failure without erasing its audit row", async () => {
    const input = await request();
    const id = await reserve(input);
    await repository.finalizeUsage(
      completion(id, {
        requestIdHash: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        succeeded: false,
        errorCode: AI_USAGE_RECORDING_FAILURE_CODE,
      }),
    );
    expect(await row(id)).toMatchObject({
      succeeded: false,
      errorCode: AI_USAGE_RECORDING_FAILURE_CODE,
      occurredAt: NOW,
    });
    expect(await repository.countUsageSince(input.userId, input.provider, SINCE, null)).toBe(0);
    const replacement = await reserve(input);
    await repository.finalizeUsage(
      completion(replacement, { succeeded: false, errorCode: "PROVIDER_ERROR" }),
    );
    expect(await repository.countUsageSince(input.userId, input.provider, SINCE, null)).toBe(1);
    expect(await repository.reserveDailyRequest(input)).toBeNull();
  });

  it("atomically caps concurrent requests and counts in-flight reservations", async () => {
    const input = await request({ dailyRequestLimit: 2 });
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => repository.reserveDailyRequest(input)),
    );
    const accepted = attempts.filter((attempt) => attempt !== null);
    expect(accepted).toHaveLength(2);
    expect(await repository.countUsageSince(input.userId, input.provider, SINCE, null)).toBe(2);
    await Promise.all(
      accepted.map((attempt) => repository.finalizeUsage(completion(attempt.reservationId))),
    );
    expect(await repository.reserveDailyRequest(input)).toBeNull();
    // Another independent feature budget remains available.
    expect(
      await repository.reserveDailyRequest({
        ...input,
        budgetScope: "another-feature",
        metadata: { budgetScope: "another-feature" },
      }),
    ).not.toBeNull();
  });

  it("allows an exact replay but rejects any changed finalized usage or deletion", async () => {
    const id = await reserve(await request());
    const final = completion(id);
    await repository.finalizeUsage(final);
    const before = await row(id);
    await repository.finalizeUsage(final);
    await expect(repository.finalizeUsage({ ...final, outputTokens: 51 })).rejects.toThrow();
    await expect(
      repository.finalizeUsage({ ...final, succeeded: false, errorCode: "PROVIDER_ERROR" }),
    ).rejects.toThrow();
    await expect(db.delete(aiUsageLedger).where(eq(aiUsageLedger.id, id))).rejects.toThrow();
    expect(await row(id)).toEqual(before);
  });

  it("serializes competing terminal updates so only one completion wins", async () => {
    const id = await reserve(await request());
    const success = completion(id);
    const failure = completion(id, {
      succeeded: false,
      errorCode: "PROVIDER_ERROR",
      requestIdHash: null,
      outputTokens: 0,
    });
    const results = await Promise.allSettled([
      repository.finalizeUsage(success),
      repository.finalizeUsage(failure),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const terminal = await row(id);
    expect(terminal).toMatchObject(
      terminal.succeeded
        ? { outputTokens: 50, errorCode: null, requestIdHash: success.requestIdHash }
        : { outputTokens: 0, errorCode: "PROVIDER_ERROR", requestIdHash: null },
    );
  });

  it("rejects identity, budget-day, metadata, and cost changes during completion", async () => {
    const base = await request();
    const input = { ...base, credentialId: await credential(base.userId) };
    const id = await reserve(input);
    const before = await row(id);
    const protectedChanges: Partial<typeof aiUsageLedger.$inferInsert>[] = [
      { id: randomUUID() },
      { userId: null },
      { credentialId: null },
      { provider: "openai" },
      { model: "different" },
      { operation: "different" },
      { cost: "1" },
      { currency: "EUR" },
      { metadata: { budgetScope: "different" } },
      { occurredAt: NEXT_DAY },
      { createdAt: NEXT_DAY },
    ];
    for (const change of protectedChanges) {
      await expect(
        db
          .update(aiUsageLedger)
          .set({ latencyMs: 1, succeeded: true, ...change })
          .where(eq(aiUsageLedger.id, id)),
      ).rejects.toThrow();
    }
    expect(await row(id)).toEqual(before);
    await repository.finalizeUsage(completion(id));
    const terminal = await row(id);
    for (const change of protectedChanges) {
      await expect(
        db
          .update(aiUsageLedger)
          .set({ outputTokens: 51, ...change })
          .where(eq(aiUsageLedger.id, id)),
      ).rejects.toThrow();
    }
    expect(await row(id)).toEqual(terminal);
  });

  it("rejects incomplete or contradictory outcomes without changing the reservation", async () => {
    const id = await reserve(await request());
    const before = await row(id);
    const invalidOutcomes: Partial<typeof aiUsageLedger.$inferInsert>[] = [
      { succeeded: true, latencyMs: null },
      { succeeded: true, latencyMs: -1 },
      { succeeded: true, latencyMs: 1, errorCode: "PROVIDER_ERROR" },
      { succeeded: false, latencyMs: 1, errorCode: null },
      { succeeded: false, latencyMs: 1, errorCode: "   " },
      { succeeded: true, latencyMs: 1, inputTokens: -1 },
    ];
    for (const outcome of invalidOutcomes) {
      await expect(
        db.update(aiUsageLedger).set(outcome).where(eq(aiUsageLedger.id, id)),
      ).rejects.toThrow();
    }
    expect(await row(id)).toEqual(before);
    await repository.finalizeUsage(
      completion(id, {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        latencyMs: 0,
        requestIdHash: null,
      }),
    );
    expect(await row(id)).toMatchObject({ succeeded: true, latencyMs: 0 });
  });

  it("does not treat a legacy finished zero-token row as an open reservation", async () => {
    const input = await request();
    const [legacy] = await db
      .insert(aiUsageLedger)
      .values({
        userId: input.userId,
        provider: input.provider,
        model: input.model,
        operation: input.operation,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: null,
        succeeded: true,
        occurredAt: NOW,
      })
      .returning({ id: aiUsageLedger.id });
    await expect(repository.finalizeUsage(completion(legacy!.id))).rejects.toThrow();
    expect(await row(legacy!.id)).toMatchObject({
      succeeded: true,
      latencyMs: null,
      outputTokens: 0,
    });
  });
});
