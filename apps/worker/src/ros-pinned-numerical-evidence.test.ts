import type * as FileSystemPromises from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION,
  firstPartyRosSeedHash,
  projectionScoringProfileKey,
  type FirstPartyRosProjectionInput,
} from "@laces-out/projections";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { historicalOutcomeInputFixture } from "./ros-historical-outcome.test-fixtures.js";
import { rosHistoricalOutcomeCacheKey } from "./ros-historical-outcome-replay.js";
import {
  createRosOutcomeCache,
  type RosOutcomeCache,
  type RosOutcomeCacheEnsemble,
} from "./ros-outcome-cache.js";
import {
  evaluatePinnedRosNumericalEvidence,
  pinnedRosNumericalEvidenceMatchesSource,
  ROS_PINNED_NUMERICAL_SCORER_VERSION,
} from "./ros-pinned-numerical-evidence.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof FileSystemPromises>()),
  statfs: vi.fn(),
}));
beforeEach(() => {
  // Keep the real codec and integrity checks; only the unrelated disk-reserve check is mocked.
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
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fixtureForecast() {
  return historicalOutcomeInputFixture({
    scoringProfile: { id: "synthetic-points", rules: [{ statId: "receiving_yards", points: 0.1 }] },
  });
}

/** Deliberately synthetic, ordered components; no football simulator or historical data used. */
function fixtureEnsemble(forecast: FirstPartyRosProjectionInput): RosOutcomeCacheEnsemble {
  const key = rosHistoricalOutcomeCacheKey(forecast);
  return {
    scenarioCount: 16_384,
    columns: {
      receiving_yards: Float64Array.from({ length: 16_384 }, (_, index) =>
        index < 6143 || (index >= 12_288 && index < 14_338) ? 0 : 1000,
      ),
      receptions: new Float64Array(16_384),
      receiving_touchdowns: new Float64Array(16_384),
    },
    games: new Uint8Array(16_384).fill(1),
    metadata: {
      schemaVersion: FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION,
      identity: key.identity,
      seed: forecast.seed,
      core: {
        playerId: forecast.playerId,
        position: forecast.position,
        scheduledGames: 1,
        provenance: {
          modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
          strategy: forecast.strategy,
          weeklyModelVersion: forecast.weeklyModelVersion,
          inputChecksum: forecast.inputChecksum,
          seedHash: firstPartyRosSeedHash(forecast),
          randomGenerator: "xoshiro128**-sha256-128",
          scenarioCount: 16_384,
          season: forecast.season,
          asOfWeek: forecast.asOfWeek,
          asOfAt: forecast.asOfAt,
          windowStartWeek: forecast.windowStartWeek,
          windowEndWeek: forecast.windowEndWeek,
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
}

async function persisted(forecast = fixtureForecast(), ensemble = fixtureEnsemble(forecast)) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ros-pinned-numerical-"));
  directories.push(directory);
  const cache = createRosOutcomeCache({ directory });
  const key = rosHistoricalOutcomeCacheKey(forecast);
  const write = await cache.write(key, ensemble);
  return {
    directory,
    input: {
      cache,
      forecast,
      expectedManifestChecksum: write.manifestChecksum,
      family: { size: 144, errorBudget: 0.05, protocolChecksum: "b".repeat(64) },
    },
  };
}

describe("pinned ROS numerical evidence", () => {
  it("binds the real codec and scorer while retaining a failed legacy median diagnostic", async () => {
    const { input } = await persisted();
    const read = vi.spyOn(input.cache, "read");
    const write = vi.spyOn(input.cache, "write");
    const result = await evaluatePinnedRosNumericalEvidence(input);
    expect(read).toHaveBeenCalledExactlyOnceWith(rosHistoricalOutcomeCacheKey(input.forecast), {
      expectedScenarioCount: 16_384,
    });
    expect(write).not.toHaveBeenCalled();
    expect(result.source.manifestChecksum).toBe(input.expectedManifestChecksum);
    expect(result.evaluation.measurement.provenance).toMatchObject({
      vectorChecksum: input.expectedManifestChecksum,
      seedHash: firstPartyRosSeedHash(input.forecast),
      scorerVersion: ROS_PINNED_NUMERICAL_SCORER_VERSION,
      scoringProfileKey: projectionScoringProfileKey(input.forecast.scoringProfile),
    });
    expect(result.evaluation.measurement.prefixVsFull).toMatchObject({
      numerator: 7,
      denominator: 49_152,
    });
    expect(result.evaluation.summaries.release.p50Points).toBe(100);
    expect(result.evaluation.summaries.reference.p50Points).toBe(0);
    expect(result.evaluation.operational.state).toBe("within-tolerance");
    expect(result.evaluation.legacyDiagnostic.state).toBe("unstable");
    expect(result.evaluation.pointSensitivity.state).toBe("legacy-quantile-sensitive");
    expect(result).toMatchObject({
      canAuthorizeRelease: false,
      canAuthorizeModelAdoption: false,
      familyAuthentication: "caller-declaration-not-verified-here",
      simulationExecutionAuthentication: "not-verified-here",
    });
    expect(await pinnedRosNumericalEvidenceMatchesSource(result, input)).toBe(true);
    expect(
      await pinnedRosNumericalEvidenceMatchesSource(
        { ...result, canAuthorizeRelease: true },
        input,
      ),
    ).toBe(false);
    expect(
      await pinnedRosNumericalEvidenceMatchesSource({ ...result, unexpected: true }, input),
    ).toBe(false);
  });

  it.each([0, 0.5, -0.3])("rescores the same component paths at coefficient %s", async (points) => {
    const { input } = await persisted();
    const baseline = await evaluatePinnedRosNumericalEvidence(input);
    const forecast = {
      ...input.forecast,
      scoringProfile: {
        id: "changed",
        rules: [
          { statId: "receiving_yards", points },
          { statId: "receptions", points: 1 },
        ],
      },
    };
    const result = await evaluatePinnedRosNumericalEvidence({ ...input, forecast });
    expect(result.source).toEqual(baseline.source);
    expect(result.evaluation.measurement.provenance.scoringProfileKey).toBe(
      projectionScoringProfileKey(forecast.scoringProfile),
    );
    expect(result.evidenceChecksum).not.toBe(baseline.evidenceChecksum);
    expect(result.evaluation.summaries.reference.meanPoints).toBeCloseTo(
      (8191 / 16_384) * 1000 * points,
      9,
    );
  });

  it("rejects missing data, a corrupted payload and an independent manifest pin mismatch", async () => {
    const { input, directory } = await persisted();
    await expect(
      evaluatePinnedRosNumericalEvidence({ ...input, expectedManifestChecksum: "c".repeat(64) }),
    ).rejects.toMatchObject({ code: "manifest_pin_mismatch" });
    await expect(
      evaluatePinnedRosNumericalEvidence({
        ...input,
        forecast: { ...input.forecast, seed: "different-input" },
      }),
    ).rejects.toMatchObject({ code: "missing_outcomes" });
    const filename = (await readdir(directory)).find((name) => name.endsWith(".ros-outcomes"))!;
    const file = path.join(directory, filename);
    const bytes = await readFile(file);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(file, bytes);
    await expect(evaluatePinnedRosNumericalEvidence(input)).rejects.toMatchObject({
      code: "corrupt_outcomes",
    });
  });

  it.each(["seed", "asOfAt"] as const)(
    "rejects coherently rewritten %s even with its new valid manifest pin",
    async (field) => {
      const forecast = fixtureForecast();
      const changed = {
        ...forecast,
        [field]: field === "seed" ? "replacement-seed" : "2026-10-01T13:00:00.000Z",
      };
      const ensemble = fixtureEnsemble(changed);
      const { input } = await persisted(forecast, {
        ...ensemble,
        metadata: {
          ...ensemble.metadata,
          identity: rosHistoricalOutcomeCacheKey(forecast).identity,
        },
      });
      await expect(evaluatePinnedRosNumericalEvidence(input)).rejects.toMatchObject({
        code: "forecast_identity_mismatch",
      });
    },
  );

  it("binds score and game order even when all distribution summaries stay unchanged", async () => {
    const forecast = fixtureForecast();
    const original = fixtureEnsemble(forecast);
    original.games[0] = 0;
    const first = await evaluatePinnedRosNumericalEvidence(
      (await persisted(forecast, original)).input,
    );
    const changed = structuredClone(original);
    [changed.columns.receiving_yards![0], changed.columns.receiving_yards![6143]] = [1000, 0];
    [changed.games[0], changed.games[1]] = [1, 0];
    const second = await evaluatePinnedRosNumericalEvidence(
      (await persisted(forecast, changed)).input,
    );
    expect(second.evaluation.summaries).toEqual(first.evaluation.summaries);
    expect(second.source.manifestChecksum).not.toBe(first.source.manifestChecksum);
    expect(second.evaluation.measurement.scoreVectorChecksum).not.toBe(
      first.evaluation.measurement.scoreVectorChecksum,
    );
    expect(second.evaluation.gamesVectorChecksum).not.toBe(first.evaluation.gamesVectorChecksum);
  });

  it("captures nested input and family values before an asynchronous cache read", async () => {
    const { input } = await persisted();
    const expected = await evaluatePinnedRosNumericalEvidence(input);
    let proceed!: () => void;
    const wait = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const cache: Pick<RosOutcomeCache, "read"> = {
      read: async (...args) => {
        await wait;
        return input.cache.read(...args);
      },
    };
    const request = structuredClone({
      forecast: input.forecast,
      family: input.family,
      expectedManifestChecksum: input.expectedManifestChecksum,
    });
    const result = evaluatePinnedRosNumericalEvidence({ ...request, cache });
    Object.assign(request.forecast, { seed: "changed", asOfAt: "2026-10-02T12:00:00.000Z" });
    Object.assign(request.forecast.weeks[0]!, { scheduled: false });
    Object.assign(request.forecast.scoringProfile.rules[0]!, { points: -5 });
    request.family.size = 1;
    request.family.protocolChecksum = "c".repeat(64);
    proceed();
    expect(await result).toEqual(expected);
  });

  it("honors cancellation before and during a read without producing evidence", async () => {
    const { input } = await persisted();
    const controller = new AbortController();
    const read = vi.spyOn(input.cache, "read");
    controller.abort();
    await expect(
      evaluatePinnedRosNumericalEvidence({ ...input, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(read).not.toHaveBeenCalled();
    const next = new AbortController();
    const cache: Pick<RosOutcomeCache, "read"> = {
      read: async (...args) => {
        const value = await input.cache.read(...args);
        next.abort();
        return value;
      },
    };
    await expect(
      evaluatePinnedRosNumericalEvidence({ ...input, cache, signal: next.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("matches the submitted receipt snapshot even if the caller repairs it during cache I/O", async () => {
    const { input } = await persisted();
    const original = await evaluatePinnedRosNumericalEvidence(input);
    const submitted = { ...original, canAuthorizeRelease: true };
    let proceed!: () => void;
    const wait = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const cache: Pick<RosOutcomeCache, "read"> = {
      read: async (...args) => {
        await wait;
        return input.cache.read(...args);
      },
    };
    const result = pinnedRosNumericalEvidenceMatchesSource(submitted, { ...input, cache });
    submitted.canAuthorizeRelease = false;
    proceed();
    expect(await result).toBe(false);
  });

  it.each([
    { size: 0 },
    { size: 1.5 },
    { errorBudget: 0 },
    { errorBudget: 1 },
    { errorBudget: Number.NaN },
    { protocolChecksum: "untrusted" },
  ])("rejects invalid family declaration %j before reading data", async (invalid) => {
    const { input } = await persisted();
    const read = vi.spyOn(input.cache, "read");
    await expect(
      evaluatePinnedRosNumericalEvidence({
        ...input,
        family: { ...input.family, ...invalid },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(read).not.toHaveBeenCalled();
  });

  it("does not approximate weekly threshold bonuses from season totals", async () => {
    const { input } = await persisted();
    await expect(
      evaluatePinnedRosNumericalEvidence({
        ...input,
        forecast: {
          ...input.forecast,
          scoringProfile: {
            id: "weekly-bonus",
            rules: [
              { statId: "receiving_yards", points: 0.1, bonuses: [{ atLeast: 100, points: 3 }] },
            ],
          },
        },
      }),
    ).rejects.toThrow();
  });
});
