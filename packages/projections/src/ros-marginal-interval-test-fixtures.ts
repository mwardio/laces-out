import {
  buildRosMarginalIntervalQualificationSet,
  type RosMarginalQualificationDataset,
  type RosMarginalQualificationInput,
  type RosMarginalQualificationSetInput,
} from "./ros-marginal-interval-qualification.js";
import { validateMarginalRosTrainingCohort } from "./marginal-ros-training.js";
import {
  FIRST_PARTY_ROS_MODEL_VERSION,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosHeldOutSeason,
} from "./rest-of-season.js";
import { rosScoringProfile } from "./ros-scoring-profiles.js";
import { sha256Hex } from "./sha256.js";

const YEARS = [2022, 2023, 2024, 2025];
const TEAMS = ["LAR", "BUF", "KC", "SF", "DAL", "BAL", "PIT", "MIA"];
const MODEL = FIRST_PARTY_ROS_MODEL_VERSION;
const OLD_MODEL = "laces-ros-distribution-v12";
const PROFILE = rosScoringProfile("full-ppr").scoringProfileKey;
const MANIFEST = sha256Hex("shared-official-source-manifest");
const LEGACY_POLICY = "season-walk-forward-mean-rmse-block-wis-cqr-v7";
const CELL = { position: "DST", bucket: "one-to-four" } as const;

function seasons(
  model = MODEL as string,
  teams: readonly string[] = TEAMS,
): FirstPartyRosHeldOutSeason[] {
  return YEARS.map((season) => ({
    season,
    complete: true,
    forecasts: Array.from({ length: 17 }, (_, index) => index + 1).flatMap((asOfWeek) =>
      teams.map((team) => {
        const games = 18 - asOfWeek;
        const playerId = `DST:${team}`;
        const interval = {
          meanPoints: 2 * games + 1,
          p15Points: games,
          p50Points: 2 * games,
          p85Points: 3 * games,
        };
        return {
          playerId,
          position: "DST",
          forecastSeason: season,
          asOfWeek,
          windowStartWeek: asOfWeek + 1,
          windowEndWeek: 18,
          trainedThroughSeason: season - 1,
          inputChecksum: sha256Hex(`${model}:${season}:${asOfWeek}:${playerId}`),
          contextualModelVersion: `${model}:contextual:laces-weekly-components-v15`,
          recencyModelVersion: `${model}:availability-aware-recency:laces-weekly-components-v15`,
          scoringProfileKey: PROFILE,
          intervalMethodVersion: "simulation-p15-p50-p85-cqr-v1",
          evidence: {
            coverage: { contextual: 1, recency: 1 },
            availability: {
              scheduledGames: games,
              actualGames: games,
              contextualExpectedGames: games,
              recencyExpectedGames: games,
            },
            convergence: {
              contextual: {
                state: "converged",
                diagnosticChecksum: sha256Hex(`${model}:contextual`),
              },
              recency: { state: "converged", diagnosticChecksum: sha256Hex(`${model}:recency`) },
            },
          },
          contextual: { ...interval },
          recency: { ...interval },
          actualPoints: 2 * games,
        } satisfies FirstPartyRosHeldOutForecast;
      }),
    ),
  }));
}

function dataset(
  heldOutSeasons: readonly FirstPartyRosHeldOutSeason[],
  model: string,
  label = model,
): RosMarginalQualificationDataset {
  return {
    heldOutSeasons,
    source: {
      modelVersion: model,
      policyVersion: LEGACY_POLICY,
      scoringProfileKey: PROFILE,
      physicalCorpusChecksum: sha256Hex(`${label}:physical-corpus`),
      reportChecksum: sha256Hex(`${label}:report`),
    },
    sourceManifestChecksum: MANIFEST,
    rowsChecksum: validateMarginalRosTrainingCohort(heldOutSeasons, heldOutSeasons).provenance
      .evaluationRowsChecksum,
  };
}

function input(
  candidateRows = seasons(),
  previousRows = seasons(OLD_MODEL),
): RosMarginalQualificationInput {
  return {
    cell: CELL,
    forecastSeason: 2026,
    scope: {
      sourceSeasons: YEARS,
      requiredCells: [
        { position: "DST", bucket: "five-to-eight" },
        { position: "DST", bucket: "nine-plus" },
        CELL,
      ],
      protocolChecksum: sha256Hex("qualification-protocol"),
      sourceManifestChecksum: MANIFEST,
      fullReportChecksum: sha256Hex("complete-immutable-evidence-report"),
      identityAmendment: "none",
    },
    candidate: dataset(candidateRows, MODEL),
    previous: dataset(previousRows, OLD_MODEL),
  };
}

/** Synthetic physical rows run through the authoritative raw-input reconstruction. */
export function rosMarginalIntervalQualificationFixtureInput(): RosMarginalQualificationSetInput {
  const source = input();
  return {
    forecastSeason: source.forecastSeason,
    scope: source.scope,
    candidate: source.candidate,
    previous: source.previous,
  };
}

/** No hand-written qualification flags or checksums are used by this fixture. */
export function buildRosMarginalIntervalQualificationFixture() {
  return buildRosMarginalIntervalQualificationSet(rosMarginalIntervalQualificationFixtureInput());
}

/** Full release scope, still synthetic and reconstructed from all original physical rows. */
export function rosMarginalIntervalQualificationFullFixtureInput(): RosMarginalQualificationSetInput {
  const source = rosMarginalIntervalQualificationFixtureInput();
  const positions = ["QB", "RB", "WR", "TE", "K", "DST"] as const;
  const expand = (value: RosMarginalQualificationDataset): RosMarginalQualificationDataset => {
    const heldOutSeasons = value.heldOutSeasons.map((year) => ({
      ...year,
      forecasts: year.forecasts.flatMap((row) =>
        positions.map((position) => ({
          ...row,
          position,
          playerId: row.playerId.replace(/^DST/u, position),
          inputChecksum: sha256Hex(`${row.inputChecksum}:${position}`),
        })),
      ),
    }));
    return {
      ...value,
      heldOutSeasons,
      rowsChecksum: validateMarginalRosTrainingCohort(heldOutSeasons, heldOutSeasons).provenance
        .evaluationRowsChecksum,
    };
  };
  return {
    ...source,
    scope: {
      ...source.scope,
      requiredCells: positions.flatMap((position) =>
        source.scope.requiredCells.map((cell) => ({ ...cell, position })),
      ),
    },
    candidate: expand(source.candidate),
    previous: expand(source.previous),
  };
}

export function buildRosMarginalIntervalQualificationFullFixture() {
  return buildRosMarginalIntervalQualificationSet(
    rosMarginalIntervalQualificationFullFixtureInput(),
  );
}
