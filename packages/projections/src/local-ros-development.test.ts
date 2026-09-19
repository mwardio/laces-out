import { NFL_TEAMS } from "@laces-out/domain";
import { describe, expect, it } from "vitest";
import {
  evaluateLocalRosDevelopment,
  LOCAL_ROS_DEFENSE_RANK_VERSION,
  localRosDefenseRanksChecksum,
  type LocalRosDefenseRanks,
} from "./local-ros-development.js";
import {
  evaluateFirstPartyRosChampionPolicy,
  type FirstPartyRosHeldOutForecast,
  type FirstPartyRosHeldOutSeason,
  type FirstPartyRosPosition,
} from "./rest-of-season.js";
import { rosScoringProfile } from "./ros-scoring-profiles.js";
import { sha256Hex } from "./sha256.js";

const YEARS = [2022, 2023, 2024, 2025];
const CUTOFFS = [1, 4, 8, 12, 14, 16];
function row(
  season: number,
  cutoff: number,
  player: number,
  position: FirstPartyRosPosition,
): FirstPartyRosHeldOutForecast {
  const games = 18 - cutoff;
  const mean = (10 + player / 32) * games;
  return {
    playerId: position === "DST" ? `DST:${NFL_TEAMS[player]!}` : `${position}:${player}`,
    position,
    forecastSeason: season,
    asOfWeek: cutoff,
    windowStartWeek: cutoff + 1,
    windowEndWeek: 18,
    trainedThroughSeason: season - 1,
    inputChecksum: sha256Hex(`${season}:${cutoff}:${position}:${player}`),
    contextualModelVersion: "synthetic-contextual-v13",
    recencyModelVersion: "synthetic-recency-v13",
    scoringProfileKey: rosScoringProfile("full-ppr").scoringProfileKey,
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
        contextual: { state: "converged", diagnosticChecksum: sha256Hex("contextual") },
        recency: { state: "converged", diagnosticChecksum: sha256Hex("recency") },
      },
    },
    contextual: {
      meanPoints: mean,
      p15Points: mean - games,
      p50Points: mean,
      p85Points: mean + games,
    },
    recency: {
      meanPoints: mean + games,
      p15Points: mean,
      p50Points: mean + games,
      p85Points: mean + 2 * games,
    },
    actualPoints: mean + ((player % 3) - 1) * games,
  };
}
function fixture(full = false) {
  const positions: readonly FirstPartyRosPosition[] = full
    ? ["QB", "RB", "WR", "TE", "K", "DST"]
    : ["WR"];
  const audit = YEARS.map((season): FirstPartyRosHeldOutSeason => ({
    season,
    complete: true,
    forecasts: positions.flatMap((position) =>
      CUTOFFS.flatMap((cutoff) =>
        Array.from({ length: 8 }, (_, player) => row(season, cutoff, player, position)),
      ),
    ),
  }));
  const training = audit.map((season) => ({
    ...season,
    forecasts: [
      ...season.forecasts,
      ...(full
        ? CUTOFFS.flatMap((cutoff) =>
            Array.from({ length: 24 }, (_, player) =>
              row(season.season, cutoff, player + 8, "DST"),
            ),
          )
        : []),
    ],
  }));
  const rows = full
    ? YEARS.flatMap((season) =>
        CUTOFFS.flatMap((asOfWeek) =>
          NFL_TEAMS.map((canonicalTeam, index) => ({
            season,
            asOfWeek,
            canonicalTeam,
            ordinalRank: index + 1,
            orderedUniverseChecksum: sha256Hex(JSON.stringify(NFL_TEAMS)),
          })),
        ),
      )
    : [];
  const defenseRanks: LocalRosDefenseRanks = {
    featureVersion: LOCAL_ROS_DEFENSE_RANK_VERSION,
    checksum: localRosDefenseRanksChecksum(rows),
    rows,
  };
  return { audit, training, defenseRanks };
}
function run(input = fixture()) {
  return evaluateLocalRosDevelopment(input.audit, {
    forecastSeason: 2026,
    intervalTrainingSeasons: input.training,
    defenseRanks: input.defenseRanks,
  });
}

describe("chronological pooled local ROS development", () => {
  it("pools only fits while preserving all six positions, original horizons, both strategies and frozen mean choices", () => {
    const input = fixture(true);
    const before = JSON.stringify(input);
    const result = run(input);
    expect(result.canAuthorizeRelease).toBe(false);
    expect(result.liveFits.scopes).toHaveLength(12);
    expect(new Set(result.liveFits.scopes.map((scope) => scope.seriesKey)).size).toBe(12);
    expect(result.auditCoverage).toMatchObject({
      forecasts: 1152,
      candidateRows: 2304,
      selectedRows: 1152,
    });
    expect(result.cohort).toMatchObject({
      evaluationForecasts: 1152,
      trainingForecasts: 1728,
      additionalTrainingForecasts: 576,
    });
    expect(
      new Set(result.candidates.map((candidate) => `${candidate.position}:${candidate.bucket}`))
        .size,
    ).toBe(18);
    expect(result.legacyEvaluation).toEqual(
      evaluateFirstPartyRosChampionPolicy(input.audit, result.meanSelectorOptions),
    );
    expect(
      result.selected.map(({ playerId, forecastSeason, asOfWeek, strategy, predictedMean }) => ({
        playerId,
        forecastSeason,
        asOfWeek,
        strategy,
        predictedMean,
      })),
    ).toEqual(
      result.legacyEvaluation.selected.map(
        ({ playerId, forecastSeason, asOfWeek, strategy, predictedMean }) => ({
          playerId,
          forecastSeason,
          asOfWeek,
          strategy,
          predictedMean,
        }),
      ),
    );
    const raw = input.audit.flatMap((year) => year.forecasts);
    result.candidates.forEach((candidate, index) => {
      const source = raw[Math.floor(index / 2)]!;
      expect(candidate.predictedMean).toBe(
        source[candidate.strategy === "contextual" ? "contextual" : "recency"].meanPoints,
      );
      expect(candidate.physicalEvidence).toEqual(source.evidence);
      expect(candidate.referenceProductionRank).toBe(
        source.position === "DST"
          ? NFL_TEAMS.indexOf(source.playerId.slice(4) as (typeof NFL_TEAMS)[number]) + 1
          : null,
      );
      if (candidate.correction)
        expect(candidate.correction.meanPoints).toBe(candidate.predictedMean);
    });
    expect(JSON.stringify(input)).toBe(before);
  });

  it("prepares each position/strategy/year once, preserving all first-year unavailable records", () => {
    const result = run();
    for (const year of result.seasonFits) {
      for (const scope of year.scopes)
        expect(
          scope.fit.history.every(
            ({ row: history }) => history.forecastSeason < year.forecastSeason,
          ),
        ).toBe(true);
      const wr = year.scopes.filter((scope) => scope.context.position === "WR");
      expect(wr).toHaveLength(2);
      expect(
        wr.every(
          (scope) => scope.training.priorForecasts === 48 * YEARS.indexOf(year.forecastSeason),
        ),
      ).toBe(true);
    }
    const first = result.candidates.filter((candidate) => candidate.forecastSeason === 2022);
    expect(first).toHaveLength(96);
    expect(
      first.every(
        (candidate) =>
          candidate.failure?.code === "prior-fit-unavailable" && candidate.correction === null,
      ),
    ).toBe(true);
    expect(
      result.auditCoverage.correctedCandidateRows + result.auditCoverage.withheldCandidateRows,
    ).toBe(384);
  });

  it("does not expose a current/future target outcome to prior fits or applications", () => {
    const original = fixture();
    const changed = fixture();
    changed.audit = changed.audit.map((season) => ({
      ...season,
      forecasts: season.forecasts.map((forecast) => ({
        ...forecast,
        actualPoints: forecast.actualPoints + (season.season >= 2024 ? 100 : 0),
      })),
    }));
    changed.training = changed.training.map((season) => ({
      ...season,
      forecasts: season.forecasts.map((forecast) => ({
        ...forecast,
        actualPoints: forecast.actualPoints + (season.season >= 2024 ? 100 : 0),
      })),
    }));
    const before = run(original),
      after = run(changed);
    expect(after.seasonFits.filter((year) => year.forecastSeason <= 2024)).toEqual(
      before.seasonFits.filter((year) => year.forecastSeason <= 2024),
    );
    expect(
      after.candidates
        .filter((candidate) => candidate.forecastSeason <= 2024)
        .map((candidate) => candidate.correction),
    ).toEqual(
      before.candidates
        .filter((candidate) => candidate.forecastSeason <= 2024)
        .map((candidate) => candidate.correction),
    );
    expect(
      after.liveFits.scopes.find((scope) => scope.context.position === "WR")!.fit.checksum,
    ).not.toBe(
      before.liveFits.scopes.find((scope) => scope.context.position === "WR")!.fit.checksum,
    );
  });

  it("retains local-support failures with diagnostics instead of deleting sparse queries", () => {
    const input = fixture();
    input.audit = input.audit.map((season) => ({
      ...season,
      forecasts: season.forecasts.filter((forecast) => [1, 4, 8].includes(forecast.asOfWeek)),
    }));
    input.training = input.training.map((season) => ({
      ...season,
      forecasts: season.forecasts.filter((forecast) => [1, 4, 8].includes(forecast.asOfWeek)),
    }));
    const result = run(input);
    expect(result.auditCoverage.forecasts).toBe(96);
    const withheld = result.candidates.filter(
      (candidate) =>
        candidate.forecastSeason > 2022 && candidate.failure?.code === "application-unavailable",
    );
    expect(withheld.length).toBeGreaterThan(0);
    expect(
      withheld.every(
        (candidate) =>
          candidate.applicationSupport !== null &&
          candidate.failure!.reasons.some((reason) => reason.includes("effective")),
      ),
    ).toBe(true);
  });

  it("retains structural zero-game forecasts and names each prior residual exclusion", () => {
    const input = fixture();
    const zero = (forecast: FirstPartyRosHeldOutForecast): FirstPartyRosHeldOutForecast =>
      forecast.playerId !== "WR:0"
        ? forecast
        : {
            ...forecast,
            actualPoints: 0,
            contextual: { meanPoints: 0, p15Points: 0, p50Points: 0, p85Points: 0 },
            recency: { meanPoints: 0, p15Points: 0, p50Points: 0, p85Points: 0 },
            evidence: {
              ...forecast.evidence,
              availability: {
                scheduledGames: 0,
                actualGames: 0,
                contextualExpectedGames: 0,
                recencyExpectedGames: 0,
              },
            },
          };
    input.audit = input.audit.map((season) => ({
      ...season,
      forecasts: season.forecasts.map(zero),
    }));
    input.training = input.training.map((season) => ({
      ...season,
      forecasts: season.forecasts.map(zero),
    }));
    const result = run(input);
    expect(result.auditCoverage).toMatchObject({ forecasts: 192, candidateRows: 384 });
    const zeroRows = result.candidates.filter((candidate) => candidate.playerId === "WR:0");
    expect(zeroRows).toHaveLength(48);
    expect(zeroRows.every((candidate) => candidate.failure?.code === "zero-scheduled-games")).toBe(
      true,
    );
    for (const scope of result.liveFits.scopes.filter((scope) => scope.context.position === "WR")) {
      expect(scope.training.priorForecasts).toBe(192);
      expect(scope.training.includedForecasts).toBe(168);
      expect(scope.training.zeroScheduledGameExclusions).toHaveLength(24);
      expect(scope.fit.history.every(({ row: history }) => history.scheduledGames > 0)).toBe(true);
    }
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 18])(
    "rejects invalid scheduled-game exposure %s instead of dropping a training row",
    (scheduledGames) => {
      const input = fixture();
      const change = (forecast: FirstPartyRosHeldOutForecast): FirstPartyRosHeldOutForecast => ({
        ...forecast,
        evidence: {
          ...forecast.evidence,
          availability: { ...forecast.evidence.availability, scheduledGames },
        },
      });
      input.audit = input.audit.map((season) => ({
        ...season,
        forecasts: season.forecasts.map(change),
      }));
      input.training = input.training.map((season) => ({
        ...season,
        forecasts: season.forecasts.map(change),
      }));
      expect(() => run(input)).toThrow();
    },
  );

  it("retains physical failures even when a local correction can be computed", () => {
    const input = fixture();
    const alter = (forecast: FirstPartyRosHeldOutForecast): FirstPartyRosHeldOutForecast => ({
      ...forecast,
      evidence: {
        ...forecast.evidence,
        coverage: { contextual: 0.9, recency: 1 },
        convergence: {
          ...forecast.evidence.convergence,
          contextual: { state: "unstable", diagnosticChecksum: sha256Hex("unstable") },
        },
      },
    });
    input.audit = input.audit.map((season) => ({
      ...season,
      forecasts: season.forecasts.map(alter),
    }));
    input.training = input.training.map((season) => ({
      ...season,
      forecasts: season.forecasts.map(alter),
    }));
    const result = run(input);
    expect(
      result.candidates
        .filter((candidate) => candidate.strategy === "contextual")
        .every((candidate) => candidate.physicalIssues.length === 2),
    ).toBe(true);
    expect(
      result.liveFits.scopes.find(
        (scope) => scope.context.position === "WR" && scope.context.strategy === "contextual",
      )!.training.physicalIssues,
    ).toHaveLength(384);
  });

  it("rejects missing, duplicate, noncanonical and incomplete full32 rank metadata", () => {
    const input = fixture(true);
    const missing = {
      ...input,
      defenseRanks: { ...input.defenseRanks, rows: input.defenseRanks.rows.slice(1) },
    };
    missing.defenseRanks.checksum = localRosDefenseRanksChecksum(missing.defenseRanks.rows);
    expect(() => run(missing)).toThrow(/universe incomplete/);
    const duplicate = {
      ...input,
      defenseRanks: {
        ...input.defenseRanks,
        rows: [...input.defenseRanks.rows, input.defenseRanks.rows[0]!],
      },
    };
    duplicate.defenseRanks.checksum = localRosDefenseRanksChecksum(duplicate.defenseRanks.rows);
    expect(() => run(duplicate)).toThrow(/duplicate defense rank/);
    expect(() =>
      run({ ...input, defenseRanks: { ...input.defenseRanks, checksum: "a".repeat(64) } }),
    ).toThrow(/integrity/);
  });
});
