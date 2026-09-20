import { NFL_TEAMS } from "@laces-out/domain";
import { isDefensePointsAllowedStatId, projectionScoringProfileKey } from "@laces-out/projections";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildCorrectedLocalRosDefenseRankSidecar,
  type CorrectedLocalRosRankReportPair,
} from "./ros-local-development.js";
import { fullReport, defenseTrainingReport } from "./ros-marginal-admission.test-fixtures.js";
import { forecasts, hash, SCORING, TEAMS } from "./ros-marginal-development.test-fixtures.js";

const ORDER = [...TEAMS, ...NFL_TEAMS.filter((team) => !TEAMS.includes(team))];
let profiles: CorrectedLocalRosRankReportPair[];
function build(pairs = profiles) {
  return buildCorrectedLocalRosDefenseRankSidecar({
    profiles: pairs,
    sourceRevision: "a".repeat(40),
    extractorSourceChecksum: hash("unchanged fixed-reference selector"),
    amendmentChecksum: hash("frozen provider metadata amendment"),
    specificationChecksum: hash("unchanged original local-residual-v2 specification"),
  });
}
beforeAll(() => {
  const audit = fullReport(false);
  const full = defenseTrainingReport(forecasts(false, ORDER));
  profiles = Array.from({ length: 9 }, (_, index) => {
    const definition = index % 2 === 0 ? "yahoo-2022-v1" : "espn-2019-v1";
    const originalRules = SCORING.profile.rules.map((rule) => ({
      statId: rule.statId,
      bonuses: rule.bonuses ?? [],
      points: rule.statId === "passing_yards" ? index + 1 : rule.points,
    }));
    const originalScoringProfileKey = projectionScoringProfileKey({
      id: "original",
      rules: originalRules,
    });
    const scoringProfileKey = projectionScoringProfileKey({
      id: "corrected",
      rules: originalRules.map((rule) => ({
        ...rule,
        ...(isDefensePointsAllowedStatId(rule.statId) ? { statDefinition: definition } : {}),
      })),
    });
    const rewrite = (report: typeof audit | typeof full, training: boolean) => {
      const rows = report.diagnostics.candidateForecasts.map((row) => ({
        ...row,
        scoringProfileKey,
      }));
      // Source changes can reverse provider order; the original audit order is deliberately fixed.
      if (training && definition === "espn-2019-v1") {
        for (let start = 0; start < rows.length; start += 32)
          rows.splice(start, 32, ...rows.slice(start, start + 32).reverse());
      }
      return JSON.stringify({
        ...report,
        sources: report.sources.map((source) => ({
          ...source,
          teamWeeklyStatsChecksum: hash(definition),
        })),
        scoringProfile: { ...report.scoringProfile, digest: hash(scoringProfileKey) },
        identityAudit: { ...report.identityAudit, scoringProfileKey },
        diagnostics: { ...report.diagnostics, candidateForecasts: rows },
      });
    };
    const candidateReportJson = rewrite(audit, false),
      trainingReportJson = rewrite(full, true);
    return {
      scoringProfileKey,
      originalScoringProfileKey,
      comparisonManifestChecksum: hash(`manifest:${index}`),
      candidateReportJson,
      candidateReportChecksum: hash(candidateReportJson),
      trainingReportJson,
      trainingReportChecksum: hash(trainingReportJson),
    };
  });
}, 60_000);

describe("corrected provider-specific local rank metadata", () => {
  it("retains old profile identities and joins all audit members without requiring old source order", () => {
    const sidecar = build();
    expect(sidecar.profiles).toHaveLength(9);
    expect(sidecar.profiles[0]!.ranks.rows.slice(0, 32).map((r) => r.canonicalTeam)).toEqual(ORDER);
    expect(sidecar.profiles[1]!.ranks.rows.slice(0, 32).map((r) => r.canonicalTeam)).toEqual(
      [...ORDER].reverse(),
    );
    for (const profile of sidecar.profiles) {
      expect(profile.ranks.rows).toHaveLength(2176);
      expect(profile.bindings.filter((b) => b.auditInputChecksum !== null)).toHaveLength(544);
      expect(profile.originalScoringProfileDigest).toBe(hash(profile.originalScoringProfileKey));
      expect(profile.originalScoringProfileDigest).not.toBe(profile.scoringProfileDigest);
    }
  });

  it("rejects changed numerical coefficients instead of treating them as definition annotations", () => {
    const pair = profiles[0]!;
    const changed = { ...pair, originalScoringProfileKey: profiles[2]!.originalScoringProfileKey };
    expect(() => build([changed, ...profiles.slice(1)])).toThrow(/distinct original/);
    const originalScoringProfileKey = projectionScoringProfileKey({
      id: "changed",
      rules: [{ statId: "passing_yards", points: 999 }],
    });
    expect(() => build([{ ...pair, originalScoringProfileKey }, ...profiles.slice(1)])).toThrow(
      /numerical scoring/,
    );
  });

  it("rejects missing, duplicated or changed audit physical identities", () => {
    const pair = profiles[0]!;
    const report = JSON.parse(pair.candidateReportJson) as ReturnType<typeof fullReport>;
    const row = report.diagnostics.candidateForecasts.find((r) => r.position === "DST")!;
    Object.assign(row, { inputChecksum: hash("changed physical input") });
    const candidateReportJson = JSON.stringify(report);
    expect(() =>
      build([
        { ...pair, candidateReportJson, candidateReportChecksum: hash(candidateReportJson) },
        ...profiles.slice(1),
      ]),
    ).toThrow(/exact original audit joins/);
  });

  it("rejects inconsistent order within one provider even with repinned report bytes", () => {
    const pair = profiles[2]!;
    const report = JSON.parse(pair.trainingReportJson) as ReturnType<typeof defenseTrainingReport>;
    const rows = report.diagnostics.candidateForecasts;
    [rows[8], rows[9]] = [rows[9]!, rows[8]!];
    const trainingReportJson = JSON.stringify(report);
    const changed = profiles.map((p, i) =>
      i === 2 ? { ...p, trainingReportJson, trainingReportChecksum: hash(trainingReportJson) } : p,
    );
    expect(() => build(changed)).toThrow(/differs within provider/);
  });

  it("rejects incomplete profiles, duplicate full32 identities and mismatched report pins", () => {
    expect(() => build(profiles.slice(1))).toThrow(/nine distinct/);
    const pair = profiles[0]!;
    expect(() =>
      build([{ ...pair, trainingReportJson: pair.trainingReportJson + " " }, ...profiles.slice(1)]),
    ).toThrow(/byte pin/);
    const report = JSON.parse(pair.trainingReportJson) as ReturnType<typeof defenseTrainingReport>;
    report.diagnostics.candidateForecasts[1] = report.diagnostics.candidateForecasts[0]!;
    const trainingReportJson = JSON.stringify(report);
    expect(() =>
      build([
        { ...pair, trainingReportJson, trainingReportChecksum: hash(trainingReportJson) },
        ...profiles.slice(1),
      ]),
    ).toThrow(/complete full32/);
  });

  it("extracts the same ranks when observed labels change, and rejects a provider source mismatch", () => {
    const before = build();
    const changed = profiles.map((pair) => {
      const report = JSON.parse(pair.trainingReportJson) as ReturnType<
        typeof defenseTrainingReport
      >;
      for (const row of report.diagnostics.candidateForecasts)
        Object.assign(row, { actualPoints: 123456 });
      const trainingReportJson = JSON.stringify(report);
      return { ...pair, trainingReportJson, trainingReportChecksum: hash(trainingReportJson) };
    });
    const after = build(changed);
    expect(after.profiles.map((p) => p.ranks)).toEqual(before.profiles.map((p) => p.ranks));
    expect(after.profiles.map((p) => p.bindings)).toEqual(before.profiles.map((p) => p.bindings));
    const pair = profiles[0]!;
    const report = JSON.parse(pair.trainingReportJson) as ReturnType<typeof defenseTrainingReport>;
    Object.assign(report.sources[0]!, { teamWeeklyStatsChecksum: hash("another source") });
    const trainingReportJson = JSON.stringify(report);
    expect(() =>
      build([
        { ...pair, trainingReportJson, trainingReportChecksum: hash(trainingReportJson) },
        ...profiles.slice(1),
      ]),
    ).toThrow(/source mismatch/);
  });
});
