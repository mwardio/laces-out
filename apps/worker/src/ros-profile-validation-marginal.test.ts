import { beforeAll, describe, expect, it, vi } from "vitest";
import { firstPartyRosReleaseIdentity } from "@laces-out/projections";
import { firstPartyRosChampionArtifactIsValid } from "./first-party-ros-publication.js";
import { fullReport } from "./ros-marginal-admission.test-fixtures.js";
import { hash, SCORING } from "./ros-marginal-development.test-fixtures.js";
import {
  ROS_MARGINAL_CORPUS_BUNDLE_VERSION,
  type RosMarginalProfileEvidence,
} from "./ros-profile-marginal-evidence.js";
import {
  RosProfileValidationService,
  type RosProfileValidationRecord,
  type RosProfileValidationRepository,
} from "./ros-profile-validation.js";

import { RosMarginalDependencyError } from "./ros-marginal-corpus-bundle.js";

let evidence: RosMarginalProfileEvidence;
beforeAll(() => {
  const candidate = fullReport(false);
  const previous = fullReport(true);
  const candidateReportJson = JSON.stringify(candidate);
  const previousReportJson = JSON.stringify(previous);
  const qualificationProtocolText = "# Frozen all-position qualification\n";
  const candidateReportChecksum = hash(candidateReportJson);
  const previousReportChecksum = hash(previousReportJson);
  const qualificationProtocolChecksum = hash(qualificationProtocolText);
  evidence = {
    candidateReportJson,
    candidateReportChecksum,
    previousReportJson,
    previousReportChecksum,
    qualificationProtocolText,
    qualificationProtocolChecksum,
    provenance: {
      version: ROS_MARGINAL_CORPUS_BUNDLE_VERSION,
      forecastSeason: 2026,
      scoringProfileKey: SCORING.scoringProfileKey,
      candidateCorpusIdentity: candidate.outcomeCorpusIdentity,
      previousCorpusIdentity: previous.outcomeCorpusIdentity,
      qualificationProtocolChecksum,
      candidateReportChecksum,
      previousReportChecksum,
    },
  };
}, 30_000);

function setup() {
  let record: RosProfileValidationRecord = {
    id: "11111111-1111-4111-8111-111111111111",
    season: 2026,
    ...firstPartyRosReleaseIdentity("marginal-v8"),
    scoringProfileKey: SCORING.scoringProfileKey,
    scoringProfileDigest: SCORING.digest,
    state: "pending",
    blockers: [],
    report: null,
    artifactId: null,
    publicationScopeDigest: null,
    requestedAt: new Date(),
    startedAt: null,
    completedAt: null,
    updatedAt: new Date(),
  };
  const completions: Parameters<RosProfileValidationRepository["complete"]>[0][] = [];
  const deferForCorpus = vi.fn(async () => {});
  const repository: RosProfileValidationRepository = {
    get: async () => record,
    begin: async (_id, startedAt) => {
      record = { ...record, state: "validating", startedAt };
      return startedAt;
    },
    complete: async (input) => {
      completions.push(input);
      record = {
        ...record,
        state: input.admission ? "admitted" : "withheld",
        blockers: input.blockers,
        report: input.report,
      };
      return true;
    },
    fail: async () => {
      record = { ...record, state: "failed" };
    },
    deferForCorpus,
  };
  const runner = vi.fn(async () => ({ mustNotBeUsed: true }));
  const marginalRunner = vi.fn(async () => evidence);
  const enqueueProjectionRefresh = vi.fn(async () => {});
  const options = {
    repository,
    runner,
    marginalRunner,
    enqueueProjectionRefresh,
    releaseRail: "marginal-v8" as const,
    sharedCorpus: async () => ({
      requestIdentity: "d".repeat(64),
      corpusIdentity: evidence.provenance.candidateCorpusIdentity,
    }),
  };
  return {
    options,
    deferForCorpus,
    repository,
    runner,
    marginalRunner,
    enqueueProjectionRefresh,
    completions,
    record: () => record,
    job: { profileValidationId: record.id },
    context: { jobId: "test", signal: new AbortController().signal },
  };
}

describe("registered marginal profile admission", () => {
  it("reconstructs actual pinned evidence, stores effective blockers and queues publication once", async () => {
    const test = setup();
    const service = new RosProfileValidationService(test.options);
    await service.validateProfile(test.job, test.context);
    expect(test.record().state).toBe("admitted");
    expect(test.runner).not.toHaveBeenCalled();
    expect(test.marginalRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredReadyCorpusIdentity: evidence.provenance.candidateCorpusIdentity,
        scoringProfileKey: SCORING.scoringProfileKey,
      }),
    );
    const completion = test.completions[0]!;
    expect(completion.admission).toBeDefined();
    expect(
      firstPartyRosChampionArtifactIsValid({
        ...completion.admission!.payload,
        artifactChecksum: completion.admission!.artifactChecksum,
      }),
    ).toBe(true);
    expect(completion.blockers).toEqual([]);
    expect(completion.report).not.toHaveProperty("diagnostics");
    expect(completion.report).toMatchObject({ marginalEvidence: evidence.provenance });
    const diagnostics = completion.report?.releaseDiagnostics as Record<string, unknown>;
    expect(diagnostics.rawBlockers).toBeInstanceOf(Array);
    expect(diagnostics.supersededIntervalDiagnostics).toBeInstanceOf(Array);
    expect(test.enqueueProjectionRefresh).toHaveBeenCalledExactlyOnceWith(2026);
    // An enqueue retry can request publication again but never repeats the historical proof.
    await service.validateProfile(test.job, test.context);
    expect(test.marginalRunner).toHaveBeenCalledTimes(1);
    expect(test.completions).toHaveLength(1);
  }, 30_000);

  it("rejects corrupt pinned transport as an execution failure without admitting or refreshing", async () => {
    const test = setup();
    test.marginalRunner.mockResolvedValue({ ...evidence, candidateReportChecksum: "0".repeat(64) });
    await expect(
      new RosProfileValidationService(test.options).validateProfile(test.job, test.context),
    ).rejects.toThrow(/provenance/);
    expect(test.record().state).toBe("failed");
    expect(test.completions).toEqual([]);
    expect(test.enqueueProjectionRefresh).not.toHaveBeenCalled();
  });

  it("requires paired replay configuration for the marginal rail", () => {
    const test = setup();
    expect(
      () =>
        new RosProfileValidationService({
          repository: test.repository,
          enqueueProjectionRefresh: test.enqueueProjectionRefresh,
          releaseRail: "marginal-v8",
        }),
    ).toThrow(/paired pinned/);
  });

  it("does not use a retired-rail admitted job to trigger publication", async () => {
    const test = setup();
    test.record().state = "admitted";
    test.record().policyVersion = firstPartyRosReleaseIdentity("legacy-v7").policyVersion;
    await new RosProfileValidationService(test.options).validateProfile(test.job, test.context);
    expect(test.marginalRunner).not.toHaveBeenCalled();
    expect(test.enqueueProjectionRefresh).not.toHaveBeenCalled();
  });
});

it("defers a named missing dependency without falling back to legacy replay or consuming queue retries", async () => {
  const test = setup();
  const diagnostic = { dependency: "previous", reason: "missing" } as const;
  const service = new RosProfileValidationService({
    ...test.options,
    sharedCorpus: async () => {
      throw new RosMarginalDependencyError(diagnostic);
    },
  });
  await service.validateProfile(test.job, test.context);
  expect(test.deferForCorpus).toHaveBeenCalledWith(
    test.job.profileValidationId,
    expect.any(Date),
    expect.stringMatching(/^[a-f0-9]{64}$/u),
    expect.any(Date),
    diagnostic,
  );
  expect(test.runner).not.toHaveBeenCalled();
  expect(test.marginalRunner).not.toHaveBeenCalled();
  expect(test.enqueueProjectionRefresh).not.toHaveBeenCalled();
  expect(test.completions).toEqual([]);
});
