import type * as FileSystemPromises from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
  FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
  FIRST_PARTY_ROS_POLICY_VERSION,
  FIRST_PARTY_ROS_MEAN_SELECTION_VERSION,
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
async function preparedCorpus(players = 1, legacyEvaluation = false) {
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
    // This test fixture reuses the identical football vectors under their prior evaluator
    // provenance. It never labels old admission evidence current.
    ...(legacyEvaluation
      ? {
          buildProtocol: {
            ...original.buildProtocol,
            policyVersion: "season-walk-forward-block-wis-cqr-v6" as const,
            calibrationVersion: "season-blocked-split-conformal-cqr-v1" as const,
          },
        }
      : {}),
    options: { ...original.options, heldOutSeasons: [2023, 2024, 2025] },
    forecasts,
  };
  const store = createRosHistoricalCorpusStore({ directory: path.join(directory, "corpora") });
  const saved = await store.write(corpus);
  const restored = await store.read(saved.identity);
  if (restored.state !== "hit") throw new Error("Expected stored corpus");
  return {
    directory,
    cache,
    simulate,
    corpus: restored.corpus,
    inputs,
    corpusIdentity: saved.identity,
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("cache-only historical model validation", () => {
  it.each(["espn-2019-v1", undefined] as const)(
    "rejects a Yahoo corpus for conflicting or unspecified PA (%s) before cache reads",
    async (statDefinition) => {
      const cache = {
        read: vi.fn(async () => ({ state: "missing" as const })),
        write: vi.fn(async () => {
          throw new Error("No writes");
        }),
      };
      await expect(
        replayRosHistoricalCorpus({
          corpus: historicalCorpusFixture(),
          cache,
          scoringProfile: {
            id: "PA",
            rules: [
              {
                statId: "points_allowed",
                points: -1,
                ...(statDefinition === undefined ? {} : { statDefinition }),
              },
            ],
          },
        }),
      ).rejects.toThrow(/points-allowed/);
      expect(cache.read).not.toHaveBeenCalled();
      expect(cache.write).not.toHaveBeenCalled();
    },
  );

  it("rejects missing corpus PA provenance even for a profile without points-allowed scoring", async () => {
    const corpus = Object.fromEntries(
      Object.entries(historicalCorpusFixture()).filter(
        ([key]) => key !== "pointsAllowedDefinition",
      ),
    ) as unknown as RosHistoricalCorpus;
    const cache = {
      read: vi.fn(async () => ({ state: "missing" as const })),
      write: vi.fn(async () => {
        throw new Error("No writes");
      }),
    };
    await expect(
      replayRosHistoricalCorpus({
        corpus,
        cache,
        scoringProfile: { id: "WR", rules: [{ statId: "receptions", points: 1 }] },
      }),
    ).rejects.toThrow(/points-allowed definition.*recapture/);
    expect(cache.read).not.toHaveBeenCalled();
  });

  it.each(["yahoo-2022-v1", "espn-2019-v1"] as const)(
    "allows a profile without PA to reuse validated %s vectors without rebuilding",
    async (pointsAllowedDefinition) => {
      const prepared = await preparedCorpus();
      const calls = prepared.simulate.mock.calls.length;
      const result = await replayRosHistoricalCorpus({
        corpus: { ...prepared.corpus, pointsAllowedDefinition },
        cache: prepared.cache,
        scoringProfile: { id: "WR", rules: [{ statId: "receptions", points: 1 }] },
      });
      expect(result.report.forecasts).toBe(prepared.corpus.forecasts.length);
      expect(prepared.simulate).toHaveBeenCalledTimes(calls);
    },
  );

  it("rejects unversioned labels even when every required key exists, before reading cached forecasts", async () => {
    const original = historicalCorpusFixture();
    const corpus = Object.fromEntries(
      Object.entries(original).filter(([key]) => key !== "actualDefinitionVersion"),
    ) as unknown as RosHistoricalCorpus;
    const cache = {
      read: vi.fn(async () => ({ state: "missing" as const })),
      write: vi.fn(async () => {
        throw new Error("No writes");
      }),
    };
    await expect(
      replayRosHistoricalCorpus({
        corpus,
        cache,
        scoringProfile: historicalOutcomeInputFixture().scoringProfile,
      }),
    ).rejects.toThrow(/actual definition.*recapture/);
    expect(cache.read).not.toHaveBeenCalled();
    expect(cache.write).not.toHaveBeenCalled();
  });

  it.each([
    [
      "missing passing stat on a receiver",
      { receptions: 1 },
      { statId: "passing_yards", points: 0.04 },
      "missing=passing_yards",
      "WR",
    ],
    [
      "missing rare event",
      { receptions: 1 },
      { statId: "defensive_two_point_returns", points: 2 },
      "missing=defensive_two_point_returns",
      "DST",
    ],
    [
      "invalid rare event",
      { defensive_two_point_returns: -1 },
      { statId: "defensive_two_point_returns", points: 2 },
      "invalid=defensive_two_point_returns",
      "DST",
    ],
  ] as const)(
    "preflights every row for %s before any vector read",
    async (_name, components, rule, message, position) => {
      const original = historicalCorpusFixture();
      const first = {
        ...original.forecasts[0]!,
        forecast: { ...original.forecasts[0]!.forecast, position },
      };
      const corpus: RosHistoricalCorpus = {
        ...original,
        options: { ...original.options, positions: [position] },
        forecasts: [
          { ...first, actualComponents: { [rule.statId]: 0 } },
          {
            ...first,
            forecast: { ...first.forecast, playerId: "second-player" },
            actualComponents: components,
          },
        ],
      };
      const cache = {
        read: vi.fn(async () => ({ state: "missing" as const })),
        write: vi.fn(async () => {
          throw new Error("No writes");
        }),
      };
      await expect(
        replayRosHistoricalCorpus({
          corpus,
          cache,
          scoringProfile: { id: "exact", rules: [rule] },
        }),
      ).rejects.toThrow(message);
      expect(cache.read).not.toHaveBeenCalled();
    },
  );

  it("ignores offense and zero-weight missing stats on DST while requiring scored observed DST stats", async () => {
    const original = historicalCorpusFixture();
    const corpus: RosHistoricalCorpus = {
      ...original,
      options: { ...original.options, positions: ["DST"] },
      forecasts: [
        {
          ...original.forecasts[0]!,
          forecast: { ...original.forecasts[0]!.forecast, position: "DST" },
          actualComponents: { defensive_two_point_returns: 0 },
        },
      ],
    };
    const cache = {
      read: vi.fn(async () => {
        throw new Error("Actual preflight passed");
      }),
      write: vi.fn(async () => {
        throw new Error("No writes");
      }),
    };
    await expect(
      replayRosHistoricalCorpus({
        corpus,
        cache,
        scoringProfile: {
          id: "dst",
          rules: [
            { statId: "passing_yards", points: 1 },
            { statId: "one_point_safeties", points: 0 },
            { statId: "defensive_two_point_returns", points: 2 },
          ],
        },
      }),
    ).rejects.toThrow("Actual preflight passed");
    expect(cache.read).toHaveBeenCalledOnce();
  });

  it("allows a structural empty schedule but does not treat unobserved scheduled games as zero", async () => {
    const original = historicalCorpusFixture();
    const cache = {
      read: vi.fn(async () => {
        throw new Error("Actual preflight passed");
      }),
      write: vi.fn(async () => {
        throw new Error("No writes");
      }),
    };
    const replay = (scheduledGames: number, actualComponents: Record<string, number> = {}) =>
      replayRosHistoricalCorpus({
        corpus: {
          ...original,
          forecasts: [
            { ...original.forecasts[0]!, actualComponents, scheduledGames, actualGames: 0 },
          ],
        },
        cache,
        scoringProfile: historicalOutcomeInputFixture().scoringProfile,
      });
    await expect(replay(1)).rejects.toThrow(/actual components unavailable/);
    await expect(replay(0, { receptions: 1 })).rejects.toThrow(/contradict zero observed games/);
    expect(cache.read).not.toHaveBeenCalled();
    await expect(replay(0)).rejects.toThrow("Actual preflight passed");
    expect(cache.read).toHaveBeenCalledOnce();
  });

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

  it("replays v6 physical forecasts with explicit current actuals under v7 without rebuilding football", async () => {
    // The existing two-candidate fixture setup is unchanged; replay must make no additional
    // simulation calls or cache writes, and preserve the original v6 manifest bytes.
    const prepared = await preparedCorpus(1, true);
    const before = JSON.stringify(prepared.corpus);
    const manifestPath = path.join(
      prepared.directory,
      "corpora",
      `${prepared.corpusIdentity}.ros-corpus.json.gz`,
    );
    const manifestBefore = await readFile(manifestPath);
    const write = vi.spyOn(prepared.cache, "write");
    expect(prepared.corpus.buildProtocol.policyVersion).toBe(
      "season-walk-forward-block-wis-cqr-v6",
    );
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
      expect(result.champion.livePolicy).toMatchObject({
        policyVersion: FIRST_PARTY_ROS_POLICY_VERSION,
        meanSelectionEvidenceVersion: FIRST_PARTY_ROS_MEAN_SELECTION_VERSION,
        legacyPointImprovementMetric: "mean-absolute-error",
      });
      expect(result.champion.livePolicy.policyVersion).toBe(
        "season-walk-forward-mean-rmse-block-wis-cqr-v7",
      );
      expect(
        result.champion.livePolicy.choices.every(
          (choice) =>
            choice.meanSelectionEvidence.version === FIRST_PARTY_ROS_MEAN_SELECTION_VERSION,
        ),
      ).toBe(true);
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
    expect(write).not.toHaveBeenCalled();
    expect(await readFile(manifestPath)).toEqual(manifestBefore);
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

  it("rejects another forecast's cache reference and requires explicit zero-appearance observations", async () => {
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
    await expect(
      replayRosHistoricalCorpus({
        ...prepared,
        corpus: absent,
        scoringProfile: prepared.inputs[0]!.scoringProfile,
      }),
    ).rejects.toThrow(/actual components unavailable/);
    const result = await replayRosHistoricalCorpus({
      ...prepared,
      corpus: {
        ...absent,
        forecasts: [
          {
            ...absent.forecasts[0]!,
            actualComponents: { receptions: 0, receiving_yards: 0, receiving_touchdowns: 0 },
          },
        ],
      },
      scoringProfile: prepared.inputs[0]!.scoringProfile,
    });
    expect(result.heldOutSeasons[0]!.forecasts[0]!.actualPoints).toBe(0);
    expect(result.heldOutSeasons[0]!.forecasts[0]!.evidence.availability.actualGames).toBe(0);
  });
});
