import { describe, expect, it } from "vitest";
import {
  ROS_DERIVED_EVALUATION_VERSION,
  validateRosDerivedEvaluation,
} from "./ros-derived-evaluation.js";
import {
  rosDerivedEvaluationFixture as fixture,
  rosDerivedProductionEvaluationFixture,
  hash,
  key,
  pin,
} from "./ros-derived-evaluation.test-fixtures.js";

describe("derived observed-truth report lineage", () => {
  it("supports stable production package-role identities only with complete matching package provenance", () => {
    const f = rosDerivedProductionEvaluationFixture();
    const input = f.repin();
    const result = validateRosDerivedEvaluation(input);
    expect(result.lineage.productionPackageIdentity).toBe(input.input.productionPackageChecksum);
    expect(result.lineage.productionIdentityVersion).toBe("ros-derived-production-role-v1");
    const withoutChecksum = Object.fromEntries(
      Object.entries(input.input).filter(([name]) => name !== "productionPackageChecksum"),
    ) as typeof input.input;
    expect(() => validateRosDerivedEvaluation({ ...input, input: withoutChecksum })).toThrow(
      /pin is incomplete/,
    );
    const diagnosticOnly = Object.fromEntries(
      Object.entries(input.input).filter(([name]) => !name.startsWith("productionPackage")),
    ) as typeof input.input;
    expect(() => validateRosDerivedEvaluation({ ...input, input: diagnosticOnly })).toThrow(
      /derived report identity/,
    );
    Object.assign(f.productionPackage, { nonDstFragmentIdentity: hash("other-fragment") });
    expect(() => validateRosDerivedEvaluation(f.repin())).toThrow(/physical dependency/);
  });
  it("authenticates a complete ordered audit against distinct physical sources without changing the frozen original", () => {
    const f = fixture();
    const input = f.repin();
    const result = validateRosDerivedEvaluation(input);
    expect(result.originalPreviousReport).toEqual(f.originalPrevious);
    expect(result.originalCandidateReport).toEqual(f.originalCandidate);
    expect(result.lineage).toMatchObject({
      version: ROS_DERIVED_EVALUATION_VERSION,
      comparisonManifestChecksum: input.input.comparisonManifestChecksum,
      originalPreviousPhysicalCorpus: f.originalPrevious.outcomeCorpusIdentity,
      correctedDstPhysicalCorpus: f.training.outcomeCorpusIdentity,
      observedSources: f.training.sources,
      originalPreviousForecastSources: f.originalPrevious.sources,
    });
    expect(result.lineage.observedSources).not.toEqual(
      result.lineage.originalPreviousForecastSources,
    );
    expect(Object.isFrozen(result.originalPreviousReport)).toBe(true);
    const before = JSON.stringify(result);
    Object.assign(f.originalPrevious.diagnostics.candidateForecasts[0]!.contextual, {
      meanPoints: 999,
    });
    expect(JSON.stringify(result)).toBe(before);
  });

  it("rejects changed report bytes, reconstructed pins and a different canonical manifest identity", () => {
    const f = fixture();
    const input = f.repin();
    expect(() =>
      validateRosDerivedEvaluation({
        ...input,
        candidateReportJson: `${input.candidateReportJson} `,
      }),
    ).toThrow(/byte pin/);
    const manifest = JSON.parse(input.input.comparisonManifestJson) as {
      identity: string;
      payload: unknown;
    };
    manifest.identity = hash(JSON.stringify(manifest.payload));
    const changed = pin(manifest);
    expect(() =>
      validateRosDerivedEvaluation({
        ...input,
        input: {
          ...input.input,
          comparisonManifestJson: changed.text,
          comparisonManifestChecksum: changed.checksum,
        },
      }),
    ).toThrow(/manifest identity/);
    expect(() =>
      validateRosDerivedEvaluation({
        ...input,
        input: {
          ...input.input,
          originalPreviousReportChecksum: input.input.originalCandidateReportChecksum,
        },
      }),
    ).toThrow(/byte pin/);
  });

  it("rejects relabeling physical source lineage or introducing uncertified player-source changes", () => {
    const f = fixture();
    f.manifest.originalPreviousForecastSources = f.training.sources;
    expect(() => validateRosDerivedEvaluation(f.repin())).toThrow(/previous forecast sources/);
    f.manifest.originalPreviousForecastSources = f.originalPrevious.sources;
    const changed = hash("unproven-new-player-history");
    f.training.sources[0]!.weeklyStatsChecksum = changed;
    f.candidate.sources[0]!.weeklyStatsChecksum = changed;
    f.previous.sources[0]!.weeklyStatsChecksum = changed;
    expect(() => validateRosDerivedEvaluation(f.repin())).toThrow(/uncertified non-DST source/);
  });

  it("rejects rehashed non-DST forecast changes and nonzero actual corrections", () => {
    const f = fixture();
    const row = f.candidate.diagnostics.candidateForecasts.find((row) => row.position === "WR")!;
    const mean = row.contextual.meanPoints;
    Object.assign(row.contextual, { meanPoints: mean + 1 });
    expect(() => validateRosDerivedEvaluation(f.repin())).toThrow(/non-DST forecast/);
    Object.assign(row.contextual, { meanPoints: mean });
    const previous = f.previous.diagnostics.candidateForecasts.find(
      (candidate) => key(candidate) === key(row),
    )!;
    Object.assign(row, { actualPoints: row.actualPoints + 1 });
    Object.assign(previous, { actualPoints: row.actualPoints });
    expect(() => validateRosDerivedEvaluation(f.repin())).toThrow(/non-DST numerical actual/);
  });

  it("rejects rehashed previous physical forecasts, availability and labels differing from current truth", () => {
    const f = fixture();
    const row = f.previous.diagnostics.candidateForecasts.find((row) => row.position === "DST")!;
    const mean = row.recency.meanPoints;
    Object.assign(row.recency, { meanPoints: mean + 1 });
    expect(() => validateRosDerivedEvaluation(f.repin())).toThrow(/previous physical/);
    Object.assign(row.recency, { meanPoints: mean });
    Object.assign(row, { actualPoints: row.actualPoints + 1 });
    expect(() => validateRosDerivedEvaluation(f.repin())).toThrow(/observed truth differ/);
  });

  it("requires exact native DST predictions and complete32 training even when all outer pins are rebuilt", () => {
    const f = fixture();
    const row = f.candidate.diagnostics.candidateForecasts.find((row) => row.position === "DST")!;
    Object.assign(row.contextual, { meanPoints: row.contextual.meanPoints + 1 });
    expect(() => validateRosDerivedEvaluation(f.repin())).toThrow(/native training forecast/);
    f.candidate.diagnostics.candidateForecasts = f.candidate.diagnostics.candidateForecasts.map(
      (row) =>
        row.position === "DST"
          ? structuredClone(
              f.training.diagnostics.candidateForecasts.find((source) => key(source) === key(row))!,
            )
          : row,
    );
    f.training.diagnostics.candidateForecasts.pop();
    f.training.report.forecasts = 2175;
    expect(() => validateRosDerivedEvaluation(f.repin())).toThrow(/2176/);
  });

  it("rejects changed ordered membership and duplicate canonical LA/LAR identities", () => {
    const f = fixture();
    const rows = f.candidate.diagnostics.candidateForecasts;
    [rows[0], rows[1]] = [rows[1]!, rows[0]!];
    expect(() => validateRosDerivedEvaluation(f.repin())).toThrow(/membership or order/);
    [rows[0], rows[1]] = [rows[1], rows[0]];
    const dst = f.previous.diagnostics.candidateForecasts.filter(
      (row) => row.position === "DST" && row.forecastSeason === 2022 && row.asOfWeek === 1,
    );
    Object.assign(dst[1]!, { playerId: "DST:LAR" });
    expect(() => validateRosDerivedEvaluation(f.repin())).toThrow(/duplicate canonical/);
  });

  it("rejects numerical scoring changes and the wrong points-allowed provider", () => {
    const f = fixture();
    const changed = JSON.parse(f.candidate.identityAudit.scoringProfileKey) as { points: number }[];
    changed[0]!.points += 1;
    const key = JSON.stringify(changed);
    for (const report of [f.candidate, f.previous, f.training]) {
      report.identityAudit.scoringProfileKey = key;
      for (const row of report.diagnostics.candidateForecasts)
        Object.assign(row, { scoringProfileKey: key });
    }
    f.manifest.profile = key;
    expect(() => validateRosDerivedEvaluation(f.repin())).toThrow(/numeric scoring rules/);
    const provider = fixture();
    provider.manifest.pointsAllowedDefinition = "espn-2019-v1";
    expect(() => validateRosDerivedEvaluation(provider.repin())).toThrow(
      /native training observed truth/,
    );
  });

  it("checks all convergence bindings and their recalculated row/audit commitments", () => {
    const f = fixture();
    const bindings = f.manifest.convergenceBindings as Record<string, unknown>[];
    const first = bindings[0]!;
    const diagnostic = first.diagnostic as Record<string, unknown>;
    diagnostic.worstToleranceRatio = 0.5;
    expect(() => validateRosDerivedEvaluation(f.repin())).toThrow(
      /diagnostic does not reconstruct/,
    );
    diagnostic.worstToleranceRatio = 0;
    const saved = bindings[1]!;
    bindings[1] = structuredClone(first);
    expect(() => validateRosDerivedEvaluation(f.repin())).toThrow(
      /duplicate or unknown convergence/,
    );
    bindings[1] = saved;
    const row = f.candidate.diagnostics.candidateForecasts.find((row) => row.position === "DST")!;
    Object.assign(row.evidence.convergence.contextual, { diagnosticChecksum: hash("forged") });
    expect(() => validateRosDerivedEvaluation(f.repin())).toThrow(/row convergence/);
  });

  it("rejects forged derived roles and identities even with valid report byte pins", () => {
    const f = fixture();
    const input = f.repin();
    f.candidate.outcomeCorpusIdentity = hash("unrelated-derived-corpus");
    const changed = pin(f.candidate);
    expect(() =>
      validateRosDerivedEvaluation({
        ...input,
        candidateReportJson: changed.text,
        candidateReportChecksum: changed.checksum,
      }),
    ).toThrow(/derived report identity/);
    const role = fixture();
    const roleInput = role.repin();
    Object.assign(role.previous.correctedComparison as object, { role: "candidate" });
    const wrong = pin(role.previous);
    expect(() =>
      validateRosDerivedEvaluation({
        ...roleInput,
        previousReportJson: wrong.text,
        previousReportChecksum: wrong.checksum,
      }),
    ).toThrow(/role or manifest/);
  });
});
