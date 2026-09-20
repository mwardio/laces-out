import { createHash } from "node:crypto";
import type * as FileSystemPromises from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  type FirstPartyRosOutcomeScore,
  type ProjectionScoringProfile,
  projectionScoringProfileKey,
  rosProfileDefinitionFromKey,
} from "@laces-out/projections";
import {
  historicalCorpusFixture,
  historicalOutcomeInputFixture,
} from "./ros-historical-outcome.test-fixtures.js";
import {
  createRosHistoricalOutcomeEvaluator,
  rosHistoricalOutcomeCacheKey,
} from "./ros-historical-outcome-replay.js";
import { createRosOutcomeCache } from "./ros-outcome-cache.js";
import { snapshotRosHistoricalCorpus } from "./ros-historical-corpus.js";
import { replayRosHistoricalCorpus } from "./ros-historical-corpus-replay.js";
import { replayRosDerivedPopulation } from "./ros-derived-population-replay.js";
import { buildRosDerivedReplayReport } from "./ros-derived-replay-report.js";
import type { RosDerivedOutcomeSource } from "./ros-derived-outcome-cache.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof FileSystemPromises>()),
  statfs: vi.fn().mockResolvedValue({ bsize: 4096n, bavail: 16_777_216n }),
}));
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "derived-population-"));
  dirs.push(directory);
  const cache = createRosOutcomeCache({ directory });
  const build = createRosHistoricalOutcomeEvaluator({ cache, mode: "build" });
  const input = historicalOutcomeInputFixture({
    season: 2025,
    asOfAt: "2025-10-01T12:00:00.000Z",
    weeks: historicalOutcomeInputFixture().weeks.map((week) => ({ ...week, season: 2025 })),
  });
  const recency = { ...input, strategy: "availability-aware-recency" as const };
  await build(input);
  await build(recency);
  const base = historicalCorpusFixture();
  const corpus = {
    ...base,
    options: { ...base.options, heldOutSeasons: [2023, 2024, 2025] },
    forecasts: [
      {
        ...base.forecasts[0]!,
        forecast: {
          ...base.forecasts[0]!.forecast,
          inputChecksum: input.inputChecksum,
          windowEndWeek: 5,
        },
        scheduledGames: 1,
        contextualKey: rosHistoricalOutcomeCacheKey(input),
        recencyKey: rosHistoricalOutcomeCacheKey(recency),
      },
    ],
  };
  const sourceForKey = new Map<string, RosDerivedOutcomeSource>();
  for (const filename of await readdir(directory)) {
    if (!filename.endsWith(".ros-outcomes")) continue;
    const bytes = await readFile(path.join(directory, filename));
    const envelope = JSON.parse(bytes.subarray(12, 12 + bytes.readUInt32LE(8)).toString()) as {
      manifest: Record<string, unknown> & { modelVersion: string; identity: string };
      checksum: string;
    };
    const key = {
      modelVersion: envelope.manifest.modelVersion,
      identity: envelope.manifest.identity,
    };
    sourceForKey.set(`${key.modelVersion}:${key.identity}`, {
      namespace: "native-dst-v13",
      key,
      filename,
      sha256: hash(bytes),
      bytes: bytes.length,
      manifest: envelope.manifest,
      manifestChecksum: envelope.checksum,
    });
  }
  return {
    cache,
    corpus: snapshotRosHistoricalCorpus(corpus),
    sourceForKey,
    scoreMemo: new Map<string, FirstPartyRosOutcomeScore>(),
  };
}
it("matches every native scalar, row, policy and convergence result exactly while repricing an unlisted scoring profile", async () => {
  const f = await fixture();
  const scoringProfile: ProjectionScoringProfile = {
    id: "custom-not-a-known-report",
    rules: [
      { statId: "receiving_yards", points: 0.137 },
      { statId: "receptions", points: 0.73 },
    ],
  };
  const reference = await replayRosHistoricalCorpus({ ...f, scoringProfile });
  const read = vi.spyOn(f.cache, "read");
  const write = vi.spyOn(f.cache, "write");
  const result = await replayRosDerivedPopulation({ ...f, scoringProfile });
  expect(result.result).toEqual(reference);
  expect(JSON.stringify(result.result)).toBe(JSON.stringify(reference));
  expect(result.bindings).toHaveLength(2);
  const calls = read.mock.calls.length;
  const repeated = await replayRosDerivedPopulation({ ...f, scoringProfile });
  expect(repeated).toEqual(result);
  expect(read).toHaveBeenCalledTimes(calls);
  const doubled = await replayRosDerivedPopulation({
    ...f,
    scoringProfile: {
      ...scoringProfile,
      rules: scoringProfile.rules.map((rule) => ({ ...rule, points: rule.points * 2 })),
    },
  });
  const one = result.result.heldOutSeasons[0]!.forecasts[0]!,
    two = doubled.result.heldOutSeasons[0]!.forecasts[0]!;
  expect(two.contextual.meanPoints).toBeCloseTo(one.contextual.meanPoints * 2, 12);
  expect(two.actualPoints).toBeCloseTo(one.actualPoints * 2, 12);
  expect(read.mock.calls.length).toBeGreaterThan(calls);
  expect(write).not.toHaveBeenCalled();
  const reportInput = {
    result: result.result,
    positions: undefined,
    scoringProfile: rosProfileDefinitionFromKey(projectionScoringProfileKey(scoringProfile)),
    coverage: f.corpus.coverage,
    sourceAudit: f.corpus.sourceAudit,
    pointsAllowedDefinition: "yahoo-2022-v1" as const,
  };
  expect(buildRosDerivedReplayReport(reportInput)).toEqual(
    buildRosDerivedReplayReport(reportInput),
  );
  expect(buildRosDerivedReplayReport(reportInput)).toMatchObject({
    publicationPolicy: result.result.champion.livePolicy,
    diagnostics: {
      candidateForecasts: result.result.heldOutSeasons.flatMap((row) => row.forecasts),
    },
  });
});
it("requires complete corrected labels and confines archived zero semantics to original DST only", async () => {
  const corpus = historicalCorpusFixture();
  const row = {
    ...corpus.forecasts[0]!,
    actualComponents: {},
    forecast: { ...corpus.forecasts[0]!.forecast, position: "DST" as const, playerId: "DST:ATL" },
  };
  const cache = {
    read: vi.fn(async () => {
      throw new Error("physical-read-reached");
    }),
    write: vi.fn(async () => {
      throw new Error("never-write");
    }),
  };
  const sourceForKey = new Map([
    [
      `${row.contextualKey.modelVersion}:${row.contextualKey.identity}`,
      { sha256: hash("physical") } as RosDerivedOutcomeSource,
    ],
  ]);
  const input = {
    corpus: { ...corpus, forecasts: [row] },
    cache,
    sourceForKey,
    scoreMemo: new Map(),
    scoringProfile: { id: "defense", rules: [{ statId: "defensive_sacks", points: 1 }] },
  };
  await expect(replayRosDerivedPopulation(input)).rejects.toThrow(/actual components unavailable/);
  expect(cache.read).not.toHaveBeenCalled();
  await expect(
    replayRosDerivedPopulation({
      ...input,
      originalDstObservedSemantics: "archived-missing-components-as-zero",
    }),
  ).rejects.toThrow("physical-read-reached");
  cache.read.mockClear();
  await expect(
    replayRosDerivedPopulation({
      ...input,
      originalDstObservedSemantics: "archived-missing-components-as-zero",
      corpus: { ...corpus, forecasts: [{ ...corpus.forecasts[0]!, actualComponents: {} }] },
      scoringProfile: { id: "player", rules: [{ statId: "receptions", points: 1 }] },
    }),
  ).rejects.toThrow(/actual components unavailable/);
  expect(cache.read).not.toHaveBeenCalled();
});
