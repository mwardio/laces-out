/** Durable bootstrap orchestration with fake source/model runners and disposable PostgreSQL. */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  createDatabase,
  firstPartyRosCorpusBootstraps,
  firstPartyRosProfileValidations,
} from "@laces-out/db";
import { createJobQueue, queueNames, type RosCorpusBootstrapJob } from "@laces-out/jobs";
import {
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
  FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
  rosScoringProfile,
} from "@laces-out/projections";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RosCorpusBootstrapService,
  type RosCorpusBootstrapDependencies,
} from "./ros-corpus-bootstrap.js";
import type { RosBootstrapSourceSnapshot } from "./ros-bootstrap-source-snapshots.js";
import { readRosBootstrapHealth } from "./ros-bootstrap-health.js";
import { RosExecutionCapacity } from "./ros-execution-capacity.js";
import type { RosProfileValidationRunner } from "./ros-profile-validation-runner.js";
import { rosSharedCorpusRequest } from "./ros-shared-corpus-runner.js";

const CORPUS = "a".repeat(64);
const NOW = new Date("2026-09-18T14:00:00Z");
const PROFILE = rosScoringProfile("full-ppr");
const table = firstPartyRosCorpusBootstraps;
const signal = () => new AbortController().signal;
const context = () => ({ jobId: randomUUID(), signal: signal() });

function dockerAvailable() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!dockerAvailable())("Durable shared ROS bootstrap against PostgreSQL", () => {
  const container = `laces-ros-bootstrap-pg-${randomUUID().slice(0, 8)}`;
  let handle: ReturnType<typeof createDatabase>;
  let connectionString: string;
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
        "--memory=256m",
        "--memory-swap=256m",
        "--tmpfs",
        "/var/lib/postgresql/data",
        "-e",
        "POSTGRES_USER=bootstrap_test",
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "-e",
        "POSTGRES_DB=bootstrap_test",
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
    if (!Number.isInteger(port) || port <= 0) throw new Error("Disposable database port missing");
    connectionString = `postgres://bootstrap_test:${password}@127.0.0.1:${port}/bootstrap_test`;
    handle = createDatabase(connectionString, 5);
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        execFileSync(
          "docker",
          ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "bootstrap_test"],
          { stdio: "ignore" },
        );
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("Disposable database did not start");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    await migrate(handle.db, {
      migrationsFolder: fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url)),
    });
  }, 60_000);
  beforeEach(async () => {
    await handle.db.delete(table);
    await handle.db.delete(firstPartyRosProfileValidations);
  });
  afterAll(async () => {
    try {
      await handle?.close();
    } finally {
      execFileSync("docker", ["rm", "-f", "-v", container], { stdio: "ignore" });
    }
  }, 30_000);

  function fixture(
    season = 2026,
    pointsAllowedDefinition: "yahoo-2022-v1" | "espn-2019-v1" = "yahoo-2022-v1",
  ) {
    let now = NOW;
    let ready: string | null = null;
    const request = rosSharedCorpusRequest(season, pointsAllowedDefinition);
    const profile = rosScoringProfile(
      pointsAllowedDefinition === "espn-2019-v1" ? "espn-ppr-4pt-pass" : "full-ppr",
    );
    const outstanding = new Set<string>();
    const terminalAttempts = new Set<number>();
    const readyCorpusForSeason = vi.fn(async () => ready);
    const snapshots = new Map<string, RosBootstrapSourceSnapshot>();
    const prepare = vi.fn<RosCorpusBootstrapDependencies["snapshots"]["prepare"]>(async (input) => {
      const existing = snapshots.get(input.snapshotId);
      if (existing) return existing;
      if (!input.allowCreate) throw new Error("Snapshot disappeared");
      const snapshot: RosBootstrapSourceSnapshot = {
        snapshotId: input.snapshotId,
        directory: `/fake-owned-snapshot/${input.snapshotId}`,
        state: "capturing",
        createdAt: now.toISOString(),
        qualifiedAt: null,
      };
      snapshots.set(input.snapshotId, snapshot);
      return snapshot;
    });
    const mark = (state: "qualified" | "unqualified") =>
      vi.fn(async (_request: string, id: string) => {
        const previous = snapshots.get(id);
        if (!previous) throw new Error("Unknown snapshot");
        const next = {
          ...previous,
          state,
          qualifiedAt: state === "qualified" ? now.toISOString() : null,
        };
        snapshots.set(id, next);
        return next;
      });
    const markQualified = mark("qualified");
    const markUnqualified = mark("unqualified");
    const qualifiedPreflight = {
      state: "component-preflight-qualified",
      noDatabaseWrites: true,
      noSimulation: true,
      scoringProfile: { digest: profile.digest },
      coverage: { state: "qualified", fullyHeldOutSeasons: request.protocol.heldOutSeasons },
      componentPreflight: { state: "qualified" },
      executionIdentity: {
        modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
        policyVersion: FIRST_PARTY_ROS_POLICY_VERSION,
        scoringProfileKey: profile.scoringProfileKey,
        evidenceThroughSeason: season - 1,
      },
    };
    const preflight = vi.fn<RosProfileValidationRunner>(async () => qualifiedPreflight);
    const modeling = vi.fn<RosProfileValidationRunner>(async () => ({
      report: { state: "insufficient", blockers: ["portfolio_statistical_rejection"] },
      outcomeCorpusIdentity: CORPUS,
    }));
    const runner = vi.fn<RosCorpusBootstrapDependencies["runner"]>((options) =>
      options.preflightOnly ? preflight : modeling,
    );
    const commit = vi.fn(async () => {
      ready = CORPUS;
    });
    const buildCorpus = vi.fn<NonNullable<RosCorpusBootstrapDependencies["buildCorpus"]>>(
      async (input) => {
        const report = await input.runner({
          season,
          scoringProfileKey: profile.scoringProfileKey,
          signal: input.signal,
        });
        await input.commitReady({ corpusIdentity: CORPUS, commit });
        return report;
      },
    );
    const enqueue = vi.fn(async (job: RosCorpusBootstrapJob): Promise<string | null> => {
      outstanding.add(job.requestIdentity);
      return randomUUID();
    });
    const jobIsOutstanding = vi.fn(async (identity: string) => outstanding.has(identity));
    const jobIsTerminal = vi.fn(
      async (identity: string, attempt: number) =>
        identity === request.identity && terminalAttempts.has(attempt),
    );
    let lockDepth = 0;
    const lock = vi.fn<RosCorpusBootstrapDependencies["lock"]>(async (_identity, abort, run) => {
      lockDepth += 1;
      try {
        return await run({
          signal: abort,
          assertHeld: async () => {
            abort.throwIfAborted();
          },
        });
      } finally {
        lockDepth -= 1;
      }
    });
    const createService = () =>
      new RosCorpusBootstrapService({
        database: handle.db,
        directory: "/unused-outcome-cache",
        snapshots: { prepare, markQualified, markUnqualified },
        // Vitest erases the generic callback result; the fixture always returns run's result.
        lock: (identity, abort, run) => lock(identity, abort, run) as ReturnType<typeof run>,
        runner,
        capacity: new RosExecutionCapacity(),
        enqueue,
        jobIsOutstanding,
        jobIsTerminal,
        readyCorpusForSeason,
        buildCorpus,
        now: () => now,
      });
    return {
      service: createService(),
      createService,
      request,
      outstanding,
      enqueue,
      jobIsOutstanding,
      jobIsTerminal,
      terminalAttempts,
      lock,
      lockIsHeld: () => lockDepth > 0,
      readyCorpusForSeason,
      prepare,
      markQualified,
      markUnqualified,
      snapshots,
      preflight,
      modeling,
      runner,
      buildCorpus,
      commit,
      qualifiedPreflight,
      setReady: (value: string | null) => {
        ready = value;
      },
      advance: (milliseconds: number) => {
        now = new Date(now.getTime() + milliseconds);
      },
      job: (attempt = 1): RosCorpusBootstrapJob => ({
        requestIdentity: request.identity,
        pointsAllowedDefinition,
        season,
        attempt,
      }),
    };
  }

  it("coalesces concurrent demand into one committed bootstrap dispatch", async () => {
    const test = fixture();
    test.enqueue.mockImplementation(async (job) => {
      const row = await test.service.lookup(2026);
      expect(row).toMatchObject({ state: "pending", attempt: 1 });
      expect(row?.dispatchReservationId).not.toBeNull();
      test.outstanding.add(job.requestIdentity);
      return randomUUID();
    });
    await Promise.all([
      test.service.ensure(2026, signal()),
      test.createService().ensure(2026, signal()),
    ]);
    expect(test.enqueue).toHaveBeenCalledExactlyOnceWith(test.job());
    expect((await test.service.lookup(2026))?.jobId).toBe(
      await test.enqueue.mock.results[0]!.value,
    );
    expect(test.buildCorpus).not.toHaveBeenCalled();
  });

  it("keeps ESPN and Yahoo bootstrap jobs, source snapshots and ready records separate", async () => {
    const yahoo = fixture(2026, "yahoo-2022-v1");
    const espn = fixture(2026, "espn-2019-v1");
    await yahoo.service.ensure(2026, signal(), "yahoo-2022-v1");
    await espn.service.ensure(2026, signal(), "espn-2019-v1");
    expect(yahoo.request.identity).not.toBe(espn.request.identity);
    expect(espn.enqueue).toHaveBeenCalledExactlyOnceWith(espn.job());
    // A legacy message cannot claim an ESPN request by omitting its definition.
    await espn.service.run(
      { requestIdentity: espn.request.identity, season: 2026, attempt: 1 },
      context(),
    );
    expect(espn.preflight).not.toHaveBeenCalled();
    await espn.service.run(espn.job(), context());
    expect(espn.preflight).toHaveBeenCalledWith(
      expect.objectContaining({
        scoringProfileKey: rosScoringProfile("espn-ppr-4pt-pass").scoringProfileKey,
      }),
    );
    expect(await espn.service.lookup(2026, "espn-2019-v1")).toMatchObject({
      state: "ready",
      corpusIdentity: CORPUS,
    });
    expect(await yahoo.service.lookup(2026, "yahoo-2022-v1")).toMatchObject({
      state: "pending",
      corpusIdentity: null,
    });
    expect(yahoo.modeling).not.toHaveBeenCalled();
  });

  it.each(["null", "error"] as const)(
    "retains cycle1 after %s dispatch and retries safely",
    async (failure) => {
      const test = fixture();
      if (failure === "null") test.enqueue.mockResolvedValueOnce(null);
      else test.enqueue.mockRejectedValueOnce(new Error("queue offline"));
      const first = test.service.ensure(2026, signal());
      if (failure === "error") await expect(first).rejects.toThrow("queue offline");
      else await first;
      expect(await test.service.lookup(2026)).toMatchObject({
        state: "pending",
        attempt: 1,
        dispatchReservationId: null,
        jobId: null,
      });
      await test.service.ensure(2026, signal());
      expect(test.enqueue).toHaveBeenCalledTimes(2);
      expect(test.enqueue).toHaveBeenLastCalledWith(test.job());
    },
  );

  it("recovers an abandoned dispatch lease without consuming another cycle", async () => {
    const test = fixture();
    await test.service.ensure(2026, signal());
    await handle.db
      .update(table)
      .set({ jobId: null })
      .where(eq(table.requestIdentity, test.request.identity)); // Sender died before recording an enqueue result.
    test.outstanding.clear();
    await test.service.ensure(2026, signal());
    expect(test.enqueue).toHaveBeenCalledTimes(1);
    test.advance(30_000);
    await test.service.ensure(2026, signal());
    expect(test.enqueue).toHaveBeenCalledTimes(2);
    expect(test.enqueue).toHaveBeenLastCalledWith(test.job());
  });

  it("preserves a known enqueue ID through its grace period then recovers a disappeared queue job", async () => {
    const test = fixture();
    await test.service.ensure(2026, signal());
    const jobId = (await test.service.lookup(2026))!.jobId;
    test.outstanding.clear();
    test.advance(30_000);
    await test.service.ensure(2026, signal());
    expect(test.enqueue).toHaveBeenCalledTimes(1);
    expect(await test.service.lookup(2026)).toMatchObject({ state: "pending", jobId });
    test.advance(5 * 60_000 - 30_000);
    await test.service.ensure(2026, signal());
    expect(await test.service.lookup(2026)).toMatchObject({ state: "retry-wait", attempt: 1 });
    await expect(test.jobIsTerminal.mock.results.at(-1)!.value).resolves.toBe(false);
    test.advance(15 * 60_000);
    await test.service.ensure(2026, signal());
    expect(test.enqueue).toHaveBeenLastCalledWith(test.job(2));
  });

  it("recovers a terminal queue cycle that failed before claiming the ledger after bounded cooldown", async () => {
    const test = fixture();
    await test.service.ensure(2026, signal());
    test.terminalAttempts.add(1);
    test.outstanding.clear();
    test.advance(30_000);
    await test.service.ensure(2026, signal());
    expect(await test.service.lookup(2026)).toMatchObject({
      state: "retry-wait",
      attempt: 1,
      sourceSnapshotId: null,
    });
    expect(test.enqueue).toHaveBeenCalledTimes(1);
    test.advance(15 * 60_000 - 1);
    await test.service.ensure(2026, signal());
    expect(test.enqueue).toHaveBeenCalledTimes(1);
    test.advance(1);
    await test.service.ensure(2026, signal());
    expect(test.enqueue).toHaveBeenLastCalledWith(test.job(2));
    await test.service.run(test.job(1), context());
    expect(test.modeling).not.toHaveBeenCalled();
    await test.service.run(test.job(2), context());
    expect(await test.service.lookup(2026)).toMatchObject({ state: "ready", attempt: 2 });
    expect(test.modeling).toHaveBeenCalledTimes(1);
  });

  it("backs off exhausted operational failure and reuses its qualified source snapshot", async () => {
    const test = fixture();
    await test.service.ensure(2026, signal());
    test.modeling.mockRejectedValueOnce(new Error("process failure"));
    await expect(test.service.run(test.job(), context())).rejects.toThrow("process failure");
    const failed = await test.service.lookup(2026);
    expect(failed).toMatchObject({
      state: "retry-wait",
      attempt: 1,
      sourceSnapshotState: "qualified",
    });
    test.advance(15 * 60_000);
    await test.service.ensure(2026, signal());
    expect(test.enqueue).toHaveBeenCalledTimes(1); // pg-boss still owns its retry.
    test.outstanding.clear();
    await test.service.ensure(2026, signal());
    expect(test.enqueue).toHaveBeenLastCalledWith(test.job(2));
    await test.service.run(test.job(1), context());
    expect(test.modeling).toHaveBeenCalledTimes(1);
    await test.service.run(test.job(2), context());
    expect(await test.service.lookup(2026)).toMatchObject({
      state: "ready",
      attempt: 2,
      corpusIdentity: CORPUS,
      sourceSnapshotId: failed?.sourceSnapshotId,
    });
    expect(test.preflight).toHaveBeenCalledTimes(1);
    expect(test.modeling).toHaveBeenCalledTimes(2);
    expect(test.runner).toHaveBeenLastCalledWith(
      expect.objectContaining({ offline: true, preflightOnly: false }),
    );
  });

  it("starts a fresh source snapshot after source withholding, then establishes physical readiness despite statistical rejection", async () => {
    const test = fixture();
    await test.service.ensure(2026, signal());
    test.preflight.mockResolvedValueOnce({
      ...test.qualifiedPreflight,
      state: "blocked-before-modeling",
      coverage: { state: "insufficient" },
    });
    await test.service.run(test.job(), context());
    const waiting = await test.service.lookup(2026);
    expect(waiting).toMatchObject({ state: "waiting-source", sourceSnapshotState: "unqualified" });
    expect(test.modeling).not.toHaveBeenCalled();
    test.outstanding.clear();
    test.advance(15 * 60_000 - 1);
    await test.service.ensure(2026, signal());
    expect(test.enqueue).toHaveBeenCalledTimes(1);
    test.advance(1);
    await test.service.ensure(2026, signal());
    await test.service.run(test.job(2), context());
    const ready = await test.service.lookup(2026);
    expect(ready).toMatchObject({ state: "ready", corpusIdentity: CORPUS });
    expect(ready?.sourceSnapshotId).not.toBe(waiting?.sourceSnapshotId);
    expect(test.snapshots.get(waiting!.sourceSnapshotId!)?.state).toBe("unqualified");
    expect(test.preflight).toHaveBeenCalledTimes(2);
    expect(test.modeling).toHaveBeenCalledTimes(1);
  });

  it.each(["simulation", "profile", "execution"] as const)(
    "treats a malformed %s identity in source withholding as an operational failure",
    async (invalid) => {
      const test = fixture();
      await test.service.ensure(2026, signal());
      test.preflight.mockResolvedValueOnce({
        ...test.qualifiedPreflight,
        state: "blocked-before-modeling",
        coverage: { state: "insufficient" },
        ...(invalid === "simulation" ? { noSimulation: false } : {}),
        ...(invalid === "profile" ? { scoringProfile: { digest: "b".repeat(64) } } : {}),
        ...(invalid === "execution"
          ? {
              executionIdentity: {
                ...test.qualifiedPreflight.executionIdentity,
                modelVersion: "stale-model",
              },
            }
          : {}),
      });
      await expect(test.service.run(test.job(), context())).rejects.toThrow("identity");
      expect(await test.service.lookup(2026)).toMatchObject({
        state: "retry-wait",
        sourceSnapshotState: "capturing",
      });
      expect(test.markUnqualified).not.toHaveBeenCalled();
      expect(test.modeling).not.toHaveBeenCalled();
    },
  );

  it("fences a replaced same-cycle claim before publishing a ready pointer", async () => {
    const test = fixture();
    await test.service.ensure(2026, signal());
    let finishFirst!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    test.buildCorpus.mockImplementationOnce(async (input) => {
      entered();
      await held;
      await input.commitReady({ corpusIdentity: CORPUS, commit: test.commit });
      return { outcomeCorpusIdentity: CORPUS };
    });
    const first = test.service.run(test.job(), context());
    const rejected = expect(first).rejects.toThrow("claim was replaced");
    await started;
    await test.service.run(test.job(), context());
    finishFirst();
    await rejected;
    expect(test.commit).toHaveBeenCalledTimes(1);
    expect(await test.service.lookup(2026)).toMatchObject({
      state: "ready",
      corpusIdentity: CORPUS,
    });
  });

  it("rejects a replaced claim after waiting for the global lock before touching sources or modeling", async () => {
    const test = fixture();
    await test.service.ensure(2026, signal());
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lock = test.lock.getMockImplementation()!;
    test.lock.mockImplementationOnce(async (...args) => {
      entered();
      await held;
      return lock(...args);
    });
    const first = test.service.run(test.job(), context());
    const rejected = expect(first).rejects.toThrow("claim");
    await waiting;
    await test.createService().run(test.job(), context());
    release();
    await rejected;
    expect(test.prepare).toHaveBeenCalledTimes(1);
    expect(test.preflight).toHaveBeenCalledTimes(1);
    expect(test.modeling).toHaveBeenCalledTimes(1);
    expect(test.commit).toHaveBeenCalledTimes(1);
    expect(await test.service.lookup(2026)).toMatchObject({ state: "ready" });
  });

  it("revalidates a qualified snapshot offline after its ledger qualification update rolled back", async () => {
    const test = fixture();
    await test.service.ensure(2026, signal());
    const functionName = `reject_qualified_${randomUUID().replaceAll("-", "")}`;
    await handle.db.execute(
      sql.raw(
        `create function ${functionName}() returns trigger language plpgsql as $$ begin if new.source_snapshot_state = 'qualified' then raise exception 'injected qualification commit failure'; end if; return new; end; $$`,
      ),
    );
    await handle.db.execute(
      sql.raw(
        `create trigger ${functionName} before update on first_party_ros_corpus_bootstraps for each row execute function ${functionName}()`,
      ),
    );
    try {
      await expect(test.service.run(test.job(), context())).rejects.toThrow();
    } finally {
      await handle.db.execute(
        sql.raw(`drop trigger ${functionName} on first_party_ros_corpus_bootstraps`),
      );
      await handle.db.execute(sql.raw(`drop function ${functionName}()`));
    }
    const failed = await test.service.lookup(2026);
    expect(failed).toMatchObject({ state: "retry-wait", sourceSnapshotState: "capturing" });
    expect(test.snapshots.get(failed!.sourceSnapshotId!)).toMatchObject({ state: "qualified" });
    expect(test.modeling).not.toHaveBeenCalled();
    await test.service.run(test.job(), context());
    expect(test.runner).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ offline: true, preflightOnly: true }),
    );
    expect(await test.service.lookup(2026)).toMatchObject({
      state: "ready",
      sourceSnapshotId: failed?.sourceSnapshotId,
    });
    expect(test.modeling).toHaveBeenCalledTimes(1);
  });

  it("reconciles a committed pointer after the readiness database update rolls back without rebuilding", async () => {
    const test = fixture();
    await test.service.ensure(2026, signal());
    const functionName = `reject_ready_${randomUUID().replaceAll("-", "")}`;
    await handle.db.execute(
      sql.raw(
        `create function ${functionName}() returns trigger language plpgsql as $$ begin if new.state = 'ready' then raise exception 'injected readiness commit failure'; end if; return new; end; $$`,
      ),
    );
    await handle.db.execute(
      sql.raw(
        `create trigger ${functionName} before update on first_party_ros_corpus_bootstraps for each row execute function ${functionName}()`,
      ),
    );
    try {
      await expect(test.service.run(test.job(), context())).rejects.toThrow();
      expect(test.commit).toHaveBeenCalledTimes(1);
    } finally {
      await handle.db.execute(
        sql.raw(`drop trigger ${functionName} on first_party_ros_corpus_bootstraps`),
      );
      await handle.db.execute(sql.raw(`drop function ${functionName}()`));
    }
    await test.service.ensure(2026, signal());
    expect(await test.service.lookup(2026)).toMatchObject({
      state: "ready",
      corpusIdentity: CORPUS,
    });
    expect(test.modeling).toHaveBeenCalledTimes(1);
  });

  it("holds the ledger row lock while observing readiness so adoption cannot race a stale absence", async () => {
    const test = fixture();
    await test.service.ensure(2026, signal());
    test.readyCorpusForSeason.mockImplementationOnce(async () => {
      await expect(
        handle.db.execute(sql`select request_identity from first_party_ros_corpus_bootstraps
          where request_identity = ${test.request.identity} for update nowait`),
      ).rejects.toThrow();
      return null;
    });
    await test.service.ensure(2026, signal());
    expect(await test.service.lookup(2026)).toMatchObject({ state: "pending" });
    test.setReady(CORPUS);
    await test.service.recordVerifiedAdoption(2026, CORPUS);
    expect(await test.service.ensure(2026, signal())).toBe(CORPUS);
    expect(await test.service.lookup(2026)).toMatchObject({
      state: "ready",
      corpusIdentity: CORPUS,
    });
    expect(test.modeling).not.toHaveBeenCalled();
  });

  it("holds the shared build lock throughout source preparation, qualification, and the physical build", async () => {
    const test = fixture();
    const prepare = test.prepare.getMockImplementation()!;
    test.prepare.mockImplementation(async (...args) => {
      expect(test.lockIsHeld()).toBe(true);
      return prepare(...args);
    });
    const preflight = test.preflight.getMockImplementation()!;
    test.preflight.mockImplementation(async (...args) => {
      expect(test.lockIsHeld()).toBe(true);
      return preflight(...args);
    });
    const qualify = test.markQualified.getMockImplementation()!;
    test.markQualified.mockImplementation(async (...args) => {
      expect(test.lockIsHeld()).toBe(true);
      return qualify(...args);
    });
    const build = test.buildCorpus.getMockImplementation()!;
    test.buildCorpus.mockImplementation(async (...args) => {
      expect(test.lockIsHeld()).toBe(true);
      return build(...args);
    });
    await test.service.ensure(2026, signal());
    await test.service.run(test.job(), context());
    expect(await test.service.lookup(2026)).toMatchObject({ state: "ready" });
    expect(test.lock).toHaveBeenCalledTimes(1);
    expect(test.lockIsHeld()).toBe(false);
  });

  it("retains ever-ready identity after storage loss and requires explicit verified restoration", async () => {
    const test = fixture();
    test.setReady(CORPUS);
    expect(await test.service.ensure(2026, signal())).toBe(CORPUS);
    test.setReady(null);
    await test.service.ensure(2026, signal());
    expect(await test.service.lookup(2026)).toMatchObject({
      state: "blocked-integrity",
      corpusIdentity: CORPUS,
    });
    test.advance(24 * 60 * 60_000);
    await test.service.ensure(2026, signal());
    await test.service.run(test.job(), context());
    expect(test.enqueue).not.toHaveBeenCalled();
    expect(test.modeling).not.toHaveBeenCalled();
    test.setReady(CORPUS);
    await test.service.recordVerifiedAdoption(2026, CORPUS);
    expect(await test.service.lookup(2026)).toMatchObject({
      state: "ready",
      corpusIdentity: CORPUS,
    });
  });

  it("accepts JSONB protocol ordering but rejects a relabeled physical request job", async () => {
    const test = fixture();
    await test.service.ensure(2026, signal());
    await handle.db
      .update(table)
      .set({ protocol: Object.fromEntries(Object.entries(test.request.protocol).reverse()) })
      .where(eq(table.requestIdentity, test.request.identity));
    await test.service.run({ ...test.job(), season: 2027 }, context());
    expect(test.modeling).not.toHaveBeenCalled();
    await test.service.run(test.job(), context());
    expect(await test.service.lookup(2026)).toMatchObject({ state: "ready" });
  });

  it("reads health from PostgreSQL using only current demand and outstanding jobs for the exact physical request", async () => {
    const boss = createJobQueue(
      { connectionString, supervise: false, schedule: false },
      { error: vi.fn(), warn: vi.fn() },
    );
    await boss.start();
    try {
      await boss.createQueue(queueNames.bootstrapRosCorpus);
      await boss.createQueue(queueNames.validateRosProfile);
      const request = rosSharedCorpusRequest(2026);
      const otherRequest = rosSharedCorpusRequest(2027);
      const old = new Date(NOW.getTime() - 60 * 60_000);
      const read = () =>
        readRosBootstrapHealth({
          database: handle.db,
          directory: `/tmp/ros-bootstrap-health-absent-${randomUUID()}`,
          season: 2026,
          signal: signal(),
          now: NOW,
        });
      const demand = {
        season: 2026,
        modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
        policyVersion: FIRST_PARTY_ROS_POLICY_VERSION,
        calibrationVersion: FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
        scoringProfileKey: PROFILE.scoringProfileKey,
        scoringProfileDigest: PROFILE.digest,
        requestedAt: old,
      };
      await handle.db.insert(firstPartyRosProfileValidations).values([
        { ...demand, modelVersion: "retired-model" },
        { ...demand, policyVersion: "retired-policy" },
        { ...demand, calibrationVersion: "retired-calibration" },
        { ...demand, season: 2025 },
      ]);
      await handle.db.insert(table).values({
        requestIdentity: otherRequest.identity,
        season: 2027,
        protocol: otherRequest.protocol,
        state: "blocked-integrity",
      });
      expect(await read()).toMatchObject({ attention: false, reason: "no-current-demand" });
      await handle.db.insert(firstPartyRosProfileValidations).values(demand);
      expect(await read()).toMatchObject({ attention: true, reason: "bootstrap-not-registered" });
      await handle.db.insert(table).values({
        requestIdentity: request.identity,
        season: 2026,
        protocol: request.protocol,
        state: "pending",
        attempt: 1,
        updatedAt: old,
      });
      for (const state of ["created", "retry", "active", "completed"] as const) {
        const id = await boss.send(queueNames.bootstrapRosCorpus, {
          requestIdentity: request.identity,
          season: 2026,
          attempt: 1,
        });
        await handle.db.execute(
          sql`update pgboss.job set state = ${state}::pgboss.job_state where id = ${id}`,
        );
      }
      await boss.send(queueNames.bootstrapRosCorpus, { requestIdentity: otherRequest.identity });
      await boss.send(queueNames.bootstrapRosCorpus, {
        requestIdentity: request.identity,
        season: 2026,
        attempt: 2,
      });
      await boss.send(queueNames.validateRosProfile, { requestIdentity: request.identity });
      const ledgerBefore = await handle.db.select().from(table);
      const demandBefore = await handle.db.select().from(firstPartyRosProfileValidations);
      const jobsBefore = await handle.db.execute(sql`select * from pgboss.job order by id`);
      expect(await read()).toMatchObject({
        attention: false,
        reason: "pending",
        requestIdentity: request.identity,
        outstandingJobs: 3,
      });
      expect(await handle.db.select().from(table)).toEqual(ledgerBefore);
      expect(await handle.db.select().from(firstPartyRosProfileValidations)).toEqual(demandBefore);
      expect(await handle.db.execute(sql`select * from pgboss.job order by id`)).toEqual(
        jobsBefore,
      );
    } finally {
      await boss.stop({ graceful: false });
    }
  });
});
