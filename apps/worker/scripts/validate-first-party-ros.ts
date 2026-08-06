import {
  NflverseInjuriesSource,
  NflversePlayersSource,
  NflverseSchedulesSource,
  NflverseSnapCountsSource,
  NflverseTeamWeeklyStatsSource,
  NflverseWeeklyRostersSource,
  NflverseWeeklyStatsSource,
  type NflverseDatasetState,
} from "@laces-out/source-nflverse";

import {
  ROS_SCORING_PROFILE_KEYS,
  isRosScoringProfileKey,
  rosScoringProfile,
  type RosScoringProfileEntry,
} from "@laces-out/projections";

import {
  buildHistoricalRosBacktest,
  historicalRosBucket,
} from "../src/first-party-ros-backtest.js";
import {
  buildFirstPartyPlayerHistory,
  buildFirstPartyDefenseHistory,
  type ProjectionInjuryFact,
  type ProjectionRosterFact,
  type ProjectionScheduleFact,
  type ProjectionSnapFact,
  type ProjectionTeamWeekFact,
  type ProjectionWeeklyFact,
} from "../src/first-party-projection-inputs.js";
import { firstPartyRosChampionPolicyChecksum } from "../src/first-party-ros-publication.js";
import {
  ROS_COVERAGE_POSITIONS,
  auditHistoricalRosCoverage,
  type RosCoveragePosition,
  type RosPlayerCoverageFact,
  type RosScheduleCoverageFact,
} from "../src/ros-data-coverage.js";
import { nflEasternKickoffAt } from "../src/nflverse-schedules.js";

const emptyState: NflverseDatasetState = {
  etag: null,
  lastModified: null,
  checksumSha256: null,
};

function integerOption(name: string, fallback: number): number {
  const raw = process.argv.find((argument) => argument.startsWith(`${name}=`));
  const value = raw ? Number(raw.slice(name.length + 1)) : fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function integerList(name: string, fallback: string): readonly number[] {
  const raw = process.argv.find((argument) => argument.startsWith(`${name}=`));
  const values = (raw?.slice(name.length + 1) ?? fallback).split(",").map(Number);
  if (values.some((value) => !Number.isSafeInteger(value))) {
    throw new Error(`${name} must contain comma-separated integers`);
  }
  return [...new Set(values)].sort((left, right) => left - right);
}

/**
 * Resolves `--scoring-profile=`. The frozen validation process is run once per profile; an unknown
 * name throws before any work starts rather than silently validating the default.
 */
function scoringProfileOption(): RosScoringProfileEntry {
  const raw = process.argv.find((argument) => argument.startsWith("--scoring-profile="));
  const value = raw?.slice("--scoring-profile=".length) ?? "full-ppr";
  if (!isRosScoringProfileKey(value)) {
    throw new Error(
      `--scoring-profile must be one of ${ROS_SCORING_PROFILE_KEYS.join(", ")} (received ${value})`,
    );
  }
  return rosScoringProfile(value);
}

function normalizePosition(value: string): RosCoveragePosition | null {
  const normalized = value.trim().toUpperCase();
  const position =
    normalized === "HB" || normalized === "FB" ? "RB" : normalized === "PK" ? "K" : normalized;
  return ROS_COVERAGE_POSITIONS.includes(position as RosCoveragePosition)
    ? (position as RosCoveragePosition)
    : null;
}

function requireChanged<T extends { readonly state: string }>(
  result: T,
  label: string,
): Extract<T, { readonly state: "changed" }> {
  if (result.state !== "changed") throw new Error(`${label} returned ${result.state}`);
  return result as Extract<T, { readonly state: "changed" }>;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const scoringProfile = scoringProfileOption();
  const seasons = integerList("--seasons", "2019,2020,2021,2022,2023,2024,2025");
  const heldOutSeasons = integerList("--holdouts", "2022,2023,2024,2025");
  const asOfWeeks = integerList("--cutoffs", "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17");
  // Five deterministic quantile-stratified players per position/cutoff (selection quantiles
  // 0/25/50/75/100 of the recent-production ranking, declared before any result inspection) put
  // every 2025 walk-forward cell above the 18-row evidence floor; the forecast cap stays above
  // the full 4-season corpus (5 players x 6 positions x 17 cutoffs x 4 seasons = 2,040) so the
  // run can never truncate silently.
  const playersPerPosition = integerOption("--players-per-position", 5);
  const maximumForecasts = integerOption("--max-forecasts", 3_000);
  if (heldOutSeasons.length < 3) {
    throw new Error("Historical ROS validation requires at least three holdouts");
  }
  if (heldOutSeasons.some((season) => !seasons.includes(season))) {
    throw new Error("Every holdout must be included in --seasons");
  }
  if (
    heldOutSeasons.some((season) => seasons.filter((candidate) => candidate < season).length < 3)
  ) {
    throw new Error("Every holdout requires at least three earlier source seasons");
  }

  process.stderr.write(
    `Scoring profile: ${scoringProfile.key} (${scoringProfile.label}, digest ${scoringProfile.digest.slice(0, 12)})\n`,
  );
  process.stderr.write(
    `Loading official nflverse artifacts for ${seasons.join(", ")} (read-only)...\n`,
  );
  const catalog = requireChanged(
    await new NflversePlayersSource().check(emptyState),
    "player catalog",
  );
  const gsisByPfr = new Map(
    catalog.players.flatMap((player) =>
      player.pfrId ? ([[player.pfrId, player.gsisId]] as const) : [],
    ),
  );
  const positionByGsis = new Map(
    catalog.players.map((player) => [player.gsisId, player.position] as const),
  );
  const weekly: ProjectionWeeklyFact[] = [];
  const teamWeekly: ProjectionTeamWeekFact[] = [];
  const snaps: ProjectionSnapFact[] = [];
  const rosters: ProjectionRosterFact[] = [];
  const injuries: ProjectionInjuryFact[] = [];
  const schedules: ProjectionScheduleFact[] = [];
  const coveragePlayers: RosPlayerCoverageFact[] = [];
  const coverageSchedules: RosScheduleCoverageFact[] = [];
  const sourceAudit: Array<Record<string, unknown>> = [];

  for (const season of seasons) {
    process.stderr.write(`  ${season}: player/team stats, rosters, injuries, snaps, schedule\n`);
    const [weeklyResult, teamWeeklyResult, rosterResult, injuryResult, snapResult, scheduleResult] =
      await Promise.all([
        new NflverseWeeklyStatsSource().check(season, emptyState),
        new NflverseTeamWeeklyStatsSource().check(season, emptyState),
        new NflverseWeeklyRostersSource().check(season, emptyState),
        new NflverseInjuriesSource().check(season, emptyState),
        new NflverseSnapCountsSource().check(season, emptyState),
        new NflverseSchedulesSource().check(
          season,
          { ...emptyState, selectionKey: null },
          { seasonTypes: ["REG"] },
        ),
      ]);
    const weeklyArtifact = requireChanged(weeklyResult, `${season} weekly stats`);
    const teamWeeklyArtifact = requireChanged(teamWeeklyResult, `${season} team weekly stats`);
    const rosterArtifact = requireChanged(rosterResult, `${season} weekly rosters`);
    const injuryArtifact = requireChanged(injuryResult, `${season} injuries`);
    const snapArtifact = requireChanged(snapResult, `${season} snap counts`);
    const scheduleArtifact = requireChanged(scheduleResult, `${season} schedule`);

    for (const row of weeklyArtifact.observations) {
      const position = normalizePosition(row.position);
      if (row.seasonType !== "REG" || !position) continue;
      weekly.push({
        playerId: row.gsisId,
        position,
        season: row.season,
        week: row.week,
        gameId: row.gameId,
        team: row.team,
        opponentTeam: row.opponentTeam,
        components: Object.fromEntries(Object.entries(row.components)),
        advanced: Object.fromEntries(Object.entries(row.advanced)),
      });
      coveragePlayers.push({
        dataset: "weekly-stats",
        season: row.season,
        week: row.week,
        position,
        playerId: row.gsisId,
      });
    }
    for (const row of teamWeeklyArtifact.observations) {
      if (row.seasonType !== "REG") continue;
      teamWeekly.push({
        season: row.season,
        week: row.week,
        gameId: row.gameId,
        team: row.team,
        opponentTeam: row.opponentTeam,
        components: Object.fromEntries(Object.entries(row.components)),
      });
    }
    for (const row of rosterArtifact.observations) {
      const catalogPosition = row.gsisId ? positionByGsis.get(row.gsisId) : undefined;
      const position = normalizePosition(catalogPosition ?? row.position);
      if (row.seasonType !== "REG" || !row.gsisId || !position) continue;
      rosters.push({
        playerId: row.gsisId,
        position,
        season: row.season,
        week: row.week,
        team: row.team,
        status: row.status,
      });
      coveragePlayers.push({
        dataset: "weekly-rosters",
        season: row.season,
        week: row.week,
        position,
        playerId: row.gsisId,
      });
    }
    for (const row of injuryArtifact.observations) {
      const position = normalizePosition(positionByGsis.get(row.gsisId) ?? row.position);
      if (row.seasonType !== "REG" || !position) continue;
      injuries.push({
        playerId: row.gsisId,
        season: row.season,
        week: row.week,
        reportStatus: row.report.status,
        practiceStatus: row.practice.status,
      });
      coveragePlayers.push({
        dataset: "injuries",
        season: row.season,
        week: row.week,
        position,
        playerId: row.gsisId,
      });
    }
    let unresolvedSnaps = 0;
    for (const row of snapArtifact.observations) {
      const position = normalizePosition(row.position);
      const playerId = gsisByPfr.get(row.pfrPlayerId);
      if (row.seasonType !== "REG" || !position || !playerId) {
        unresolvedSnaps += 1;
        continue;
      }
      snaps.push({
        playerId,
        position,
        season: row.season,
        week: row.week,
        gameId: row.gameId,
        team: row.team,
        opponentTeam: row.opponentTeam,
        offenseShare: row.offense.share,
        specialTeamsShare: row.specialTeams.share,
      });
      coveragePlayers.push({
        dataset: "snap-counts",
        season: row.season,
        week: row.week,
        position,
        playerId,
      });
    }
    for (const game of scheduleArtifact.games) {
      schedules.push({
        season: game.season,
        week: game.week,
        gameId: game.gameId,
        awayTeam: game.awayTeam,
        homeTeam: game.homeTeam,
        awayScore: game.awayScore,
        homeScore: game.homeScore,
        kickoffAt: nflEasternKickoffAt(game),
      });
      coverageSchedules.push({
        season: game.season,
        week: game.week,
        gameId: game.gameId,
        complete: game.status === "final" && game.awayScore !== null && game.homeScore !== null,
      });
    }
    sourceAudit.push({
      season,
      weeklyStatsChecksum: weeklyArtifact.checksumSha256,
      teamWeeklyStatsChecksum: teamWeeklyArtifact.checksumSha256,
      weeklyRosterChecksum: rosterArtifact.checksumSha256,
      injuryChecksum: injuryArtifact.checksumSha256,
      snapChecksum: snapArtifact.checksumSha256,
      scheduleChecksum: scheduleArtifact.checksumSha256,
      unresolvedSnapRows: unresolvedSnaps,
    });
  }

  const coverage = auditHistoricalRosCoverage({
    seasons,
    heldOutSeasons,
    players: coveragePlayers,
    schedules: coverageSchedules,
  });
  if (coverage.state !== "qualified") {
    const output = {
      validationMode: "read-only-first-party-ros-backtest",
      generatedAt: new Date().toISOString(),
      elapsedSeconds: (Date.now() - startedAt) / 1_000,
      state: "blocked-before-modeling",
      noDatabaseWrites: true,
      scoringProfile: {
        key: scoringProfile.key,
        label: scoringProfile.label,
        digest: scoringProfile.digest,
      },
      coverage: {
        state: coverage.state,
        fullyHeldOutSeasons: coverage.fullyHeldOutSeasons,
        completeAsOfBatches: coverage.completeAsOfBatches,
        reasons: coverage.reasons,
        seasons: coverage.seasons.map((candidate) => ({
          season: candidate.season,
          reasons: candidate.reasons,
          completeAsOfWeeks: candidate.completeAsOfWeeks,
          eligibleAsOfWeeks: candidate.eligibleAsOfWeeks,
        })),
      },
      sources: sourceAudit,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (!process.argv.includes("--allow-incomplete")) process.exitCode = 1;
    return;
  }

  const history = buildFirstPartyPlayerHistory(weekly, snaps, rosters, schedules, injuries);
  const defenseHistory = buildFirstPartyDefenseHistory(teamWeekly, schedules);
  process.stderr.write(
    `Building paired forecasts (${playersPerPosition}/position/cutoff, max ${maximumForecasts})...\n`,
  );
  let phaseStartedAt = Date.now();
  const result = buildHistoricalRosBacktest({
    history,
    defenseHistory,
    rosters,
    injuries,
    schedules,
    coverage,
    scoringProfile: scoringProfile.profile,
    onProgress: (event) => {
      const now = Date.now();
      process.stderr.write(
        `  ${event.stage}${event.season === undefined ? "" : ` ${event.season}`}: ${event.forecasts} forecasts${event.convergenceStrata === undefined ? "" : `, ${event.convergenceStrata} strata`} (${((now - phaseStartedAt) / 1_000).toFixed(1)}s)\n`,
      );
      phaseStartedAt = now;
    },
    options: {
      heldOutSeasons,
      asOfWeeks,
      playersPerPosition,
      maximumForecasts,
      minimumPortfolioForecasts: 300,
      minimumPortfolioBatches: 30,
      minimumCellSamples: 18,
      minimumCellCutoffs: 3,
      minimumCellBatches: 9,
      minimumCellSeasons: 3,
    },
  });
  // Signed expected-games bias per selected strategy and cell (row-weighted, diagnostic-only):
  // the release gate uses block-weighted MAE, but a signed view identifies systematic hazard
  // mismatch before any threshold tuning is considered.
  const meanOf = (values: readonly number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  const availabilityAudit = result.champion.livePolicy.choices.map((choice) => {
    const rows = result.heldOutSeasons.flatMap((season) =>
      season.forecasts.filter(
        (forecast) =>
          forecast.position === choice.position &&
          historicalRosBucket(forecast.windowStartWeek, forecast.windowEndWeek) === choice.bucket,
      ),
    );
    const selected = choice.strategy === "contextual" ? "contextual" : "recency";
    const errors = rows.map((forecast) => {
      const expected =
        selected === "contextual"
          ? forecast.evidence.availability.contextualExpectedGames
          : forecast.evidence.availability.recencyExpectedGames;
      return expected - forecast.evidence.availability.actualGames;
    });
    return {
      position: choice.position,
      bucket: choice.bucket,
      strategy: choice.strategy,
      rows: rows.length,
      signedExpectedGamesBias: meanOf(errors),
      expectedGamesRowMae: meanOf(errors.map((error) => Math.abs(error))),
    };
  });
  const output = {
    validationMode: "read-only-first-party-ros-backtest",
    generatedAt: new Date().toISOString(),
    elapsedSeconds: (Date.now() - startedAt) / 1_000,
    noDatabaseWrites: true,
    sourcePolicy: "official-nflverse-artifacts",
    // Recorded so a report can never be misattributed to a profile it was not graded under. The
    // authoritative identity remains `identityAudit.scoringProfileKey`, which admission compares.
    scoringProfile: {
      key: scoringProfile.key,
      label: scoringProfile.label,
      digest: scoringProfile.digest,
    },
    availabilityAudit,
    coverage: {
      state: coverage.state,
      fullyHeldOutSeasons: coverage.fullyHeldOutSeasons,
      completeAsOfBatches: coverage.completeAsOfBatches,
      totalAsOfBatches: coverage.totalAsOfBatches,
    },
    report: result.report,
    identityAudit: {
      inputChecksums: new Set(
        result.heldOutSeasons.flatMap((season) =>
          season.forecasts.map((forecast) => forecast.inputChecksum),
        ),
      ).size,
      contextualConvergenceChecksums: new Set(
        result.heldOutSeasons.flatMap((season) =>
          season.forecasts.map(
            (forecast) => forecast.evidence.convergence.contextual.diagnosticChecksum,
          ),
        ),
      ).size,
      recencyConvergenceChecksums: new Set(
        result.heldOutSeasons.flatMap((season) =>
          season.forecasts.map(
            (forecast) => forecast.evidence.convergence.recency.diagnosticChecksum,
          ),
        ),
      ).size,
      scoringProfileKey: result.champion.livePolicy.evidenceIdentity?.scoringProfileKey ?? null,
      contextualModelVersion:
        result.champion.livePolicy.evidenceIdentity?.contextualModelVersion ?? null,
      recencyModelVersion: result.champion.livePolicy.evidenceIdentity?.recencyModelVersion ?? null,
      intervalMethodVersion:
        result.champion.livePolicy.evidenceIdentity?.intervalMethodVersion ?? null,
    },
    champion: {
      policyVersion: result.champion.livePolicy.policyVersion,
      modelVersion: result.champion.livePolicy.modelVersion,
      evidenceThroughSeason: result.champion.livePolicy.evidenceThroughSeason,
      globalBatches: result.champion.livePolicy.globalBatches,
      evidenceIdentity: result.champion.livePolicy.evidenceIdentity,
      publicationPolicyChecksum: firstPartyRosChampionPolicyChecksum(result.champion.livePolicy),
      choices: result.champion.livePolicy.choices.map((choice) => {
        const selected = choice.strategy === "contextual" ? "contextual" : "recency";
        const calibration = choice.intervalCalibrationArtifacts[selected];
        const walkForward = choice.walkForwardCalibrationEvidence[selected];
        return {
          position: choice.position,
          bucket: choice.bucket,
          strategy: choice.strategy,
          reason: choice.reason,
          heldOutSeasons: choice.heldOutSeasons,
          batches: choice.batches,
          samples: choice.samples,
          modelImprovement: choice.modelImprovement,
          modelImprovementLowerBound: choice.modelImprovementLowerBound,
          intervalScoreDifferenceUpperBound: choice.intervalScoreDifferenceUpperBound,
          inputCoverage: {
            contextual: choice.heldOutEvidence.contextualMeanInputCoverage,
            recency: choice.heldOutEvidence.recencyMeanInputCoverage,
          },
          convergenceRate: {
            contextual: choice.heldOutEvidence.contextualConvergenceRate,
            recency: choice.heldOutEvidence.recencyConvergenceRate,
          },
          // Uncalibrated simulation-interval hit rates; the release gate judges only the
          // CQR-calibrated walk-forward coverage, but the raw rate shows how much work the
          // conformal expansion is doing.
          observedIntervalCoverage: {
            contextual: choice.heldOutEvidence.contextualObservedIntervalCoverage,
            recency: choice.heldOutEvidence.recencyObservedIntervalCoverage,
          },
          intervalCalibration: choice.intervalCalibration,
          selectedCalibrationState: calibration.state,
          selectedCalibrationCorrectionPoints: calibration.adjustmentPoints,
          selectedHeldOutEvidence: {
            state: choice.heldOutEvidence.state,
            inputCoverage:
              selected === "contextual"
                ? choice.heldOutEvidence.contextualMeanInputCoverage
                : choice.heldOutEvidence.recencyMeanInputCoverage,
            availabilityMae:
              selected === "contextual"
                ? choice.heldOutEvidence.contextualAvailabilityMae
                : choice.heldOutEvidence.recencyAvailabilityMae,
            availabilityBias:
              selected === "contextual"
                ? choice.heldOutEvidence.contextualAvailabilityBias
                : choice.heldOutEvidence.recencyAvailabilityBias,
            convergenceRate:
              selected === "contextual"
                ? choice.heldOutEvidence.contextualConvergenceRate
                : choice.heldOutEvidence.recencyConvergenceRate,
          },
          walkForwardCalibration: {
            state: walkForward.state,
            seasons: walkForward.seasons,
            blocks: walkForward.blocks,
            samples: walkForward.samples,
            observedBlockCoverage: walkForward.observedBlockCoverage,
            nominalCoverage: calibration.nominalCoverage,
            coverageShortfall: calibration.nominalCoverage - walkForward.observedBlockCoverage,
          },
        };
      }),
    },
    // Admission needs the exact executable policy, including immutable calibration artifacts and
    // their checksums. `champion` above remains the concise human-audit summary; it must never be
    // cast back into this richer runtime contract.
    publicationPolicy: result.champion.livePolicy,
    sources: process.argv.includes("--full") ? sourceAudit : undefined,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (result.report.state !== "evidence-ready" && !process.argv.includes("--allow-incomplete")) {
    process.exitCode = 1;
  }
}

await main();
