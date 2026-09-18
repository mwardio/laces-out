import type * as FileSystemPromises from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFENSE_COPULA_COMPONENTS,
  FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
  FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
  defenseGameRankDependence,
  firstPartyRosSeedHash,
  projectFirstPartyRestOfSeason,
  simulateFirstPartyRosOutcomes,
  type FirstPartyRosProjectionInput,
} from "@laces-out/projections";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRosHistoricalOutcomeEvaluator,
  restoreCachedRosHistoricalOutcome,
  rosHistoricalOutcomeCacheKey,
  scoreCachedRosHistoricalOutcome,
} from "./ros-historical-outcome-replay.js";
import { createRosOutcomeCache, type RosOutcomeCache } from "./ros-outcome-cache.js";
import { createRosOutcomeSimulationPool } from "./ros-outcome-simulation-pool.js";

import { historicalOutcomeInputFixture as input } from "./ros-historical-outcome.test-fixtures.js";
import { denseSimulationInput } from "./ros-outcome-simulation.test-fixtures.js";
import { rosLiveOutcomeCacheKey } from "./ros-live-outcomes.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof FileSystemPromises>()),
  statfs: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(statfs).mockResolvedValue({
    type: 0n,
    bsize: 1n,
    blocks: 1_000_000_000_000n,
    bfree: 1_000_000_000_000n,
    bavail: 1_000_000_000_000n,
    files: 100_000n,
    ffree: 99_000n,
  });
});

const directories: string[] = [];
async function cache() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ros-outcome-replay-"));
  directories.push(directory);
  return { directory, cache: createRosOutcomeCache({ directory }) };
}

const halfPpr = input({
  scoringProfile: {
    id: "half-ppr",
    rules: [
      { statId: "receptions", points: 0.5 },
      { statId: "receiving_yards", points: 0.1 },
      { statId: "receiving_touchdowns", points: 6 },
    ],
  },
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("historical outcome corpus replay", () => {
  it("pins seventeen D/ST weeks and a full seven-season packed history within unchanged cache bounds", () => {
    const base = denseSimulationInput("DST", "contextual");
    const dependence = defenseGameRankDependence(
      Array.from({ length: 3_808 }, (_, row) =>
        DEFENSE_COPULA_COMPONENTS.map((_, dimension) => row % (dimension + 2)),
      ),
    );
    const allowed = {
      pointsAllowed: { center: 22, standardDeviation: 12, maximum: 80 as const },
      yardsAllowed: { center: 330, standardDeviation: 85, maximum: 800 as const },
    };
    const request: FirstPartyRosProjectionInput = {
      ...base,
      asOfWeek: 1,
      asOfAt: "2026-09-15T00:00:00.000Z",
      windowStartWeek: 2,
      windowEndWeek: 18,
      scoringProfile: { id: "defense", rules: [{ statId: "defensive_sacks", points: 1 }] },
      defense: { ...base.defense!, dependence },
      weeks: Array.from({ length: 17 }, (_, index) => ({
        ...base.weeks[0]!,
        week: index + 2,
        scheduled: index !== 4,
        bye: index === 4,
        defenseDistributions: { contextual: allowed, recency: allowed },
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(512 * 1_024);
    for (const key of [rosHistoricalOutcomeCacheKey, rosLiveOutcomeCacheKey]) {
      const baseline = key(request);
      expect(baseline.identity).toMatch(/^[a-f0-9]{64}$/u);
      for (const changed of [
        {
          ...request,
          defense: {
            ...request.defense!,
            overdispersion: { ...request.defense!.overdispersion, defensive_sacks: 0.2 },
          },
        },
        {
          ...request,
          defense: {
            ...request.defense!,
            dependence: defenseGameRankDependence([DEFENSE_COPULA_COMPONENTS.map(() => 0)]),
          },
        },
        {
          ...request,
          weeks: request.weeks.map((week, index) =>
            index === 0
              ? {
                  ...week,
                  defenseDistributions: {
                    contextual: {
                      ...allowed,
                      pointsAllowed: { ...allowed.pointsAllowed, standardDeviation: 13 },
                    },
                    recency: allowed,
                  },
                }
              : week,
          ),
        },
      ])
        expect(key(changed)).not.toEqual(baseline);
    }
  });

  it.each(["contextual", "availability-aware-recency"] as const)(
    "restores discrete D/ST seeds in full-input and compact corpus replays for %s",
    async (strategy) => {
      const storage = await cache();
      const request = {
        ...denseSimulationInput("DST", strategy),
        scenarioCount: 128,
        scoringProfile: {
          id: "defense-points-allowed",
          rules: [
            { statId: "defensive_sacks", points: 1 },
            { statId: "points_allowed_0_probability", points: 10 },
            { statId: "points_allowed_35_plus_probability", points: -4 },
          ],
        },
      };
      const build = createRosHistoricalOutcomeEvaluator({ cache: storage.cache, mode: "build" });
      const generated = await build(request);
      const forbidden = vi.fn(() => {
        throw new Error("Replay must not simulate");
      });
      const replay = createRosHistoricalOutcomeEvaluator({
        cache: storage.cache,
        mode: "replay",
        simulate: forbidden,
      });
      expect(await replay(request)).toEqual(generated);
      const key = rosHistoricalOutcomeCacheKey(request);
      const expected = {
        playerId: request.playerId,
        position: request.position,
        forecastSeason: request.season,
        asOfWeek: request.asOfWeek,
        windowStartWeek: request.windowStartWeek,
        windowEndWeek: request.windowEndWeek,
        inputChecksum: request.inputChecksum,
        strategy: request.strategy,
        weeklyModelVersion: request.weeklyModelVersion,
        scheduledGames: 3,
      };
      const rescoredProfile = {
        id: "defense-yards-allowed",
        rules: [
          { statId: "defensive_interceptions", points: 3 },
          { statId: "yards_allowed_450_499_probability", points: -5 },
        ],
      };
      for (const scoringProfile of [request.scoringProfile, rescoredProfile]) {
        const compact = await scoreCachedRosHistoricalOutcome({
          cache: storage.cache,
          key,
          expected,
          scoringProfile,
          scenarioCount: 128,
        });
        const direct = projectFirstPartyRestOfSeason({ ...request, scoringProfile });
        expect(compact.seedHash).toBe(firstPartyRosSeedHash(request));
        for (const metric of [
          "meanPoints",
          "standardDeviation",
          "p15Points",
          "p50Points",
          "p85Points",
        ] as const)
          expect(compact[metric]).toBeCloseTo(direct[metric], 10);
      }
      expect(forbidden).not.toHaveBeenCalled();
      const saved = await storage.cache.read(key);
      if (saved.state !== "hit") throw new Error("Expected saved D/ST evidence");
      expect(() =>
        restoreCachedRosHistoricalOutcome(
          saved.ensemble,
          {
            ...key,
            modelVersion: "laces-ros-distribution-v12",
          },
          expected,
        ),
      ).toThrow("outcome_evidence_corrupt");
      for (const provenance of [
        { modelVersion: "laces-ros-distribution-v12" },
        // The formerly duplicated formula omits the D/ST process suffix.
        { seedHash: firstPartyRosSeedHash({ ...request, position: "WR" }) },
      ]) {
        const malformed = structuredClone(saved.ensemble);
        const core = malformed.metadata.core as Record<string, unknown>;
        core.provenance = { ...(core.provenance as Record<string, unknown>), ...provenance };
        expect(() => restoreCachedRosHistoricalOutcome(malformed, key, expected)).toThrow(
          "outcome_evidence_corrupt",
        );
      }
    },
  );

  it.each([
    ["contextual", "fa2b0fc843c800cbe4e17e8bd93b7957e67526f146acfdf637eec6863311a745"],
    [
      "availability-aware-recency",
      "1dae0d06bf91824a4d2de9607513479207b90cd9f06a40e01ff2be6654a22db8",
    ],
  ] as const)(
    "does not reuse captured v11 D/ST cache identities with current physical inputs for %s",
    (strategy, expectedIdentity) => {
      // These keys were captured under v11. The current model and complete discrete-game
      // inputs have changed; explicit old-model rejection is tested separately above.
      const request = {
        ...denseSimulationInput("DST", strategy),
        scoringProfile: input().scoringProfile,
      };
      expect(rosHistoricalOutcomeCacheKey(request).identity).not.toBe(expectedIdentity);
    },
  );

  it("builds one reference ensemble and replays exact league scores and release prefixes without simulation", async () => {
    const storage = await cache();
    const simulate = vi.fn(simulateFirstPartyRosOutcomes);
    const build = createRosHistoricalOutcomeEvaluator({
      cache: storage.cache,
      mode: "build",
      simulate,
    });
    const release = await build(input());
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(simulate.mock.calls[0]![0]).not.toHaveProperty("scoringProfile");
    expect(simulate.mock.calls[0]![0].scenarioCount).toBe(
      FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
    );
    const forbidden = vi.fn(() => {
      throw new Error("Replay must not simulate");
    });
    const replay = createRosHistoricalOutcomeEvaluator({
      cache: storage.cache,
      mode: "replay",
      simulate: forbidden,
    });
    expect(await replay(input())).toEqual(release);
    const half = await replay(halfPpr);
    const reference = await replay(
      input({ scenarioCount: FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS }),
    );
    for (const [actual, supplied] of [
      [release, input()],
      [half, halfPpr],
      [reference, input({ scenarioCount: FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS })],
    ] as const) {
      const direct = projectFirstPartyRestOfSeason(supplied);
      for (const metric of [
        "meanPoints",
        "standardDeviation",
        "p15Points",
        "p50Points",
        "p85Points",
      ] as const)
        expect(actual[metric]).toBeCloseTo(direct[metric], 10);
      expect(actual.expectedGames).toBe(direct.expectedGames);
      expect(actual.seedHash).toBe(direct.provenance.seedHash);
    }
    expect(release.scenarioCount).toBe(FIRST_PARTY_ROS_DEFAULT_SCENARIOS);
    expect(reference.scenarioCount).toBe(FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS);
    expect(reference.seedHash).toBe(release.seedHash);
    expect(forbidden).not.toHaveBeenCalled();
    expect(await readdir(storage.directory)).toHaveLength(1);
  });

  it("shares in-flight generation across profiles/evaluator instances and releases completed vectors", async () => {
    const storage = await cache();
    const simulate = vi.fn(simulateFirstPartyRosOutcomes);
    const first = createRosHistoricalOutcomeEvaluator({
      cache: storage.cache,
      mode: "build",
      simulate,
    });
    const second = createRosHistoricalOutcomeEvaluator({
      cache: storage.cache,
      mode: "build",
      simulate,
    });
    const results = await Promise.all([
      first(input()),
      second(halfPpr),
      second(input({ scenarioCount: 128 })),
    ]);
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(results[0].meanPoints).toBeGreaterThan(results[1].meanPoints);
    expect(results[2].scenarioCount).toBe(128);
    await first(input());
    expect(simulate).toHaveBeenCalledTimes(1);
    const file = (await readdir(storage.directory)).find((file) => file.endsWith(".ros-outcomes"))!;
    await writeFile(path.join(storage.directory, file), "corrupt after previous use");
    await expect(first(input())).rejects.toMatchObject({ code: "outcome_evidence_corrupt" });
    expect(simulate).toHaveBeenCalledTimes(1);
  });

  it("binds every football parameter, cutoff, source checksum and strategy while ignoring exact rules/prefix", () => {
    const baseline = rosHistoricalOutcomeCacheKey(input());
    expect(rosHistoricalOutcomeCacheKey(halfPpr)).toEqual(baseline);
    expect(
      rosHistoricalOutcomeCacheKey(
        input({ scenarioCount: FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS }),
      ),
    ).toEqual(baseline);
    for (const changed of [
      input({ strategy: "availability-aware-recency" }),
      input({ inputChecksum: "b".repeat(64) }),
      input({ seed: "new-seed" }),
      input({ asOfAt: "2026-10-01T13:00:00.000Z" }),
      input({ weeklyModelVersion: "weekly-next" }),
      input({ playerId: "other-player" }),
      input({ role: { ...input().role, centerVolatility: 0.25 } }),
      input({
        weeks: [
          {
            ...input().weeks[0]!,
            contextualComponents: { ...input().weeks[0]!.contextualComponents, receptions: 7 },
          },
        ],
      }),
    ])
      expect(rosHistoricalOutcomeCacheKey(changed).identity).not.toBe(baseline.identity);
    const reversedRules = input({
      scoringProfile: { id: "same-scoring", rules: [...input().scoringProfile.rules].reverse() },
    });
    expect(rosHistoricalOutcomeCacheKey(reversedRules)).toEqual(baseline);
  });

  it("returns explicit not-ready on a replay miss with no write or simulation", async () => {
    const storage = await cache();
    const simulate = vi.fn(simulateFirstPartyRosOutcomes);
    const write = vi.spyOn(storage.cache, "write");
    const replay = createRosHistoricalOutcomeEvaluator({
      cache: storage.cache,
      mode: "replay",
      simulate,
    });
    await expect(replay(input())).rejects.toMatchObject({
      code: "outcome_evidence_not_ready",
      identity: rosHistoricalOutcomeCacheKey(input()).identity,
    });
    expect(simulate).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(await readdir(storage.directory)).toEqual([]);
  });

  it("never treats damaged cache evidence as permission to rebuild", async () => {
    const storage = await cache();
    await createRosHistoricalOutcomeEvaluator({ cache: storage.cache, mode: "build" })(input());
    const file = (await readdir(storage.directory)).find((file) => file.endsWith(".ros-outcomes"))!;
    const bytes = await readFile(path.join(storage.directory, file));
    await writeFile(path.join(storage.directory, file), bytes.subarray(0, bytes.length - 3));
    const simulate = vi.fn(simulateFirstPartyRosOutcomes);
    for (const mode of ["build", "replay"] as const) {
      await expect(
        createRosHistoricalOutcomeEvaluator({ cache: storage.cache, mode, simulate })(input()),
      ).rejects.toMatchObject({ code: "outcome_evidence_corrupt" });
    }
    expect(simulate).not.toHaveBeenCalled();
  });

  it.each(["player", "schema", "seed", "cutoff", "simulation", "diagnostics"])(
    "validates restored %s metadata in addition to storage checksums",
    async (part) => {
      const storage = await cache();
      await createRosHistoricalOutcomeEvaluator({ cache: storage.cache, mode: "build" })(input());
      const read = await storage.cache.read(rosHistoricalOutcomeCacheKey(input()));
      if (read.state !== "hit") throw new Error("Expected saved evidence");
      const metadata = JSON.parse(JSON.stringify(read.ensemble.metadata)) as {
        schemaVersion: string;
        core: {
          playerId: string;
          provenance: { seedHash: string; asOfWeek: number };
          simulation: { roleLagOneCorrelation: number };
          diagnostics: { severity: string; code: string; message: string }[];
        };
      };
      if (part === "player") metadata.core.playerId = "wrong-player";
      if (part === "schema") metadata.schemaVersion = "wrong-schema";
      if (part === "seed") metadata.core.provenance.seedHash = "c".repeat(64);
      if (part === "cutoff") metadata.core.provenance.asOfWeek = 9;
      if (part === "simulation") metadata.core.simulation.roleLagOneCorrelation = 2;
      if (part === "diagnostics") metadata.core.diagnostics[0]!.code = "invented-diagnostic";
      const malformed: RosOutcomeCache = {
        read: vi.fn(async () => ({ ...read, ensemble: { ...read.ensemble, metadata } })),
        write: vi.fn(),
      };
      await expect(
        createRosHistoricalOutcomeEvaluator({ cache: malformed, mode: "replay" })(input()),
      ).rejects.toMatchObject({ code: "outcome_evidence_corrupt" });
    },
  );

  it("clears failed generation and permits a subsequent explicit build", async () => {
    const storage = await cache();
    const simulate = vi.fn(simulateFirstPartyRosOutcomes).mockImplementationOnce(() => {
      throw new Error("transient build failure");
    });
    const build = createRosHistoricalOutcomeEvaluator({
      cache: storage.cache,
      mode: "build",
      simulate,
    });
    await expect(build(input())).rejects.toThrow("transient build failure");
    expect(await readdir(storage.directory)).toEqual([]);
    await expect(build(input())).resolves.toHaveProperty(
      "scenarioCount",
      FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
    );
    expect(simulate).toHaveBeenCalledTimes(2);
  });

  it("never starts a simulation worker for a verified cache hit or replay", async () => {
    const storage = await cache();
    await createRosHistoricalOutcomeEvaluator({ cache: storage.cache, mode: "build" })(input());
    const workerFactory = vi.fn(() => {
      throw new Error("A cache read must not start an isolate");
    });
    const pool = createRosOutcomeSimulationPool({ workerFactory });
    try {
      for (const mode of ["build", "replay"] as const) {
        await createRosHistoricalOutcomeEvaluator({
          cache: storage.cache,
          mode,
          simulate: pool.simulate,
        })(input());
      }
      expect(workerFactory).not.toHaveBeenCalled();
    } finally {
      await pool.close();
    }
  });

  it("bounds different forecast builds to two in-process simulations", async () => {
    const storage = await cache();
    let active = 0;
    let maximum = 0;
    let bothStarted!: () => void;
    const barrier = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const simulate = vi.fn(
      async (football: Parameters<typeof simulateFirstPartyRosOutcomes>[0]) => {
        active += 1;
        maximum = Math.max(maximum, active);
        if (active === 2) bothStarted();
        await barrier;
        const result = simulateFirstPartyRosOutcomes(football);
        active -= 1;
        return result;
      },
    );
    const build = createRosHistoricalOutcomeEvaluator({
      cache: storage.cache,
      mode: "build",
      simulate,
    });
    await Promise.all([build(input()), build(input({ playerId: "receiver-two" }))]);
    expect(maximum).toBe(2);
    expect(simulate).toHaveBeenCalledTimes(2);
  });

  it("cancels before generation and after generation without publishing", async () => {
    const storage = await cache();
    const pre = new AbortController();
    pre.abort(new Error("cancelled"));
    const simulate = vi.fn(simulateFirstPartyRosOutcomes);
    await expect(
      createRosHistoricalOutcomeEvaluator({
        cache: storage.cache,
        mode: "build",
        signal: pre.signal,
        simulate,
      })(input()),
    ).rejects.toThrow("cancelled");
    expect(simulate).not.toHaveBeenCalled();
    const controller = new AbortController();
    const during = vi.fn((football: Parameters<typeof simulateFirstPartyRosOutcomes>[0]) => {
      const result = simulateFirstPartyRosOutcomes(football);
      controller.abort(new Error("stale build"));
      return result;
    });
    await expect(
      createRosHistoricalOutcomeEvaluator({
        cache: storage.cache,
        mode: "build",
        signal: controller.signal,
        simulate: during,
      })(input()),
    ).rejects.toThrow("stale build");
    expect(await readdir(storage.directory)).toEqual([]);
  });

  it("rejects invalid prefixes and unsupported nonlinear scoring before generation", async () => {
    const storage = await cache();
    const simulate = vi.fn(simulateFirstPartyRosOutcomes);
    const build = createRosHistoricalOutcomeEvaluator({
      cache: storage.cache,
      mode: "build",
      simulate,
    });
    await expect(build(input({ scenarioCount: 129 }))).rejects.toMatchObject({
      code: "outcome_input_invalid",
    });
    await expect(
      build(
        input({
          scoringProfile: {
            id: "nonlinear",
            rules: [
              { statId: "receiving_yards", points: 0.1, bonuses: [{ atLeast: 100, points: 3 }] },
            ],
          },
        }),
      ),
    ).rejects.toThrow();
    expect(simulate).not.toHaveBeenCalled();
  });
});
