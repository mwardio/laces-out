import { createHash } from "node:crypto";
import type * as FileSystemPromises from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

import { FIRST_PARTY_ROS_MODEL_VERSION } from "@laces-out/projections";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRosHistoricalCorpusStore,
  rosHistoricalCorpusIdentity,
  type RosHistoricalCorpus,
} from "./ros-historical-corpus.js";

import { historicalCorpusFixture as corpus } from "./ros-historical-outcome.test-fixtures.js";
import { firstPartyAvailableProjectionComponents } from "./first-party-projections.js";
import {
  ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL,
  ROS_HISTORICAL_CORPUS_COVERAGE_THRESHOLDS,
  ROS_HISTORICAL_CORPUS_RELEASE_THRESHOLDS,
} from "./ros-historical-corpus-protocol.js";

// Exercise real immutable I/O independently of the host's available temporary filesystem space.
// Low-space behavior is covered separately in ros-cache-disk-space.test.ts.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof FileSystemPromises>()),
  statfs: vi.fn().mockResolvedValue({
    type: 0n,
    bsize: 4_096n,
    blocks: 16_777_216n,
    bfree: 16_777_216n,
    bavail: 16_777_216n,
    files: 100_000n,
    ffree: 99_000n,
  }),
}));

const directories: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function store() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ros-historical-corpus-"));
  directories.push(directory);
  return { directory, store: createRosHistoricalCorpusStore({ directory }) };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("shared historical evaluation corpus", () => {
  it("reads original v5 corpus bytes without rewriting their provenance or identity", async () => {
    const storage = await store();
    const current = corpus();
    const original: RosHistoricalCorpus = {
      ...current,
      buildProtocol: {
        ...ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL,
        policyVersion: "season-walk-forward-block-wis-cqr-v5",
        calibrationVersion: "season-blocked-split-conformal-cqr-v1",
      },
    };
    const { identity } = await storage.store.write(original);
    const file = path.join(storage.directory, `${identity}.ros-corpus.json.gz`);
    const before = await readFile(file);
    expect(identity).not.toBe(rosHistoricalCorpusIdentity(current));
    expect(await storage.store.read(identity)).toEqual({
      state: "hit",
      identity,
      corpus: original,
    });
    expect(await readFile(file)).toEqual(before);
    expect(original.buildProtocol.policyVersion).toBe("season-walk-forward-block-wis-cqr-v5");
  });

  it("accepts the full locked forecast scope with the complete modeled actual-stat vocabulary", () => {
    const manifest = corpus();
    const row = manifest.forecasts[0]!;
    const actualComponents = Object.fromEntries(
      firstPartyAvailableProjectionComponents().map((name) => [name, 1]),
    );
    const complete = {
      ...manifest,
      forecasts: Array.from({ length: 6_000 }, (_, index) => ({
        ...row,
        forecast: { ...row.forecast, playerId: `full-scope-player-${index}` },
        actualComponents,
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(complete))).toBeGreaterThan(16 * 1_024 * 1_024);
    expect(rosHistoricalCorpusIdentity(complete)).toMatch(/^[a-f0-9]{64}$/u);
  }, 30_000);

  it("stores a small immutable manifest with exact sources, heldout outcomes and cache references", async () => {
    const storage = await store();
    const manifest = corpus();
    const identity = rosHistoricalCorpusIdentity(manifest);
    expect(await storage.store.read(identity)).toEqual({ state: "missing" });
    expect(await storage.store.write(manifest)).toEqual({ state: "written", identity });
    const read = await storage.store.read(identity);
    expect(read).toEqual({ state: "hit", identity, corpus: manifest });
    const bytes = await readFile(path.join(storage.directory, `${identity}.ros-corpus.json.gz`));
    const saved = gunzipSync(bytes).toString("utf8");
    expect(saved).not.toContain("scoringProfileKey");
    expect(saved).not.toContain("contextualComponents");
    expect(saved).toContain("-3.5");
    expect(saved.length).toBeLessThan(10_000);
  });

  it("has one atomic winner, snapshots caller data and is idempotent across key insertion order", async () => {
    const storage = await store();
    const manifest = corpus();
    const identity = rosHistoricalCorpusIdentity(manifest);
    const writes = await Promise.all([
      storage.store.write(manifest),
      storage.store.write({
        ...manifest,
        sourceChecksums: Object.fromEntries(Object.entries(manifest.sourceChecksums).reverse()),
      }),
    ]);
    expect(writes.map((write) => write.state).sort()).toEqual(["existing", "written"]);
    expect(writes.every((write) => write.identity === identity)).toBe(true);
    const changed = { ...corpus() };
    const pending = storage.store.write(changed);
    changed.productionBasis = "mutated after invocation";
    expect((await pending).identity).toBe(identity);
    expect(await readdir(storage.directory)).toHaveLength(1);
  });

  it("changes identity when observed outcomes, source lineage, scope or referenced vectors change", () => {
    const original = corpus();
    const identity = rosHistoricalCorpusIdentity(original);
    for (const changed of [
      {
        ...original,
        sourceChecksums: { ...original.sourceChecksums, catalog: hash("updated catalog") },
      },
      {
        ...original,
        forecasts: [
          {
            ...original.forecasts[0]!,
            actualComponents: { ...original.forecasts[0]!.actualComponents, receptions: 2 },
          },
        ],
      },
      {
        ...original,
        forecasts: [
          {
            ...original.forecasts[0]!,
            contextualKey: {
              modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
              identity: hash("changed vectors"),
            },
          },
        ],
      },
      { ...original, options: { ...original.options, playersPerPosition: 9 } },
    ])
      expect(rosHistoricalCorpusIdentity(changed)).not.toBe(identity);
  });

  it("rejects legacy manifests, stale build versions, altered release gates and stale interval evidence", async () => {
    const storage = await store();
    const original = corpus();
    const changed: unknown[] = [
      { ...original, schemaVersion: "ros-historical-corpus-v1" },
      { ...original, buildProtocol: undefined },
      { ...original, weeklyModelVersion: "old weekly model" },
      { ...original, productionBasis: "old production loss" },
      {
        ...original,
        coverage: {
          ...original.coverage,
          thresholds: {
            ...original.coverage.thresholds,
            minimumRosterMatchRate: 0,
          },
        },
      },
      {
        ...original,
        forecasts: [
          {
            ...original.forecasts[0]!,
            forecast: {
              ...original.forecasts[0]!.forecast,
              intervalMethodVersion: "old interval",
            },
          },
        ],
      },
      ...Object.keys(ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL).map((name) => ({
        ...original,
        buildProtocol: { ...original.buildProtocol, [name]: "old" },
      })),
      ...(["contextualModelVersion", "recencyModelVersion"] as const).map((name) => ({
        ...original,
        forecasts: [
          {
            ...original.forecasts[0]!,
            forecast: {
              ...original.forecasts[0]!.forecast,
              [name]: `${original.forecasts[0]!.forecast[name]}:stale`,
            },
          },
        ],
      })),
      ...Object.entries(ROS_HISTORICAL_CORPUS_RELEASE_THRESHOLDS).map(([name, value]) => ({
        ...original,
        options: { ...original.options, [name]: value - 1 },
      })),
      ...Object.entries(ROS_HISTORICAL_CORPUS_COVERAGE_THRESHOLDS).map(([name, value]) => ({
        ...original,
        coverage: {
          ...original.coverage,
          thresholds: { ...original.coverage.thresholds, [name]: value / 2 },
        },
      })),
    ];
    for (const value of changed) {
      await expect(storage.store.write(value as RosHistoricalCorpus)).rejects.toMatchObject({
        code: "invalid_manifest",
      });
    }
    expect(await readdir(storage.directory)).toEqual([]);
  });

  it("fails closed on corrupted, truncated, wrong-identity or symlink artifacts", async () => {
    const storage = await store();
    const result = await storage.store.write(corpus());
    const file = path.join(storage.directory, `${result.identity}.ros-corpus.json.gz`);
    const bytes = await readFile(file);
    await writeFile(file, bytes.subarray(0, bytes.length - 4));
    expect((await storage.store.read(result.identity)).state).toBe("corrupt");
    await expect(storage.store.write(corpus())).rejects.toMatchObject({
      code: "existing_entry_corrupt",
    });
    const envelope = JSON.parse(gunzipSync(bytes).toString("utf8")) as {
      identity: string;
      corpus: { productionBasis: string };
    };
    envelope.corpus.productionBasis = "modified while checksum unchanged";
    await writeFile(file, gzipSync(JSON.stringify(envelope)));
    expect(await storage.store.read(result.identity)).toEqual({
      state: "corrupt",
      reason: "checksum_mismatch",
    });
    envelope.identity = hash("wrong identity");
    await writeFile(file, gzipSync(JSON.stringify(envelope)));
    expect((await storage.store.read(result.identity)).state).toBe("corrupt");
    const outside = path.join(storage.directory, "outside.gz");
    await writeFile(outside, bytes);
    await rm(file);
    await symlink(outside, file);
    expect((await storage.store.read(result.identity)).state).toBe("corrupt");
  });

  it.each([
    [
      "future training",
      (value: RosHistoricalCorpus) => ({
        ...value,
        forecasts: [
          {
            ...value.forecasts[0]!,
            forecast: { ...value.forecasts[0]!.forecast, trainedThroughSeason: 2025 },
          },
        ],
      }),
    ],
    ["model", (value: RosHistoricalCorpus) => ({ ...value, modelVersion: "old model" })],
    [
      "missing source digest",
      (value: RosHistoricalCorpus) => ({ ...value, sourceChecksums: { catalog: hash("catalog") } }),
    ],
    [
      "duplicate forecast",
      (value: RosHistoricalCorpus) => ({
        ...value,
        forecasts: [value.forecasts[0]!, value.forecasts[0]!],
      }),
    ],
    [
      "wrong strategy reference",
      (value: RosHistoricalCorpus) => ({
        ...value,
        forecasts: [{ ...value.forecasts[0]!, contextualKey: value.forecasts[0]!.recencyKey }],
      }),
    ],
    [
      "nonfinite actual",
      (value: RosHistoricalCorpus) => ({
        ...value,
        forecasts: [{ ...value.forecasts[0]!, actualComponents: { receptions: Number.NaN } }],
      }),
    ],
    [
      "scored outcome leakage",
      (value: RosHistoricalCorpus) => ({
        ...value,
        forecasts: [
          {
            ...value.forecasts[0]!,
            forecast: { ...value.forecasts[0]!.forecast, actualPoints: 99 },
          },
        ],
      }),
    ],
    [
      "unqualified season",
      (value: RosHistoricalCorpus) => ({
        ...value,
        coverage: { ...value.coverage, fullyHeldOutSeasons: [] },
      }),
    ],
    [
      "invalid actual games",
      (value: RosHistoricalCorpus) => ({
        ...value,
        forecasts: [{ ...value.forecasts[0]!, actualGames: 14 }],
      }),
    ],
  ] as const)("rejects %s before persisting evidence", async (_label, change) => {
    const storage = await store();
    await expect(storage.store.write(change(corpus()))).rejects.toMatchObject({
      code: "invalid_manifest",
    });
    expect(await readdir(storage.directory)).toEqual([]);
  });

  it("bounds compressed/uncompressed manifests and does not leak files on cancellation", async () => {
    const storage = await store();
    const limited = createRosHistoricalCorpusStore({
      directory: storage.directory,
      maximumBytes: 256,
    });
    await expect(limited.write(corpus())).rejects.toMatchObject({ code: "limits_exceeded" });
    expect(await readdir(storage.directory)).toEqual([]);
    const controller = new AbortController();
    const pending = storage.store.write(corpus(), { signal: controller.signal });
    controller.abort(new Error("cancel corpus"));
    await expect(pending).rejects.toThrow();
    expect(await readdir(storage.directory)).toEqual([]);
    const result = await storage.store.write(corpus());
    expect(await limited.read(result.identity)).toEqual({
      state: "corrupt",
      reason: "limits_exceeded",
    });
  });
});
