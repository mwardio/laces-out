import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
  FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
  projectFirstPartyRestOfSeason,
  type FirstPartyRosProjectionInput,
} from "@laces-out/projections";
import { evaluateRosNumericalReplication } from "../../../packages/projections/src/ros-numerical-replication.js";
import { historicalOutcomeInputFixture } from "./ros-historical-outcome.test-fixtures.js";
import {
  createRosLiveOutcomeProjector,
  readPinnedRosLiveNumericalReplicationInput,
  rosLiveOutcomeCacheKey,
} from "./ros-live-outcomes.js";
import type { RosOutcomeCache, RosOutcomeCacheEnsemble } from "./ros-outcome-cache.js";

const manifest = "c".repeat(64);
const family = { size: 36, errorBudget: 0.05, protocolChecksum: "a".repeat(64) };
let forecast: FirstPartyRosProjectionInput;
let original: RosOutcomeCacheEnsemble;
beforeAll(async () => {
  forecast = historicalOutcomeInputFixture({
    scenarioCount: FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
  });
  const cache: RosOutcomeCache = {
    read: async () => ({ state: "missing" }),
    write: async (_key, ensemble) => {
      original = structuredClone(ensemble);
      return { state: "written", manifestChecksum: manifest };
    },
  };
  await createRosLiveOutcomeProjector({ cache })(forecast);
});

function setup() {
  const ensemble = structuredClone(original);
  const read = vi.fn<RosOutcomeCache["read"]>(async () => ({
    state: "hit",
    ensemble,
    manifestChecksum: manifest,
  }));
  return {
    ensemble,
    read,
    options: {
      cache: { read },
      forecast: structuredClone(forecast),
      expectedManifestChecksum: manifest,
      family: { ...family },
    },
  };
}

describe("pinned live numerical vectors", () => {
  it("recomputes the actual release prefix and reference from original live paths", async () => {
    const { options, read } = setup();
    const captured = await readPinnedRosLiveNumericalReplicationInput(options);
    expect(captured.cacheIdentity).toBe(rosLiveOutcomeCacheKey(forecast).identity);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(rosLiveOutcomeCacheKey(forecast), {
      expectedScenarioCount: FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
    });
    const evaluation = evaluateRosNumericalReplication(captured.input);
    for (const [actual, count] of [
      [evaluation.summaries.release, FIRST_PARTY_ROS_DEFAULT_SCENARIOS],
      [evaluation.summaries.reference, FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS],
    ] as const) {
      const direct = projectFirstPartyRestOfSeason({ ...forecast, scenarioCount: count });
      for (const key of [
        "meanPoints",
        "p15Points",
        "p50Points",
        "p85Points",
        "expectedGames",
      ] as const)
        expect(actual[key]).toBeCloseTo(direct[key], 9);
      expect(actual.seedHash).toBe(direct.provenance.seedHash);
    }
    expect(evaluation.canAuthorizeRelease).toBe(false);
    expect(captured.input.provenance.vectorChecksum).toBe(manifest);
  });

  it.each(["missing", "corrupt"] as const)("keeps %s cache evidence unavailable", async (state) => {
    const { options, read } = setup();
    read.mockResolvedValue(
      state === "missing" ? { state } : { state, reason: "payload_checksum_mismatch" },
    );
    await expect(readPinnedRosLiveNumericalReplicationInput(options)).rejects.toThrow(state);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("rejects an unpinned manifest and mismatched original seed", async () => {
    const { options, ensemble } = setup();
    await expect(
      readPinnedRosLiveNumericalReplicationInput({
        ...options,
        expectedManifestChecksum: "d".repeat(64),
      }),
    ).rejects.toThrow("manifest mismatch");
    const neutral = ensemble.metadata.neutral as unknown as { provenance: { seedHash: string } };
    neutral.provenance.seedHash = "d".repeat(64);
    await expect(readPinnedRosLiveNumericalReplicationInput(options)).rejects.toThrow(
      "invalid or incomplete",
    );
  });

  it("rejects release-only paths instead of silently creating a reference", async () => {
    const { options, read } = setup();
    await expect(
      readPinnedRosLiveNumericalReplicationInput({
        ...options,
        forecast: { ...forecast, scenarioCount: FIRST_PARTY_ROS_DEFAULT_SCENARIOS },
      }),
    ).rejects.toThrow("Invalid pinned live");
    expect(read).not.toHaveBeenCalled();
  });

  it("snapshots caller identity and scoring before the cache await", async () => {
    const { options, read, ensemble } = setup();
    const expected = await readPinnedRosLiveNumericalReplicationInput(options);
    read.mockImplementation(async () => {
      options.forecast = {
        ...options.forecast,
        seed: "changed",
        scoringProfile: { id: "changed", rules: [{ statId: "receptions", points: 20 }] },
      };
      options.family.size = 1;
      options.expectedManifestChecksum = "d".repeat(64);
      return { state: "hit", ensemble, manifestChecksum: manifest };
    });
    const actual = await readPinnedRosLiveNumericalReplicationInput(options);
    expect(actual).toEqual(expected);
    ensemble.games.fill(0);
    expect(actual.input.games).toEqual(expected.input.games);
  });

  it("honors cancellation both before and after the cache read", async () => {
    const { options, read, ensemble } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      readPinnedRosLiveNumericalReplicationInput({ ...options, signal: controller.signal }),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    const duringRead = new AbortController();
    read.mockImplementation(async () => {
      duringRead.abort();
      return { state: "hit", ensemble, manifestChecksum: manifest };
    });
    await expect(
      readPinnedRosLiveNumericalReplicationInput({ ...options, signal: duringRead.signal }),
    ).rejects.toThrow();
  });
});
