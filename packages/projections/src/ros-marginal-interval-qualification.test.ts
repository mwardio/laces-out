import { beforeAll, describe, expect, it } from "vitest";
import {
  buildRosMarginalIntervalQualification,
  buildRosMarginalIntervalQualificationSet,
  rosMarginalIntervalQualificationMatchesInput,
  rosMarginalIntervalQualificationSetMatchesInput,
  ROS_MARGINAL_INTERVAL_QUALIFICATION_VERSION,
  type RosMarginalQualificationDataset,
  type RosMarginalQualificationInput,
} from "./ros-marginal-interval-qualification.js";
import { evaluateFirstPartyRosMarginalPolicy } from "./marginal-ros-policy.js";
import { validateMarginalRosTrainingCohort } from "./marginal-ros-training.js";
import {
  evaluateFirstPartyRosChampionPolicy,
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

function mapRows(
  rows: readonly FirstPartyRosHeldOutSeason[],
  fn: (row: FirstPartyRosHeldOutForecast) => FirstPartyRosHeldOutForecast,
) {
  return rows.map((year) => ({ ...year, forecasts: year.forecasts.map(fn) }));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function forge(value: Record<string, unknown>) {
  const body = { ...value };
  delete body.qualificationChecksum;
  return { ...body, qualificationChecksum: sha256Hex(canonical(body)) };
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseKeys(child)]),
    );
  return value;
}

let pinned: RosMarginalQualificationInput;
let receipt: ReturnType<typeof buildRosMarginalIntervalQualification>;
beforeAll(() => {
  pinned = input();
  receipt = buildRosMarginalIntervalQualification(pinned);
});

describe("shared raw-source marginal interval qualification", () => {
  it("reconstructs the fixed strategy across all declared years and preserves the original mean choice", () => {
    expect(receipt).toMatchObject({
      qualificationMethod: ROS_MARGINAL_INTERVAL_QUALIFICATION_VERSION,
      state: "qualified",
      canAuthorizeRelease: false,
      interpretation: "historical-descriptive",
      scope: "final-live-fixed-strategy-cell",
      forecastSeason: 2026,
      requiredEvaluationSeasons: [2023, 2024, 2025],
      comparisonSeason: 2025,
      strategy: "availability-aware-recency",
      previousStrategy: "availability-aware-recency",
    });
    expect(receipt.evidence.overall.samples).toBe(96);
    expect(
      receipt.evidence.perSeason.map((year) => [year.forecastSeason, year.blocks, year.samples]),
    ).toEqual([
      [2023, 4, 32],
      [2024, 4, 32],
      [2025, 4, 32],
    ]);
    expect(receipt.comparison.cells[0]!.samples).toBe(32);
    expect(
      receipt.historicalArtifacts.map(({ forecastSeason, artifact }) => [
        forecastSeason,
        artifact.fit.priorSeasons,
      ]),
    ).toEqual([
      [2023, [2022]],
      [2024, [2022, 2023]],
      [2025, [2022, 2023, 2024]],
    ]);
    expect(receipt.liveArtifact.fit.priorSeasons).toEqual(YEARS);
    const legacy = evaluateFirstPartyRosChampionPolicy(pinned.candidate.heldOutSeasons);
    expect(receipt.meanChoice).toEqual(
      legacy.livePolicy.choices.find(
        (cell) => cell.position === CELL.position && cell.bucket === CELL.bucket,
      ),
    );
    expect(receipt.reasons).toEqual([]);
    expect(receipt.qualificationChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.linkage.filter((block) => block.comparisonRowsChecksum !== null)).toHaveLength(
      4,
    );
    expect(receipt.evidence.sourceRowsChecksum).not.toBe(
      receipt.comparison.cells[0]!.cohortChecksum,
    );
  });

  it("round-trips JSONB object ordering and requires the complete pinned input when checking a receipt", () => {
    expect(
      rosMarginalIntervalQualificationMatchesInput(
        JSON.parse(JSON.stringify(receipt)) as unknown,
        pinned,
      ),
    ).toBe(true);
    expect(
      rosMarginalIntervalQualificationMatchesInput(
        reverseKeys(receipt),
        reverseKeys(pinned) as RosMarginalQualificationInput,
      ),
    ).toBe(true);
    expect(
      buildRosMarginalIntervalQualification(reverseKeys(pinned) as RosMarginalQualificationInput),
    ).toEqual(receipt);
  });

  it("links escaped player identities and varied finite score magnitudes without using cross-module float equality as proof", () => {
    const names = [
      'DST:q"',
      "DST:back\\slash",
      "DST:line\nfeed",
      "DST:null\u0000",
      "DST:\t-tab",
      "DST:a",
      "DST:z",
      "DST:é",
    ];
    const magnitudes = [1e-120, 1e-10, 1, 1e5, 1e12, 1e30, 1e70, 1e120];
    const changed = (row: FirstPartyRosHeldOutForecast) => {
      const index = TEAMS.indexOf(row.playerId.slice(4));
      const unit = row.evidence.availability.scheduledGames * magnitudes[index]!;
      const quantiles = {
        meanPoints: 2 * unit + 1,
        p15Points: unit,
        p50Points: 2 * unit,
        p85Points: 3 * unit,
      };
      return {
        ...row,
        playerId: names[index]!,
        contextual: { ...quantiles },
        recency: { ...quantiles },
        actualPoints: 2 * unit,
      };
    };
    const source = input(
      mapRows(pinned.candidate.heldOutSeasons, changed),
      mapRows(pinned.previous.heldOutSeasons, changed),
    );
    const result = buildRosMarginalIntervalQualification(source);
    expect(result.reasons).not.toContain("invalid-evidence");
    expect(
      result.linkage
        .filter((block) => block.forecastSeason === 2025)
        .every((block) => block.correctedRowsChecksum === block.comparisonCandidateRowsChecksum),
    ).toBe(true);
    expect(result.linkage.every((block) => /^[a-f0-9]{64}$/u.test(block.observationChecksum))).toBe(
      true,
    );
    expect(rosMarginalIntervalQualificationMatchesInput(result, source)).toBe(true);
    const substituted = forge({
      ...result,
      linkage: result.linkage.map((block, index) =>
        index === 0
          ? { ...block, observationChecksum: sha256Hex("same-size substituted outcome cohort") }
          : block,
      ),
    });
    expect(rosMarginalIntervalQualificationMatchesInput(substituted, source)).toBe(false);
  }, 15_000);

  it("compares only the bounded expected receipt shape for cyclic or deeply nested unknown payloads", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      rosMarginalIntervalQualificationMatchesInput({ ...receipt, unknown: cyclic }, pinned),
    ).toBe(false);
    expect(
      rosMarginalIntervalQualificationMatchesInput(
        { ...receipt, qualificationChecksum: cyclic },
        pinned,
      ),
    ).toBe(false);
    expect(
      rosMarginalIntervalQualificationMatchesInput({ ...receipt, evidence: cyclic }, pinned),
    ).toBe(false);
  });

  it("builds every corpus-declared cell once and rejects omitted, duplicate and extra cells", () => {
    const { cell, ...shared } = pinned;
    expect(cell).toEqual(CELL);
    const receipts = buildRosMarginalIntervalQualificationSet(shared);
    expect(receipts.map((value) => value.cell.bucket)).toEqual([
      "five-to-eight",
      "nine-plus",
      "one-to-four",
    ]);
    expect(
      receipts.find((value) => value.cell.bucket === "nine-plus")!.evidence.overall.samples,
    ).toBe(216);
    expect(rosMarginalIntervalQualificationSetMatchesInput([...receipts].reverse(), shared)).toBe(
      true,
    );
    expect(rosMarginalIntervalQualificationSetMatchesInput(receipts.slice(1), shared)).toBe(false);
    expect(
      rosMarginalIntervalQualificationSetMatchesInput(
        [receipts[0], receipts[0], receipts[2]],
        shared,
      ),
    ).toBe(false);
    expect(
      rosMarginalIntervalQualificationSetMatchesInput([...receipts, receipts[0]], shared),
    ).toBe(false);
  });

  it("requires the predeclared cell set even when a whole missing cell is repinned", () => {
    const withoutShort = (years: readonly FirstPartyRosHeldOutSeason[]) =>
      years.map((year) => ({
        ...year,
        forecasts: year.forecasts.filter((row) => row.asOfWeek < 14),
      }));
    const omitted = input(
      withoutShort(pinned.candidate.heldOutSeasons),
      withoutShort(pinned.previous.heldOutSeasons),
    );
    expect(() => buildRosMarginalIntervalQualification(omitted)).toThrow(
      /exact required cell scope/u,
    );
    expect(() =>
      buildRosMarginalIntervalQualification({
        ...pinned,
        scope: {
          ...pinned.scope,
          requiredCells: pinned.scope.requiredCells.slice(1),
        },
      }),
    ).toThrow(/exact required cell scope/u);
    expect(() =>
      buildRosMarginalIntervalQualification({
        ...pinned,
        scope: {
          ...pinned.scope,
          requiredCells: [...pinned.scope.requiredCells, CELL],
        },
      }),
    ).toThrow(/duplicate required cell/u);
    expect(() =>
      buildRosMarginalIntervalQualification({
        ...pinned,
        scope: {
          ...pinned.scope,
          requiredCells: [...pinned.scope.requiredCells, { position: "WR", bucket: "one-to-four" }],
        },
      }),
    ).toThrow(/exact required cell scope/u);
    expect(() =>
      buildRosMarginalIntervalQualification({
        ...pinned,
        cell: { position: "WR", bucket: "one-to-four" },
      }),
    ).toThrow(/cell is absent/u);
  });

  it("accepts exactly three cutoffs and eighteen rows in every required year", () => {
    const boundary = (years: readonly FirstPartyRosHeldOutSeason[]) =>
      years.map((year) => ({
        ...year,
        forecasts: year.forecasts.filter(
          (row) =>
            row.asOfWeek < 14 || (row.asOfWeek < 17 && TEAMS.indexOf(row.playerId.slice(4)) < 6),
        ),
      }));
    const result = buildRosMarginalIntervalQualification(
      input(boundary(pinned.candidate.heldOutSeasons), boundary(pinned.previous.heldOutSeasons)),
    );
    expect(result.state).toBe("qualified");
    expect(result.evidence.perSeason.map((year) => [year.blocks, year.samples])).toEqual([
      [3, 18],
      [3, 18],
      [3, 18],
    ]);
  });

  it("uses broader prior training without replacing audit means or support", () => {
    const broad = mapRows(
      seasons(MODEL, [...TEAMS, "ARI", "ATL", "CAR", "CHI", "CLE", "CIN", "DEN", "DET"]),
      (row) =>
        TEAMS.includes(row.playerId.slice(4))
          ? row
          : {
              ...row,
              contextual: { ...row.contextual, meanPoints: row.actualPoints },
              recency: { ...row.recency, meanPoints: row.actualPoints + 100 },
            },
    );
    const result = buildRosMarginalIntervalQualification({
      ...pinned,
      intervalTraining: dataset(broad, MODEL, "broader-training"),
    });
    expect(result.state).toBe("qualified");
    expect(result.meanChoice).toEqual(receipt.meanChoice);
    expect(result.evidence.overall.samples).toBe(96);
    expect(result.intervalTraining).toMatchObject({
      evaluationForecasts: 544,
      trainingForecasts: 1088,
      additionalTrainingForecasts: 544,
    });
    expect(result.liveArtifact.fit.samples).toBe(256);
    expect(result.sources.intervalTraining!.rowsChecksum).not.toBe(
      result.sources.candidate.rowsChecksum,
    );
  });

  it("does not turn interval qualification into a convergence or source-authentication gate", () => {
    const unstable = mapRows(pinned.candidate.heldOutSeasons, (row) => ({
      ...row,
      evidence: {
        ...row.evidence,
        convergence: {
          ...row.evidence.convergence,
          contextual: { ...row.evidence.convergence.contextual, state: "unstable" },
        },
      },
    }));
    const result = buildRosMarginalIntervalQualification(
      input(unstable, [...pinned.previous.heldOutSeasons]),
    );
    expect(result.state).toBe("qualified");
    expect(result.canAuthorizeRelease).toBe(false);
    expect(result.meanChoice.heldOutEvidence.contextualConvergenceRate).toBe(0);
  });

  it("retains a poor annual quality measurement descriptively when the declared aggregate and latest WIS pass", () => {
    const changed = (row: FirstPartyRosHeldOutForecast) =>
      row.forecastSeason === 2025 && TEAMS.indexOf(row.playerId.slice(4)) < 4
        ? {
            ...row,
            actualPoints: row.actualPoints + 0.1 * row.evidence.availability.scheduledGames,
          }
        : row;
    const result = buildRosMarginalIntervalQualification(
      input(
        mapRows(pinned.candidate.heldOutSeasons, changed),
        mapRows(pinned.previous.heldOutSeasons, changed),
      ),
    );
    expect(result.state).toBe("qualified");
    expect(result.evidence.perSeason.at(-1)!.metrics!.coverage).toEqual({
      numerator: "1",
      denominator: "2",
    });
    expect(result.evidence.overall.metrics!.coverage).toEqual({ numerator: "5", denominator: "6" });
  });

  it("retains every failed aggregate or proper-score comparison without weakening thresholds", () => {
    const changed = mapRows(pinned.candidate.heldOutSeasons, (row) =>
      row.forecastSeason === 2025
        ? {
            ...row,
            contextual: {
              ...row.contextual,
              p15Points: row.contextual.p15Points + 100 * row.evidence.availability.scheduledGames,
              p50Points: row.contextual.p50Points + 100 * row.evidence.availability.scheduledGames,
              p85Points: row.contextual.p85Points + 100 * row.evidence.availability.scheduledGames,
            },
            recency: {
              ...row.recency,
              p15Points: row.recency.p15Points + 100 * row.evidence.availability.scheduledGames,
              p50Points: row.recency.p50Points + 100 * row.evidence.availability.scheduledGames,
              p85Points: row.recency.p85Points + 100 * row.evidence.availability.scheduledGames,
            },
          }
        : row,
    );
    const result = buildRosMarginalIntervalQualification(
      input(changed, [...pinned.previous.heldOutSeasons]),
    );
    expect(result.state).toBe("failed-qualification");
    expect(result.reasons).toContain("lower-tail-above-one-quarter");
    expect(result.reasons).toContain("wis-worse-than-previous-deployed");
    expect(result.reasons).toContain("wis-worse-than-same-physics-legacy");
    expect(
      rosMarginalIntervalQualificationMatchesInput(
        result,
        input(changed, [...pinned.previous.heldOutSeasons]),
      ),
    ).toBe(true);
  });

  it("keeps final-live and chronological selected strategies separate, including the retained benchmark strategy", () => {
    const candidate = mapRows(pinned.candidate.heldOutSeasons, (row) => ({
      ...row,
      contextual: {
        ...row.contextual,
        meanPoints: row.actualPoints + (row.forecastSeason === 2023 ? 10 : 8),
      },
      recency: {
        meanPoints: row.actualPoints + 10,
        p15Points: 0,
        p50Points: row.actualPoints,
        p85Points: 4 * row.evidence.availability.scheduledGames,
      },
    }));
    const previous = mapRows(pinned.previous.heldOutSeasons, (row) => ({
      ...row,
      contextual: { ...row.contextual, meanPoints: row.actualPoints + 10 },
      recency: {
        meanPoints: row.actualPoints + 10,
        p15Points: -row.evidence.availability.scheduledGames,
        p50Points: row.actualPoints,
        p85Points: 5 * row.evidence.availability.scheduledGames,
      },
    }));
    const source = input(candidate, previous);
    const result = buildRosMarginalIntervalQualification(source);
    const evaluated = evaluateFirstPartyRosMarginalPolicy(candidate, { forecastSeason: 2026 });
    const choice = evaluated.livePolicy.choices.find(
      (row) => row.position === "DST" && row.bucket === CELL.bucket,
    )!;
    expect(result.strategy).toBe("contextual");
    expect(result.previousStrategy).toBe("availability-aware-recency");
    expect(
      evaluated.selected
        .filter((row) => row.forecastSeason === 2025)
        .every((row) => row.strategy === "availability-aware-recency"),
    ).toBe(true);
    expect(result.evidence).toEqual(choice.intervalEvidence.contextual);
    expect(result.evidence).not.toEqual(choice.selectedEvidence);
    expect(
      rosMarginalIntervalQualificationMatchesInput(
        forge({ ...result, evidence: choice.selectedEvidence }),
        source,
      ),
    ).toBe(false);
    expect(
      rosMarginalIntervalQualificationMatchesInput(
        forge({ ...result, strategy: "availability-aware-recency" }),
        source,
      ),
    ).toBe(false);
  });

  it("permits only the explicit closed previous Rams amendment and rejects canonical collisions", () => {
    const renamed = mapRows(pinned.previous.heldOutSeasons, (row) =>
      row.playerId === "DST:LAR" ? { ...row, playerId: "DST:LA" } : row,
    );
    const source = input([...pinned.candidate.heldOutSeasons], renamed);
    expect(() => buildRosMarginalIntervalQualification(source)).toThrow(/cohort mismatch/u);
    const amended = {
      ...source,
      scope: { ...source.scope, identityAmendment: "previous-defense-la-to-lar-v1" as const },
    };
    expect(buildRosMarginalIntervalQualification(amended).state).toBe("qualified");
    const colliding = mapRows(renamed, (row) =>
      row.playerId === "DST:BUF" ? { ...row, playerId: "DST:LAR" } : row,
    );
    expect(() =>
      buildRosMarginalIntervalQualification({
        ...amended,
        previous: dataset(colliding, OLD_MODEL),
      }),
    ).toThrow(/identity collision/u);
    expect(() =>
      buildRosMarginalIntervalQualification({
        ...source,
        scope: { ...source.scope, identityAmendment: "any-renames" },
      } as unknown as RosMarginalQualificationInput),
    ).toThrow(/unsupported identity amendment/u);
  });

  it.each(["row", "year", "checksum"] as const)("rejects a missing or forged pinned %s", (kind) => {
    const rows = pinned.candidate.heldOutSeasons.map((year, index) => ({
      ...year,
      forecasts: index === 1 ? year.forecasts.slice(1) : year.forecasts,
    }));
    const changed = {
      ...pinned,
      candidate: {
        ...pinned.candidate,
        ...(kind === "checksum"
          ? { rowsChecksum: "0".repeat(64) }
          : { heldOutSeasons: kind === "year" ? pinned.candidate.heldOutSeasons.slice(1) : rows }),
      },
    };
    expect(() => buildRosMarginalIntervalQualification(changed)).toThrow(
      /pinned checksum|bounded array/u,
    );
  });

  it.each(["annual-row-count", "annual-cutoffs", "whole-year", "prior-fit"] as const)(
    "rejects repinned but inadequate required support: %s",
    (kind) => {
      const filter = (years: readonly FirstPartyRosHeldOutSeason[]) =>
        years.map((year) => ({
          ...year,
          forecasts: year.forecasts.filter(
            (row) =>
              row.asOfWeek < 14 ||
              (kind === "prior-fit"
                ? year.season !== 2022 || TEAMS.indexOf(row.playerId.slice(4)) < 2
                : year.season !== 2023 ||
                  (kind === "whole-year"
                    ? false
                    : kind === "annual-cutoffs"
                      ? row.asOfWeek < 16
                      : TEAMS.indexOf(row.playerId.slice(4)) < 4)),
          ),
        }));
      expect(() =>
        buildRosMarginalIntervalQualification(
          input(filter(pinned.candidate.heldOutSeasons), filter(pinned.previous.heldOutSeasons)),
        ),
      ).toThrow(/annual evaluation needs|historical interval fit|live fit omits declared/u);
    },
  );

  it("never accepts a favorable-year subset or infers evaluable years from passing fits", () => {
    const selectedYears = {
      ...pinned,
      scope: { ...pinned.scope, sourceSeasons: [2022, 2024, 2025] },
    };
    expect(() => buildRosMarginalIntervalQualification(selectedYears)).toThrow(/bounded array/u);
    const forged = forge({
      ...receipt,
      requiredEvaluationSeasons: [2024, 2025],
      evidence: {
        ...receipt.evidence,
        perSeason: receipt.evidence.perSeason.slice(1),
      },
    });
    expect(rosMarginalIntervalQualificationMatchesInput(forged, pinned)).toBe(false);
  });

  it("requires every declared evaluation year even when three other complete years would pass", () => {
    const extend = (years: readonly FirstPartyRosHeldOutSeason[]) => [
      {
        season: 2021,
        complete: true,
        forecasts: years[0]!.forecasts.map((row) => ({
          ...row,
          forecastSeason: 2021,
          trainedThroughSeason: 2020,
        })),
      },
      ...years,
    ];
    const base = input(
      extend(pinned.candidate.heldOutSeasons),
      extend(pinned.previous.heldOutSeasons),
    );
    const source = { ...base, scope: { ...base.scope, sourceSeasons: [2021, ...YEARS] } };
    const result = buildRosMarginalIntervalQualification(source);
    expect(result.requiredEvaluationSeasons).toEqual([2022, 2023, 2024, 2025]);
    expect(() =>
      buildRosMarginalIntervalQualification({
        ...source,
        scope: { ...source.scope, sourceSeasons: YEARS },
      }),
    ).toThrow(/declared source seasons mismatch/u);
    expect(
      rosMarginalIntervalQualificationMatchesInput(
        forge({
          ...result,
          requiredEvaluationSeasons: [2023, 2024, 2025],
        }),
        source,
      ),
    ).toBe(false);
  });

  it.each(["actualPoints", "scheduledGames", "playerId"] as const)(
    "checks all-source-year benchmark %s before comparing the latest year",
    (field) => {
      const changed = mapRows(pinned.previous.heldOutSeasons, (row) =>
        row.forecastSeason === 2022 && row.asOfWeek === 1 && row.playerId === "DST:LAR"
          ? {
              ...row,
              ...(field === "actualPoints"
                ? { actualPoints: row.actualPoints + 1 }
                : field === "playerId"
                  ? { playerId: "DST:REPLACEMENT" }
                  : {
                      evidence: {
                        ...row.evidence,
                        availability: {
                          scheduledGames: 16,
                          actualGames: 16,
                          contextualExpectedGames: 16,
                          recencyExpectedGames: 16,
                        },
                      },
                    }),
            }
          : row,
      );
      expect(() =>
        buildRosMarginalIntervalQualification(input([...pinned.candidate.heldOutSeasons], changed)),
      ).toThrow(/all-season benchmark/u);
    },
  );

  it.each(["manifest", "scoring", "model", "policy"] as const)(
    "rejects a mismatched source %s binding",
    (kind) => {
      const changed = {
        ...pinned.previous,
        ...(kind === "manifest"
          ? { sourceManifestChecksum: sha256Hex("other manifest") }
          : {
              source: {
                ...pinned.previous.source,
                ...(kind === "scoring"
                  ? { scoringProfileKey: rosScoringProfile("half-ppr").scoringProfileKey }
                  : kind === "model"
                    ? { modelVersion: "unknown" }
                    : { policyVersion: "relaxed-selector" }),
              },
            }),
      };
      expect(() => buildRosMarginalIntervalQualification({ ...pinned, previous: changed })).toThrow(
        /source manifest|identity mismatch|frozen v7/u,
      );
    },
  );

  it("binds report/protocol identities without pretending hashes authenticate their owner", () => {
    const forgedInput = {
      ...pinned,
      scope: { ...pinned.scope, protocolChecksum: sha256Hex("different protocol") },
      candidate: {
        ...pinned.candidate,
        source: { ...pinned.candidate.source, reportChecksum: sha256Hex("different report") },
      },
    };
    const result = buildRosMarginalIntervalQualification(forgedInput);
    expect(result.qualificationChecksum).not.toBe(receipt.qualificationChecksum);
    expect(result.canAuthorizeRelease).toBe(false);
    expect(rosMarginalIntervalQualificationMatchesInput(result, pinned)).toBe(false);
  });

  it("allows explicit source gaps but requires live forecasts to follow all source seasons", () => {
    expect(
      buildRosMarginalIntervalQualification({ ...pinned, forecastSeason: 2028 }).forecastSeason,
    ).toBe(2028);
    expect(() =>
      buildRosMarginalIntervalQualification({ ...pinned, forecastSeason: 2025 }),
    ).toThrow(/invalid season/u);
    const shifted = (rows: readonly FirstPartyRosHeldOutSeason[]) =>
      rows.map((year) => ({
        ...year,
        season: year.season + (year.season > 2022 ? 1 : 0),
        forecasts: year.forecasts.map((row) => ({
          ...row,
          forecastSeason: row.forecastSeason + (row.forecastSeason > 2022 ? 1 : 0),
          trainedThroughSeason: row.trainedThroughSeason + (row.forecastSeason > 2022 ? 1 : 0),
        })),
      }));
    const source = input(
      shifted(pinned.candidate.heldOutSeasons),
      shifted(pinned.previous.heldOutSeasons),
    );
    const result = buildRosMarginalIntervalQualification({
      ...source,
      forecastSeason: 2028,
      scope: { ...source.scope, sourceSeasons: [2022, 2024, 2025, 2026] },
    });
    expect(result.requiredEvaluationSeasons).toEqual([2024, 2025, 2026]);
  });

  it("rejects future-trained raw inputs and a training superset that changes an audit target", () => {
    const future = mapRows(pinned.candidate.heldOutSeasons, (row) => ({
      ...row,
      trainedThroughSeason: row.forecastSeason,
    }));
    expect(() =>
      buildRosMarginalIntervalQualification({
        ...pinned,
        candidate: { ...pinned.candidate, heldOutSeasons: future },
      }),
    ).toThrow(/earlier season/u);
    const changed = mapRows(pinned.candidate.heldOutSeasons, (row) =>
      row.forecastSeason === 2022 ? { ...row, actualPoints: row.actualPoints + 1 } : row,
    );
    expect(() =>
      buildRosMarginalIntervalQualification({
        ...pinned,
        intervalTraining: dataset(changed, MODEL, "mutated-training"),
      }),
    ).toThrow(/preserve every original audit input and target/u);
  });

  it.each(["input", "scope", "source", "row", "coverage", "interval"] as const)(
    "rejects unknown %s fields",
    (where) => {
      const next = structuredClone(pinned);
      const targets = {
        input: next,
        scope: next.scope,
        source: next.candidate.source,
        row: next.candidate.heldOutSeasons[0]!.forecasts[0]!,
        coverage: next.candidate.heldOutSeasons[0]!.forecasts[0]!.evidence.coverage,
        interval: next.candidate.heldOutSeasons[0]!.forecasts[0]!.contextual,
      };
      Object.assign(targets[where], { unrecognized: true });
      expect(() => buildRosMarginalIntervalQualification(next)).toThrow(
        /unknown or missing fields/u,
      );
    },
  );

  it.each([
    "checksum",
    "live-artifact",
    "historical-artifacts",
    "comparison",
    "linkage",
    "options",
    "extra",
    "sparse",
    "array-property",
  ] as const)("rejects a forged or malformed receipt even with a recomputed hash: %s", (kind) => {
    let value: Record<string, unknown> = { ...receipt };
    if (kind === "checksum") value.qualificationChecksum = "0".repeat(64);
    else if (kind === "live-artifact")
      value.liveArtifact = {
        ...receipt.liveArtifact,
        fit: { ...receipt.liveArtifact.fit, corrections: [0, 0, 0] },
      };
    else if (kind === "historical-artifacts")
      value.historicalArtifacts = receipt.historicalArtifacts.slice(1);
    else if (kind === "comparison") value.comparison = { ...receipt.comparison, candidateWis: -1 };
    else if (kind === "linkage") value.linkage = receipt.linkage.slice(1);
    else if (kind === "options")
      value.meanSelectorOptions = { ...receipt.meanSelectorOptions, minimumModelImprovement: 0 };
    else if (kind === "extra") value.unknown = true;
    else {
      const years = [...receipt.requiredEvaluationSeasons];
      if (kind === "sparse") Reflect.deleteProperty(years, 0);
      else Object.assign(years, { unknown: true });
      value.requiredEvaluationSeasons = years;
    }
    if (kind !== "checksum") value = forge(value);
    expect(rosMarginalIntervalQualificationMatchesInput(value, pinned)).toBe(false);
  });
});
