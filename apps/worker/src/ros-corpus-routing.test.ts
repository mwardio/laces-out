import { describe, expect, it, vi } from "vitest";
import { projectionScoringProfileKey, rosScoringProfile } from "@laces-out/projections";
import {
  createRosDefinitionAwareReadiness,
  rosCorpusDemandGroups,
  type RosProfileMarginalCorpusResolver,
} from "./ros-corpus-routing.js";
import { rosSharedCorpusRequest } from "./ros-shared-corpus-runner.js";

const yahoo = rosScoringProfile("full-ppr").scoringProfileKey;
const espn = rosScoringProfile("espn-ppr-4pt-pass").scoringProfileKey;
const unpriced = projectionScoringProfileKey({
  id: "sacks",
  rules: [{ statId: "defensive_sacks", points: 1 }],
});
const legacy = projectionScoringProfileKey({
  id: "legacy",
  rules: [{ statId: "points_allowed", points: -0.1 }],
});
const signal = () => new AbortController().signal;

function fixture() {
  const ensure = vi.fn(async (_season: number, _signal: AbortSignal, definition: string) =>
    definition === "espn-2019-v1" ? "e".repeat(64) : "a".repeat(64),
  );
  const ready = vi.fn(
    async (_season: number, _signal: AbortSignal, definition: string): Promise<string | null> =>
      definition === "espn-2019-v1" ? "e".repeat(64) : null,
  );
  const marginal = vi.fn<RosProfileMarginalCorpusResolver>();
  return { ensure, ready, marginal };
}

describe("definition-aware ROS background routing", () => {
  it("routes profiles to separate physical requests and exact corpus identities", async () => {
    const deps = fixture();
    const route = createRosDefinitionAwareReadiness({ ...deps, releaseRail: "legacy-v7" });
    const yahooResult = await route(2026, signal(), yahoo);
    const espnResult = await route(2026, signal(), espn);
    expect(yahooResult).toEqual({
      requestIdentity: rosSharedCorpusRequest(2026, "yahoo-2022-v1").identity,
      corpusIdentity: "a".repeat(64),
    });
    expect(espnResult).toEqual({
      requestIdentity: rosSharedCorpusRequest(2026, "espn-2019-v1").identity,
      corpusIdentity: "e".repeat(64),
    });
    expect(yahooResult.requestIdentity).not.toBe(espnResult.requestIdentity);
    expect(deps.ensure.mock.calls.map((call) => call[2])).toEqual([
      "yahoo-2022-v1",
      "espn-2019-v1",
    ]);
  });

  it("can reuse an available group for unpriced PA without scheduling another build", async () => {
    const deps = fixture();
    const route = createRosDefinitionAwareReadiness({ ...deps, releaseRail: "legacy-v7" });
    expect((await route(2026, signal(), unpriced)).corpusIdentity).toBe("e".repeat(64));
    expect(deps.ensure).toHaveBeenCalledExactlyOnceWith(
      2026,
      expect.any(AbortSignal),
      "espn-2019-v1",
    );
  });

  it("does not let an unavailable Yahoo group redirect or block an ESPN profile", async () => {
    const deps = fixture();
    deps.ensure.mockImplementation(async (_season, _signal, definition) => {
      if (definition === "yahoo-2022-v1") throw new Error("Yahoo source unavailable");
      return "e".repeat(64);
    });
    const route = createRosDefinitionAwareReadiness({ ...deps, releaseRail: "legacy-v7" });
    await expect(route(2026, signal(), yahoo)).rejects.toThrow("Yahoo source unavailable");
    expect((await route(2026, signal(), espn)).corpusIdentity).toBe("e".repeat(64));
  });

  it("can prepare an unpriced profile using ESPN when Yahoo's ready pointer is corrupt", async () => {
    const deps = fixture();
    deps.ready.mockImplementation(async (_season, _signal, definition) => {
      if (definition === "yahoo-2022-v1") throw new Error("Corrupt pointer");
      return null;
    });
    const route = createRosDefinitionAwareReadiness({ ...deps, releaseRail: "legacy-v7" });
    expect((await route(2026, signal(), unpriced)).corpusIdentity).toBe("e".repeat(64));
    expect(deps.ensure).toHaveBeenCalledExactlyOnceWith(
      2026,
      expect.any(AbortSignal),
      "espn-2019-v1",
    );
  });

  it("rejects legacy active PA before scheduling and isolates it in demand grouping", async () => {
    const deps = fixture();
    const route = createRosDefinitionAwareReadiness({ ...deps, releaseRail: "legacy-v7" });
    await expect(route(2026, signal(), legacy)).rejects.toThrow("explicit definition");
    expect(deps.ensure).not.toHaveBeenCalled();
    const demand = rosCorpusDemandGroups(
      [yahoo, yahoo, espn, legacy, "invalid"].map((scoringProfileKey) => ({
        season: 2026,
        scoringProfileKey,
      })),
    );
    expect(demand.invalidProfiles).toBe(2);
    expect(demand.groups.map((group) => group.pointsAllowedDefinition)).toEqual([
      "yahoo-2022-v1",
      "espn-2019-v1",
    ]);
  });

  it("uses the exact marginal selection and never starts a bootstrap on that rail", async () => {
    const deps = fixture();
    deps.marginal.mockResolvedValue({
      pointsAllowedDefinition: "espn-2019-v1",
      bundle: {
        version: "ros-marginal-corpus-bundle-v1",
        forecastSeason: 2026,
        candidateCorpusIdentity: "e".repeat(64),
        previousCorpusIdentity: "b".repeat(64),
        intervalTrainingCorpusIdentity: "c".repeat(64),
        qualificationProtocolText: "test",
        qualificationProtocolChecksum: "d".repeat(64),
      },
    });
    const route = createRosDefinitionAwareReadiness({ ...deps, releaseRail: "marginal-v8" });
    expect(await route(2026, signal(), espn)).toEqual({
      requestIdentity: rosSharedCorpusRequest(2026, "espn-2019-v1").identity,
      corpusIdentity: "e".repeat(64),
    });
    expect(deps.marginal).toHaveBeenCalledWith(2026, expect.any(AbortSignal), espn);
    expect(deps.ensure).not.toHaveBeenCalled();
    expect(deps.ready).not.toHaveBeenCalled();
  });
});
