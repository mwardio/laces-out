import { describe, expect, it, vi } from "vitest";
import { rosScoringProfile } from "@laces-out/projections";
import { firstPartyRosChampionArtifactIsValid } from "./first-party-ros-publication.js";
import { constants, validReport } from "./ros-profile-validation.test-fixtures.js";
import {
  RosProfileValidationService,
  type RosProfileValidationRecord,
  type RosProfileValidationRepository,
} from "./ros-profile-validation.js";

function setup(overrides: Partial<RosProfileValidationRecord> = {}) {
  const profile = rosScoringProfile("full-ppr");
  let record: RosProfileValidationRecord = {
    id: "11111111-1111-4111-8111-111111111111",
    season: 2026,
    modelVersion: constants.modelVersion,
    policyVersion: constants.policyVersion,
    calibrationVersion: constants.calibrationVersion,
    scoringProfileKey: profile.scoringProfileKey,
    scoringProfileDigest: profile.digest,
    state: "pending",
    blockers: [],
    report: null,
    artifactId: null,
    publicationScopeDigest: null,
    requestedAt: new Date(),
    startedAt: null,
    completedAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
  const completions: Parameters<RosProfileValidationRepository["complete"]>[0][] = [];
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
        artifactId: input.admission ? "artifact" : null,
        blockers: input.blockers,
        report: input.report,
      };
      return true;
    },
    fail: async () => {
      if (record.state === "validating")
        record = { ...record, state: "failed", blockers: ["validation_execution_failed"] };
    },
  };
  const runner = vi.fn(async () => validReport({}));
  const enqueueProjectionRefresh = vi.fn(async () => {});
  const service = new RosProfileValidationService({ repository, runner, enqueueProjectionRefresh });
  const context = { jobId: "job", signal: new AbortController().signal };
  const job = { profileValidationId: record.id };
  return {
    repository,
    runner,
    service,
    enqueueProjectionRefresh,
    context,
    job,
    completions,
    record: () => record,
  };
}

describe("automatic exact ROS profile validation", () => {
  const recoveryIdentity = "c".repeat(64);
  const recoveryReport = {
    automaticRecovery: {
      version: "ready-corpus-replay-v1",
      corpusIdentity: recoveryIdentity,
      state: "pending-dispatch",
      requestedAt: "2026-09-17T12:00:00Z",
    },
  };

  it("pins recovery to its ready corpus and does not let old queue rows start modeling", async () => {
    const test = setup({
      state: "failed",
      blockers: ["validation_execution_failed"],
      report: recoveryReport,
    });
    await test.service.validateProfile(test.job, test.context);
    await test.service.validateProfile(
      { ...test.job, recoveryCorpusIdentity: "d".repeat(64) },
      test.context,
    );
    expect(test.runner).not.toHaveBeenCalled();
    test.runner.mockResolvedValue({ ...validReport({}), outcomeCorpusIdentity: recoveryIdentity });
    await test.service.validateProfile(
      { ...test.job, recoveryCorpusIdentity: recoveryIdentity },
      test.context,
    );
    expect(test.runner).toHaveBeenCalledWith(
      expect.objectContaining({ requiredReadyCorpusIdentity: recoveryIdentity }),
    );
    expect(test.record()).toMatchObject({
      state: "admitted",
      report: { automaticRecovery: { state: "attempted", corpusIdentity: recoveryIdentity } },
    });
  });

  it("allows queued recovery retries but rejects a report from another corpus", async () => {
    const test = setup({
      state: "failed",
      blockers: ["validation_execution_failed"],
      report: recoveryReport,
    });
    const job = { ...test.job, recoveryCorpusIdentity: recoveryIdentity };
    await expect(test.service.validateProfile(job, test.context)).rejects.toThrow(
      "different ready corpus",
    );
    expect(test.record().state).toBe("failed");
    test.runner.mockResolvedValue({ ...validReport({}), outcomeCorpusIdentity: recoveryIdentity });
    await test.service.validateProfile(job, test.context);
    expect(test.record().state).toBe("admitted");
    expect(test.runner).toHaveBeenCalledTimes(2);
  });

  it("does not repeat a completed statistical recovery rejection", async () => {
    const test = setup({
      state: "withheld",
      blockers: ["portfolio_convergence_below_minimum"],
      report: { automaticRecovery: { ...recoveryReport.automaticRecovery, state: "attempted" } },
    });
    await test.service.validateProfile(
      { ...test.job, recoveryCorpusIdentity: recoveryIdentity },
      test.context,
    );
    expect(test.runner).not.toHaveBeenCalled();
  });

  it("applies real admission checks, persists an immutable artifact, and retries publication without replaying", async () => {
    const test = setup();
    await test.service.validateProfile(test.job, test.context);
    expect(test.record().state).toBe("admitted");
    const admission = test.completions[0]!.admission!;
    expect(
      firstPartyRosChampionArtifactIsValid({
        ...admission.payload,
        artifactChecksum: admission.artifactChecksum,
      }),
    ).toBe(true);
    expect(admission.payload.scoringProfileKey).toBe(test.record().scoringProfileKey);
    expect(test.enqueueProjectionRefresh).toHaveBeenCalledWith(2026);
    await test.service.validateProfile(test.job, test.context);
    expect(test.runner).toHaveBeenCalledTimes(1);
    expect(test.enqueueProjectionRefresh).toHaveBeenCalledTimes(2);
  });
  it("preserves statistical blockers without admitting or automatically retrying rejected evidence", async () => {
    const test = setup();
    test.runner.mockResolvedValue(
      validReport({
        reportOverrides: {
          state: "insufficient",
          blockers: ["portfolio_convergence_below_minimum"],
        },
      }),
    );
    await test.service.validateProfile(test.job, test.context);
    expect(test.record()).toMatchObject({ state: "withheld", artifactId: null });
    expect(test.record().blockers).toContain("portfolio_convergence_below_minimum");
    expect(test.enqueueProjectionRefresh).not.toHaveBeenCalled();
    await test.service.validateProfile(test.job, test.context);
    expect(test.runner).toHaveBeenCalledTimes(1);
  });
  it("records insufficient historical source coverage without fabricating a champion", async () => {
    const test = setup();
    test.runner.mockResolvedValue({
      state: "blocked-before-modeling",
      scoringProfile: { digest: test.record().scoringProfileDigest },
      coverage: { state: "insufficient" },
    });
    await test.service.validateProfile(test.job, test.context);
    expect(test.record()).toMatchObject({
      state: "withheld",
      blockers: ["historical_source_coverage_incomplete"],
      artifactId: null,
    });
  });
  it("rejects reports graded under a different scoring identity", async () => {
    const test = setup();
    test.runner.mockResolvedValue(
      validReport({
        evidenceIdentityOverrides: {
          scoringProfileKey: rosScoringProfile("half-ppr").scoringProfileKey,
        },
      }),
    );
    await expect(test.service.validateProfile(test.job, test.context)).rejects.toThrow(
      /identity contract/,
    );
    expect(test.record().state).toBe("failed");
    expect(test.completions).toHaveLength(0);
    expect(test.enqueueProjectionRefresh).not.toHaveBeenCalled();
  });
  it.each(["modelVersion", "policyVersion", "calibrationVersion"] as const)(
    "withholds a stale requested %s before spending validation work",
    async (field) => {
      const test = setup({ [field]: "obsolete" });
      await test.service.validateProfile(test.job, test.context);
      expect(test.record()).toMatchObject({
        state: "withheld",
        blockers: ["validation_execution_identity_changed"],
      });
      expect(test.runner).not.toHaveBeenCalled();
    },
  );
  it("retires a queued v4 request without evaluating it under corrected history semantics", async () => {
    const test = setup({ policyVersion: "season-walk-forward-block-wis-cqr-v4" });
    await expect(test.service.validateProfile(test.job, test.context)).resolves.toBeUndefined();
    expect(test.record()).toMatchObject({
      state: "withheld",
      blockers: ["validation_execution_identity_changed"],
    });
    expect(test.runner).not.toHaveBeenCalled();
    expect(test.enqueueProjectionRefresh).not.toHaveBeenCalled();
  });

  it("rethrows infrastructure failures so the job can retry", async () => {
    const test = setup();
    test.runner.mockRejectedValueOnce(new Error("temporary process failure"));
    await expect(test.service.validateProfile(test.job, test.context)).rejects.toThrow(/temporary/);
    expect(test.record().state).toBe("failed");
    await test.service.validateProfile(test.job, test.context);
    expect(test.record().state).toBe("admitted");
    expect(test.runner).toHaveBeenCalledTimes(2);
  });
  it("does not lose admission when scheduling the follow-up refresh fails", async () => {
    const test = setup();
    test.enqueueProjectionRefresh.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(test.service.validateProfile(test.job, test.context)).rejects.toThrow(
      /queue unavailable/,
    );
    expect(test.record().state).toBe("admitted");
    await test.service.validateProfile(test.job, test.context);
    expect(test.runner).toHaveBeenCalledTimes(1);
    expect(test.enqueueProjectionRefresh).toHaveBeenCalledTimes(2);
  });
  it("does not publish after cancellation or a fenced stale completion", async () => {
    const test = setup();
    const controller = new AbortController();
    test.runner.mockImplementationOnce(async () => {
      controller.abort();
      return validReport({});
    });
    await expect(
      test.service.validateProfile(test.job, { ...test.context, signal: controller.signal }),
    ).rejects.toThrow();
    expect(test.completions).toHaveLength(0);
    test.repository.complete = async () => false;
    await test.service.validateProfile(test.job, test.context);
    expect(test.enqueueProjectionRefresh).not.toHaveBeenCalled();
  });
});
