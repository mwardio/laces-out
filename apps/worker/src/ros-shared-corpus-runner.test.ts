import { createHash } from "node:crypto";
import type * as FileSystemPromises from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION,
  firstPartyRosSeedHash,
  rosScoringProfile,
  type RosScoringProfileKey,
} from "@laces-out/projections";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RosCorpusLock } from "./ros-corpus-lock.js";
import { ROS_CACHE_MINIMUM_FREE_BYTES } from "./ros-cache-disk-space.js";
import {
  createRosHistoricalCorpusStore,
  type RosHistoricalCorpus,
} from "./ros-historical-corpus.js";
import { historicalCorpusFixture } from "./ros-historical-outcome.test-fixtures.js";
import {
  ROS_HISTORICAL_CORPUS_PHYSICAL_PROTOCOL,
  ROS_HISTORICAL_CORPUS_RELEASE_THRESHOLDS,
} from "./ros-historical-corpus-protocol.js";
import { createRosOutcomeCache } from "./ros-outcome-cache.js";
import type { RosProfileValidationRunInput } from "./ros-profile-validation-runner.js";
import { componentBlockedReport } from "./ros-profile-validation.test-fixtures.js";
import {
  adoptRosSharedCorpus,
  createSharedRosCorpusValidationRunner,
  readyRosSharedCorpusIdentity,
  rosSharedCorpusRequest,
} from "./ros-shared-corpus-runner.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof FileSystemPromises>()),
  statfs: vi.fn(),
}));

const disk = (available: bigint) => ({
  type: 0n,
  bsize: 1n,
  blocks: available,
  bfree: available,
  bavail: available,
  files: 100_000n,
  ffree: 99_000n,
});
beforeEach(() => {
  vi.mocked(statfs)
    .mockReset()
    .mockResolvedValue(disk(ROS_CACHE_MINIMUM_FREE_BYTES + 1_024n ** 3n));
});

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function sequentialLock(): RosCorpusLock {
  let previous = Promise.resolve();
  return async (_identity, signal, run) => {
    const prior = previous;
    let release!: () => void;
    previous = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      signal.throwIfAborted();
      return await run({
        signal,
        assertHeld: async () => {
          signal.throwIfAborted();
        },
      });
    } finally {
      release();
    }
  };
}

const input = (profile: RosScoringProfileKey = "full-ppr"): RosProfileValidationRunInput => ({
  scoringProfileKey: rosScoringProfile(profile).scoringProfileKey,
  season: 2026,
  signal: new AbortController().signal,
});

async function fixture(scenarioCount?: number) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shared-ros-runner-"));
  directories.push(directory);
  const request = rosSharedCorpusRequest(2026);
  const original = historicalCorpusFixture();
  const corpus: RosHistoricalCorpus = {
    ...original,
    weeklyModelVersion: request.protocol.weeklyModelVersion,
    productionBasis: request.protocol.productionBasis,
    seasons: request.protocol.heldOutSeasons,
    coverage: {
      ...original.coverage,
      heldOutSeasonsRequested: request.protocol.heldOutSeasons,
      fullyHeldOutSeasons: request.protocol.heldOutSeasons,
      completeAsOfBatches:
        request.protocol.heldOutSeasons.length * request.protocol.asOfWeeks.length,
      totalAsOfBatches: request.protocol.heldOutSeasons.length * request.protocol.asOfWeeks.length,
      seasons: request.protocol.heldOutSeasons.map((season) => ({
        ...original.coverage.seasons[0]!,
        season,
        priorSeasons: [season - 3, season - 2, season - 1],
        priorSeasonCoverage: [season - 3, season - 2, season - 1].map((prior) => ({
          ...original.coverage.seasons[0]!.priorSeasonCoverage[0]!,
          season: prior,
        })),
        expectedWeeks: request.protocol.asOfWeeks.map((week) => week + 1),
        eligibleAsOfWeeks: request.protocol.asOfWeeks.length,
        completeAsOfWeeks: request.protocol.asOfWeeks.length,
        weeks: request.protocol.asOfWeeks.map((week) => ({
          ...original.coverage.seasons[0]!.weeks[0]!,
          asOfWeek: week,
          targetWeek: week + 1,
          positions: request.protocol.positions
            .filter((position) => position !== "DST")
            .map((position) => ({
              ...original.coverage.seasons[0]!.weeks[0]!.positions[0]!,
              position,
            })),
        })),
      })),
    },
    sourceAudit: request.protocol.sourceSeasons.map((season) => ({
      ...original.sourceAudit[0]!,
      season,
    })),
    options: {
      ...original.options,
      heldOutSeasons: request.protocol.heldOutSeasons,
      asOfWeeks: request.protocol.asOfWeeks,
      positions: request.protocol.positions,
    },
    // Structural completeness only; these fixtures never purport to pass statistical admission.
    forecasts: request.protocol.heldOutSeasons.flatMap((season) =>
      request.protocol.asOfWeeks.flatMap((week) =>
        request.protocol.positions.map((position) => ({
          ...original.forecasts[0]!,
          contextualKey: {
            modelVersion: request.protocol.modelVersion,
            identity: hash(`contextual:${position}:${season}:${week}`),
          },
          recencyKey: {
            modelVersion: request.protocol.modelVersion,
            identity: hash(`availability-aware-recency:${position}:${season}:${week}`),
          },
          forecast: {
            ...original.forecasts[0]!.forecast,
            playerId: `${position}-${season}-${week}`,
            position,
            forecastSeason: season,
            trainedThroughSeason: season - 1,
            asOfWeek: week,
            windowStartWeek: week + 1,
          },
          scheduledGames: 18 - week,
        })),
      ),
    ),
  };
  const store = createRosHistoricalCorpusStore({ directory: path.join(directory, "corpora") });
  const cache = createRosOutcomeCache({ directory });
  const runner = vi.fn(async (job: RosProfileValidationRunInput) => {
    if (job.replayCorpusIdentity) {
      const loaded = await store.read(job.replayCorpusIdentity);
      if (loaded.state !== "hit") throw new Error("Replay requires its immutable corpus");
      for (const key of loaded.corpus.forecasts.flatMap((row) => [
        row.contextualKey,
        row.recencyKey,
      ])) {
        if ((await cache.read(key)).state !== "hit")
          throw new Error("Replay outcome is missing or corrupt");
      }
      return { state: "complete", outcomeCorpusIdentity: job.replayCorpusIdentity };
    }
    const count = scenarioCount ?? request.protocol.referenceScenarioCount;
    const columns = { receptions: new Float64Array(count).fill(2) };
    const games = new Uint8Array(count).fill(1);
    // These structural fixtures mirror the real outcome metadata contract. Every forecast has
    // distinct immutable references; statistical qualification is deliberately not asserted.
    for (const row of corpus.forecasts) {
      for (const [strategy, key] of [
        ["contextual", row.contextualKey],
        ["availability-aware-recency", row.recencyKey],
      ] as const) {
        const forecast = row.forecast;
        const asOfAt = `${forecast.forecastSeason}-09-01T12:00:00.000Z`;
        const seed = "shared-corpus-fixture";
        await cache.write(key, {
          scenarioCount: count,
          columns,
          games,
          metadata: {
            schemaVersion: FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION,
            identity: key.identity,
            seed,
            core: {
              playerId: forecast.playerId,
              position: forecast.position,
              scheduledGames: row.scheduledGames,
              simulation: {
                availabilityLagOneCorrelation: null,
                roleLagOneCorrelation: null,
                boundedRoleSamples: 0,
              },
              provenance: {
                modelVersion: key.modelVersion,
                strategy,
                weeklyModelVersion: corpus.weeklyModelVersion,
                inputChecksum: forecast.inputChecksum,
                seedHash: firstPartyRosSeedHash({
                  position: forecast.position,
                  seed,
                  inputChecksum: forecast.inputChecksum,
                  playerId: forecast.playerId,
                  strategy,
                  season: forecast.forecastSeason,
                  asOfWeek: forecast.asOfWeek,
                  asOfAt,
                  windowStartWeek: forecast.windowStartWeek,
                  windowEndWeek: forecast.windowEndWeek,
                }),
                randomGenerator: "xoshiro128**-sha256-128",
                scenarioCount: count,
                season: forecast.forecastSeason,
                asOfWeek: forecast.asOfWeek,
                asOfAt,
                windowStartWeek: forecast.windowStartWeek,
                windowEndWeek: forecast.windowEndWeek,
                intervalCalibration: "simulation-only",
              },
              diagnostics: [],
            },
          },
        });
      }
    }
    const written = await store.write(corpus);
    return { state: "complete", outcomeCorpusIdentity: written.identity };
  });
  const lock = sequentialLock();
  const createRunner = () => createSharedRosCorpusValidationRunner({ directory, lock, runner });
  return { directory, request, corpus, store, cache, runner, createRunner, lock };
}

describe("durable shared ROS corpus orchestration", { timeout: 30_000 }, () => {
  it("recovers only through its required ready corpus and never falls back to the build lock", async () => {
    const prepared = await fixture();
    expect(await readyRosSharedCorpusIdentity(prepared.directory, 2026, input().signal)).toBeNull();
    const report = await prepared.createRunner()(input());
    const identity = report.outcomeCorpusIdentity;
    if (typeof identity !== "string") throw new Error("Expected a ready corpus");
    const lockCalled = vi.fn();
    const lock: RosCorpusLock = (identity, signal, run) => {
      lockCalled();
      return prepared.lock(identity, signal, run);
    };
    const runner = createSharedRosCorpusValidationRunner({
      directory: prepared.directory,
      lock,
      runner: prepared.runner,
    });
    const recovery = { ...input("half-ppr"), requiredReadyCorpusIdentity: identity };
    expect(await readyRosSharedCorpusIdentity(prepared.directory, 2026, recovery.signal)).toBe(
      identity,
    );
    await expect(runner(recovery)).resolves.toMatchObject({ outcomeCorpusIdentity: identity });
    expect(prepared.runner.mock.calls.at(-1)?.[0]).toMatchObject({
      replayCorpusIdentity: identity,
    });
    prepared.runner.mockClear();
    await expect(
      runner({ ...recovery, requiredReadyCorpusIdentity: "a".repeat(64) }),
    ).rejects.toThrow("absent or changed");
    const pointer = path.join(prepared.directory, "ready", `${prepared.request.identity}.json`);
    const pointerBytes = await readFile(pointer);
    await rm(pointer);
    await expect(runner(recovery)).rejects.toThrow("absent or changed");
    await writeFile(pointer, pointerBytes);
    await rm(path.join(prepared.directory, "corpora", `${identity}.ros-corpus.json.gz`));
    await expect(runner(recovery)).rejects.toThrow("missing");
    await writeFile(pointer, "corrupt");
    await expect(runner(recovery)).rejects.toThrow();
    expect(lockCalled).not.toHaveBeenCalled();
    expect(prepared.runner).not.toHaveBeenCalled();
  });

  it("pins the build envelope and all release thresholds in the durable request identity", () => {
    const { version, ...physicalProtocol } = ROS_HISTORICAL_CORPUS_PHYSICAL_PROTOCOL;
    expect(rosSharedCorpusRequest(2026).protocol).toMatchObject({
      ...physicalProtocol,
      ...ROS_HISTORICAL_CORPUS_RELEASE_THRESHOLDS,
      buildProtocolVersion: version,
      version: "shared-historical-football-corpus-v3",
    });
    expect(rosSharedCorpusRequest(2026).protocol).not.toHaveProperty("policyVersion");
    expect(rosSharedCorpusRequest(2026).protocol).not.toHaveProperty("calibrationVersion");
  });

  it("requires a new ready pointer after zero-game player history semantics change", () => {
    const current = rosSharedCorpusRequest(2026);
    expect(current.protocol.playerHistoryVersion).toBe("first-party-player-history-v2");
    const legacyProtocol = Object.fromEntries(
      Object.entries(current.protocol).filter(([key]) => key !== "playerHistoryVersion"),
    );
    const legacyIdentity = createHash("sha256")
      .update(JSON.stringify(legacyProtocol))
      .digest("hex");
    expect(current.identity).not.toBe(legacyIdentity);
  });

  it("adopts original v5 physical corpus bytes unchanged and subsequent profiles must replay it", async () => {
    const prepared = await fixture();
    await prepared.runner(input());
    const original: RosHistoricalCorpus = {
      ...prepared.corpus,
      buildProtocol: {
        ...prepared.corpus.buildProtocol,
        policyVersion: "season-walk-forward-block-wis-cqr-v5",
        calibrationVersion: "season-blocked-split-conformal-cqr-v1",
      },
    };
    const { identity } = await prepared.store.write(original);
    const corpusFile = path.join(prepared.directory, "corpora", `${identity}.ros-corpus.json.gz`);
    const corpusBytes = await readFile(corpusFile);
    const options = {
      directory: prepared.directory,
      corpusIdentity: identity,
      season: 2026,
      lock: prepared.lock,
      signal: input().signal,
    };
    expect(await adoptRosSharedCorpus(options)).toEqual({
      state: "adopted",
      requestIdentity: prepared.request.identity,
      corpusIdentity: identity,
    });
    const file = path.join(prepared.directory, "ready", `${prepared.request.identity}.json`);
    const originalPointer = await readFile(file);
    expect((await adoptRosSharedCorpus(options)).state).toBe("existing");
    expect(await readFile(file)).toEqual(originalPointer);
    expect(prepared.runner).toHaveBeenCalledTimes(1);
    await prepared.createRunner()(input("half-ppr"));
    expect(prepared.runner.mock.calls.at(-1)?.[0].replayCorpusIdentity).toBe(identity);
    expect(await readFile(corpusFile)).toEqual(corpusBytes);
    expect(await prepared.store.read(identity)).toEqual({
      state: "hit",
      identity,
      corpus: original,
    });
  });

  it("does not publish a ready pointer at low space and preserves all prebuilt immutable bytes", async () => {
    const prepared = await fixture();
    const report = await prepared.runner(input());
    const files = (await readdir(prepared.directory))
      .filter((name) => name.endsWith(".ros-outcomes"))
      .map((name) => path.join(prepared.directory, name));
    files.push(
      path.join(
        prepared.directory,
        "corpora",
        `${report.outcomeCorpusIdentity}.ros-corpus.json.gz`,
      ),
    );
    const originals = await Promise.all(files.map((file) => readFile(file)));
    vi.mocked(statfs).mockResolvedValue(disk(ROS_CACHE_MINIMUM_FREE_BYTES - 1n));
    const options = {
      directory: prepared.directory,
      corpusIdentity: report.outcomeCorpusIdentity,
      season: 2026,
      lock: prepared.lock,
      signal: input().signal,
    };
    await expect(adoptRosSharedCorpus(options)).rejects.toMatchObject({
      code: "insufficient_disk_space",
    });
    await expect(
      readFile(path.join(prepared.directory, "ready", `${prepared.request.identity}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(originals);
    expect((await prepared.store.read(report.outcomeCorpusIdentity)).state).toBe("hit");
    expect(prepared.runner).toHaveBeenCalledTimes(1);
    vi.mocked(statfs).mockResolvedValue(disk(ROS_CACHE_MINIMUM_FREE_BYTES + 1_024n ** 3n));
    expect((await adoptRosSharedCorpus(options)).state).toBe("adopted");
  });

  it("keeps an existing ready corpus replayable and adoptable below the free-space floor", async () => {
    const prepared = await fixture();
    const report = await prepared.createRunner()(input());
    const identity = report.outcomeCorpusIdentity;
    if (typeof identity !== "string") throw new Error("Expected an immutable corpus identity");
    const file = path.join(prepared.directory, "ready", `${prepared.request.identity}.json`);
    const original = await readFile(file);
    vi.mocked(statfs).mockReset().mockResolvedValue(disk(0n));
    await expect(prepared.createRunner()(input("half-ppr"))).resolves.toMatchObject({
      outcomeCorpusIdentity: report.outcomeCorpusIdentity,
    });
    expect(
      (
        await adoptRosSharedCorpus({
          directory: prepared.directory,
          corpusIdentity: identity,
          season: 2026,
          lock: prepared.lock,
          signal: input().signal,
        })
      ).state,
    ).toBe("existing");
    expect(await readFile(file)).toEqual(original);
    expect(statfs).not.toHaveBeenCalled();
    expect(prepared.runner.mock.calls.filter(([job]) => !job.replayCorpusIdentity)).toHaveLength(1);
  });

  it("rechecks space after adoption verification before creating any ready-pointer bytes", async () => {
    const prepared = await fixture();
    const report = await prepared.runner(input());
    vi.mocked(statfs)
      .mockReset()
      .mockResolvedValueOnce(disk(ROS_CACHE_MINIMUM_FREE_BYTES + 1_024n ** 3n))
      .mockResolvedValue(disk(0n));
    await expect(
      adoptRosSharedCorpus({
        directory: prepared.directory,
        corpusIdentity: report.outcomeCorpusIdentity,
        season: 2026,
        lock: prepared.lock,
        signal: input().signal,
      }),
    ).rejects.toMatchObject({ code: "insufficient_disk_space" });
    expect(statfs).toHaveBeenCalledTimes(2);
    expect(await readdir(path.join(prepared.directory, "ready"))).toEqual([]);
    expect((await prepared.store.read(report.outcomeCorpusIdentity)).state).toBe("hit");
    expect(prepared.runner).toHaveBeenCalledTimes(1);
  });

  it("stops before invoking a new shared builder when the disk reserve is unavailable", async () => {
    const prepared = await fixture();
    vi.mocked(statfs).mockResolvedValue(disk(ROS_CACHE_MINIMUM_FREE_BYTES - 1n));
    await expect(prepared.createRunner()(input())).rejects.toMatchObject({
      code: "insufficient_disk_space",
    });
    expect(prepared.runner).not.toHaveBeenCalled();
    expect(await readdir(prepared.directory)).toEqual([]);
  });

  it("refuses a different prebuilt corpus or corrupt pointer for an already committed protocol", async () => {
    const prepared = await fixture();
    const report = await prepared.runner(input());
    const options = {
      directory: prepared.directory,
      corpusIdentity: report.outcomeCorpusIdentity,
      season: 2026,
      lock: prepared.lock,
      signal: input().signal,
    };
    await adoptRosSharedCorpus(options);
    const different = await prepared.store.write({
      ...prepared.corpus,
      sourceChecksums: { ...prepared.corpus.sourceChecksums, catalog: "d".repeat(64) },
    });
    await expect(
      adoptRosSharedCorpus({ ...options, corpusIdentity: different.identity }),
    ).rejects.toThrow(/conflicting/);
    const file = path.join(prepared.directory, "ready", `${prepared.request.identity}.json`);
    await writeFile(file, "corrupt");
    await expect(adoptRosSharedCorpus(options)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("corrupt");
  });

  it.each(["missing-batch", "missing-position", "coverage"])(
    "cannot pin a %s corpus as complete readiness",
    async (failure) => {
      const prepared = await fixture();
      await prepared.runner(input());
      const altered = {
        ...prepared.corpus,
        ...(failure === "missing-batch"
          ? {
              forecasts: prepared.corpus.forecasts.filter(
                ({ forecast }) => !(forecast.forecastSeason === 2022 && forecast.asOfWeek === 1),
              ),
            }
          : {}),
        ...(failure === "missing-position"
          ? { forecasts: prepared.corpus.forecasts.slice(1) }
          : {}),
        ...(failure === "coverage"
          ? { coverage: { ...prepared.corpus.coverage, state: "insufficient" as const } }
          : {}),
      };
      const saved = await prepared.store.write(altered);
      await expect(
        adoptRosSharedCorpus({
          directory: prepared.directory,
          corpusIdentity: saved.identity,
          season: 2026,
          lock: prepared.lock,
          signal: input().signal,
        }),
      ).rejects.toThrow(/incomplete|scope/);
      await expect(
        readFile(path.join(prepared.directory, "ready", `${prepared.request.identity}.json`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["strategy", "repeated-player", "checksum", "cutoff"])(
    "refuses a structurally valid vector with the wrong %s identity before pinning readiness",
    async (failure) => {
      const prepared = await fixture();
      await prepared.runner(input());
      const forecasts = prepared.corpus.forecasts.map((row) => ({
        ...row,
        forecast: { ...row.forecast },
      }));
      if (failure === "strategy") {
        const original = forecasts[0]!.contextualKey;
        forecasts[0]!.contextualKey = forecasts[0]!.recencyKey;
        forecasts[0]!.recencyKey = original;
      }
      if (failure === "repeated-player") forecasts[1]!.contextualKey = forecasts[0]!.contextualKey;
      if (failure === "checksum") forecasts[0]!.forecast.inputChecksum = "f".repeat(64);
      if (failure === "cutoff") {
        const original = forecasts[0]!.contextualKey;
        forecasts[0]!.contextualKey = forecasts[6]!.contextualKey;
        forecasts[6]!.contextualKey = original;
      }
      const saved = await prepared.store.write({ ...prepared.corpus, forecasts });
      await expect(
        adoptRosSharedCorpus({
          directory: prepared.directory,
          corpusIdentity: saved.identity,
          season: 2026,
          lock: prepared.lock,
          signal: input().signal,
        }),
      ).rejects.toThrow(/outcome_evidence_corrupt/);
      await expect(
        readFile(path.join(prepared.directory, "ready", `${prepared.request.identity}.json`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("allows only one heavy build even when distinct target seasons arrive together", async () => {
    const prepared = await fixture();
    const locks = new Map<string, RosCorpusLock>();
    const keyedLock: RosCorpusLock = async (identity, signal, run) => {
      const lock = locks.get(identity) ?? sequentialLock();
      locks.set(identity, lock);
      return lock(identity, signal, run);
    };
    let active = 0;
    let peak = 0;
    const build = createSharedRosCorpusValidationRunner({
      directory: prepared.directory,
      lock: keyedLock,
      runner: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return { state: "blocked-before-modeling" };
      },
    });
    await Promise.all([build(input()), build({ ...input(), season: 2027 })]);
    expect(peak).toBe(1);
  });

  it("builds once across separate runner instances and replays every later scoring profile", async () => {
    const prepared = await fixture();
    const [first, second] = await Promise.all([
      prepared.createRunner()(input()),
      prepared.createRunner()(input("half-ppr")),
    ]);
    expect(first.outcomeCorpusIdentity).toBe(second.outcomeCorpusIdentity);
    expect(prepared.runner.mock.calls.filter(([job]) => !job.replayCorpusIdentity)).toHaveLength(1);
    expect(prepared.runner.mock.calls.filter(([job]) => job.replayCorpusIdentity)).toHaveLength(1);
    await prepared.createRunner()(input("standard"));
    expect(prepared.runner.mock.calls.filter(([job]) => !job.replayCorpusIdentity)).toHaveLength(1);
    expect(await readdir(path.join(prepared.directory, "ready"))).toEqual([
      `${prepared.request.identity}.json`,
    ]);
    expect(rosSharedCorpusRequest(2027).identity).not.toBe(prepared.request.identity);
  });

  it("does not expose readiness when its durable claim rejects the commit", async () => {
    const prepared = await fixture();
    const commitReady = vi.fn<
      NonNullable<Parameters<typeof createSharedRosCorpusValidationRunner>[0]["commitReady"]>
    >(async () => {
      throw new Error("stale durable claim");
    });
    const runner = createSharedRosCorpusValidationRunner({
      directory: prepared.directory,
      runner: prepared.runner,
      lock: sequentialLock(),
      commitReady,
    });
    await expect(runner(input())).rejects.toThrow("stale durable claim");
    expect(commitReady).toHaveBeenCalledOnce();
    const committed = commitReady.mock.calls[0]![0];
    expect(committed.corpusIdentity).toMatch(/^[a-f0-9]{64}$/u);
    expect(committed.commit).toBeTypeOf("function");
    expect(
      await readyRosSharedCorpusIdentity(prepared.directory, 2026, new AbortController().signal),
    ).toBeNull();
  });

  it("recovers a failed first build without ever publishing a partial ready pointer", async () => {
    const prepared = await fixture();
    prepared.runner.mockRejectedValueOnce(new Error("Builder died"));
    await expect(prepared.createRunner()(input())).rejects.toThrow("Builder died");
    await expect(
      readFile(path.join(prepared.directory, "ready", `${prepared.request.identity}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(prepared.createRunner()(input())).resolves.toHaveProperty("outcomeCorpusIdentity");
    expect(prepared.runner).toHaveBeenCalledTimes(2);
  });

  it("rejects an undersized saved scenario ensemble before publishing readiness", async () => {
    const prepared = await fixture(128);
    await expect(prepared.createRunner()(input())).rejects.toThrow(/corrupt outcome entry/);
    await expect(
      readFile(path.join(prepared.directory, "ready", `${prepared.request.identity}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replays an already ready corpus without waiting for a different model's global build lock", async () => {
    const prepared = await fixture();
    await prepared.createRunner()(input());
    const unavailableLock: RosCorpusLock = async () => {
      throw new Error("Another corpus is building");
    };
    const replay = createSharedRosCorpusValidationRunner({
      directory: prepared.directory,
      runner: prepared.runner,
      lock: unavailableLock,
    });
    await expect(replay(input("half-ppr"))).resolves.toHaveProperty("outcomeCorpusIdentity");
  });

  it("does not publish readiness when source coverage stops the build before modeling", async () => {
    const prepared = await fixture();
    prepared.runner.mockResolvedValueOnce({ state: "blocked-before-modeling" } as Awaited<
      ReturnType<typeof prepared.runner>
    >);
    expect(await prepared.createRunner()(input())).toEqual({ state: "blocked-before-modeling" });
    await expect(
      readFile(path.join(prepared.directory, "ready", `${prepared.request.identity}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns component-evidence diagnostics without publishing a ready corpus", async () => {
    const prepared = await fixture();
    const report = componentBlockedReport();
    prepared.runner.mockResolvedValueOnce(report as Awaited<ReturnType<typeof prepared.runner>>);
    expect(await prepared.createRunner()(input())).toEqual(report);
    expect(prepared.runner).toHaveBeenCalledTimes(1);
    await expect(
      readyRosSharedCorpusIdentity(prepared.directory, 2026, new AbortController().signal),
    ).resolves.toBeNull();
  });

  it("rejects a replay report that does not identify the selected immutable corpus", async () => {
    const prepared = await fixture();
    await prepared.createRunner()(input());
    prepared.runner.mockResolvedValueOnce({
      state: "complete",
      outcomeCorpusIdentity: "f".repeat(64),
    });
    await expect(prepared.createRunner()(input("half-ppr"))).rejects.toThrow(
      /different corpus identity/,
    );
    expect(prepared.runner.mock.calls.filter(([job]) => !job.replayCorpusIdentity)).toHaveLength(1);
  });

  it("fails visibly on a corrupted ready pointer or missing corpus without rebuilding", async () => {
    const prepared = await fixture();
    await prepared.createRunner()(input());
    const file = path.join(prepared.directory, "ready", `${prepared.request.identity}.json`);
    const bytes = await readFile(file);
    await writeFile(file, '{"truncated":');
    await expect(prepared.createRunner()(input("half-ppr"))).rejects.toThrow();
    await writeFile(file, bytes);
    await rm(path.join(prepared.directory, "corpora"), { recursive: true });
    await expect(prepared.createRunner()(input("half-ppr"))).rejects.toThrow(
      /ready corpus is missing/,
    );
    expect(prepared.runner).toHaveBeenCalledTimes(1);
  });

  it("fails replay on a missing outcome without falling back to a fresh per-profile build", async () => {
    const prepared = await fixture();
    await prepared.createRunner()(input());
    const entry = (await readdir(prepared.directory)).find((file) =>
      file.endsWith(".ros-outcomes"),
    )!;
    await rm(path.join(prepared.directory, entry));
    await expect(prepared.createRunner()(input("half-ppr"))).rejects.toThrow(/missing or corrupt/);
    expect(prepared.runner.mock.calls.filter(([job]) => !job.replayCorpusIdentity)).toHaveLength(1);
    expect(prepared.runner.mock.calls.at(-1)?.[0].replayCorpusIdentity).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("verifies source lineage and every referenced outcome before exposing readiness", async () => {
    const prepared = await fixture();
    const written = await prepared.store.write(prepared.corpus);
    prepared.runner.mockResolvedValueOnce({
      state: "complete",
      outcomeCorpusIdentity: written.identity,
    });
    await expect(prepared.createRunner()(input())).rejects.toThrow(/missing outcome entry/);
    await expect(
      readFile(path.join(prepared.directory, "ready", `${prepared.request.identity}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await prepared.createRunner()(input());
    const file = path.join(prepared.directory, "ready", `${prepared.request.identity}.json`);
    const pointer = JSON.parse(await readFile(file, "utf8")) as {
      sourceChecksums: Record<string, string>;
    };
    pointer.sourceChecksums.catalog = "b".repeat(64);
    await writeFile(file, JSON.stringify(pointer));
    await expect(prepared.createRunner()(input())).rejects.toThrow(/source lineage/);
  });
});
