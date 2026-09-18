import { mkdtemp, readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  projectFirstPartyRestOfSeason,
  type FirstPartyRosProjection,
  type FirstPartyRosProjectionInput,
  type ProjectionScoringProfile,
} from "@laces-out/projections";
import { historicalOutcomeInputFixture } from "./ros-historical-outcome.test-fixtures.js";
import {
  createRosOutcomeCache,
  type RosOutcomeCache,
  type RosOutcomeCacheEnsemble,
} from "./ros-outcome-cache.js";
import {
  createRosLiveOutcomeProjector,
  rosLiveOutcomeCacheKey,
  ROS_LIVE_OUTCOME_CACHE_LIMITS,
} from "./ros-live-outcomes.js";
import type { FirstPartyRosLiveProjection } from "./ros-live-projection.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
function memoryCache() {
  const entries = new Map<string, RosOutcomeCacheEnsemble>();
  const cache: RosOutcomeCache = {
    async read(key) {
      const ensemble = entries.get(key.identity);
      return ensemble
        ? { state: "hit", ensemble: structuredClone(ensemble), manifestChecksum: "c".repeat(64) }
        : { state: "missing" };
    },
    async write(key, ensemble) {
      entries.set(key.identity, structuredClone(ensemble));
      return { state: "written", manifestChecksum: "c".repeat(64) };
    },
  };
  return { cache, entries };
}
function fixture(scenarioCount = 128): FirstPartyRosProjectionInput {
  const base = historicalOutcomeInputFixture({ scenarioCount });
  const week = base.weeks[0]!;
  const componentElasticities = {
    ...week.componentElasticities,
    receiving_yards_100_199_probability: { role: 0, production: 0 },
    receiving_yards_200_plus_probability: { role: 0, production: 0 },
  };
  const withBonuses = {
    ...week,
    componentElasticities,
    contextualComponents: {
      ...week.contextualComponents,
      receiving_yards_100_199_probability: 0.2,
      receiving_yards_200_plus_probability: 0.005,
    },
    recencyComponents: {
      ...week.recencyComponents,
      receiving_yards_100_199_probability: 0.15,
      receiving_yards_200_plus_probability: 0.002,
    },
  };
  return {
    ...base,
    windowEndWeek: 7,
    weeks: [
      withBonuses,
      { ...withBonuses, week: 6, scheduled: false, bye: true },
      { ...withBonuses, week: 7, newAbsenceProbability: 0.3, recoveryProbability: 0.15 },
    ],
  };
}
const normalizedBonusProfile: ProjectionScoringProfile = {
  id: "half-ppr-normalized-yardage-bonuses",
  rules: [
    { statId: "receptions", points: 0.5 },
    { statId: "receiving_yards", points: 0.1 },
    { statId: "receiving_touchdowns", points: 4 },
    { statId: "receiving_yards_100_199_probability", points: 3 },
    { statId: "receiving_yards_200_plus_probability", points: 6 },
  ],
};
function equivalent(actual: FirstPartyRosLiveProjection, expected: FirstPartyRosProjection) {
  const fields = [
    "meanPoints",
    "standardDeviation",
    "p15Points",
    "p50Points",
    "p85Points",
  ] as const;
  for (const field of fields) {
    expect(Math.abs(actual[field] - expected[field])).toBeLessThanOrEqual(1e-9);
    for (const precision of [3, 4, 6])
      expect(actual[field].toFixed(precision)).toBe(expected[field].toFixed(precision));
  }
  expect(actual).toEqual({
    ...expected,
    ...Object.fromEntries(fields.map((field) => [field, actual[field]])),
    weekly: expected.weekly.map(({ week, scheduled, bye, availabilityProbability }) => ({
      week,
      scheduled,
      bye,
      availabilityProbability,
    })),
  });
  for (const week of actual.weekly) {
    expect(Object.keys(week).sort()).toEqual([
      "availabilityProbability",
      "bye",
      "scheduled",
      "week",
    ]);
  }
}

describe("durable live aggregate outcome replay", () => {
  it.each([128, 130, 256])(
    "replays aggregate forecasts and exact availability across new adapter instances at %i paths",
    async (scenarioCount) => {
      const input = fixture(scenarioCount);
      const { cache } = memoryCache();
      const simulate = vi.fn(projectFirstPartyRestOfSeason);
      const first = await createRosLiveOutcomeProjector({ cache, simulate })(input);
      equivalent(first, projectFirstPartyRestOfSeason(input));
      expect(simulate).toHaveBeenCalledTimes(1);
      const forbidden = vi.fn<typeof projectFirstPartyRestOfSeason>(() => {
        throw new Error("unexpected simulation");
      });
      const afterRestart = createRosLiveOutcomeProjector({ cache, simulate: forbidden });
      expect(await afterRestart(input)).toEqual(first);
      const changed = { ...input, scoringProfile: normalizedBonusProfile };
      equivalent(await afterRestart(changed), projectFirstPartyRestOfSeason(changed));
      expect(forbidden).not.toHaveBeenCalled();
      expect(first.weekly[1]).toEqual({
        week: 6,
        scheduled: false,
        bye: true,
        availabilityProbability: 0,
      });
      (first as { meanPoints: number }).meanPoints = 999;
      expect((await afterRestart(input)).meanPoints).not.toBe(999);
    },
  );

  it("reuses bounded profile summaries without decoding vectors again", async () => {
    const input = fixture();
    const { cache } = memoryCache();
    const read = vi.spyOn(cache, "read");
    const project = createRosLiveOutcomeProjector({
      cache,
      profiles: [input.scoringProfile, normalizedBonusProfile],
    });
    await project(input);
    equivalent(
      await project({ ...input, scoringProfile: normalizedBonusProfile }),
      projectFirstPartyRestOfSeason({ ...input, scoringProfile: normalizedBonusProfile }),
    );
    expect(read).toHaveBeenCalledTimes(1);
    const uncached = createRosLiveOutcomeProjector({ cache, maximumSummaryBytes: 0 });
    await uncached(input);
    await uncached(input);
    expect(read).toHaveBeenCalledTimes(3);
    expect(() => createRosLiveOutcomeProjector({ cache, maximumSummaryBytes: -1 })).toThrow(
      "bound",
    );
  });

  it("isolates a speculative profile with missing priced components from a valid requested profile", async () => {
    const input = fixture();
    const incompatible: ProjectionScoringProfile = {
      id: "missing-rushing-evidence",
      rules: [{ statId: "rushing_yards", points: 0.1 }],
    };
    const { cache } = memoryCache();
    const simulate = vi.fn(projectFirstPartyRestOfSeason);
    const project = createRosLiveOutcomeProjector({
      cache,
      simulate,
      profiles: [input.scoringProfile, incompatible],
    });
    equivalent(await project(input), projectFirstPartyRestOfSeason(input));
    await expect(project({ ...input, scoringProfile: incompatible })).rejects.toThrow();
    expect(simulate).toHaveBeenCalledTimes(1);
    equivalent(await project(input), projectFirstPartyRestOfSeason(input));
  });

  it("reopens real immutable files and reprices a new normalized profile without simulation", async () => {
    const directory = await mkdtemp(path.join(process.cwd(), "reports", ".live-outcomes-test-"));
    directories.push(directory);
    const input = fixture();
    const cache = createRosOutcomeCache({ directory, limits: ROS_LIVE_OUTCOME_CACHE_LIMITS });
    await createRosLiveOutcomeProjector({ cache })(input);
    expect(
      (await readdir(directory)).filter((name) => name.endsWith(".ros-outcomes")),
    ).toHaveLength(1);
    const forbidden = vi.fn<typeof projectFirstPartyRestOfSeason>(() => {
      throw new Error("unexpected simulation");
    });
    const replay = createRosLiveOutcomeProjector({
      cache: createRosOutcomeCache({ directory }),
      simulate: forbidden,
    });
    const changed = { ...input, scoringProfile: normalizedBonusProfile };
    equivalent(await replay(changed), projectFirstPartyRestOfSeason(changed));
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("replays a new scoring profile in a separate process with simulation forbidden", async () => {
    const directory = await mkdtemp(
      path.join(process.cwd(), "reports", ".live-outcomes-process-test-"),
    );
    directories.push(directory);
    const input = fixture();
    const changed = { ...input, scoringProfile: normalizedBonusProfile };
    const script = `
      import { createRosLiveOutcomeProjector } from ${JSON.stringify(new URL("./ros-live-outcomes.ts", import.meta.url).href)};
      import { createRosOutcomeCache } from ${JSON.stringify(new URL("./ros-outcome-cache.ts", import.meta.url).href)};
      const [directory, mode, serialized] = process.argv.slice(1);
      const options = { cache: createRosOutcomeCache({ directory }) };
      if (mode === 'replay') options.simulate = () => { throw new Error('Unexpected simulation in new process'); };
      const result = await createRosLiveOutcomeProjector(options)(JSON.parse(serialized));
      process.stdout.write(JSON.stringify(result));
    `;
    const run = promisify(execFile);
    const child = async (mode: string, value: FirstPartyRosProjectionInput) => {
      const { stdout } = await run(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          script,
          directory,
          mode,
          JSON.stringify(value),
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=256" },
          timeout: 20_000,
          maxBuffer: 256 * 1024,
        },
      );
      return JSON.parse(stdout) as FirstPartyRosLiveProjection;
    };
    const cold = await child("cold", input);
    const replay = await child("replay", changed);
    equivalent(cold, projectFirstPartyRestOfSeason(input));
    equivalent(replay, projectFirstPartyRestOfSeason(changed));
    expect(replay.provenance.seedHash).toBe(cold.provenance.seedHash);
  }, 30_000);

  it.each(["seed", "asOfAt", "scenarioCount", "strategy", "inputChecksum", "weeks"] as const)(
    "invalidates physical %s changes",
    async (field) => {
      const input = fixture();
      const changed = {
        ...input,
        ...(field === "seed" ? { seed: "new-football" } : {}),
        ...(field === "asOfAt" ? { asOfAt: "2026-10-01T12:01:00.000Z" } : {}),
        ...(field === "scenarioCount" ? { scenarioCount: 256 } : {}),
        ...(field === "strategy" ? { strategy: "availability-aware-recency" as const } : {}),
        ...(field === "inputChecksum" ? { inputChecksum: "b".repeat(64) } : {}),
        ...(field === "weeks"
          ? { weeks: input.weeks.map((week) => ({ ...week, recoveryProbability: 0.7 })) }
          : {}),
      };
      expect(rosLiveOutcomeCacheKey(changed)).not.toEqual(rosLiveOutcomeCacheKey(input));
      expect(rosLiveOutcomeCacheKey({ ...input, scoringProfile: normalizedBonusProfile })).toEqual(
        rosLiveOutcomeCacheKey(input),
      );
      const { cache } = memoryCache();
      const simulate = vi.fn(projectFirstPartyRestOfSeason);
      const project = createRosLiveOutcomeProjector({ cache, simulate });
      await project(input);
      equivalent(await project(changed), projectFirstPartyRestOfSeason(changed));
      expect(simulate).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps exact reserve/bye availability and honest availability-only weekly rows", async () => {
    const input = fixture();
    const reserve = {
      ...input,
      scoringProfile: normalizedBonusProfile,
      weeks: input.weeks.map((week) => ({ ...week, recoveryProbability: 0 })),
      availability: {
        ...input.availability,
        state: "reserve" as const,
        reserveRecoveryProbability: 0,
      },
    };
    const { cache } = memoryCache();
    const project = createRosLiveOutcomeProjector({ cache });
    equivalent(await project(reserve), projectFirstPartyRestOfSeason(reserve));
    expect((await project(reserve)).meanPoints).toBe(0);
    const byes = {
      ...input,
      weeks: input.weeks.map((week) => ({ ...week, scheduled: false, bye: true })),
    };
    equivalent(await project(byes), projectFirstPartyRestOfSeason(byes));
  });

  it("rejects raw weekly threshold bonuses before any cache lookup or simulation", async () => {
    const input = fixture();
    const { cache } = memoryCache();
    const read = vi.spyOn(cache, "read");
    const simulate = vi.fn(projectFirstPartyRestOfSeason);
    await expect(
      createRosLiveOutcomeProjector({ cache, simulate })({
        ...input,
        scoringProfile: {
          id: "raw-threshold",
          rules: [
            { statId: "receiving_yards", points: 0.1, bonuses: [{ atLeast: 100, points: 3 }] },
          ],
        },
      }),
    ).rejects.toThrow("nonlinear bonus");
    expect(read).not.toHaveBeenCalled();
    expect(simulate).not.toHaveBeenCalled();
  });

  it("rejects newly priced unknown long-touchdown evidence on an otherwise warm input", async () => {
    const input = fixture();
    const { cache } = memoryCache();
    const simulate = vi.fn(projectFirstPartyRestOfSeason);
    const project = createRosLiveOutcomeProjector({ cache, simulate });
    await project(input);
    const changed = {
      ...input,
      scoringProfile: {
        id: "unknown-tds",
        rules: [{ statId: "receiving_touchdowns_40_plus", points: 2 }],
      },
    };
    expect(() => projectFirstPartyRestOfSeason(changed)).toThrow();
    await expect(project(changed)).rejects.toThrow("invalid or incomplete");
    expect(simulate).toHaveBeenCalledTimes(1);
  });

  it.each(["contextual", "availability-aware-recency"] as const)(
    "preserves generated kicker components and aggregate tails for %s",
    async (strategy) => {
      const components = {
        field_goals_made_0_39: 0.9,
        field_goals_made_40_49: 0.4,
        field_goals_made_50_plus: 0.2,
        field_goals_made: 1.5,
        field_goals_attempted: 1.8,
        field_goals_total_yards: 55,
        extra_points_made: 2.2,
        extra_points_attempted: 2.3,
      };
      const input: FirstPartyRosProjectionInput = {
        ...fixture(256),
        position: "K",
        strategy,
        weeks: fixture(256).weeks.map((week) => ({
          ...week,
          contextualComponents: components,
          recencyComponents: components,
          componentElasticities: Object.fromEntries(
            Object.keys(components).map((key) => [key, { role: 1, production: 1 }]),
          ),
        })),
        kicker: {
          fgEventDispersion: 0.83,
          xpDispersion: 0.85,
          centerVolatility: 0.1,
          bucketMix: [0.57, 0.27, 0.16],
          missBucketMix: [0, 0.03, 0.09, 0.36, 0.46, 0.06],
        },
        scoringProfile: {
          id: "kicker",
          rules: [
            { statId: "field_goals_made_0_39", points: 3 },
            { statId: "field_goals_made_50_plus", points: 5 },
            { statId: "field_goals_total_yards", points: 0.1 },
          ],
        },
      };
      const { cache } = memoryCache();
      equivalent(
        await createRosLiveOutcomeProjector({ cache })(input),
        projectFirstPartyRestOfSeason(input),
      );
      equivalent(
        await createRosLiveOutcomeProjector({ cache })(input),
        projectFirstPartyRestOfSeason(input),
      );
    },
  );

  it.each([
    "identity",
    "seed",
    "weekly",
    "availability",
    "column",
    "componentMean",
    "scenarioCount",
    "inventedWeeklyPoints",
  ])("fails closed on malformed cached %s", async (mutation) => {
    const input = fixture();
    const { cache, entries } = memoryCache();
    await createRosLiveOutcomeProjector({ cache })(input);
    const key = rosLiveOutcomeCacheKey(input).identity;
    const malformed = structuredClone(entries.get(key)!) as unknown as {
      scenarioCount: number;
      columns: Record<string, Float64Array>;
      metadata: {
        identity: string;
        neutral: {
          provenance: { seedHash: string };
          expectedComponents: Record<string, number>;
          weekly: Array<{ availabilityProbability: number; meanPoints?: number }>;
        };
      };
    };
    if (mutation === "identity") malformed.metadata.identity = "d".repeat(64);
    if (mutation === "seed") malformed.metadata.neutral.provenance.seedHash = "d".repeat(64);
    if (mutation === "weekly") malformed.metadata.neutral.weekly = [];
    if (mutation === "availability")
      malformed.metadata.neutral.weekly[0]!.availabilityProbability = 0.1234;
    if (mutation === "column") delete malformed.columns[Object.keys(malformed.columns)[0]!];
    if (mutation === "componentMean")
      malformed.metadata.neutral.expectedComponents.receptions! += 1;
    if (mutation === "scenarioCount") malformed.scenarioCount = 256;
    if (mutation === "inventedWeeklyPoints") malformed.metadata.neutral.weekly[0]!.meanPoints = 0;
    entries.set(key, malformed as unknown as RosOutcomeCacheEnsemble);
    const forbidden = vi.fn<typeof projectFirstPartyRestOfSeason>(() => {
      throw new Error("unexpected simulation");
    });
    await expect(
      createRosLiveOutcomeProjector({ cache, simulate: forbidden })(input),
    ).rejects.toThrow("invalid or incomplete");
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("does not treat corrupt evidence as a cold miss", async () => {
    const write = vi.fn();
    const cache: RosOutcomeCache = {
      read: async () => ({ state: "corrupt", reason: "payload_checksum_mismatch" }),
      write,
    };
    const simulate = vi.fn(projectFirstPartyRestOfSeason);
    await expect(createRosLiveOutcomeProjector({ cache, simulate })(fixture())).rejects.toThrow(
      "invalid or incomplete",
    );
    expect(simulate).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
