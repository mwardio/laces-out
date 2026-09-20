import type * as MarginalBundleModule from "./ros-marginal-corpus-bundle.js";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectionScoringProfileKey, rosScoringProfile } from "@laces-out/projections";
import {
  createRosDefinitionAwareReadiness,
  createRosDefinitionAwareMarginalResolver,
  createRosDefinitionAwareMarginalValidationRunner,
  rosCorpusDemandGroups,
  type RosDerivedProfileEvidenceProvider,
  type RosProfileMarginalCorpusResolver,
} from "./ros-corpus-routing.js";
import { rosSharedCorpusRequest } from "./ros-shared-corpus-runner.js";
import { createRosMarginalCorpusBundleResolver } from "./ros-marginal-corpus-bundle.js";
import { rosDerivedProductionRoleIdentity } from "./ros-derived-production-package.js";
import type { RosMarginalCorpusBundle } from "./ros-profile-marginal-evidence.js";
import { ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION } from "./ros-historical-corpus.js";

vi.mock("./ros-marginal-corpus-bundle.js", async (original) => ({
  ...(await original<typeof MarginalBundleModule>()),
  createRosMarginalCorpusBundleResolver: vi.fn(),
}));
vi.mock("./ros-cache-disk-space.js", () => ({ assertRosCacheHeadroom: vi.fn(async () => {}) }));

const temporaryDirectories: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const protocol = "# Frozen routing protocol\n";
const marginalBundle: RosMarginalCorpusBundle = {
  version: "ros-marginal-corpus-bundle-v1",
  forecastSeason: 2026,
  candidateCorpusIdentity: "a".repeat(64),
  previousCorpusIdentity: "b".repeat(64),
  intervalTrainingCorpusIdentity: "c".repeat(64),
  qualificationProtocolText: protocol,
  qualificationProtocolChecksum: hash(protocol),
};
const nativeResolve = vi.fn(async () => marginalBundle);
beforeEach(() => {
  vi.clearAllMocks();
  nativeResolve.mockResolvedValue(marginalBundle);
  vi.mocked(createRosMarginalCorpusBundleResolver).mockReturnValue(nativeResolve);
});
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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

async function pinnedRouteFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "ros-corpus-routing-"));
  temporaryDirectories.push(directory);
  await mkdir(path.join(directory, "marginal-bundles"));
  async function put(value: unknown) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const checksum = hash(text);
    await writeFile(path.join(directory, "marginal-bundles", `${checksum}.json`), text);
    return checksum;
  }
  // Routing selects an envelope version only. The injected provider owns full package validation.
  const derivedChecksum = await put({ version: "ros-derived-production-package-v1" });
  const nativeChecksum = await put({ format: "laces-ros-marginal-ready-bundle-v1" });
  const bundle = {
    ...marginalBundle,
    candidateCorpusIdentity: rosDerivedProductionRoleIdentity(derivedChecksum, "candidate"),
    previousCorpusIdentity: rosDerivedProductionRoleIdentity(derivedChecksum, "retained-v12"),
  };
  const resolveCorpora = vi.fn(async () => ({
    bundle,
    pointsAllowedDefinition: "yahoo-2022-v1" as const,
  }));
  const derivedEvidenceProvider = vi.fn<RosDerivedProfileEvidenceProvider>(async () => {
    throw new Error("Dynamic report test stop");
  });
  const derivedProviderFactory = vi.fn(() => ({ resolveCorpora, derivedEvidenceProvider }));
  return {
    directory,
    put,
    derivedChecksum,
    nativeChecksum,
    bundle,
    resolveCorpora,
    derivedEvidenceProvider,
    derivedProviderFactory,
  };
}

describe("pinned native and derived runtime routes", () => {
  it("uses the same stable readiness identity for new exact-scoring profiles without running replay", async () => {
    const test = await pinnedRouteFixture();
    const marginal = createRosDefinitionAwareMarginalResolver({
      directory: test.directory,
      bundleChecksums: { "yahoo-2022-v1": test.derivedChecksum },
      derivedProviderFactory: test.derivedProviderFactory,
    });
    const deps = fixture();
    const ready = createRosDefinitionAwareReadiness({
      ...deps,
      marginal,
      releaseRail: "marginal-v8",
    });
    const newProfile = projectionScoringProfileKey({
      id: "new league",
      rules: [
        { statId: "receptions", points: 0.73 },
        { statId: "points_allowed_0_probability", points: 15, statDefinition: "yahoo-2022-v1" },
      ],
    });
    expect((await ready(2026, signal(), yahoo)).corpusIdentity).toBe(
      test.bundle.candidateCorpusIdentity,
    );
    expect((await ready(2026, signal(), newProfile)).corpusIdentity).toBe(
      test.bundle.candidateCorpusIdentity,
    );
    expect(test.resolveCorpora).toHaveBeenLastCalledWith(2026, expect.any(AbortSignal), newProfile);
    expect(test.derivedProviderFactory).toHaveBeenCalledExactlyOnceWith(
      "yahoo-2022-v1",
      test.derivedChecksum,
    );
    expect(test.derivedEvidenceProvider).not.toHaveBeenCalled();
    expect(nativeResolve).not.toHaveBeenCalled();
    expect(deps.ensure).not.toHaveBeenCalled();
  });

  it("preserves explicit native routes and sends derived profiles only to the dynamic provider", async () => {
    const test = await pinnedRouteFixture();
    const marginal = createRosDefinitionAwareMarginalResolver({
      directory: test.directory,
      bundleChecksums: {
        "yahoo-2022-v1": test.derivedChecksum,
        "espn-2019-v1": test.nativeChecksum,
      },
      derivedProviderFactory: test.derivedProviderFactory,
    });
    expect((await marginal(2026, signal(), espn)).derivedEvidenceProvider).toBeUndefined();
    expect(nativeResolve).toHaveBeenCalledOnce();
    nativeResolve.mockClear();
    const reportRunner = vi.fn(async () => {
      throw new Error("Unexpected native report replay");
    });
    const runner = createRosDefinitionAwareMarginalValidationRunner({
      resolveSelection: marginal,
      reportDirectory: path.join(test.directory, "reports"),
      reportRunner,
    });
    const input = {
      scoringProfileKey: yahoo,
      season: 2026,
      signal: signal(),
      requiredReadyCorpusIdentity: test.bundle.candidateCorpusIdentity,
    };
    await expect(runner(input)).rejects.toThrow("Dynamic report test stop");
    expect(test.derivedEvidenceProvider).toHaveBeenCalledExactlyOnceWith(input, test.bundle);
    expect(reportRunner).not.toHaveBeenCalled();
    expect(nativeResolve).not.toHaveBeenCalled();
    await expect(readdir(path.join(test.directory, "reports"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("still replays and archives an explicitly native bundle", async () => {
    const test = await pinnedRouteFixture();
    const resolveSelection = createRosDefinitionAwareMarginalResolver({
      directory: test.directory,
      bundleChecksums: { "yahoo-2022-v1": test.nativeChecksum },
    });
    const reportRunner = vi.fn(
      async (input: { replayCorpusIdentity?: string; scoringProfileKey: string }) => {
        const report = {
          actualDefinitionVersion: ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION,
          pointsAllowedDefinition: "yahoo-2022-v1",
          outcomeCorpusIdentity: input.replayCorpusIdentity,
          identityAudit: { scoringProfileKey: input.scoringProfileKey },
          diagnostics: {},
        };
        const reportJson = JSON.stringify(report);
        return { report, reportJson, reportChecksum: hash(reportJson) };
      },
    );
    const reportDirectory = path.join(test.directory, "reports");
    const runner = createRosDefinitionAwareMarginalValidationRunner({
      resolveSelection,
      reportDirectory,
      reportRunner,
    });
    const evidence = await runner({
      scoringProfileKey: yahoo,
      season: 2026,
      signal: signal(),
      requiredReadyCorpusIdentity: marginalBundle.candidateCorpusIdentity,
    });
    expect(evidence.derivedEvaluation).toBeUndefined();
    expect(reportRunner).toHaveBeenCalledTimes(3);
    expect(await readdir(reportDirectory)).toHaveLength(3);
  });

  it.each(["missing", "corrupt", "symlink", "oversized", "unknown", "ambiguous"] as const)(
    "rejects a %s configured envelope without native fallback or provider execution",
    async (failure) => {
      const test = await pinnedRouteFixture();
      let checksum = test.derivedChecksum;
      const filename = path.join(test.directory, "marginal-bundles", `${checksum}.json`);
      if (failure === "missing") await rm(filename);
      if (failure === "corrupt") await writeFile(filename, "changed");
      if (failure === "symlink") {
        await rm(filename);
        const target = path.join(test.directory, "symlink-target.json");
        await writeFile(target, JSON.stringify({ version: "ros-derived-production-package-v1" }));
        await symlink(target, filename);
      }
      if (failure === "oversized") checksum = await test.put(" ".repeat(2 * 1024 * 1024 + 1));
      if (failure === "unknown") checksum = await test.put({ version: "future-derived-version" });
      if (failure === "ambiguous")
        checksum = await test.put({
          version: "ros-derived-production-package-v1",
          format: "laces-ros-marginal-ready-bundle-v1",
        });
      const resolve = createRosDefinitionAwareMarginalResolver({
        directory: test.directory,
        bundleChecksums: { "yahoo-2022-v1": checksum },
        derivedProviderFactory: test.derivedProviderFactory,
      });
      await expect(resolve(2026, signal(), yahoo)).rejects.toMatchObject({
        diagnostic: { dependency: "bundle" },
      });
      expect(nativeResolve).not.toHaveBeenCalled();
      expect(test.derivedProviderFactory).not.toHaveBeenCalled();
    },
  );

  it("requires a derived provider and does not downgrade failed dependency authentication", async () => {
    const test = await pinnedRouteFixture();
    const options = {
      directory: test.directory,
      bundleChecksums: { "yahoo-2022-v1": test.derivedChecksum },
    };
    await expect(
      createRosDefinitionAwareMarginalResolver(options)(2026, signal(), yahoo),
    ).rejects.toMatchObject({ diagnostic: { dependency: "bundle", reason: "incompatible" } });
    test.resolveCorpora.mockRejectedValueOnce(new Error("Original vector proof missing"));
    const resolve = createRosDefinitionAwareMarginalResolver({
      ...options,
      derivedProviderFactory: test.derivedProviderFactory,
    });
    await expect(resolve(2026, signal(), yahoo)).rejects.toThrow("Original vector proof missing");
    expect(nativeResolve).not.toHaveBeenCalled();
    expect(test.derivedEvidenceProvider).not.toHaveBeenCalled();
  });

  it("rejects crossed definition/role/season identities and stale recovery readiness before replay", async () => {
    const test = await pinnedRouteFixture();
    const resolve = createRosDefinitionAwareMarginalResolver({
      directory: test.directory,
      bundleChecksums: { "yahoo-2022-v1": test.derivedChecksum },
      derivedProviderFactory: test.derivedProviderFactory,
    });
    test.resolveCorpora.mockResolvedValueOnce({
      bundle: { ...test.bundle, candidateCorpusIdentity: "f".repeat(64) },
      pointsAllowedDefinition: "yahoo-2022-v1",
    });
    await expect(resolve(2026, signal(), yahoo)).rejects.toMatchObject({
      diagnostic: { reason: "incompatible" },
    });
    await expect(resolve(2027, signal(), yahoo)).rejects.toMatchObject({
      diagnostic: { reason: "incompatible" },
    });
    const reportRunner = vi.fn(async () => {
      throw new Error("Unexpected native replay");
    });
    const runner = createRosDefinitionAwareMarginalValidationRunner({
      resolveSelection: resolve,
      reportDirectory: path.join(test.directory, "reports"),
      reportRunner,
    });
    await expect(
      runner({
        season: 2026,
        scoringProfileKey: yahoo,
        signal: signal(),
        requiredReadyCorpusIdentity: "e".repeat(64),
      }),
    ).rejects.toThrow(/dependencies/);
    expect(test.derivedEvidenceProvider).not.toHaveBeenCalled();
    expect(reportRunner).not.toHaveBeenCalled();
  });

  it("checks cancellation and snapshots configured pins instead of accepting later configuration mutation", async () => {
    const test = await pinnedRouteFixture();
    const pins = { "yahoo-2022-v1": test.derivedChecksum };
    const resolve = createRosDefinitionAwareMarginalResolver({
      directory: test.directory,
      bundleChecksums: pins,
      derivedProviderFactory: test.derivedProviderFactory,
    });
    pins["yahoo-2022-v1"] = test.nativeChecksum;
    expect((await resolve(2026, signal(), yahoo)).bundle.candidateCorpusIdentity).toBe(
      test.bundle.candidateCorpusIdentity,
    );
    const controller = new AbortController();
    controller.abort();
    test.resolveCorpora.mockClear();
    await expect(resolve(2026, controller.signal, yahoo)).rejects.toThrow();
    expect(test.resolveCorpora).not.toHaveBeenCalled();
    expect(nativeResolve).not.toHaveBeenCalled();
  });
});
