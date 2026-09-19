import { rosMarginalIntervalQualificationFullFixtureInput } from "./ros-marginal-interval-test-fixtures.js";
import {
  buildRosMarginalIntervalQualificationSet,
  ROS_MARGINAL_INTERVAL_QUALIFICATION_VERSION,
  type RosMarginalQualificationDataset,
} from "./ros-marginal-interval-qualification.js";
import { buildRosMarginalIntervalStoredCells } from "./ros-marginal-interval-storage.js";
import { evaluateFirstPartyRosChampionPolicy } from "./rest-of-season.js";
import { validateMarginalRosTrainingCohort } from "./marginal-ros-training.js";
import { firstPartyRosReleaseIdentity } from "./ros-release-identity.js";
import { firstPartyRosReleaseArtifactChecksum } from "./ros-artifact-blockers.js";
import { sha256Hex } from "./sha256.js";

/** Synthetic full raw cohort; proofs, mean policy, compact cells and hashes use real builders. */
export function rosMarginalReleaseArtifactFullFixture(
  input: {
    readonly scoringProfileKey?: string;
    readonly blockers?: readonly string[];
  } = {},
) {
  const original = rosMarginalIntervalQualificationFullFixtureInput();
  const scoringProfileKey = input.scoringProfileKey ?? original.candidate.source.scoringProfileKey;
  const bind = (dataset: RosMarginalQualificationDataset): RosMarginalQualificationDataset => {
    const heldOutSeasons = dataset.heldOutSeasons.map((year) => ({
      ...year,
      forecasts: year.forecasts.map((row) => ({ ...row, scoringProfileKey })),
    }));
    return {
      ...dataset,
      source: {
        ...dataset.source,
        scoringProfileKey,
        reportChecksum: sha256Hex(`${dataset.source.reportChecksum}:${scoringProfileKey}`),
      },
      heldOutSeasons,
      rowsChecksum: validateMarginalRosTrainingCohort(heldOutSeasons, heldOutSeasons).provenance
        .evaluationRowsChecksum,
    };
  };
  const candidate = bind(original.candidate);
  const qualifications = buildRosMarginalIntervalQualificationSet({
    ...original,
    candidate,
    previous: bind(original.previous),
  });
  const policy = evaluateFirstPartyRosChampionPolicy(
    candidate.heldOutSeasons,
    qualifications[0]!.meanSelectorOptions,
  ).livePolicy;
  const payload = {
    season: 2026,
    scoringProfileKey,
    ...firstPartyRosReleaseIdentity("marginal-v8"),
    evidenceThroughSeason: 2025,
    sourceChecksums: [
      { key: "nflverse.schedules.2025", checksum: sha256Hex("fixture-source-schedule") },
    ],
    policy,
    releaseGate: {
      state: "insufficient",
      blockers: input.blockers ?? [],
      marginalIntervals: {
        schemaVersion: 1 as const,
        qualificationMethod: ROS_MARGINAL_INTERVAL_QUALIFICATION_VERSION,
        qualifications,
        cells: buildRosMarginalIntervalStoredCells({
          qualifications,
          releasedCells: qualifications
            .filter((receipt) => receipt.state === "qualified")
            .map((receipt) => receipt.cell),
        }),
      },
    },
  };
  return { ...payload, artifactChecksum: firstPartyRosReleaseArtifactChecksum(payload) };
}
