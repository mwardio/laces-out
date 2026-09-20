import { beforeEach, expect, it, vi } from "vitest";
import { projectionScoringProfileKey } from "@laces-out/projections";
import type * as Loader from "./ros-derived-package-loader.js";
import type { VerifiedRosDerivedPackage } from "./ros-derived-package-loader.js";
import type { RosHistoricalCorpus } from "./ros-historical-corpus.js";
import type { RosDerivedPopulationReplayInput } from "./ros-derived-population-replay.js";
import type { buildRosDerivedReplayReport as BuildReport } from "./ros-derived-replay-report.js";
import { createRosDerivedProfileProvider } from "./ros-derived-profile-provider.js";
import { rosDerivedProductionEvaluationFixture } from "./ros-derived-evaluation.test-fixtures.js";
import { validateRosDerivedEvaluation } from "./ros-derived-evaluation.js";

const mocks = vi.hoisted(() => ({ load: vi.fn(), replay: vi.fn(), report: vi.fn() }));
vi.mock("./ros-derived-package-loader.js", async (original) => ({
  ...(await original<typeof Loader>()),
  loadVerifiedRosDerivedPackage: mocks.load,
}));
vi.mock("./ros-derived-population-replay.js", () => ({ replayRosDerivedPopulation: mocks.replay }));
vi.mock("./ros-derived-replay-report.js", () => ({ buildRosDerivedReplayReport: mocks.report }));
beforeEach(() => {
  mocks.load.mockReset();
  mocks.replay.mockReset();
  mocks.report.mockReset();
});
function fixture() {
  const f = rosDerivedProductionEvaluationFixture();
  const pins = f.repin();
  const corpus = (report: typeof f.candidate) =>
    ({
      forecasts: report.diagnostics.candidateForecasts.map((row) => ({
        forecast: row,
        actualGames: row.evidence.availability.actualGames,
        scheduledGames: row.evidence.availability.scheduledGames,
        actualComponents: { points_allowed_0_probability: row.actualPoints },
      })),
      sourceAudit: report.sources,
      coverage: {},
      options: {},
    }) as unknown as RosHistoricalCorpus;
  const verified = {
    packageJson: pins.input.productionPackageJson,
    packageChecksum: pins.input.productionPackageChecksum,
    manifest: f.productionPackage,
    qualificationProtocolText: "qualificationProtocol",
    original: corpus(f.originalPrevious),
    originalCandidate: corpus(f.originalCandidate),
    currentCandidate: corpus(f.candidate),
    training: corpus(f.training),
    originalCache: {
      read: async () => ({ state: "missing" }),
      write: async () => {
        throw new Error("No writes");
      },
    },
    originalCandidateCache: {
      read: async () => ({ state: "missing" }),
      write: async () => {
        throw new Error("No writes");
      },
    },
    currentCandidateCache: {
      read: async () => ({ state: "missing" }),
      write: async () => {
        throw new Error("No writes");
      },
    },
    trainingCache: {
      read: async () => ({ state: "missing" }),
      write: async () => {
        throw new Error("No writes");
      },
    },
    sourceForKey: new Map(),
  } as VerifiedRosDerivedPackage;
  mocks.load.mockResolvedValue(verified);
  const templates = [f.originalCandidate, f.originalPrevious, f.training, f.candidate, f.previous];
  let index = 0;
  mocks.replay.mockImplementation(async (_input: RosDerivedPopulationReplayInput) => {
    void _input;
    const template = structuredClone(templates[index++]!);
    return {
      result: {
        heldOutSeasons: [{ season: 2022, forecasts: template.diagnostics.candidateForecasts }],
        template,
      },
      bindings: structuredClone(f.manifest.convergenceBindings),
    };
  });
  mocks.report.mockImplementation((input: Parameters<typeof BuildReport>[0]) => ({
    ...(input.result as unknown as { template: Record<string, unknown> }).template,
    outcomeCorpusIdentity: input.outcomeCorpusIdentity,
  }));
  const options = {
    directory: "/explicit/artifacts",
    packageChecksums: { "yahoo-2022-v1": pins.input.productionPackageChecksum },
    sourceRoots: {
      "original-v12": "/explicit/v12",
      "native-dst-v13": "/explicit/old-native",
      "expanded-dst-v13": { "yahoo-2022-v1": "/explicit/current-native" },
    },
  };
  return {
    f,
    pins,
    verified,
    options,
    provider: createRosDerivedProfileProvider(options),
    signal: new AbortController().signal,
  };
}
it("assembles dynamic five-population evidence through the real complete 3264/2176 report-lineage validator", async () => {
  const test = fixture(),
    key = test.f.candidate.identityAudit.scoringProfileKey;
  const ready = await test.provider.resolveCorpora(2026, test.signal, key);
  const result = await test.provider.derivedEvidenceProvider(
    {
      season: 2026,
      signal: test.signal,
      scoringProfileKey: key,
      requiredReadyCorpusIdentity: ready.bundle.candidateCorpusIdentity,
    },
    ready.bundle,
  );
  const validated = validateRosDerivedEvaluation({ input: result.derivedEvaluation, ...result });
  expect(validated.lineage.productionPackageChecksum).toBe(
    test.pins.input.productionPackageChecksum,
  );
  expect(mocks.replay).toHaveBeenCalledTimes(5);
  const calls = mocks.replay.mock.calls.map((call) => call[0] as RosDerivedPopulationReplayInput);
  expect(calls.map((input) => input.originalDstObservedSemantics)).toEqual([
    "archived-missing-components-as-zero",
    "archived-missing-components-as-zero",
    undefined,
    undefined,
    undefined,
  ]);
  expect(calls.map((input) => input.retainedV12 ?? false)).toEqual([
    false,
    true,
    false,
    false,
    true,
  ]);
  expect(calls[4]!.corpus.forecasts[0]!.actualComponents).toEqual(
    test.verified.currentCandidate.forecasts[0]!.actualComponents,
  );
  expect(calls.every((input) => input.scoreMemo === calls[0]!.scoreMemo)).toBe(true);
  expect(mocks.load).toHaveBeenCalledTimes(1);
});
it("resolves the same scoring-independent package role for arbitrary unseen supported numeric profiles", async () => {
  const test = fixture();
  const profiles = [0.137, 0.819].map((points) =>
    projectionScoringProfileKey({ id: "unlisted", rules: [{ statId: "receptions", points }] }),
  );
  const [a, b] = await Promise.all(
    profiles.map((key) => test.provider.resolveCorpora(2026, test.signal, key)),
  );
  expect(a).toEqual(b);
  expect(mocks.load).toHaveBeenCalledTimes(1);
  expect(mocks.replay).not.toHaveBeenCalled();
  const mismatch = projectionScoringProfileKey({
    id: "other-PA",
    rules: [{ statId: "points_allowed_0_probability", points: 7, statDefinition: "espn-2019-v1" }],
  });
  await expect(test.provider.resolveCorpora(2026, test.signal, mismatch)).rejects.toThrow(
    /dependency/,
  );
});
it("fails closed on wrong ready identity, source pins, unsupported season and abort without replay fallback", async () => {
  const test = fixture(),
    key = test.f.candidate.identityAudit.scoringProfileKey;
  const ready = await test.provider.resolveCorpora(2026, test.signal, key);
  await expect(
    test.provider.derivedEvidenceProvider(
      {
        season: 2026,
        signal: test.signal,
        scoringProfileKey: key,
        requiredReadyCorpusIdentity: "a".repeat(64),
      },
      ready.bundle,
    ),
  ).rejects.toThrow(/ready package/);
  await expect(test.provider.resolveCorpora(2027, test.signal, key)).rejects.toThrow(/dependency/);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(test.provider.resolveCorpora(2026, controller.signal, key)).rejects.toThrow(
    "cancelled",
  );
  mocks.load.mockRejectedValue(new Error("corrupt artifact"));
  await expect(
    createRosDerivedProfileProvider(test.options).resolveCorpora(2026, test.signal, key),
  ).rejects.toThrow(/dependency/);
  expect(mocks.replay).not.toHaveBeenCalled();
});

it("defers unavailable retained physical evidence as a retriable dependency instead of rejecting league settings", async () => {
  const test = fixture(),
    scoringProfileKey = test.f.candidate.identityAudit.scoringProfileKey;
  const { bundle } = await test.provider.resolveCorpora(2026, test.signal, scoringProfileKey);
  mocks.replay.mockRejectedValue(
    Object.assign(new Error("removed physical vector"), { code: "ENOENT" }),
  );
  await expect(
    test.provider.derivedEvidenceProvider(
      {
        season: 2026,
        signal: test.signal,
        scoringProfileKey,
        requiredReadyCorpusIdentity: bundle.candidateCorpusIdentity,
      },
      bundle,
    ),
  ).rejects.toMatchObject({ diagnostic: { dependency: "candidate", reason: "missing" } });
});
