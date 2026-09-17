import type * as FileSystemPromises from "node:fs/promises";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
  FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
  evaluateFirstPartyRosConvergence,
  projectFirstPartyRestOfSeason,
  simulateFirstPartyRosOutcomes,
  type ProjectionScoringProfile,
} from "@laces-out/projections";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  historicalRosChecksum,
  historicalRosConvergenceChecksum,
} from "./first-party-ros-backtest.js";
import { replayRosHistoricalCorpus } from "./ros-historical-corpus-replay.js";
import {
  createRosHistoricalCorpusStore,
  type RosHistoricalCorpus,
  type RosHistoricalCorpusForecast,
} from "./ros-historical-corpus.js";
import {
  createRosHistoricalOutcomeEvaluator,
  rosHistoricalOutcomeCacheKey,
} from "./ros-historical-outcome-replay.js";
import {
  historicalCorpusFixture,
  historicalOutcomeInputFixture,
} from "./ros-historical-outcome.test-fixtures.js";
import { createRosOutcomeCache } from "./ros-outcome-cache.js";

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
async function preparedCorpus(players = 1) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ros-corpus-replay-"));
  directories.push(directory);
  const cache = createRosOutcomeCache({ directory });
  const simulate = vi.fn(simulateFirstPartyRosOutcomes);
  const build = createRosHistoricalOutcomeEvaluator({ cache, mode: "build", simulate });
  const original = historicalCorpusFixture();
  const forecasts: RosHistoricalCorpusForecast[] = [];
  const inputs = Array.from({ length: players }, (_, index) =>
    historicalOutcomeInputFixture({
      playerId: `receiver-${index}`,
      season: 2025,
      weeks: historicalOutcomeInputFixture().weeks.map((week) => ({ ...week, season: 2025 })),
      asOfAt: "2025-10-01T12:00:00.000Z",
      inputChecksum: String(index + 1).repeat(64),
    }),
  );
  for (const input of inputs) {
    const recency = { ...input, strategy: "availability-aware-recency" as const };
    await build(input);
    await build(recency);
    forecasts.push({
      ...original.forecasts[0]!,
      forecast: {
        ...original.forecasts[0]!.forecast,
        playerId: input.playerId,
        inputChecksum: input.inputChecksum,
        windowEndWeek: 5,
      },
      scheduledGames: 1,
      contextualKey: rosHistoricalOutcomeCacheKey(input),
      recencyKey: rosHistoricalOutcomeCacheKey(recency),
    });
  }
  const corpus: RosHistoricalCorpus = {
    ...original,
    options: { ...original.options, heldOutSeasons: [2023, 2024, 2025] },
    forecasts,
  };
  const store = createRosHistoricalCorpusStore({ directory: path.join(directory, "corpora") });
  const saved = await store.write(corpus);
  const restored = await store.read(saved.identity);
  if (restored.state !== "hit") throw new Error("Expected stored corpus");
  return { directory, cache, simulate, corpus: restored.corpus, inputs };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("cache-only historical model validation", () => {
  it("rejects stale protocol or weakened gates before reading any vectors", async () => {
    const original = historicalCorpusFixture();
    const cache = {
      read: vi.fn(async () => ({ state: "missing" as const })),
      write: vi.fn(async () => {
        throw new Error("Replay must never write");
      }),
    };
    for (const corpus of [
      { ...original, buildProtocol: { ...original.buildProtocol, roleVersion: "stale" } },
      { ...original, options: { ...original.options, minimumCellSeasons: 1 } },
      {
        ...original,
        coverage: {
          ...original.coverage,
          thresholds: {
            ...original.coverage.thresholds,
            minimumSnapMatchRate: 0,
          },
        },
      },
    ]) {
      await expect(
        replayRosHistoricalCorpus({
          corpus: corpus as RosHistoricalCorpus,
          cache,
          scoringProfile: historicalOutcomeInputFixture().scoringProfile,
        }),
      ).rejects.toMatchObject({ code: "invalid_manifest" });
    }
    expect(cache.read).not.toHaveBeenCalled();
    expect(cache.write).not.toHaveBeenCalled();
  });

  it("replays a persisted corpus for new exact rules and preserves all quality/sample gates", async () => {
    const prepared = await preparedCorpus();
    const before = JSON.stringify(prepared.corpus);
    const ppr = prepared.inputs[0]!.scoringProfile;
    const halfPpr: ProjectionScoringProfile = {
      id: "new-half-ppr",
      rules: ppr.rules.map((rule) => ({
        ...rule,
        points: rule.statId === "receptions" ? 0.5 : rule.points,
      })),
    };
    const onProgress = vi.fn();
    const results = [];
    for (const scoringProfile of [ppr, halfPpr]) {
      const result = await replayRosHistoricalCorpus({ ...prepared, scoringProfile, onProgress });
      results.push(result);
      expect(result.report.state).toBe("insufficient");
      expect(result.report.blockers).toContain("fewer_than_three_qualified_heldout_seasons");
      expect(result.report.forecasts).toBe(1);
      expect(result.report.diagnosedPairs).toBe(1);
      const forecast = result.heldOutSeasons[0]!.forecasts[0]!;
      const direct = projectFirstPartyRestOfSeason({ ...prepared.inputs[0]!, scoringProfile });
      expect(forecast.contextual.meanPoints).toBeCloseTo(direct.meanPoints, 10);
      expect(forecast.contextual.p15Points).toBeCloseTo(direct.p15Points, 10);
      expect(forecast.evidence.availability.contextualExpectedGames).toBe(direct.expectedGames);
      expect(forecast.evidence.coverage).toEqual(prepared.corpus.forecasts[0]!.coverage);
    }
    expect(results[0]!.heldOutSeasons[0]!.forecasts[0]!.actualPoints).toBeCloseTo(0.65, 12);
    expect(results[1]!.heldOutSeasons[0]!.forecasts[0]!.actualPoints).toBeCloseTo(0.15, 12);
    expect(results[0]!.heldOutSeasons[0]!.forecasts[0]!.scoringProfileKey).not.toBe(
      results[1]!.heldOutSeasons[0]!.forecasts[0]!.scoringProfileKey,
    );
    expect(prepared.simulate).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(prepared.corpus)).toBe(before);
    expect(onProgress.mock.calls.at(-1)?.[0]).toMatchObject({ stage: "evaluation-ready" });
  });

  it("selects the same stable minimum-checksum convergence representative and reference prefixes", async () => {
    const prepared = await preparedCorpus(2);
    const scoringProfile = prepared.inputs[0]!.scoringProfile;
    const result = await replayRosHistoricalCorpus({ ...prepared, scoringProfile });
    const selected = [...prepared.inputs].sort((left, right) =>
      historicalRosChecksum(left.inputChecksum).localeCompare(
        historicalRosChecksum(right.inputChecksum),
      ),
    )[0]!;
    const evaluate = createRosHistoricalOutcomeEvaluator({ cache: prepared.cache, mode: "replay" });
    for (const [strategy, evidenceKey] of [
      ["contextual", "contextual"],
      ["availability-aware-recency", "recency"],
    ] as const) {
      const release = await evaluate({
        ...selected,
        strategy,
        scenarioCount: FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
      });
      const reference = await evaluate({
        ...selected,
        strategy,
        scenarioCount: FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
      });
      const diagnostic = evaluateFirstPartyRosConvergence({ position: "WR", release, reference });
      const expected = historicalRosConvergenceChecksum({
        season: 2025,
        position: "WR",
        bucket: "one-to-four",
        strategy,
        diagnostics: [diagnostic],
      });
      for (const forecast of result.heldOutSeasons[0]!.forecasts) {
        expect(forecast.evidence.convergence[evidenceKey].diagnosticChecksum).toBe(expected);
        expect(forecast.evidence.convergence[evidenceKey].state).toBe(diagnostic.state);
      }
    }
    expect(prepared.simulate).toHaveBeenCalledTimes(4);
  });

  it("fails on a missing referenced ensemble instead of rebuilding or publishing partial evidence", async () => {
    const prepared = await preparedCorpus();
    const file = (await readdir(prepared.directory)).find((file) =>
      file.endsWith(".ros-outcomes"),
    )!;
    await rm(path.join(prepared.directory, file));
    await expect(
      replayRosHistoricalCorpus({
        ...prepared,
        scoringProfile: prepared.inputs[0]!.scoringProfile,
      }),
    ).rejects.toMatchObject({ code: "outcome_evidence_not_ready" });
    expect(prepared.simulate).toHaveBeenCalledTimes(2);
  });

  it("snapshots caller-owned outcomes and options before asynchronous reads or progress callbacks", async () => {
    const prepared = await preparedCorpus();
    const onProgress = vi.fn(() => {
      (prepared.corpus.forecasts[0]!.actualComponents as Record<string, number>).receptions = 999;
      (prepared.corpus.options as { playersPerPosition: number }).playersPerPosition = 1;
    });
    const result = await replayRosHistoricalCorpus({
      ...prepared,
      scoringProfile: prepared.inputs[0]!.scoringProfile,
      onProgress,
    });
    expect(onProgress).toHaveBeenCalled();
    expect(result.heldOutSeasons[0]!.forecasts[0]!.actualPoints).toBeCloseTo(0.65, 12);
    expect(result.report.playersPerPosition).toBe(8);
  });

  it("rejects a valid cache reference belonging to another forecast and handles zero-appearance outcomes", async () => {
    const prepared = await preparedCorpus(2);
    const wrong: RosHistoricalCorpus = {
      ...prepared.corpus,
      forecasts: [
        {
          ...prepared.corpus.forecasts[0]!,
          contextualKey: prepared.corpus.forecasts[1]!.contextualKey,
        },
      ],
    };
    await expect(
      replayRosHistoricalCorpus({
        ...prepared,
        corpus: wrong,
        scoringProfile: prepared.inputs[0]!.scoringProfile,
      }),
    ).rejects.toMatchObject({ code: "outcome_evidence_corrupt" });
    const absent: RosHistoricalCorpus = {
      ...prepared.corpus,
      forecasts: [{ ...prepared.corpus.forecasts[0]!, actualComponents: {}, actualGames: 0 }],
    };
    const result = await replayRosHistoricalCorpus({
      ...prepared,
      corpus: absent,
      scoringProfile: prepared.inputs[0]!.scoringProfile,
    });
    expect(result.heldOutSeasons[0]!.forecasts[0]!.actualPoints).toBe(0);
    expect(result.heldOutSeasons[0]!.forecasts[0]!.evidence.availability.actualGames).toBe(0);
  });
});
