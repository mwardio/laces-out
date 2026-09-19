import { NFL_TEAMS } from "@laces-out/domain";
import { type FirstPartyRosHeldOutForecast } from "@laces-out/projections";
import { firstPartyRosAdmissionConstants } from "./first-party-ros-admission.js";
import { historicalRosCalibrationBlockers } from "./first-party-ros-backtest.js";
import {
  forecasts,
  reportFixture,
  hash,
  SCORING,
} from "./ros-marginal-development.test-fixtures.js";

export const MARGINAL_ADMISSION_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;
const CONSTANTS = firstPartyRosAdmissionConstants(SCORING.profile);

/** Complete3264-row matched audit, preserving the DST input identity for broader training. */
export function fullForecasts(previous: boolean): FirstPartyRosHeldOutForecast[] {
  return forecasts(previous).flatMap((row) =>
    MARGINAL_ADMISSION_POSITIONS.map((position) => {
      const team = row.playerId.slice(4) === "LA" ? "LAR" : row.playerId.slice(4);
      return {
        ...row,
        position,
        playerId: position === "DST" ? row.playerId : `${position}:${team}`,
        inputChecksum:
          position === "DST" ? row.inputChecksum : hash(`${row.inputChecksum}:${position}`),
      };
    }),
  );
}

/** Actual v7 selector/identity diagnostics, suitable for exact-byte v8 reconstruction tests. */
export function fullReport(previous: boolean, raw = fullForecasts(previous)) {
  const report = reportFixture(previous, raw, MARGINAL_ADMISSION_POSITIONS);
  const policy = report.publicationPolicy;
  const blockers = [...historicalRosCalibrationBlockers(policy.choices)];
  return {
    ...report,
    report: {
      ...report.report,
      state: blockers.length === 0 ? "evidence-ready" : "insufficient",
      blockers,
      availabilityCalibrationVersion: CONSTANTS.availabilityCalibrationVersion,
      roleCalibrationVersion: CONSTANTS.roleCalibrationVersion,
      kickerCalibrationVersion: CONSTANTS.kickerCalibrationVersion,
    },
    champion: {
      ...report.champion,
      modelVersion: policy.modelVersion,
      policyVersion: policy.policyVersion,
      evidenceThroughSeason: policy.evidenceThroughSeason,
      evidenceIdentity: policy.evidenceIdentity,
    },
  };
}

export function defenseTrainingReport(raw = forecasts(false, NFL_TEAMS)) {
  const report = reportFixture(false, raw);
  return {
    ...report,
    outcomeCorpusIdentity: hash("separate-full-defense-training-corpus"),
    report: { ...report.report, playersPerPosition: 32 },
  };
}

export function trainingRequest(report: unknown) {
  const intervalTrainingReportJson = JSON.stringify(report);
  return {
    intervalTrainingReportJson,
    intervalTrainingReportChecksum: hash(intervalTrainingReportJson),
  };
}
