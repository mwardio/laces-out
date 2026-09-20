import type * as RosCacheDiskSpaceModule from "./ros-cache-disk-space.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectionScoringProfileKey, rosScoringProfile } from "@laces-out/projections";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRosMarginalProfileValidationRunner,
  assertRosMarginalProfileEvidenceIdentity,
  ROS_MARGINAL_CORPUS_BUNDLE_VERSION,
  type RosDerivedMarginalProfileReports,
  type RosMarginalCorpusBundle,
} from "./ros-profile-marginal-evidence.js";
import type { RosProfileValidationRunInput } from "./ros-profile-validation-runner.js";
import { assertRosCacheHeadroom, RosCacheDiskSpaceError } from "./ros-cache-disk-space.js";
import { ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION } from "./ros-historical-corpus.js";
import {
  rosDerivedEvaluationFixture,
  rosDerivedProductionEvaluationFixture,
} from "./ros-derived-evaluation.test-fixtures.js";

vi.mock("./ros-cache-disk-space.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RosCacheDiskSpaceModule>()),
  // Transport fixtures are a few KB; their behavior must not depend on the CI tmpfs capacity.
  assertRosCacheHeadroom: vi.fn(async () => {}),
}));

const directories: string[] = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const scoring = rosScoringProfile("full-ppr");
const protocol = "# Frozen qualification protocol\n";
const bundle: RosMarginalCorpusBundle = {
  version: ROS_MARGINAL_CORPUS_BUNDLE_VERSION,
  forecastSeason: 2026,
  candidateCorpusIdentity: "a".repeat(64),
  previousCorpusIdentity: "b".repeat(64),
  intervalTrainingCorpusIdentity: "c".repeat(64),
  qualificationProtocolText: protocol,
  qualificationProtocolChecksum: hash(protocol),
};
afterEach(async () => {
  vi.mocked(assertRosCacheHeadroom).mockReset();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
function response(input: RosProfileValidationRunInput) {
  const report = {
    actualDefinitionVersion: ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION,
    pointsAllowedDefinition: "yahoo-2022-v1",
    outcomeCorpusIdentity: input.replayCorpusIdentity,
    identityAudit: { scoringProfileKey: input.scoringProfileKey },
    diagnostics: { replayModel: input.replayModel, replayScope: input.replayScope },
  };
  const reportJson = ` \n${JSON.stringify(report)}\n`;
  return { report, reportJson, reportChecksum: hash(reportJson) };
}
async function setup(overrides: Partial<RosMarginalCorpusBundle> = {}) {
  const reportDirectory = await mkdtemp(path.join(tmpdir(), "ros-marginal-evidence-"));
  directories.push(reportDirectory);
  const reportRunner = vi.fn(async (input: RosProfileValidationRunInput) => response(input));
  const resolveCorpora = vi.fn(async () => ({ ...bundle, ...overrides }));
  const runner = createRosMarginalProfileValidationRunner({
    reportDirectory,
    reportRunner,
    resolveCorpora,
  });
  const input: RosProfileValidationRunInput = {
    scoringProfileKey: scoring.scoringProfileKey,
    season: 2026,
    requiredReadyCorpusIdentity: bundle.candidateCorpusIdentity,
    signal: new AbortController().signal,
  };
  return { reportDirectory, reportRunner, resolveCorpora, runner, input };
}

describe("paired cache-only marginal profile evidence", () => {
  it.each([
    { actualDefinitionVersion: "complete-player-ledger-actuals-v1" },
    { correctedComparison: { manifestIdentity: "f".repeat(64) } },
  ])(
    "does not treat an unauthenticated corrected report marker as native evidence: %j",
    async (extra) => {
      const test = await setup();
      test.reportRunner.mockImplementationOnce(async (input) => {
        const value = response(input);
        const reportJson = JSON.stringify({ ...value.report, ...extra });
        return { ...value, reportJson, reportChecksum: hash(reportJson) };
      });
      await expect(test.runner(test.input)).rejects.toThrow(/current actual definition/);
      expect(await readdir(test.reportDirectory)).toEqual([]);
    },
  );

  it.each([undefined, "unknown", "espn-2019-v1"])(
    "rejects captured PA metadata %s even when the runner object claims valid metadata",
    async (pointsAllowedDefinition) => {
      const test = await setup();
      test.reportRunner.mockImplementationOnce(async (input) => {
        const value = response(input);
        const report = { ...value.report, pointsAllowedDefinition };
        const reportJson = JSON.stringify(report);
        return { ...value, reportJson, reportChecksum: hash(reportJson) };
      });
      await expect(test.runner(test.input)).rejects.toThrow(/points-allowed definition/);
      expect(test.reportRunner).toHaveBeenCalledOnce();
      expect(await readdir(test.reportDirectory)).toEqual([]);
    },
  );

  it("rechecks persisted PA binding and retains every existing archived report byte", async () => {
    const test = await setup();
    const evidence = await test.runner(test.input);
    const report = {
      ...response({ ...test.input, replayCorpusIdentity: bundle.previousCorpusIdentity }).report,
      pointsAllowedDefinition: "espn-2019-v1",
    };
    const reportJson = JSON.stringify(report),
      reportChecksum = hash(reportJson);
    const file = path.join(test.reportDirectory, `${reportChecksum}.json`);
    await writeFile(file, reportJson);
    expect(() =>
      assertRosMarginalProfileEvidenceIdentity(
        {
          ...evidence,
          previousReportJson: reportJson,
          previousReportChecksum: reportChecksum,
          provenance: { ...evidence.provenance, previousReportChecksum: reportChecksum },
        },
        test.input,
      ),
    ).toThrow(/points-allowed definition/);
    expect(await readFile(file, "utf8")).toBe(reportJson);
  });

  it("requires paired report definitions to agree even when the profile prices no PA", async () => {
    const test = await setup();
    const input = {
      ...test.input,
      scoringProfileKey: projectionScoringProfileKey({
        id: "WR",
        rules: [{ statId: "receptions", points: 1 }],
      }),
    };
    const evidence = await test.runner(input);
    const report = {
      ...response({ ...input, replayCorpusIdentity: bundle.previousCorpusIdentity }).report,
      pointsAllowedDefinition: "espn-2019-v1",
    };
    const reportJson = JSON.stringify(report),
      reportChecksum = hash(reportJson);
    expect(() =>
      assertRosMarginalProfileEvidenceIdentity(
        {
          ...evidence,
          previousReportJson: reportJson,
          previousReportChecksum: reportChecksum,
          provenance: { ...evidence.provenance, previousReportChecksum: reportChecksum },
        },
        input,
      ),
    ).toThrow(/disagree on points-allowed/);
    test.reportRunner.mockClear();
    test.reportRunner.mockImplementation(async (job) => {
      const value = response(job);
      const reportJson = JSON.stringify({
        ...value.report,
        pointsAllowedDefinition:
          job.replayModel === "retained-v12" ? "espn-2019-v1" : "yahoo-2022-v1",
      });
      return { ...value, reportJson, reportChecksum: hash(reportJson) };
    });
    await expect(test.runner(input)).rejects.toThrow(/disagree on points-allowed/);
    expect(test.reportRunner).toHaveBeenCalledTimes(2);
  });

  it("rejects legacy unspecified active PA profiles before resolving any dependency", async () => {
    const test = await setup();
    await expect(
      test.runner({
        ...test.input,
        scoringProfileKey: projectionScoringProfileKey({
          id: "legacy",
          rules: [{ statId: "points_allowed", points: -1 }],
        }),
      }),
    ).rejects.toThrow(/explicit definition/);
    expect(test.resolveCorpora).not.toHaveBeenCalled();
    expect(test.reportRunner).not.toHaveBeenCalled();
  });

  it("rejects unversioned live and persisted report bytes without changing archived evidence", async () => {
    const test = await setup();
    const evidence = await test.runner(test.input);
    const legacyReport = Object.fromEntries(
      Object.entries(
        response({ ...test.input, replayCorpusIdentity: bundle.previousCorpusIdentity }).report,
      ).filter(([key]) => key !== "actualDefinitionVersion"),
    );
    const reportJson = JSON.stringify(legacyReport);
    const reportChecksum = hash(reportJson);
    const file = path.join(test.reportDirectory, `${reportChecksum}.json`);
    await writeFile(file, reportJson);
    expect(() =>
      assertRosMarginalProfileEvidenceIdentity(
        {
          ...evidence,
          previousReportJson: reportJson,
          previousReportChecksum: reportChecksum,
          provenance: { ...evidence.provenance, previousReportChecksum: reportChecksum },
        },
        test.input,
      ),
    ).toThrow(/current actual definition/);
    test.reportRunner.mockImplementationOnce(async (input) => {
      const responseValue = response(input);
      const legacy = Object.fromEntries(
        Object.entries(responseValue.report).filter(([key]) => key !== "actualDefinitionVersion"),
      );
      const reportJson = JSON.stringify(legacy);
      return { ...responseValue, reportJson, reportChecksum: hash(reportJson) };
    });
    await expect(test.runner(test.input)).rejects.toThrow(/current actual definition/);
    expect(await readFile(file, "utf8")).toBe(reportJson);
  });

  it("stops without archiving or starting the next cohort when the disk reserve is unavailable", async () => {
    const test = await setup();
    vi.mocked(assertRosCacheHeadroom).mockRejectedValueOnce(
      new RosCacheDiskSpaceError("insufficient_disk_space"),
    );
    await expect(test.runner(test.input)).rejects.toThrow(/preserve disk headroom/);
    expect(test.reportRunner).toHaveBeenCalledTimes(1);
    expect(await readdir(test.reportDirectory)).toEqual([]);
  });
  it("replays each pinned physical cohort once under identical exact scoring and archives original bytes", async () => {
    const test = await setup();
    const result = await test.runner(test.input);
    expect(
      test.reportRunner.mock.calls.map(([input]) => [
        input.replayModel,
        input.replayScope,
        input.replayCorpusIdentity,
      ]),
    ).toEqual([
      ["current", "audit", bundle.candidateCorpusIdentity],
      ["retained-v12", "audit", bundle.previousCorpusIdentity],
      ["current", "full-defense-training", bundle.intervalTrainingCorpusIdentity],
    ]);
    expect(
      test.reportRunner.mock.calls.every(
        ([input]) =>
          input.scoringProfileKey === scoring.scoringProfileKey &&
          input.requiredReadyCorpusIdentity === input.replayCorpusIdentity,
      ),
    ).toBe(true);
    for (const [checksum, json] of [
      [result.candidateReportChecksum, result.candidateReportJson],
      [result.previousReportChecksum, result.previousReportJson],
      [result.intervalTrainingReportChecksum!, result.intervalTrainingReportJson!],
    ])
      expect(await readFile(path.join(test.reportDirectory, `${checksum}.json`), "utf8")).toBe(
        json,
      );
    expect(await readdir(test.reportDirectory)).toHaveLength(3);
    expect(await test.runner(test.input)).toEqual(result);
    expect(await readdir(test.reportDirectory)).toHaveLength(3);
  });

  it.each([
    { forecastSeason: 2025 },
    { candidateCorpusIdentity: "d".repeat(64) },
    { previousCorpusIdentity: bundle.candidateCorpusIdentity },
    { intervalTrainingCorpusIdentity: bundle.previousCorpusIdentity },
    { qualificationProtocolText: `${protocol}changed` },
    { previousCorpusIdentity: "../outside" },
    { extra: "unrecognized" },
  ])(
    "rejects inconsistent or incomplete shared dependencies before any replay: %j",
    async (overrides) => {
      const test = await setup(overrides);
      await expect(test.runner(test.input)).rejects.toThrow(/dependencies/);
      expect(test.reportRunner).not.toHaveBeenCalled();
      expect(await readdir(test.reportDirectory)).toEqual([]);
    },
  );

  it("never falls back to an unpinned physical build when prior replay fails", async () => {
    const test = await setup();
    test.reportRunner.mockImplementation(async (input) => {
      if (input.replayModel === "retained-v12") throw new Error("Retained vector missing");
      return response(input);
    });
    await expect(test.runner(test.input)).rejects.toThrow("Retained vector missing");
    expect(test.reportRunner).toHaveBeenCalledTimes(2);
    expect(await readdir(test.reportDirectory)).toHaveLength(1);
  });

  it("checks the raw report rather than trusting a separately supplied parsed object", async () => {
    const test = await setup();
    test.reportRunner.mockImplementation(async (input) => {
      const result = response(input);
      const reportJson = result.reportJson.replace(input.replayCorpusIdentity!, "e".repeat(64));
      return { ...result, reportJson, reportChecksum: hash(reportJson) };
    });
    await expect(test.runner(test.input)).rejects.toThrow(/pinned corpus/);
    expect(await readdir(test.reportDirectory)).toEqual([]);
  });

  it("rejects changed byte pins and missing diagnostic payloads", async () => {
    const test = await setup();
    test.reportRunner.mockImplementationOnce(async (input) => ({
      ...response(input),
      reportChecksum: "0".repeat(64),
    }));
    await expect(test.runner(test.input)).rejects.toThrow(/byte pin/);
    test.reportRunner.mockImplementationOnce(async (input) => {
      const result = response(input);
      const report: Record<string, unknown> = { ...result.report };
      delete report.diagnostics;
      const reportJson = JSON.stringify(report);
      return { ...result, reportJson, reportChecksum: hash(reportJson) };
    });
    await expect(test.runner(test.input)).rejects.toThrow(/diagnostics/);
  });

  it("preserves conflicting archived evidence without overwriting it", async () => {
    const test = await setup();
    const result = response({
      ...test.input,
      replayCorpusIdentity: bundle.candidateCorpusIdentity,
      replayModel: "current",
      replayScope: "audit",
    });
    const file = path.join(test.reportDirectory, `${result.reportChecksum}.json`);
    await writeFile(file, "corrupt");
    await expect(test.runner(test.input)).rejects.toThrow(/conflicts/);
    expect(await readFile(file, "utf8")).toBe("corrupt");
    expect(await readdir(test.reportDirectory)).toEqual([path.basename(file)]);
  });

  it("honors cancellation between cohorts", async () => {
    const test = await setup();
    const abort = new AbortController();
    test.reportRunner.mockImplementationOnce(async (input) => {
      abort.abort();
      return response(input);
    });
    await expect(test.runner({ ...test.input, signal: abort.signal })).rejects.toThrow();
    expect(test.reportRunner).toHaveBeenCalledTimes(1);
    expect(await readdir(test.reportDirectory)).toEqual([]);
  });
});

async function derivedSetup(production = false) {
  const productionFixture = production ? rosDerivedProductionEvaluationFixture() : null;
  if (productionFixture !== null) {
    const logicalPath = productionFixture.productionPackage.dependencies.qualificationProtocol;
    Object.assign(productionFixture.productionPackage.files[logicalPath]!, {
      sha256: hash(protocol),
      filename: `${hash(protocol)}.txt`,
      encoding: "utf8-text",
    });
  }
  const fixture = productionFixture ?? rosDerivedEvaluationFixture();
  const { input: derivedEvaluation, ...pinned } = fixture.repin();
  const reports: RosDerivedMarginalProfileReports = { ...pinned, derivedEvaluation };
  const dependencies: RosMarginalCorpusBundle = {
    ...bundle,
    candidateCorpusIdentity: String(fixture.candidate.outcomeCorpusIdentity),
    previousCorpusIdentity: String(fixture.previous.outcomeCorpusIdentity),
    intervalTrainingCorpusIdentity: String(fixture.training.outcomeCorpusIdentity),
  };
  const reportDirectory = await mkdtemp(path.join(tmpdir(), "ros-derived-marginal-evidence-"));
  directories.push(reportDirectory);
  const input: RosProfileValidationRunInput = {
    scoringProfileKey: fixture.candidate.identityAudit.scoringProfileKey,
    season: 2026,
    requiredReadyCorpusIdentity: dependencies.candidateCorpusIdentity,
    signal: new AbortController().signal,
  };
  const reportRunner = vi.fn(async (job: RosProfileValidationRunInput) => response(job));
  const derivedEvidenceProvider = vi.fn(async () => reports);
  const resolveCorpora = vi.fn(async () => dependencies);
  const runner = createRosMarginalProfileValidationRunner({
    reportDirectory,
    reportRunner,
    resolveCorpora,
    derivedEvidenceProvider,
  });
  return {
    fixture,
    reports,
    dependencies,
    input,
    reportDirectory,
    reportRunner,
    derivedEvidenceProvider,
    resolveCorpora,
    runner,
  };
}

describe("authenticated derived marginal evidence", () => {
  it("archives the stable production package and binds its ready identities and frozen protocol", async () => {
    const test = await derivedSetup(true);
    const evidence = await test.runner(test.input);
    expect(evidence.provenance.derivedEvaluation).toMatchObject({
      productionIdentityVersion: "ros-derived-production-role-v1",
      productionPackageIdentity: test.reports.derivedEvaluation.productionPackageChecksum,
      productionQualificationProtocolChecksum: hash(protocol),
    });
    expect(evidence.provenance.candidateCorpusIdentity).toBe(
      test.input.requiredReadyCorpusIdentity,
    );
    expect(evidence.provenance.candidateCorpusIdentity).not.toBe(
      String(test.fixture.originalCandidate.outcomeCorpusIdentity),
    );
    expect(() => assertRosMarginalProfileEvidenceIdentity(evidence, test.input)).not.toThrow();
    expect(await readdir(test.reportDirectory)).toHaveLength(7);
    expect(
      await readFile(
        path.join(
          test.reportDirectory,
          `${test.reports.derivedEvaluation.productionPackageChecksum}.json`,
        ),
        "utf8",
      ),
    ).toBe(test.reports.derivedEvaluation.productionPackageJson);
    expect(Object.isFrozen(evidence.derivedEvaluation)).toBe(true);
    const changedProtocol = `${protocol}different protocol\n`;
    test.resolveCorpora.mockResolvedValueOnce({
      ...test.dependencies,
      qualificationProtocolText: changedProtocol,
      qualificationProtocolChecksum: hash(changedProtocol),
    });
    await expect(test.runner(test.input)).rejects.toThrow(/different qualification protocol/);
    expect(test.reportRunner).not.toHaveBeenCalled();
    expect(await readdir(test.reportDirectory)).toHaveLength(7);
  });

  it("rejects half-pinned or stripped production metadata before archiving or native fallback", async () => {
    const test = await derivedSetup(true);
    const halfPinned = { ...test.reports.derivedEvaluation };
    delete halfPinned.productionPackageChecksum;
    test.derivedEvidenceProvider.mockResolvedValueOnce({
      ...test.reports,
      derivedEvaluation: halfPinned,
    });
    await expect(test.runner(test.input)).rejects.toThrow(/production package/);
    const stripped = { ...test.reports.derivedEvaluation };
    delete stripped.productionPackageJson;
    delete stripped.productionPackageChecksum;
    test.derivedEvidenceProvider.mockResolvedValueOnce({
      ...test.reports,
      derivedEvaluation: stripped,
    });
    await expect(test.runner(test.input)).rejects.toThrow(/derived report identity/);
    expect(test.reportRunner).not.toHaveBeenCalled();
    expect(await readdir(test.reportDirectory)).toEqual([]);
  });

  it("retains the exact originals and manifest with corrected reports and rechecks service provenance", async () => {
    const test = await derivedSetup();
    const evidence = await test.runner(test.input);
    expect(test.derivedEvidenceProvider).toHaveBeenCalledOnce();
    expect(test.reportRunner).not.toHaveBeenCalled();
    expect(evidence.derivedEvaluation).toEqual(test.reports.derivedEvaluation);
    expect(evidence.provenance.derivedEvaluation).toMatchObject({
      comparisonManifestChecksum: test.reports.derivedEvaluation.comparisonManifestChecksum,
      originalPreviousReportChecksum: test.reports.derivedEvaluation.originalPreviousReportChecksum,
      correctedDstPhysicalCorpus: test.dependencies.intervalTrainingCorpusIdentity,
      observedActualDefinitionVersion: "complete-player-ledger-actuals-v1",
    });
    expect(() => assertRosMarginalProfileEvidenceIdentity(evidence, test.input)).not.toThrow();
    const files = [
      [test.reports.candidateReportJson, test.reports.candidateReportChecksum],
      [test.reports.previousReportJson, test.reports.previousReportChecksum],
      [test.reports.intervalTrainingReportJson, test.reports.intervalTrainingReportChecksum],
      [
        test.reports.derivedEvaluation.comparisonManifestJson,
        test.reports.derivedEvaluation.comparisonManifestChecksum,
      ],
      [
        test.reports.derivedEvaluation.originalCandidateReportJson,
        test.reports.derivedEvaluation.originalCandidateReportChecksum,
      ],
      [
        test.reports.derivedEvaluation.originalPreviousReportJson,
        test.reports.derivedEvaluation.originalPreviousReportChecksum,
      ],
    ];
    expect(await readdir(test.reportDirectory)).toHaveLength(6);
    for (const [text, checksum] of files)
      expect(await readFile(path.join(test.reportDirectory, `${checksum}.json`), "utf8")).toBe(
        text,
      );
    expect(() =>
      assertRosMarginalProfileEvidenceIdentity(
        {
          ...evidence,
          provenance: {
            ...evidence.provenance,
            derivedEvaluation: {
              ...evidence.provenance.derivedEvaluation!,
              originalPreviousPhysicalCorpus: "0".repeat(64),
            },
          },
        },
        test.input,
      ),
    ).toThrow(/provenance/);
    const missingDerivedInput = { ...evidence };
    delete missingDerivedInput.derivedEvaluation;
    expect(() => assertRosMarginalProfileEvidenceIdentity(missingDerivedInput, test.input)).toThrow(
      /provenance/,
    );
  });

  it("rejects a changed original byte pin before archiving and never falls back to native replay", async () => {
    const test = await derivedSetup();
    test.derivedEvidenceProvider.mockResolvedValueOnce({
      ...test.reports,
      derivedEvaluation: {
        ...test.reports.derivedEvaluation,
        originalPreviousReportJson: `${test.reports.derivedEvaluation.originalPreviousReportJson} `,
      },
    });
    await expect(test.runner(test.input)).rejects.toThrow(/byte pin/);
    expect(test.reportRunner).not.toHaveBeenCalled();
    expect(await readdir(test.reportDirectory)).toEqual([]);
  });

  it("binds corrected report identity to the ready job, separately from the physical DST training", async () => {
    const test = await derivedSetup();
    test.resolveCorpora.mockResolvedValueOnce({
      ...test.dependencies,
      previousCorpusIdentity: String(test.fixture.originalPrevious.outcomeCorpusIdentity),
    });
    await expect(test.runner(test.input)).rejects.toThrow(/pinned corpus/);
    expect(await readdir(test.reportDirectory)).toEqual([]);
    test.resolveCorpora.mockResolvedValueOnce({
      ...test.dependencies,
      intervalTrainingCorpusIdentity: "d".repeat(64),
    });
    await expect(test.runner(test.input)).rejects.toThrow(/physical lineage/);
    expect(await readdir(test.reportDirectory)).toEqual([]);
    expect(test.reportRunner).not.toHaveBeenCalled();
  });

  it("reserves space for all six artifacts before writing any of them", async () => {
    const test = await derivedSetup();
    vi.mocked(assertRosCacheHeadroom).mockRejectedValueOnce(
      new RosCacheDiskSpaceError("insufficient_disk_space"),
    );
    await expect(test.runner(test.input)).rejects.toThrow(/preserve disk headroom/);
    expect(await readdir(test.reportDirectory)).toEqual([]);
    const firstCheck = vi.mocked(assertRosCacheHeadroom).mock.calls[0]!;
    expect(firstCheck[1]).toBeGreaterThan(Buffer.byteLength(test.reports.candidateReportJson));
    expect(test.reportRunner).not.toHaveBeenCalled();
  });

  it("captures provider strings before asynchronous archiving and preserves prior conflicting files", async () => {
    const test = await derivedSetup();
    const originalPreviousText = test.reports.derivedEvaluation.originalPreviousReportJson;
    vi.mocked(assertRosCacheHeadroom).mockImplementationOnce(async () => {
      Object.assign(test.reports.derivedEvaluation, {
        originalPreviousReportJson: "changed later",
      });
    });
    const evidence = await test.runner(test.input);
    expect(evidence.derivedEvaluation!.originalPreviousReportJson).toBe(originalPreviousText);
    expect(Object.isFrozen(evidence.derivedEvaluation)).toBe(true);
    expect(() => assertRosMarginalProfileEvidenceIdentity(evidence, test.input)).not.toThrow();
    Object.assign(test.reports.derivedEvaluation, {
      originalPreviousReportJson: originalPreviousText,
    });
    const originalFile = path.join(
      test.reportDirectory,
      `${test.reports.derivedEvaluation.originalPreviousReportChecksum}.json`,
    );
    await rm(originalFile);
    await writeFile(originalFile, "existing conflict");
    await expect(test.runner(test.input)).rejects.toThrow(/conflicts/);
    expect(await readFile(originalFile, "utf8")).toBe("existing conflict");
  });

  it("requires training and honors cancellation before validation or archive", async () => {
    const test = await derivedSetup();
    const missingTraining = { ...test.dependencies };
    delete missingTraining.intervalTrainingCorpusIdentity;
    test.resolveCorpora.mockResolvedValueOnce(missingTraining);
    await expect(test.runner(test.input)).rejects.toThrow(/training dependency/);
    expect(test.derivedEvidenceProvider).not.toHaveBeenCalled();
    const controller = new AbortController();
    test.derivedEvidenceProvider.mockImplementationOnce(async () => {
      controller.abort();
      return test.reports;
    });
    await expect(test.runner({ ...test.input, signal: controller.signal })).rejects.toThrow();
    expect(test.reportRunner).not.toHaveBeenCalled();
    expect(await readdir(test.reportDirectory)).toEqual([]);
  });
});

it.each([
  [0, "candidate"],
  [1, "previous"],
  [2, "training"],
] as const)(
  "preserves a closed missing-vector diagnostic for replay %s",
  async (index, dependency) => {
    const test = await setup();
    for (let prior = 0; prior < index; prior++)
      test.reportRunner.mockImplementationOnce(async (input) => response(input));
    test.reportRunner.mockImplementationOnce(async () => {
      const report = { state: "ros-replay-dependency-unavailable-v1", reason: "missing" };
      const reportJson = JSON.stringify(report);
      return {
        report: report as unknown as ReturnType<typeof response>["report"],
        reportJson,
        reportChecksum: hash(reportJson),
      };
    });
    await expect(test.runner(test.input)).rejects.toMatchObject({
      diagnostic: { dependency, reason: "missing" },
    });
    expect(test.reportRunner).toHaveBeenCalledTimes(index + 1);
    expect(await readdir(test.reportDirectory)).toHaveLength(index);
  },
);
