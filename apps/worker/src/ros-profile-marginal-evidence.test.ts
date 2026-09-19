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
  type RosMarginalCorpusBundle,
} from "./ros-profile-marginal-evidence.js";
import type { RosProfileValidationRunInput } from "./ros-profile-validation-runner.js";
import { assertRosCacheHeadroom, RosCacheDiskSpaceError } from "./ros-cache-disk-space.js";
import { ROS_HISTORICAL_ACTUAL_DEFINITION_VERSION } from "./ros-historical-corpus.js";

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
