import { beforeAll, describe, expect, it } from "vitest";
import {
  buildRosConditionalIntervalQualification,
  rosConditionalIntervalQualificationMatchesInput,
  type RosConditionalIntervalQualificationInput,
} from "./ros-conditional-interval-qualification.js";
import { conditionalContractCanonical } from "./conditional-interval-contract.js";
import { conditionalIntervalArtifactIsValid } from "./conditional-interval-artifact.js";
import { validateMarginalRosTrainingCohort } from "./marginal-ros-training.js";
import {
  evaluateFirstPartyRosChampionPolicy,
  FIRST_PARTY_ROS_MODEL_VERSION,
  type FirstPartyRosHeldOutSeason,
} from "./rest-of-season.js";
import { rosScoringProfile } from "./ros-scoring-profiles.js";
import { sha256Hex } from "./sha256.js";
import type { RosMarginalQualificationDataset } from "./ros-marginal-interval-qualification.js";

const YEARS = [2022, 2023, 2024, 2025];
const PROFILE = rosScoringProfile("full-ppr").scoringProfileKey;
const MODEL = FIRST_PARTY_ROS_MODEL_VERSION;
const OLD = "laces-ros-distribution-v12";
const MANIFEST = sha256Hex("official-source-manifest");
function seasons(model: string = MODEL, players = 8): FirstPartyRosHeldOutSeason[] {
  return YEARS.map((season) => ({
    season,
    complete: true,
    forecasts: Array.from({ length: 17 }, (_, i) => i + 1).flatMap((asOfWeek) =>
      Array.from({ length: players }, (_, player) => {
        const games = 18 - asOfWeek,
          actual = 2 * games + player;
        const raw = {
          meanPoints: actual + 1,
          p15Points: actual - games,
          p50Points: actual,
          p85Points: actual + games,
        };
        return {
          playerId: `DST:T${player}`,
          position: "DST" as const,
          forecastSeason: season,
          asOfWeek,
          windowStartWeek: asOfWeek + 1,
          windowEndWeek: 18,
          trainedThroughSeason: season - 1,
          inputChecksum: sha256Hex(`${model}:${season}:${asOfWeek}:${player}`),
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
                state: "converged" as const,
                diagnosticChecksum: sha256Hex(`${model}:contextual`),
              },
              recency: {
                state: "converged" as const,
                diagnosticChecksum: sha256Hex(`${model}:recency`),
              },
            },
          },
          contextual: { ...raw },
          recency: { ...raw },
          actualPoints: actual,
        };
      }),
    ),
  }));
}
function dataset(
  rows: readonly FirstPartyRosHeldOutSeason[],
  model: string,
  label = model,
): RosMarginalQualificationDataset {
  return {
    heldOutSeasons: rows,
    source: {
      modelVersion: model,
      policyVersion: "season-walk-forward-mean-rmse-block-wis-cqr-v7",
      scoringProfileKey: PROFILE,
      physicalCorpusChecksum: sha256Hex(`${label}:corpus`),
      reportChecksum: sha256Hex(`${label}:report`),
    },
    sourceManifestChecksum: MANIFEST,
    rowsChecksum: validateMarginalRosTrainingCohort(rows, rows).provenance.evaluationRowsChecksum,
  };
}
function input(): RosConditionalIntervalQualificationInput {
  return {
    forecastSeason: 2026,
    scope: {
      sourceSeasons: YEARS,
      requiredCells: [
        { position: "DST", bucket: "one-to-four" },
        { position: "DST", bucket: "five-to-eight" },
        { position: "DST", bucket: "nine-plus" },
      ],
      protocolChecksum: sha256Hex("qualification-protocol"),
      sourceManifestChecksum: MANIFEST,
      fullReportChecksum: sha256Hex("full-report"),
      identityAmendment: "none",
    },
    candidate: dataset(seasons(), MODEL),
    previous: dataset(seasons(OLD), OLD),
  };
}
let pinned: RosConditionalIntervalQualificationInput;
let receipt: ReturnType<typeof buildRosConditionalIntervalQualification>;
beforeAll(() => {
  pinned = input();
  receipt = buildRosConditionalIntervalQualification(pinned);
});
function forge(value: typeof receipt) {
  const { qualificationChecksum: _discard, ...body } = value;
  void _discard;
  return { ...body, qualificationChecksum: sha256Hex(conditionalContractCanonical(body)) };
}

describe("raw-source conditional interval qualification", () => {
  it("reconstructs both strategies, prior-only fits and a usable certified live artifact", () => {
    expect(receipt.state).toBe("qualified-interval-evidence");
    expect(receipt.canAuthorizeRelease).toBe(false);
    expect(receipt.requiredExternalEvidence).toContain("independent-predictive-confirmation");
    expect(receipt.auditCoverage).toMatchObject({
      forecasts: 544,
      candidateRows: 1088,
      selectedRows: 544,
    });
    for (const cell of receipt.cells) {
      expect(cell.strategies.map((row) => row.strategy)).toEqual([
        "contextual",
        "availability-aware-recency",
      ]);
      for (const strategy of cell.strategies) {
        expect(conditionalIntervalArtifactIsValid(strategy.liveArtifact)).toBe(true);
        expect(strategy.liveArtifact!.fit.priorSeasons).toEqual(YEARS);
        expect(
          strategy.historicalArtifacts.map((row) => [
            row.forecastSeason,
            row.artifact!.fit.priorSeasons,
          ]),
        ).toEqual([
          [2023, [2022]],
          [2024, [2022, 2023]],
          [2025, [2022, 2023, 2024]],
        ]);
        expect(strategy.rows.every((row) => row.correction!.meanPoints === row.predictedMean)).toBe(
          true,
        );
      }
    }
    expect(receipt.portfolio.state).toBe("available");
    if (receipt.portfolio.state === "available")
      expect(receipt.portfolio.comparison.worseThan).toEqual([]);
    const original = evaluateFirstPartyRosChampionPolicy(
      pinned.candidate.heldOutSeasons,
      receipt.meanSelectorOptions,
    );
    expect(receipt.legacyMeanEvaluation).toEqual(original);
    expect(receipt.portfolioInterpretation).toBe("chronological-prior-policy-and-fit");
  });
  it("allows reordered keys only when evidence independently reconstructs", () => {
    expect(
      rosConditionalIntervalQualificationMatchesInput(
        Object.fromEntries(Object.entries(receipt).reverse()),
        pinned,
      ),
    ).toBe(true);
  });
  it("rejects rehashed mean tampering", () => {
    const changed = structuredClone(receipt);
    const row = changed.cells[0]!.strategies[0]!.rows[0]!;
    Object.assign(row, { predictedMean: row.predictedMean + 1 });
    expect(rosConditionalIntervalQualificationMatchesInput(forge(changed), pinned)).toBe(false);
  });
  it("rejects rehashed strategy tampering", () => {
    const choice = structuredClone(receipt);
    Object.assign(choice.cells[0]!, {
      strategy:
        choice.cells[0]!.strategy === "contextual" ? "availability-aware-recency" : "contextual",
    });
    expect(rosConditionalIntervalQualificationMatchesInput(forge(choice), pinned)).toBe(false);
  });
  it("rejects another interval method", () => {
    expect(
      rosConditionalIntervalQualificationMatchesInput(
        { ...receipt, qualificationMethod: "ros-marginal-interval-qualification-v1" },
        pinned,
      ),
    ).toBe(false);
  });
  it("requires raw report, model, row, scoring, season and complete scope bindings", () => {
    expect(() =>
      buildRosConditionalIntervalQualification({ ...pinned, forecastSeason: 2027 }),
    ).toThrow(/year/);
    expect(() =>
      buildRosConditionalIntervalQualification({
        ...pinned,
        candidate: { ...pinned.candidate, rowsChecksum: sha256Hex("different") },
      }),
    ).toThrow(/checksum/);
    expect(() =>
      buildRosConditionalIntervalQualification({
        ...pinned,
        previous: {
          ...pinned.previous,
          source: { ...pinned.previous.source, modelVersion: MODEL },
        },
      }),
    ).toThrow(/identity/);
    expect(() =>
      buildRosConditionalIntervalQualification({
        ...pinned,
        previous: {
          ...pinned.previous,
          source: {
            ...pinned.previous.source,
            scoringProfileKey: rosScoringProfile("half-ppr").scoringProfileKey,
          },
        },
      }),
    ).toThrow(/identity|profile/);
    expect(() =>
      buildRosConditionalIntervalQualification({
        ...pinned,
        scope: { ...pinned.scope, requiredCells: pinned.scope.requiredCells.slice(1) },
      }),
    ).toThrow(/declared cells/);
    expect(() =>
      buildRosConditionalIntervalQualification({
        ...pinned,
        scope: { ...pinned.scope, protocolChecksum: "" },
      }),
    ).toThrow(/SHA256/);
    expect(() =>
      buildRosConditionalIntervalQualification({
        ...pinned,
        claimedDevelopmentPass: receipt,
      } as unknown as RosConditionalIntervalQualificationInput),
    ).toThrow(/unknown/);
  });
  it("rejects paired outcome/schedule changes even when the altered source rows are rehashed", () => {
    const changed = seasons(OLD);
    Object.assign(changed[0]!.forecasts[0]!, {
      actualPoints: changed[0]!.forecasts[0]!.actualPoints + 1,
    });
    expect(() =>
      buildRosConditionalIntervalQualification({ ...pinned, previous: dataset(changed, OLD) }),
    ).toThrow(/target\/schedule/);
    const future = seasons();
    Object.assign(future.at(-1)!, { season: 2026 });
    expect(() =>
      buildRosConditionalIntervalQualification({ ...pinned, candidate: dataset(future, MODEL) }),
    ).toThrow();
  });
  it("does not leak the latest outcomes into that year's conditional artifacts", () => {
    const rows = seasons(),
      previous = seasons(OLD);
    for (const years of [rows, previous])
      for (const row of years.at(-1)!.forecasts)
        Object.assign(row, { actualPoints: row.actualPoints + 2 });
    const altered = buildRosConditionalIntervalQualification({
      ...pinned,
      candidate: dataset(rows, MODEL),
      previous: dataset(previous, OLD),
    });
    expect(altered.state).toBe("rejected-interval-evidence");
    expect(altered.reasons.some((reason) => reason.includes("upper-tail"))).toBe(true);
    for (const [index, cell] of altered.cells.entries())
      for (const [strategyIndex, strategy] of cell.strategies.entries())
        expect(strategy.historicalArtifacts.at(-1)!.artifact!.fit).toEqual(
          receipt.cells[index]!.strategies[strategyIndex]!.historicalArtifacts.at(-1)!.artifact!
            .fit,
        );
    expect(altered.cells[0]!.strategies[0]!.liveArtifact!.fit.checksum).not.toBe(
      receipt.cells[0]!.strategies[0]!.liveArtifact!.fit.checksum,
    );
  });
  it("keeps extra training out of mean selection and preserves physical failures without waiving them", () => {
    const training = seasons(MODEL, 9);
    for (const year of training)
      for (const row of year.forecasts)
        if (row.playerId === "DST:T8") {
          Object.assign(row.evidence.convergence.contextual, { state: "unstable" });
        }
    const result = buildRosConditionalIntervalQualification({
      ...pinned,
      intervalTraining: dataset(training, MODEL, "expanded"),
    });
    expect(result.trainingCohort).toMatchObject({
      evaluationForecasts: 544,
      trainingForecasts: 612,
      additionalTrainingForecasts: 68,
    });
    expect(result.legacyMeanEvaluation).toEqual(receipt.legacyMeanEvaluation);
    expect(
      result.cells.every((cell) =>
        cell.strategies[0]!.liveTraining.physicalIssues.some(
          (issue) => issue.kind === "unstable-physical-convergence",
        ),
      ),
    ).toBe(true);
    expect(result.canAuthorizeRelease).toBe(false);
    expect(result.requiredExternalEvidence).toContain(
      "historical-and-live-numerical-qualification",
    );
  });
  it("retains zero-game audit rows as failures rather than shrinking the graded population", () => {
    const rows = seasons(),
      previous = seasons(OLD);
    for (const years of [rows, previous])
      for (const year of years)
        for (const row of year.forecasts)
          if (row.asOfWeek === 17) {
            Object.assign(row.evidence.availability, {
              scheduledGames: 0,
              actualGames: 0,
              contextualExpectedGames: 0,
              recencyExpectedGames: 0,
            });
          }
    const result = buildRosConditionalIntervalQualification({
      ...pinned,
      candidate: dataset(rows, MODEL),
      previous: dataset(previous, OLD),
    });
    expect(result.state).toBe("rejected-interval-evidence");
    expect(result.auditCoverage.forecasts).toBe(544);
    const last = result.cells.find((cell) => cell.cell.bucket === "one-to-four")!;
    expect(
      last.strategies[0]!.rows.filter((row) => row.failure?.code === "zero-scheduled-games"),
    ).toHaveLength(24);
    expect(last.reasons).toContain("audit-application-unavailable");
    expect(last.strategies[0]!.liveTraining.zeroScheduledGameExclusions).toHaveLength(32);
  });
});
