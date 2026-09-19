import type * as RosHistoricalCorpusModule from "./ros-historical-corpus.js";
import type * as RosOutcomeCacheModule from "./ros-outcome-cache.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRosHistoricalCorpusStore,
  createRetainedV12RosHistoricalCorpusReader,
  type RosHistoricalCorpus,
  type RosHistoricalCorpusLookup,
} from "./ros-historical-corpus.js";
import { createRosOutcomeCache } from "./ros-outcome-cache.js";
import {
  restoreCachedRosHistoricalOutcome,
  restoreRetainedV12CachedRosHistoricalOutcome,
} from "./ros-historical-outcome-replay.js";
import { historicalCorpusFixture } from "./ros-historical-outcome.test-fixtures.js";
import { rosSharedCorpusRequest } from "./ros-shared-corpus-runner.js";
import {
  ROS_MARGINAL_CORPUS_BUNDLE_VERSION,
  type RosMarginalCorpusBundle,
} from "./ros-profile-marginal-evidence.js";
import {
  createRosMarginalCorpusBundleResolver,
  prepareRosMarginalCorpusBundle,
  RosMarginalDependencyError,
  rosMarginalCorpusSourceLineageChecksum,
} from "./ros-marginal-corpus-bundle.js";
import { assertRosCacheHeadroom } from "./ros-cache-disk-space.js";

vi.mock("./ros-historical-corpus.js", async (original) => ({
  ...(await original<typeof RosHistoricalCorpusModule>()),
  createRosHistoricalCorpusStore: vi.fn(),
  createRetainedV12RosHistoricalCorpusReader: vi.fn(),
}));
vi.mock("./ros-outcome-cache.js", async (original) => ({
  ...(await original<typeof RosOutcomeCacheModule>()),
  createRosOutcomeCache: vi.fn(),
}));
vi.mock("./ros-historical-outcome-replay.js", () => ({
  restoreCachedRosHistoricalOutcome: vi.fn(),
  restoreRetainedV12CachedRosHistoricalOutcome: vi.fn(),
}));
vi.mock("./ros-cache-disk-space.js", () => ({ assertRosCacheHeadroom: vi.fn() }));
const roots: string[] = [];
const protocol = "# Fixed protocol\n";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const bundle: RosMarginalCorpusBundle = {
  version: ROS_MARGINAL_CORPUS_BUNDLE_VERSION,
  forecastSeason: 2026,
  candidateCorpusIdentity: "a".repeat(64),
  previousCorpusIdentity: "b".repeat(64),
  intervalTrainingCorpusIdentity: "c".repeat(64),
  qualificationProtocolText: protocol,
  qualificationProtocolChecksum: hash(protocol),
};
function corpus(training = false): RosHistoricalCorpus {
  const base = historicalCorpusFixture();
  const request = rosSharedCorpusRequest(2026).protocol;
  const positions = training ? (["DST"] as const) : request.positions;
  const playersPerPosition = training ? 32 : 8;
  return {
    ...base,
    sourceAudit: request.sourceSeasons.map((season) => ({ ...base.sourceAudit[0], season })),
    seasons: request.heldOutSeasons,
    coverage: {
      ...base.coverage,
      heldOutSeasonsRequested: request.heldOutSeasons,
      fullyHeldOutSeasons: request.heldOutSeasons,
      completeAsOfBatches: request.heldOutSeasons.length * request.asOfWeeks.length,
    },
    options: {
      ...base.options,
      positions,
      heldOutSeasons: request.heldOutSeasons,
      asOfWeeks: request.asOfWeeks,
      playersPerPosition,
    },
    forecasts: request.heldOutSeasons.flatMap((forecastSeason) =>
      request.asOfWeeks.flatMap((asOfWeek) =>
        positions.flatMap((position) =>
          Array.from({ length: playersPerPosition }, (_, index) => ({
            ...base.forecasts[0]!,
            forecast: {
              ...base.forecasts[0]!.forecast,
              playerId: `${position}-${index}`,
              forecastSeason,
              asOfWeek,
              position,
              windowStartWeek: asOfWeek + 1,
            },
          })),
        ),
      ),
    ),
  };
}
let corpora: Map<string, RosHistoricalCorpus>;
let read: ReturnType<typeof vi.fn<(identity: string) => Promise<RosHistoricalCorpusLookup>>>;
let cacheRead: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  corpora = new Map([
    [bundle.candidateCorpusIdentity, corpus()],
    [bundle.previousCorpusIdentity, corpus()],
    [bundle.intervalTrainingCorpusIdentity!, corpus(true)],
  ]);
  read = vi.fn(async (identity: string): Promise<RosHistoricalCorpusLookup> => {
    const corpus = corpora.get(identity);
    return corpus ? { state: "hit", identity, corpus } : { state: "missing" };
  });
  vi.mocked(createRosHistoricalCorpusStore).mockReturnValue({ read, write: vi.fn() });
  vi.mocked(createRetainedV12RosHistoricalCorpusReader).mockReturnValue({ read });
  cacheRead = vi.fn(async () => ({ state: "hit", ensemble: {} }));
  vi.mocked(createRosOutcomeCache).mockReturnValue({ read: cacheRead } as unknown as ReturnType<
    typeof createRosOutcomeCache
  >);
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "ros-bundle-"));
  roots.push(directory);
  const signal = new AbortController().signal;
  const assertHeld = vi.fn(async () => {});
  const options = {
    directory,
    bundle,
    signal,
    sourceLineageChecksum: rosMarginalCorpusSourceLineageChecksum(
      corpora.get(bundle.candidateCorpusIdentity)!,
    ),
    lock: async <T>(
      _identity: string,
      _signal: AbortSignal,
      run: (guard: { signal: AbortSignal; assertHeld: () => Promise<void> }) => Promise<T>,
    ) => run({ signal, assertHeld }),
  };
  return { directory, signal, options, assertHeld };
}
describe("shared marginal dependency bundle", () => {
  it("prepares one fenced immutable bundle, verifies all three vector cohorts, then resolves without simulation", async () => {
    const { options, directory, signal, assertHeld } = await setup();
    const checksum = await prepareRosMarginalCorpusBundle(options);
    expect(cacheRead).toHaveBeenCalledTimes((3264 * 2 + 2176) * 2);
    expect(restoreRetainedV12CachedRosHistoricalOutcome).toHaveBeenCalledTimes(6528);
    expect(restoreCachedRosHistoricalOutcome).toHaveBeenCalledTimes(10880);
    expect(assertHeld).toHaveBeenCalledTimes(2);
    expect(await readdir(path.join(directory, "marginal-bundles"))).toEqual([`${checksum}.json`]);
    const bytes = await readFile(
      path.join(directory, "marginal-bundles", `${checksum}.json`),
      "utf8",
    );
    expect(hash(bytes)).toBe(checksum);
    cacheRead.mockClear();
    expect(
      await createRosMarginalCorpusBundleResolver({ directory, bundleChecksum: checksum })(
        2026,
        signal,
      ),
    ).toEqual(bundle);
    expect(cacheRead).not.toHaveBeenCalled();
    expect(await prepareRosMarginalCorpusBundle(options)).toBe(checksum);
  });
  it.each(["candidate", "previous", "training"] as const)(
    "reports missing %s before any profile replay",
    async (dependency) => {
      const test = await setup();
      const checksum = await prepareRosMarginalCorpusBundle(test.options);
      const id =
        dependency === "candidate"
          ? bundle.candidateCorpusIdentity
          : dependency === "previous"
            ? bundle.previousCorpusIdentity
            : bundle.intervalTrainingCorpusIdentity!;
      corpora.delete(id);
      await expect(
        createRosMarginalCorpusBundleResolver({
          directory: test.directory,
          bundleChecksum: checksum,
        })(2026, test.signal),
      ).rejects.toMatchObject({ diagnostic: { dependency, reason: "missing" } });
    },
  );
  it("refuses mismatched source lineage, cohort holes, changed observations and unsupported season", async () => {
    const test = await setup();
    const previous = corpora.get(bundle.previousCorpusIdentity)!;
    for (const altered of [
      { ...previous, sourceChecksums: { ...previous.sourceChecksums, changed: hash("changed") } },
      { ...previous, forecasts: previous.forecasts.slice(1) },
      {
        ...previous,
        forecasts: previous.forecasts.map((row, index) =>
          index ? row : { ...row, actualGames: 9 },
        ),
      },
    ]) {
      corpora.set(bundle.previousCorpusIdentity, altered);
      await expect(prepareRosMarginalCorpusBundle(test.options)).rejects.toMatchObject({
        diagnostic: { dependency: "previous", reason: "incompatible" },
      });
    }
    await expect(
      prepareRosMarginalCorpusBundle({
        ...test.options,
        bundle: { ...bundle, forecastSeason: 2027 },
      }),
    ).rejects.toMatchObject({ diagnostic: { dependency: "bundle", reason: "incompatible" } });
  });
  it("never publishes on missing vectors, a lost fence or disk reserve failure", async () => {
    const test = await setup();
    cacheRead.mockResolvedValueOnce({ state: "missing" });
    await expect(prepareRosMarginalCorpusBundle(test.options)).rejects.toMatchObject({
      diagnostic: { dependency: "candidate", reason: "missing" },
    });
    test.assertHeld.mockRejectedValueOnce(new Error("lock lost"));
    await expect(prepareRosMarginalCorpusBundle(test.options)).rejects.toThrow("lock lost");
    vi.mocked(assertRosCacheHeadroom).mockRejectedValueOnce(new Error("disk reserve"));
    await expect(prepareRosMarginalCorpusBundle(test.options)).rejects.toThrow("disk reserve");
    expect(await readdir(path.join(test.directory, "marginal-bundles"))).toEqual([]);
  });
  it("fails closed on missing configuration, absent files, checksum tampering, symlinks and oversized files", async () => {
    const test = await setup();
    await expect(
      createRosMarginalCorpusBundleResolver({ directory: test.directory })(2026, test.signal),
    ).rejects.toMatchObject({ diagnostic: { reason: "unconfigured" } });
    await expect(
      createRosMarginalCorpusBundleResolver({
        directory: test.directory,
        bundleChecksum: hash("absent"),
      })(2026, test.signal),
    ).rejects.toMatchObject({ diagnostic: { reason: "missing" } });
    const checksum = await prepareRosMarginalCorpusBundle(test.options);
    const file = path.join(test.directory, "marginal-bundles", `${checksum}.json`);
    const resolver = createRosMarginalCorpusBundleResolver({
      directory: test.directory,
      bundleChecksum: checksum,
    });
    await rm(file);
    await writeFile(file, "{}");
    await expect(resolver(2026, test.signal)).rejects.toMatchObject({
      diagnostic: { reason: "corrupt" },
    });
    await rm(file);
    await symlink("/etc/passwd", file);
    await expect(resolver(2026, test.signal)).rejects.toBeInstanceOf(RosMarginalDependencyError);
    await rm(file);
    await writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(resolver(2026, test.signal)).rejects.toMatchObject({
      diagnostic: { reason: "corrupt" },
    });
  });
  it("binds original manifest bytes and rejects invalid UTF-8 that replacement decoding would hide", async () => {
    const test = await setup();
    const qualificationProtocolText = `${protocol}Literal replacement character: \uFFFD\n`;
    const checksum = await prepareRosMarginalCorpusBundle({
      ...test.options,
      bundle: {
        ...bundle,
        qualificationProtocolText,
        qualificationProtocolChecksum: hash(qualificationProtocolText),
      },
    });
    const file = path.join(test.directory, "marginal-bundles", `${checksum}.json`);
    const original = await readFile(file);
    const offset = original.indexOf(Buffer.from("\uFFFD"));
    expect(offset).toBeGreaterThan(0);
    const invalid = Buffer.concat([
      original.subarray(0, offset),
      Buffer.from([0xff]),
      original.subarray(offset + 3),
    ]);
    // The old nonfatal decoder would silently produce exactly the original string and hash.
    expect(invalid.toString("utf8")).toBe(original.toString("utf8"));
    await rm(file);
    await writeFile(file, invalid);
    await expect(
      createRosMarginalCorpusBundleResolver({
        directory: test.directory,
        bundleChecksum: checksum,
      })(2026, test.signal),
    ).rejects.toMatchObject({ diagnostic: { dependency: "bundle", reason: "corrupt" } });
    // Correctly pinning the malformed raw bytes must still fail UTF-8 decoding.
    const rawChecksum = createHash("sha256").update(invalid).digest("hex");
    await writeFile(path.join(test.directory, "marginal-bundles", `${rawChecksum}.json`), invalid);
    await expect(
      createRosMarginalCorpusBundleResolver({
        directory: test.directory,
        bundleChecksum: rawChecksum,
      })(2026, test.signal),
    ).rejects.toMatchObject({ diagnostic: { dependency: "bundle", reason: "corrupt" } });
  });

  it("honors cancellation before reading or publishing", async () => {
    const test = await setup();
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(
      createRosMarginalCorpusBundleResolver({ directory: test.directory })(2026, signal),
    ).rejects.toThrow("cancelled");
    await expect(
      prepareRosMarginalCorpusBundle({
        ...test.options,
        signal,
        lock: async (_id, signal, run) => {
          signal.throwIfAborted();
          return run({ signal, assertHeld: async () => {} });
        },
      }),
    ).rejects.toThrow("cancelled");
    expect(read).not.toHaveBeenCalled();
  });
});
