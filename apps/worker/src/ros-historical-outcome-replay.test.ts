import type * as FileSystemPromises from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
  FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
  projectFirstPartyRestOfSeason,
  simulateFirstPartyRosOutcomes,
} from "@laces-out/projections";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRosHistoricalOutcomeEvaluator,
  rosHistoricalOutcomeCacheKey,
} from "./ros-historical-outcome-replay.js";
import { createRosOutcomeCache, type RosOutcomeCache } from "./ros-outcome-cache.js";
import { createRosOutcomeSimulationPool } from "./ros-outcome-simulation-pool.js";

import { historicalOutcomeInputFixture as input } from "./ros-historical-outcome.test-fixtures.js";

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
