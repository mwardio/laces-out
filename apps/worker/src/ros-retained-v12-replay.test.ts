import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import {
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_RETAINED_V12_MODEL_VERSION,
  evaluateRetainedV12FirstPartyRosChampionPolicy,
  firstPartyRosSeedHash,
  scoreFirstPartyRosOutcomes,
  scoreRetainedV12FirstPartyRosOutcomes,
  type FirstPartyRosOutcomeEnsemble,
  type ProjectionScoringProfile,
  type RetainedV12FirstPartyRosOutcomeEnsemble,
} from "@laces-out/projections";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRetainedV12RosHistoricalCorpusReader,
  createRosHistoricalCorpusStore,
  retainedV12RosHistoricalCorpusIdentity,
  rosHistoricalCorpusIdentity,
  type RosHistoricalCorpus,
} from "./ros-historical-corpus.js";
import {
  RETAINED_V12_ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL,
  isCompatibleRosHistoricalCorpusBuildProtocol,
  isRetainedV12RosHistoricalCorpusBuildProtocol,
} from "./ros-historical-corpus-protocol.js";
import {
  replayRetainedV12RosHistoricalCorpus,
  replayRosHistoricalCorpus,
} from "./ros-historical-corpus-replay.js";
import {
  restoreCachedRosHistoricalOutcome,
  restoreRetainedV12CachedRosHistoricalOutcome,
  scoreRetainedV12CachedRosHistoricalOutcome,
  type RosHistoricalCachedOutcomeExpectation,
} from "./ros-historical-outcome-replay.js";
import { historicalCorpusFixture } from "./ros-historical-outcome.test-fixtures.js";
import type { RosOutcomeCache, RosOutcomeCacheEnsemble } from "./ros-outcome-cache.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const profile: ProjectionScoringProfile = {
  id: "new-exact-profile",
  rules: [
    { statId: "receptions", points: 1.25 },
    { statId: "receiving_yards", points: 0.125 },
  ],
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function fixture(position: "WR" | "DST" = "WR") {
  const original = historicalCorpusFixture();
  const modelVersion = FIRST_PARTY_ROS_RETAINED_V12_MODEL_VERSION;
  const row = original.forecasts[0]!;
  const corpus: RosHistoricalCorpus = {
    ...original,
    modelVersion,
    buildProtocol: RETAINED_V12_ROS_HISTORICAL_CORPUS_BUILD_PROTOCOL,
    options: { ...original.options, heldOutSeasons: [2023, 2024, 2025], positions: [position] },
    forecasts: [
      {
        ...row,
        forecast: {
          ...row.forecast,
          playerId: position === "DST" ? "DST:ATL" : row.forecast.playerId,
          position,
          windowEndWeek: 5,
          contextualModelVersion: `${modelVersion}:contextual:laces-weekly-components-v15`,
          recencyModelVersion: `${modelVersion}:availability-aware-recency:laces-weekly-components-v15`,
        },
        contextualKey: { ...row.contextualKey, modelVersion },
        recencyKey: { ...row.recencyKey, modelVersion },
        scheduledGames: 1,
      },
    ],
  };
  const forecast = corpus.forecasts[0]!;
  const expected: RosHistoricalCachedOutcomeExpectation = {
    ...forecast.forecast,
    scheduledGames: 1,
    weeklyModelVersion: corpus.weeklyModelVersion,
    strategy: "contextual",
  };
  const stored = (
    strategy: "contextual" | "availability-aware-recency",
  ): RosOutcomeCacheEnsemble => {
    const key = strategy === "contextual" ? forecast.contextualKey : forecast.recencyKey;
    const seed = "retained-synthetic-test";
    const asOfAt = "2025-10-01T12:00:00.000Z";
    return {
      scenarioCount: 16_384,
      columns: {
        receptions: Float64Array.from({ length: 16_384 }, (_, index) => (index % 2 === 0 ? 1 : 3)),
        receiving_yards: new Float64Array(16_384).fill(strategy === "contextual" ? 20 : 12),
      },
      games: new Uint8Array(16_384).fill(1),
      metadata: {
        schemaVersion: corpus.outcomeSchemaVersion,
        identity: key.identity,
        seed,
        core: {
          playerId: expected.playerId,
          position,
          scheduledGames: 1,
          provenance: {
            modelVersion,
            strategy,
            weeklyModelVersion: corpus.weeklyModelVersion,
            inputChecksum: expected.inputChecksum,
            seedHash: hash(
              `laces-ros-distribution-v11|${seed}|${expected.inputChecksum}|${expected.playerId}|${strategy}|2025|4|${asOfAt}|5|5`,
            ),
            randomGenerator: "xoshiro128**-sha256-128",
            scenarioCount: 16_384,
            season: 2025,
            asOfWeek: 4,
            asOfAt,
            windowStartWeek: 5,
            windowEndWeek: 5,
            intervalCalibration: "simulation-only",
          },
          simulation: {
            availabilityLagOneCorrelation: null,
            roleLagOneCorrelation: null,
            boundedRoleSamples: 0,
          },
          diagnostics: [],
        },
      },
    };
  };
  const contextual = stored("contextual");
  const recency = stored("availability-aware-recency");
  const cache = {
    read: vi.fn<RosOutcomeCache["read"]>(async (key) => ({
      state: "hit" as const,
      ensemble: key.identity === forecast.contextualKey.identity ? contextual : recency,
      manifestChecksum: hash(key.identity),
    })),
    write: vi.fn<RosOutcomeCache["write"]>(async () => {
      throw new Error("Retained replay must never write");
    }),
  };
  return { corpus, cache, contextual, recency, expected, key: forecast.contextualKey };
}

describe("closed retained-v12 historical replay", () => {
  it("reads authentic pinned v12 bytes without exposing a writer or widening active v13 compatibility", async () => {
    const { corpus } = fixture();
    const directory = await mkdtemp(path.join(os.tmpdir(), "retained-v12-corpus-"));
    directories.push(directory);
    const serialized = canonical(corpus);
    const identity = hash(serialized);
    expect(retainedV12RosHistoricalCorpusIdentity(corpus)).toBe(identity);
    const file = path.join(directory, `${identity}.ros-corpus.json.gz`);
    const bytes = gzipSync(`{"identity":"${identity}","corpus":${serialized}}`);
    await writeFile(file, bytes);
    const reader = createRetainedV12RosHistoricalCorpusReader({ directory });
    expect(Object.keys(reader)).toEqual(["read"]);
    expect(await reader.read(identity)).toEqual({ state: "hit", identity, corpus });
    expect(await readFile(file)).toEqual(bytes);
    expect(await createRosHistoricalCorpusStore({ directory }).read(identity)).toEqual({
      state: "corrupt",
      reason: "invalid_manifest",
    });
    expect(() => rosHistoricalCorpusIdentity(corpus)).toThrow(/invalid_manifest/);
    await expect(createRosHistoricalCorpusStore({ directory }).write(corpus)).rejects.toThrow(
      /invalid_manifest/,
    );
    expect(isCompatibleRosHistoricalCorpusBuildProtocol(corpus.buildProtocol)).toBe(false);
    expect(isRetainedV12RosHistoricalCorpusBuildProtocol(corpus.buildProtocol)).toBe(true);
    expect(
      await createRetainedV12RosHistoricalCorpusReader({ directory, maximumBytes: 32 }).read(
        identity,
      ),
    ).toEqual({ state: "corrupt", reason: "limits_exceeded" });
  });

  it("rejects unknown, mixed or translated lineage and changed pins before any vector read", async () => {
    const { corpus, cache } = fixture();
    for (const changed of [
      historicalCorpusFixture(),
      { ...corpus, modelVersion: FIRST_PARTY_ROS_MODEL_VERSION },
      {
        ...corpus,
        buildProtocol: {
          ...corpus.buildProtocol,
          policyVersion: "season-walk-forward-mean-rmse-block-wis-cqr-v7",
        },
      },
      { ...corpus, buildProtocol: { ...corpus.buildProtocol, defenseGameVersion: "invented" } },
      {
        ...corpus,
        forecasts: [
          {
            ...corpus.forecasts[0],
            contextualKey: {
              ...corpus.forecasts[0]!.contextualKey,
              modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
            },
          },
        ],
      },
      {
        ...corpus,
        forecasts: [
          {
            ...corpus.forecasts[0],
            forecast: {
              ...corpus.forecasts[0]!.forecast,
              contextualModelVersion: `${FIRST_PARTY_ROS_MODEL_VERSION}:contextual:laces-weekly-components-v15`,
            },
          },
        ],
      },
    ]) {
      await expect(
        replayRetainedV12RosHistoricalCorpus({
          corpus: changed as RosHistoricalCorpus,
          cache,
          scoringProfile: profile,
          expectedIdentity: retainedV12RosHistoricalCorpusIdentity(corpus),
        }),
      ).rejects.toThrow(/invalid_manifest/);
    }
    await expect(
      replayRetainedV12RosHistoricalCorpus({
        corpus,
        cache,
        scoringProfile: profile,
        expectedIdentity: "f".repeat(64),
      }),
    ).rejects.toThrow(/pinned dependency/);
    await expect(
      replayRosHistoricalCorpus({ corpus, cache, scoringProfile: profile }),
    ).rejects.toThrow(/invalid_manifest/);
    expect(cache.read).not.toHaveBeenCalled();
    expect(cache.write).not.toHaveBeenCalled();
  });

  it("reprices the retained observations and both ensembles under exact new rules with its own v7 policy", async () => {
    const { corpus, cache } = fixture();
    const before = canonical(corpus);
    const result = await replayRetainedV12RosHistoricalCorpus({
      corpus,
      cache,
      scoringProfile: profile,
      expectedIdentity: retainedV12RosHistoricalCorpusIdentity(corpus),
    });
    const forecast = result.heldOutSeasons[0]!.forecasts[0]!;
    expect(forecast.contextual.meanPoints).toBe(5);
    expect(forecast.recency.meanPoints).toBe(4);
    expect(forecast.actualPoints).toBe(0.8125);
    expect(forecast.contextualModelVersion).toMatch(/^laces-ros-distribution-v12:/);
    expect(result.champion.livePolicy.modelVersion).toBe(
      FIRST_PARTY_ROS_RETAINED_V12_MODEL_VERSION,
    );
    expect(result.champion.livePolicy.policyVersion).toBe(
      "season-walk-forward-mean-rmse-block-wis-cqr-v7",
    );
    expect(result.champion.seasonPolicies[0]!.policy.modelVersion).toBe(
      FIRST_PARTY_ROS_RETAINED_V12_MODEL_VERSION,
    );
    expect(result.champion.seasonPolicies[0]!.evidenceThroughSeason).toBeNull();
    expect(result.champion.selected[0]!.strategy).toBe("availability-aware-recency");
    expect(result.champion.selected[0]!.predictedMean).toBe(4);
    expect(result.champion.livePolicy).toEqual(
      evaluateRetainedV12FirstPartyRosChampionPolicy(result.heldOutSeasons, {
        minimumHeldOutSeasons: 3,
        minimumBatches: 30,
        minimumSamples: 300,
        minimumCellSamples: 18,
        minimumCellSeasons: 3,
        minimumCellCutoffs: 3,
        minimumCellBatches: 9,
      }).livePolicy,
    );
    expect(canonical(corpus)).toBe(before);
    expect(cache.read).toHaveBeenCalledTimes(4);
    expect(cache.write).not.toHaveBeenCalled();
  });

  it("validates the original v12 DST seed instead of accepting the v13 defense-specific seed", () => {
    const { contextual, expected, key } = fixture("DST");
    const restored = restoreRetainedV12CachedRosHistoricalOutcome(contextual, key, expected);
    expect(restored.modelVersion).toBe(FIRST_PARTY_ROS_RETAINED_V12_MODEL_VERSION);
    expect(restored.metadata).toBe(contextual.metadata.core);
    const v13Seed = firstPartyRosSeedHash({
      ...expected,
      season: expected.forecastSeason,
      asOfAt: "2025-10-01T12:00:00.000Z",
      seed: "retained-synthetic-test",
    });
    expect(restored.metadata.provenance.seedHash).not.toBe(v13Seed);
    const poisoned = structuredClone(contextual);
    const core = poisoned.metadata.core as { provenance: { seedHash: string } };
    core.provenance.seedHash = v13Seed;
    expect(() => restoreRetainedV12CachedRosHistoricalOutcome(poisoned, key, expected)).toThrow(
      /outcome_evidence_corrupt/,
    );
    expect(() => restoreCachedRosHistoricalOutcome(contextual, key, expected)).toThrow(
      /outcome_evidence_corrupt/,
    );
  });

  it("keeps current/retained scoring disjoint and rejects missing components and corrupt suffix vectors", () => {
    const { contextual, expected, key } = fixture();
    const restored = restoreRetainedV12CachedRosHistoricalOutcome(contextual, key, expected);
    expect(scoreRetainedV12FirstPartyRosOutcomes(restored, profile, 12_288).meanPoints).toBe(5);
    expect(() =>
      scoreFirstPartyRosOutcomes(restored as unknown as FirstPartyRosOutcomeEnsemble, profile),
    ).toThrow(/identity mismatch/);
    const translated = {
      ...restored,
      modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
      metadata: {
        ...restored.metadata,
        provenance: {
          ...restored.metadata.provenance,
          modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
        },
      },
    };
    expect(() =>
      scoreRetainedV12FirstPartyRosOutcomes(
        translated as unknown as RetainedV12FirstPartyRosOutcomeEnsemble,
        profile,
      ),
    ).toThrow(/identity mismatch/);
    expect(() =>
      scoreRetainedV12FirstPartyRosOutcomes(restored, {
        id: "missing",
        rules: [{ statId: "receiving_touchdowns", points: 6 }],
      }),
    ).toThrow(/lack scored component/);
    restored.columns.receptions![16_383] = Number.NaN;
    expect(() => scoreRetainedV12FirstPartyRosOutcomes(restored, profile, 12_288)).toThrow(
      /Non-finite/,
    );
  });

  it.each(["missing", "corrupt"] as const)(
    "preserves a %s dependency failure without writing or rebuilding",
    async (state) => {
      const { corpus, cache } = fixture();
      vi.mocked(cache.read).mockResolvedValue(
        state === "missing"
          ? { state: "missing" }
          : { state: "corrupt", reason: "payload_checksum_mismatch" },
      );
      await expect(
        replayRetainedV12RosHistoricalCorpus({
          corpus,
          cache,
          scoringProfile: profile,
          expectedIdentity: retainedV12RosHistoricalCorpusIdentity(corpus),
        }),
      ).rejects.toThrow(
        state === "missing" ? /outcome_evidence_not_ready/ : /outcome_evidence_corrupt/,
      );
      expect(cache.read).toHaveBeenCalledTimes(1);
      expect(cache.write).not.toHaveBeenCalled();
    },
  );

  it("rejects abort and wrong key model before reading any cached vector", async () => {
    const { corpus, cache, expected, key } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      replayRetainedV12RosHistoricalCorpus({
        corpus,
        cache,
        scoringProfile: profile,
        expectedIdentity: retainedV12RosHistoricalCorpusIdentity(corpus),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    await expect(
      scoreRetainedV12CachedRosHistoricalOutcome({
        cache,
        expected,
        key: { ...key, modelVersion: FIRST_PARTY_ROS_MODEL_VERSION },
        scoringProfile: profile,
      }),
    ).rejects.toThrow(/outcome_evidence_corrupt/);
    expect(cache.read).not.toHaveBeenCalled();
  });
});
