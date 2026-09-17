/** Isolated PostgreSQL 17 regression; never opens the application database. */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  createDatabase,
  firstPartyRosChampionArtifacts,
  firstPartyRosProfileValidations,
  leagues,
  leagueSeasons,
  scoringRules,
  users,
} from "@laces-out/db";
import {
  rosProfileDefinitionFromKey,
  projectionScoringProfileKey,
  rosScoringProfile,
} from "@laces-out/projections";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  firstPartyRosAdmissionConstants,
  validateFirstPartyRosAdmission,
} from "./first-party-ros-admission.js";
import { RosProfileDiscoveryService } from "./ros-profile-discovery.js";
import { DrizzleRosProfileValidationRepository } from "./ros-profile-validation.js";
import { constants, validReport } from "./ros-profile-validation.test-fixtures.js";
import { createPostgresRosCorpusLock } from "./ros-corpus-lock.js";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!dockerAvailable())("ROS profile lifecycle against PostgreSQL", () => {
  const container = `laces-ros-profile-pg-${randomUUID().slice(0, 8)}`;
  let handle: ReturnType<typeof createDatabase>;
  let connectionString: string;
  let repository: DrizzleRosProfileValidationRepository;
  let ownerId: string;
  beforeAll(async () => {
    const password = randomBytes(16).toString("hex");
    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--name",
        container,
        "--cpus=1",
        "--tmpfs",
        "/var/lib/postgresql/data",
        "-e",
        "POSTGRES_USER=profile_test",
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "-e",
        "POSTGRES_DB=profile_test",
        "-p",
        "127.0.0.1::5432",
        "postgres:17-alpine",
      ],
      { stdio: "ignore" },
    );
    const port = Number(
      execFileSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" })
        .trim()
        .split(":")
        .pop(),
    );
    connectionString = `postgres://profile_test:${password}@127.0.0.1:${port}/profile_test`;
    handle = createDatabase(connectionString, 4);
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        execFileSync(
          "docker",
          ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "profile_test"],
          { stdio: "ignore" },
        );
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("Disposable profile database did not start");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    await migrate(handle.db, {
      migrationsFolder: fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url)),
    });
    repository = new DrizzleRosProfileValidationRepository(handle.db);
    const [owner] = await handle.db
      .insert(users)
      .values({ email: "profile-test@example.invalid", displayName: "Profile test" })
      .returning({ id: users.id });
    ownerId = owner!.id;
  }, 60_000);
  afterAll(async () => {
    try {
      await handle?.close();
    } finally {
      execFileSync("docker", ["rm", "-f", "-v", container], { stdio: "ignore" });
    }
  }, 30_000);

  async function seedValidation() {
    const profile = rosScoringProfile("espn-ppr-4pt-pass").profile;
    const definition = rosProfileDefinitionFromKey(projectionScoringProfileKey(profile));
    const [record] = await handle.db
      .insert(firstPartyRosProfileValidations)
      .values({
        season: 2026,
        modelVersion: constants.modelVersion,
        policyVersion: constants.policyVersion,
        calibrationVersion: constants.calibrationVersion,
        scoringProfileKey: definition.scoringProfileKey,
        scoringProfileDigest: definition.digest,
      })
      .returning();
    const report = validReport({
      evidenceIdentityOverrides: { scoringProfileKey: definition.scoringProfileKey },
    });
    const admission = validateFirstPartyRosAdmission({
      report,
      evidenceThroughSeason: 2025,
      constants: firstPartyRosAdmissionConstants(profile),
    });
    if (admission.state !== "admissible") throw new Error(admission.blockers.join(","));
    return { record: record!, report, admission };
  }

  it("serializes corpus builders on independent reserved sessions and releases after failure", async () => {
    const identity = randomUUID();
    const firstLock = createPostgresRosCorpusLock(connectionString, { pollMs: 10 });
    const secondLock = createPostgresRosCorpusLock(connectionString, { pollMs: 10 });
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let release!: () => void;
    const untilReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    const first = firstLock(identity, new AbortController().signal, async (guard) => {
      events.push("first-start");
      began();
      await untilReleased;
      await guard.assertHeld();
      events.push("first-end");
      throw new Error("Interrupted corpus build");
    }).catch((error: unknown) => error);
    await started;
    const second = secondLock(identity, new AbortController().signal, async (guard) => {
      await guard.assertHeld();
      events.push("second-start");
    });
    await delay(40);
    expect(events).toEqual(["first-start"]);
    release();
    expect(await first).toMatchObject({ message: "Interrupted corpus build" });
    await second;
    expect(events).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("aborts an orphaned builder when PostgreSQL drops its session and permits recovery", async () => {
    const identity = randomUUID();
    const lock = createPostgresRosCorpusLock(connectionString, { pollMs: 10, heartbeatMs: 20 });
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const running = lock(identity, new AbortController().signal, async (guard) => {
      began();
      await delay(5_000, undefined, { signal: guard.signal });
    }).catch((error: unknown) => error);
    await started;
    const digest = createHash("sha256").update(`laces-ros-corpus:${identity}`).digest();
    const [owner] = await handle.db.$client<{ pid: number }[]>`
      select pid from pg_locks where locktype = 'advisory' and granted
      and classid = ${digest.readUInt32BE(0)}::bigint
      and objid = ${digest.readUInt32BE(4)}::bigint and objsubid = 2`;
    expect(owner).toBeDefined();
    await handle.db.$client`select pg_terminate_backend(${owner!.pid})`;
    expect(await running).toBeInstanceOf(Error);
    await expect(
      lock(identity, new AbortController().signal, async (guard) => {
        await guard.assertHeld();
        return "recovered";
      }),
    ).resolves.toBe("recovered");
  });

  it("holds the session lock until an aborted child has finished its shutdown", async () => {
    const identity = randomUUID();
    const lock = createPostgresRosCorpusLock(connectionString, { pollMs: 10 });
    const controller = new AbortController();
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let childFinished = false;
    const running = lock(identity, controller.signal, async (guard) => {
      began();
      try {
        await delay(5_000, undefined, { signal: guard.signal });
      } finally {
        // The actual runner awaits child close after SIGTERM/SIGKILL; model that asynchronous
        // cleanup here so cancellation cannot expose a second builder prematurely.
        await delay(50);
        childFinished = true;
      }
    }).catch((error: unknown) => error);
    await started;
    const next = lock(identity, new AbortController().signal, async () => childFinished);
    controller.abort();
    expect(await running).toBeInstanceOf(Error);
    expect(await next).toBe(true);
  });

  it("fences stale claims and atomically persists immutable evidence with admitted registry state", async () => {
    const { record, report, admission } = await seedValidation();
    const now = new Date("2026-09-17T19:00:00.000Z");
    const first = (await repository.begin(record.id, now))!;
    const second = (await repository.begin(record.id, now))!;
    expect(second.getTime()).toBeGreaterThan(first.getTime());
    expect(
      await repository.complete({
        id: record.id,
        startedAt: first,
        completedAt: now,
        report,
        blockers: [],
        admission,
      }),
    ).toBe(false);
    expect(await handle.db.select().from(firstPartyRosChampionArtifacts)).toHaveLength(0);
    expect(
      await repository.complete({
        id: record.id,
        startedAt: second,
        completedAt: now,
        report,
        blockers: [],
        admission,
      }),
    ).toBe(true);
    const stored = (await repository.get(record.id))!;
    expect(stored.state).toBe("admitted");
    expect(stored.report).toEqual(report);
    expect(stored.artifactId).toEqual(expect.any(String));
    const [artifact] = await handle.db
      .select()
      .from(firstPartyRosChampionArtifacts)
      .where(eq(firstPartyRosChampionArtifacts.id, stored.artifactId!));
    expect(artifact?.artifactChecksum).toBe(admission.artifactChecksum);
    await repository.fail(record.id, second, now);
    expect((await repository.get(record.id))?.state).toBe("admitted");
    await expect(
      handle.db
        .update(firstPartyRosChampionArtifacts)
        .set({ modelVersion: "modified" })
        .where(eq(firstPartyRosChampionArtifacts.id, stored.artifactId!)),
    ).rejects.toThrow();
  });

  async function seedLeague(season: number, receptionPoints: string): Promise<string> {
    const [league] = await handle.db
      .insert(leagues)
      .values({ ownerUserId: ownerId, name: "Isolated scoring fixture" })
      .returning();
    const [leagueSeason] = await handle.db
      .insert(leagueSeasons)
      .values({
        leagueId: league!.id,
        provider: "espn",
        externalKey: randomUUID(),
        season,
        teamCount: 10,
        draftType: "snake",
        status: "active",
      })
      .returning();
    await handle.db.insert(scoringRules).values({
      leagueSeasonId: leagueSeason!.id,
      providerStatId: "53",
      statKey: "53",
      operation: "multiply",
      points: receptionPoints,
    });
    return leagueSeason!.id;
  }

  it("deduplicates identical new leagues and creates a distinct request when scoring changes", async () => {
    const season = 2027;
    const first = await seedLeague(season, "0.73");
    await seedLeague(season, "0.73");
    const queued = new Set<string>();
    const enqueueValidation = vi.fn(async (job: { profileValidationId: string }) => {
      if (queued.has(job.profileValidationId)) return null;
      queued.add(job.profileValidationId);
      return randomUUID();
    });
    const discovery = new RosProfileDiscoveryService({
      database: handle.db,
      enqueueValidation,
      enqueueProjectionRefresh: async () => randomUUID(),
    });
    await discovery.discover(season);
    await discovery.discover(season);
    const read = () =>
      handle.db
        .select()
        .from(firstPartyRosProfileValidations)
        .where(eq(firstPartyRosProfileValidations.season, season));
    expect(await read()).toHaveLength(1);
    expect(queued.size).toBe(1);
    await handle.db
      .update(scoringRules)
      .set({ points: "0.74" })
      .where(eq(scoringRules.leagueSeasonId, first));
    await discovery.discover(season);
    expect(await read()).toHaveLength(2);
    expect(queued.size).toBe(2);
  });

  it("retains pending work when queue dispatch fails and recovers on the next discovery", async () => {
    const season = 2028;
    await seedLeague(season, "0.75");
    const enqueueValidation = vi.fn(async () => randomUUID());
    enqueueValidation.mockRejectedValueOnce(new Error("queue unavailable"));
    const discovery = new RosProfileDiscoveryService({
      database: handle.db,
      enqueueValidation,
      enqueueProjectionRefresh: async () => randomUUID(),
    });
    await expect(discovery.discover(season)).rejects.toThrow(/queue unavailable/);
    const [pending] = await handle.db
      .select()
      .from(firstPartyRosProfileValidations)
      .where(eq(firstPartyRosProfileValidations.season, season));
    expect(pending?.state).toBe("pending");
    await discovery.discover(season);
    expect(enqueueValidation).toHaveBeenLastCalledWith({ profileValidationId: pending!.id });
  });

  it("marks terminal orphan attempts failed while protecting outstanding, young, and replaced claims", async () => {
    const season = 2029;
    for (const points of ["0.8", "0.9", "1.01", "1.02"]) await seedLeague(season, points);
    const enqueueValidation = vi.fn(async () => randomUUID());
    const initial = new RosProfileDiscoveryService({
      database: handle.db,
      enqueueValidation,
      enqueueProjectionRefresh: async () => randomUUID(),
    });
    await initial.discover(season);
    const records = await handle.db
      .select()
      .from(firstPartyRosProfileValidations)
      .where(eq(firstPartyRosProfileValidations.season, season));
    const [lost, active, replaced, young] = records;
    const now = new Date("2026-09-17T20:00:00.000Z");
    for (const row of [lost!, active!, replaced!])
      await repository.begin(row.id, new Date(now.getTime() - 10 * 60_000));
    await repository.begin(young!.id, new Date(now.getTime() - 60_000));
    const validationJobIsOutstanding = vi.fn(async (id: string) => {
      if (id === replaced!.id) await repository.begin(id, now);
      return id === active!.id;
    });
    const discovery = new RosProfileDiscoveryService({
      database: handle.db,
      enqueueValidation,
      enqueueProjectionRefresh: async () => randomUUID(),
      validationJobIsOutstanding,
      now: () => now,
    });
    await discovery.discover(season);
    expect(await repository.get(lost!.id)).toMatchObject({
      state: "failed",
      blockers: ["validation_job_lost"],
    });
    expect(await repository.get(active!.id)).toMatchObject({ state: "validating" });
    expect(await repository.get(replaced!.id)).toMatchObject({
      state: "validating",
      startedAt: now,
    });
    expect(await repository.get(young!.id)).toMatchObject({ state: "validating" });
    expect(validationJobIsOutstanding).not.toHaveBeenCalledWith(young!.id);
    expect(enqueueValidation).toHaveBeenCalledTimes(4);
  });

  it("reuses admitted evidence for a newly linked league and queues each changed publication scope once", async () => {
    const season = 2026;
    const firstLeague = await seedLeague(season, "1");
    // Use the exact normalized single-rule shape; report admission still applies all normal gates.
    const definition = rosProfileDefinitionFromKey(
      projectionScoringProfileKey({
        id: "single-rule",
        rules: [{ statId: "receptions", points: 1 }],
      }),
    );
    const report = validReport({
      evidenceIdentityOverrides: { scoringProfileKey: definition.scoringProfileKey },
    });
    const admission = validateFirstPartyRosAdmission({
      report,
      evidenceThroughSeason: 2025,
      constants: firstPartyRosAdmissionConstants(definition.profile),
    });
    if (admission.state !== "admissible") throw new Error(admission.blockers.join(","));
    const [artifact] = await handle.db
      .insert(firstPartyRosChampionArtifacts)
      .values({
        ...admission.payload,
        policy: admission.payload.policy as unknown as Record<string, unknown>,
        artifactChecksum: admission.artifactChecksum,
        admittedAt: new Date(),
      })
      .returning();
    const enqueueProjectionRefresh = vi.fn(async (): Promise<string | null> => randomUUID());
    const enqueueValidation = vi.fn(async () => randomUUID());
    const discovery = new RosProfileDiscoveryService({
      database: handle.db,
      enqueueValidation,
      enqueueProjectionRefresh,
    });
    await discovery.discover(season);
    await discovery.discover(season);
    expect(enqueueProjectionRefresh).toHaveBeenCalledTimes(1);
    expect(enqueueValidation).not.toHaveBeenCalled();
    await seedLeague(season, "1");
    await discovery.discover(season);
    await discovery.discover(season);
    expect(enqueueProjectionRefresh).toHaveBeenCalledTimes(2);
    const [adopted] = await handle.db
      .select()
      .from(firstPartyRosProfileValidations)
      .where(
        and(
          eq(firstPartyRosProfileValidations.season, season),
          eq(firstPartyRosProfileValidations.scoringProfileDigest, definition.digest),
        ),
      );
    expect(adopted).toMatchObject({ state: "admitted", artifactId: artifact!.id });
    expect(firstLeague).toEqual(expect.any(String));
    const scopeBefore = adopted!.publicationScopeDigest;
    await seedLeague(season, "1");
    enqueueProjectionRefresh.mockResolvedValueOnce(null);
    await discovery.discover(season);
    expect((await repository.get(adopted!.id))?.publicationScopeDigest).toBe(scopeBefore);
    await discovery.discover(season);
    expect((await repository.get(adopted!.id))?.publicationScopeDigest).not.toBe(scopeBefore);
    expect(enqueueProjectionRefresh).toHaveBeenCalledTimes(4);
  });
});
