import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type * as FileSystemPromises from "node:fs/promises";
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  FIRST_PARTY_ROS_MODEL_VERSION as V13,
  FIRST_PARTY_ROS_RETAINED_V12_MODEL_VERSION as V12,
  firstPartyRosSeedHash,
  scoreFirstPartyRosOutcomes,
  scoreRetainedV12FirstPartyRosOutcomes,
} from "@laces-out/projections";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRosDerivedOutcomeCache,
  createRosDerivedOutcomeRecord,
  type RosDerivedOutcomeDependencies,
  type RosDerivedOutcomeRecord,
  type RosDerivedOutcomeRow,
  type RosDerivedOutcomeSource,
} from "./ros-derived-outcome-cache.js";
import {
  restoreCachedRosHistoricalOutcome,
  restoreRetainedV12CachedRosHistoricalOutcome,
} from "./ros-historical-outcome-replay.js";
import { historicalCorpusFixture } from "./ros-historical-outcome.test-fixtures.js";
import * as outcomeCache from "./ros-outcome-cache.js";
import type { RosOutcomeCacheEnsemble } from "./ros-outcome-cache.js";

// Tiny real-codec fixtures should not depend on host disk headroom; the production guard has
// its own tests. All file authentication and decoding below remain real.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof FileSystemPromises>()),
  statfs: vi.fn().mockResolvedValue({ bsize: 4_096n, bavail: 16_777_216n }),
}));

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown) => hash(canonical(value));
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(position: "WR" | "DST" = "WR", invalidSeed = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ros-derived-cache-"));
  directories.push(directory);
  const native = position === "DST";
  const modelVersion = native ? V13 : V12;
  const base = historicalCorpusFixture();
  const row = base.forecasts[0]!;
  const sourceRow: RosDerivedOutcomeRow = {
    forecast: {
      ...row.forecast,
      playerId: native ? "DST:ATL" : "receiver",
      position,
      windowEndWeek: 5,
      contextualModelVersion: `${modelVersion}:contextual:laces-weekly-components-v15`,
      recencyModelVersion: `${modelVersion}:availability-aware-recency:laces-weekly-components-v15`,
    },
    contextualKey: { modelVersion, identity: hash(`${position}-physical-contextual`) },
    recencyKey: { modelVersion, identity: hash(`${position}-physical-recency`) },
    scheduledGames: 1,
  };
  const targetRow: RosDerivedOutcomeRow = native
    ? structuredClone(sourceRow)
    : {
        ...sourceRow,
        forecast: {
          ...sourceRow.forecast,
          contextualModelVersion: `${V13}:contextual:laces-weekly-components-v15`,
          recencyModelVersion: `${V13}:availability-aware-recency:laces-weekly-components-v15`,
        },
        contextualKey: { modelVersion: V13, identity: hash("virtual-contextual") },
        recencyKey: { modelVersion: V13, identity: hash("virtual-recency") },
      };
  const strategy = "contextual" as const;
  const seed = "original-physical-seed";
  const asOfAt = "2025-10-01T12:00:00.000Z";
  const seedHash = firstPartyRosSeedHash({
    ...sourceRow.forecast,
    season: sourceRow.forecast.forecastSeason,
    strategy,
    seed,
    asOfAt,
  });
  const provenance = {
    modelVersion,
    strategy,
    weeklyModelVersion: base.weeklyModelVersion,
    inputChecksum: sourceRow.forecast.inputChecksum,
    seedHash: invalidSeed ? hash("wrong-seed") : seedHash,
    randomGenerator: "xoshiro128**-sha256-128",
    scenarioCount: 16_384,
    season: sourceRow.forecast.forecastSeason,
    asOfWeek: sourceRow.forecast.asOfWeek,
    asOfAt,
    windowStartWeek: 5,
    windowEndWeek: 5,
    intervalCalibration: "simulation-only",
  };
  const ensemble: RosOutcomeCacheEnsemble = {
    scenarioCount: 16_384,
    columns: native
      ? { defense_sacks: new Float64Array(16_384).fill(2) }
      : {
          receiving_yards: Float64Array.from({ length: 16_384 }, (_, index) =>
            index === 0 ? -0 : index % 2 === 0 ? -3.5 : 29.75,
          ),
          receptions: new Float64Array(16_384).fill(2),
        },
    games: new Uint8Array(16_384).fill(1),
    metadata: {
      schemaVersion: base.outcomeSchemaVersion,
      identity: sourceRow.contextualKey.identity,
      seed,
      core: {
        playerId: sourceRow.forecast.playerId,
        position,
        scheduledGames: 1,
        provenance,
        simulation: {
          availabilityLagOneCorrelation: null,
          roleLagOneCorrelation: null,
          boundedRoleSamples: 0,
        },
        diagnostics: [],
      },
    },
  };
  const physicalCache = outcomeCache.createRosOutcomeCache({ directory });
  const saved = await physicalCache.write(sourceRow.contextualKey, ensemble);
  const filename = `${digest({ version: 1, ...sourceRow.contextualKey })}.ros-outcomes`;
  const file = path.join(directory, filename);
  const bytes = await readFile(file);
  const header = JSON.parse(bytes.subarray(12, 12 + bytes.readUInt32LE(8)).toString()) as {
    manifest: Record<string, unknown>;
  };
  const source: RosDerivedOutcomeSource = {
    namespace: native ? "native-dst-v13" : "original-v12",
    key: sourceRow.contextualKey,
    filename,
    sha256: hash(bytes),
    bytes: bytes.length,
    manifestChecksum: saved.manifestChecksum,
    manifest: header.manifest,
  };
  const sourceCorpusIdentity = hash(`${position}-independently-pinned-original-corpus`);
  const auditVector = native
    ? null
    : {
        forecastIdentity: "2025:4:WR:receiver",
        strategy,
        position,
        originalModelVersion: V12,
        originalCorpusIdentity: sourceCorpusIdentity,
        originalKey: source.key,
        currentProposedKey: targetRow.contextualKey,
        originalManifest: source.manifest,
        originalProvenance: provenance,
        originalCacheFile: filename,
        originalFileSha256: source.sha256,
        originalManifestChecksum: source.manifestChecksum,
        originalUncompressedPayloadChecksum: source.manifest.dataChecksum,
        inputChecksumEqual: true,
        seedEqual: true,
        windowEqual: true,
        allPayloadChecksPassed: true,
        fullReferencePaths: 16_384,
        scheduledGames: 1,
        currentCanonicalFullInputSha256: hash("complete-candidate-football-input"),
      };
  const dependencies: RosDerivedOutcomeDependencies = {
    sourceRow,
    targetRow,
    strategy,
    source,
    sourceCorpusIdentity,
    auditVector,
  };
  const record = createRosDerivedOutcomeRecord(dependencies);
  const sourceRoots = { [source.namespace]: directory };
  const options = { records: [record], dependencies: [dependencies], sourceRoots };
  return {
    directory,
    file,
    bytes,
    source,
    sourceRow,
    targetRow,
    ensemble,
    dependencies,
    record,
    options,
    cache: createRosDerivedOutcomeCache(options),
    expected: {
      ...sourceRow.forecast,
      strategy,
      weeklyModelVersion: base.weeklyModelVersion,
      scheduledGames: 1,
    },
  };
}

describe("authenticated derived ROS vector references", () => {
  it("preserves original v12 bytes, seed, signed zero and exact scores while exposing only a transient v13 view", async () => {
    const f = await fixture();
    const beforeNames = await readdir(f.directory);
    const original = await outcomeCache
      .createRosOutcomeCache({ directory: f.directory })
      .read(f.source.key);
    expect(original.state).toBe("hit");
    if (original.state !== "hit") throw new Error("fixture missing");
    const restored = restoreRetainedV12CachedRosHistoricalOutcome(
      original.ensemble,
      f.source.key,
      f.expected,
    );
    const result = await f.cache.read(f.targetRow.contextualKey, { expectedScenarioCount: 16_384 });
    expect(result.state).toBe("hit");
    if (result.state !== "hit") throw new Error("reference missing");
    const virtual = restoreCachedRosHistoricalOutcome(result.ensemble, f.targetRow.contextualKey, {
      ...f.expected,
      ...f.targetRow.forecast,
    });
    expect(result.ensemble.games).toEqual(original.ensemble.games);
    for (const name of Object.keys(original.ensemble.columns))
      expect(Buffer.from(result.ensemble.columns[name]!.buffer)).toEqual(
        Buffer.from(original.ensemble.columns[name]!.buffer),
      );
    expect(Object.is(result.ensemble.columns.receiving_yards![0], -0)).toBe(true);
    expect(result.ensemble.metadata.seed).toBe(original.ensemble.metadata.seed);
    const profile = {
      id: "exact-new-scoring",
      rules: [
        { statId: "receptions", points: 1.25 },
        { statId: "receiving_yards", points: 0.125 },
      ],
    };
    expect(scoreFirstPartyRosOutcomes(virtual, profile, 12_288)).toEqual(
      scoreRetainedV12FirstPartyRosOutcomes(restored, profile, 12_288),
    );
    expect(result.manifestChecksum).toBe(
      f.cache.expectedManifestChecksum(f.targetRow.contextualKey),
    );
    expect(f.cache.receipts()).toEqual([
      expect.objectContaining({
        sourceFileSha256: f.source.sha256,
        originalManifestChecksum: f.source.manifestChecksum,
        generationModelVersion: V12,
        compatibleModelVersion: V13,
        noOriginalWrites: true,
        noSimulation: true,
        canAuthorizeRelease: false,
      }),
    ]);
    expect(await readFile(f.file)).toEqual(f.bytes);
    expect(await readdir(f.directory)).toEqual(beforeNames);
    await expect(f.cache.write(f.targetRow.contextualKey, result.ensemble)).rejects.toThrow(
      /read-only/,
    );
    expect(
      await outcomeCache
        .createRosOutcomeCache({ directory: f.directory })
        .read(f.targetRow.contextualKey),
    ).toEqual({ state: "missing" });
  });

  it("reads native DST without any model, key or metadata translation", async () => {
    const f = await fixture("DST");
    const result = await f.cache.read(f.targetRow.contextualKey);
    expect(result).toEqual({
      state: "hit",
      ensemble: f.ensemble,
      manifestChecksum: f.source.manifestChecksum,
    });
    expect(f.cache.receipts()[0]?.generationModelVersion).toBe(V13);
    expect(await readFile(f.file)).toEqual(f.bytes);
  });

  it("owns dependency snapshots before asynchronous reads and does not retain caller or result mutation", async () => {
    const f = await fixture();
    const submitted = structuredClone(f.record);
    const dependency = structuredClone(f.dependencies);
    const cache = createRosDerivedOutcomeCache({
      ...f.options,
      records: [submitted],
      dependencies: [dependency],
    });
    Object.assign(submitted.source, { sha256: hash("mutated") });
    Object.assign(dependency.targetRow.forecast, { playerId: "wrong-player" });
    const pending = cache.read(f.targetRow.contextualKey);
    f.options.sourceRoots["original-v12"] = "/wrong-root";
    const first = await pending;
    expect(first.state).toBe("hit");
    if (first.state !== "hit") throw new Error("reference missing");
    first.ensemble.columns.receptions![0] = 900;
    Object.assign(first.ensemble.metadata, { seed: "bad-seed" });
    const second = await cache.read(f.targetRow.contextualKey);
    expect(second.state).toBe("hit");
    if (second.state === "hit") expect(second.ensemble.columns.receptions![0]).toBe(2);
    expect(cache.receipts()).toHaveLength(1);
  });

  it("requires independent proof reconstruction, rejecting even self-consistent forged mapping metadata", async () => {
    const f = await fixture();
    const changed = structuredClone(f.dependencies);
    Object.assign(changed.source, { sha256: hash("different-original-file") });
    Object.assign(changed.auditVector!, { originalFileSha256: changed.source.sha256 });
    const forged = createRosDerivedOutcomeRecord(changed);
    expect(() => createRosDerivedOutcomeCache({ ...f.options, records: [forged] })).toThrow(
      /Independent record reconstruction/,
    );
    for (const mutate of [
      (d: RosDerivedOutcomeDependencies) => Object.assign(d, { auditVector: null }),
      (d: RosDerivedOutcomeDependencies) => Object.assign(d.auditVector!, { seedEqual: false }),
      (d: RosDerivedOutcomeDependencies) =>
        Object.assign(d.auditVector!, {
          currentProposedKey: { ...d.targetRow.contextualKey, identity: hash("other-key") },
        }),
      (d: RosDerivedOutcomeDependencies) =>
        Object.assign(d.targetRow.forecast, { windowEndWeek: 6 }),
      (d: RosDerivedOutcomeDependencies) =>
        Object.assign(d.targetRow.forecast, { playerId: "different-player" }),
      (d: RosDerivedOutcomeDependencies) =>
        Object.assign(d, { strategy: "availability-aware-recency" }),
    ]) {
      const dependency = structuredClone(f.dependencies);
      mutate(dependency);
      expect(() => createRosDerivedOutcomeRecord(dependency)).toThrow();
    }
  });

  it("forbids retained DST compatibility and native DST metadata translation", async () => {
    const f = await fixture("DST");
    const wrong = structuredClone(f.dependencies);
    Object.assign(wrong.source, { namespace: "original-v12" });
    expect(() => createRosDerivedOutcomeRecord(wrong)).toThrow(/DST compatibility/);
    const translated = structuredClone(f.dependencies);
    Object.assign(translated.targetRow.forecast, { inputChecksum: hash("new-defense-physics") });
    expect(() => createRosDerivedOutcomeRecord(translated)).toThrow(/Native DST physical identity/);
    const compatible = structuredClone(f.dependencies);
    Object.assign(compatible, { auditVector: {} });
    expect(() => createRosDerivedOutcomeRecord(compatible)).toThrow(/Native DST cannot carry/);
  });

  it("rejects unknown or duplicate targets/sources, path traversal, arbitrary roots and unsupported scenarios", async () => {
    const f = await fixture();
    expect(() =>
      createRosDerivedOutcomeCache({
        ...f.options,
        records: [f.record, f.record],
        dependencies: [f.dependencies, f.dependencies],
      }),
    ).toThrow(/Duplicate/);
    expect(() => createRosDerivedOutcomeCache({ ...f.options, dependencies: [] })).toThrow(
      /coverage/,
    );
    expect(() => createRosDerivedOutcomeCache({ ...f.options, sourceRoots: {} })).toThrow(
      /configured root/,
    );
    expect(() =>
      createRosDerivedOutcomeCache({ ...f.options, sourceRoots: { "original-v12": "relative" } }),
    ).toThrow(/absolute/);
    const dependency = structuredClone(f.dependencies);
    Object.assign(dependency.source, { filename: "../elsewhere.ros-outcomes" });
    expect(() => createRosDerivedOutcomeRecord(dependency)).toThrow(/basename/);
    await expect(
      f.cache.read({ ...f.targetRow.contextualKey, identity: hash("unknown") }),
    ).rejects.toThrow(/Unknown derived/);
    await expect(f.cache.read(f.source.key)).rejects.toThrow(/virtual current/);
    await expect(
      f.cache.read(f.targetRow.contextualKey, { expectedScenarioCount: 12_288 }),
    ).rejects.toThrow(/scenario/);
    expect(f.cache.receipts()).toEqual([]);
  });

  it("rejects missing, modified and truncated originals without writing replacement files", async () => {
    const f = await fixture();
    const modified = Buffer.from(f.bytes);
    modified[modified.length - 1] = modified[modified.length - 1]! ^ 1;
    await writeFile(f.file, modified);
    await expect(f.cache.read(f.targetRow.contextualKey)).rejects.toThrow(/source file hash/);
    await writeFile(f.file, f.bytes.subarray(0, 16));
    await expect(f.cache.read(f.targetRow.contextualKey)).rejects.toThrow(/bounded regular/);
    await rm(f.file);
    await expect(f.cache.read(f.targetRow.contextualKey)).rejects.toThrow(/ENOENT/);
    expect(await readdir(f.directory)).toEqual([]);
    expect(f.cache.receipts()).toEqual([]);
  });

  it("rejects source or ancestor symlinks and a FIFO without blocking", async () => {
    const f = await fixture();
    const archived = `${f.file}.original`;
    await rename(f.file, archived);
    await symlink(archived, f.file);
    await expect(f.cache.read(f.targetRow.contextualKey)).rejects.toThrow();
    await rm(f.file);
    execFileSync("mkfifo", [f.file]);
    await expect(f.cache.read(f.targetRow.contextualKey)).rejects.toThrow(/bounded regular/);
    const alias = `${f.directory}-alias`;
    directories.push(alias);
    await symlink(f.directory, alias);
    const cache = createRosDerivedOutcomeCache({
      ...f.options,
      sourceRoots: { "original-v12": alias },
    });
    await expect(cache.read(f.targetRow.contextualKey)).rejects.toThrow(/symlink/);
  });

  it("rechecks source identity after the real codec reads even if replacement bytes are identical", async () => {
    const f = await fixture();
    const actualCreate = outcomeCache.createRosOutcomeCache;
    vi.spyOn(outcomeCache, "createRosOutcomeCache").mockImplementation((options) => {
      const real = actualCreate(options);
      return {
        ...real,
        read: async (key, options) => {
          const result = await real.read(key, options);
          const replacement = `${f.file}.replacement`;
          await writeFile(replacement, f.bytes);
          await rename(replacement, f.file);
          return result;
        },
      };
    });
    await expect(f.cache.read(f.targetRow.contextualKey)).rejects.toThrow(
      /source changed|Source path changed/,
    );
    expect(f.cache.receipts()).toEqual([]);
  });

  it("rejects inconsistent seeds even when file and manifest hashes and supplied proof all agree", async () => {
    const f = await fixture("WR", true);
    await expect(f.cache.read(f.targetRow.contextualKey)).rejects.toThrow(
      /outcome_evidence_corrupt/,
    );
    expect(f.cache.receipts()).toEqual([]);
  });

  it("requires the real codec payload and manifest commitment even after a bad file is rehashed", async () => {
    const f = await fixture();
    const changed = Buffer.from(f.bytes);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    await writeFile(f.file, changed);
    const dependencies = structuredClone(f.dependencies);
    Object.assign(dependencies.source, { sha256: hash(changed) });
    Object.assign(dependencies.auditVector!, { originalFileSha256: hash(changed) });
    const cache = createRosDerivedOutcomeCache({
      ...f.options,
      records: [createRosDerivedOutcomeRecord(dependencies)],
      dependencies: [dependencies],
    });
    await expect(cache.read(f.targetRow.contextualKey)).rejects.toThrow(/real-codec validation/);
    expect(cache.receipts()).toEqual([]);
  });

  it("honors cancellation before I/O and after a codec await without recording successful evidence", async () => {
    const f = await fixture();
    const before = new AbortController();
    before.abort(new Error("cancel-before"));
    await expect(
      f.cache.read(f.targetRow.contextualKey, { signal: before.signal }),
    ).rejects.toThrow("cancel-before");
    const during = new AbortController();
    const actualCreate = outcomeCache.createRosOutcomeCache;
    vi.spyOn(outcomeCache, "createRosOutcomeCache").mockImplementation((options) => {
      const real = actualCreate(options);
      return {
        ...real,
        read: async (key, options) => {
          const result = await real.read(key, options);
          during.abort(new Error("cancel-during"));
          return result;
        },
      };
    });
    await expect(
      f.cache.read(f.targetRow.contextualKey, { signal: during.signal }),
    ).rejects.toThrow("cancel-during");
    expect(f.cache.receipts()).toEqual([]);
  });

  it("rejects unsafe JSON, extra mapping fields and unbounded input before file access", async () => {
    const f = await fixture();
    const getter = Object.defineProperty({}, "sourceRow", {
      enumerable: true,
      get() {
        throw new Error("getter executed");
      },
    });
    expect(() => createRosDerivedOutcomeRecord(getter as RosDerivedOutcomeDependencies)).toThrow(
      /Reference getter/,
    );
    const extra = { ...f.record, canAuthorizeRelease: true };
    expect(() => createRosDerivedOutcomeCache({ ...f.options, records: [extra] })).toThrow(
      /reconstruction/,
    );
    const sparse: unknown[] = new Array<unknown>(2);
    const dependency = {
      ...f.dependencies,
      auditVector: { ...f.dependencies.auditVector, unsupported: sparse },
    };
    expect(() => createRosDerivedOutcomeRecord(dependency)).toThrow(/dense/);
    expect(() =>
      createRosDerivedOutcomeCache({
        ...f.options,
        records: new Array<RosDerivedOutcomeRecord>(12_001),
      }),
    ).toThrow(/population/);
  });
});
