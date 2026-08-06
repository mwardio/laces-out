import {
  NflverseInjuriesSource,
  NflversePlayersSource,
  NflverseSchedulesSource,
  NflverseSnapCountsSource,
  NflverseWeeklyRostersSource,
  NflverseWeeklyStatsSource,
  type NflverseDatasetState,
} from "@laces-out/source-nflverse";

import {
  ROS_COVERAGE_POSITIONS,
  auditHistoricalRosCoverage,
  type RosCoveragePosition,
  type RosPlayerCoverageFact,
  type RosScheduleCoverageFact,
} from "../src/ros-data-coverage.js";

const emptyState: NflverseDatasetState = {
  etag: null,
  lastModified: null,
  checksumSha256: null,
};

function integerList(option: string, fallback: string): readonly number[] {
  const value = process.argv.find((argument) => argument.startsWith(`${option}=`));
  const seasons = (value?.slice(option.length + 1) ?? fallback).split(",").map(Number);
  if (seasons.some((season) => !Number.isSafeInteger(season) || season < 2009 || season > 2200)) {
    throw new Error(`${option} must contain comma-separated NFL seasons`);
  }
  return [...new Set(seasons)].sort((left, right) => left - right);
}

function normalizePosition(value: string): RosCoveragePosition | null {
  const normalized = value.trim().toUpperCase();
  const position =
    normalized === "HB" || normalized === "FB" ? "RB" : normalized === "PK" ? "K" : normalized;
  return ROS_COVERAGE_POSITIONS.includes(position as RosCoveragePosition)
    ? (position as RosCoveragePosition)
    : null;
}

interface CapturedArtifact<T> {
  readonly artifact: T | null;
  readonly error: string | null;
}

async function captureChanged<T extends { readonly state: string }>(
  label: string,
  load: () => Promise<T>,
): Promise<CapturedArtifact<Extract<T, { readonly state: "changed" }>>> {
  try {
    const result = await load();
    if (result.state !== "changed") {
      return { artifact: null, error: `${label} returned ${result.state}` };
    }
    return { artifact: result as Extract<T, { readonly state: "changed" }>, error: null };
  } catch (error) {
    return {
      artifact: null,
      error: `${label}: ${error instanceof Error ? error.message : "unknown source failure"}`,
    };
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const seasons = integerList("--seasons", "2020,2021,2022,2023,2024,2025");
  if (seasons.length < 6 || seasons.length > 12) {
    throw new Error("--seasons must contain between 6 and 12 seasons");
  }
  const heldOutSeasons = integerList("--holdouts", seasons.slice(-3).join(","));
  if (heldOutSeasons.length < 3 || heldOutSeasons.some((season) => !seasons.includes(season))) {
    throw new Error("--holdouts must select at least three seasons from --seasons");
  }

  const playerCatalogResult = await captureChanged("player catalog", () =>
    new NflversePlayersSource().check(emptyState),
  );
  const playerCatalog = playerCatalogResult.artifact;
  if (!playerCatalog) throw new Error(playerCatalogResult.error ?? "player catalog failed");
  const gsisByPfr = new Map(
    playerCatalog.players.flatMap((player) =>
      player.pfrId ? ([[player.pfrId, player.gsisId]] as const) : [],
    ),
  );
  const players: RosPlayerCoverageFact[] = [];
  const schedules: RosScheduleCoverageFact[] = [];
  const sources: Array<Record<string, unknown>> = [];

  for (const season of seasons) {
    const [weeklyCapture, rosterCapture, injuryCapture, snapCapture, scheduleCapture] =
      await Promise.all([
        captureChanged(`${season} weekly stats`, () =>
          new NflverseWeeklyStatsSource().check(season, emptyState),
        ),
        captureChanged(`${season} weekly rosters`, () =>
          new NflverseWeeklyRostersSource().check(season, emptyState),
        ),
        captureChanged(`${season} injuries`, () =>
          new NflverseInjuriesSource().check(season, emptyState),
        ),
        captureChanged(`${season} snap counts`, () =>
          new NflverseSnapCountsSource().check(season, emptyState),
        ),
        captureChanged(`${season} schedules`, () =>
          new NflverseSchedulesSource().check(
            season,
            { ...emptyState, selectionKey: null },
            { seasonTypes: ["REG"] },
          ),
        ),
      ]);
    const weekly = weeklyCapture.artifact;
    const rosters = rosterCapture.artifact;
    const injuries = injuryCapture.artifact;
    const snaps = snapCapture.artifact;
    const schedule = scheduleCapture.artifact;
    let unresolvedSnapRows = 0;

    for (const row of weekly?.observations ?? []) {
      const position = normalizePosition(row.position);
      if (row.seasonType === "REG" && position) {
        players.push({
          dataset: "weekly-stats",
          season: row.season,
          week: row.week,
          position,
          playerId: row.gsisId,
        });
      }
    }
    for (const row of rosters?.observations ?? []) {
      const position = normalizePosition(row.position);
      if (row.seasonType === "REG" && position && row.gsisId) {
        players.push({
          dataset: "weekly-rosters",
          season: row.season,
          week: row.week,
          position,
          playerId: row.gsisId,
        });
      }
    }
    for (const row of injuries?.observations ?? []) {
      const position = normalizePosition(row.position);
      if (row.seasonType === "REG" && position) {
        players.push({
          dataset: "injuries",
          season: row.season,
          week: row.week,
          position,
          playerId: row.gsisId,
        });
      }
    }
    for (const row of snaps?.observations ?? []) {
      if (row.seasonType !== "REG") continue;
      const position = normalizePosition(row.position);
      const playerId = gsisByPfr.get(row.pfrPlayerId);
      if (!position || !playerId) {
        unresolvedSnapRows += 1;
        continue;
      }
      players.push({
        dataset: "snap-counts",
        season: row.season,
        week: row.week,
        position,
        playerId,
      });
    }
    schedules.push(
      ...(schedule?.games ?? []).map((game) => ({
        season: game.season,
        week: game.week,
        gameId: game.gameId,
        complete: game.status === "final" && game.awayScore !== null && game.homeScore !== null,
      })),
    );
    sources.push({
      season,
      weeklyStats: {
        checksum: weekly?.checksumSha256 ?? null,
        rowsRead: weekly?.rowsRead ?? 0,
        rowsRejected: weekly?.rowsRejected ?? 0,
        error: weeklyCapture.error,
      },
      weeklyRosters: {
        checksum: rosters?.checksumSha256 ?? null,
        rowsRead: rosters?.rowsRead ?? 0,
        rowsRejected: rosters?.rowsRejected ?? 0,
        error: rosterCapture.error,
      },
      injuries: {
        checksum: injuries?.checksumSha256 ?? null,
        rowsRead: injuries?.rowsRead ?? 0,
        rowsRejected: injuries?.rowsRejected ?? 0,
        error: injuryCapture.error,
      },
      snapCounts: {
        checksum: snaps?.checksumSha256 ?? null,
        rowsRead: snaps?.rowsRead ?? 0,
        rowsRejected: snaps?.rowsRejected ?? 0,
        unresolvedIdentityRows: unresolvedSnapRows,
        error: snapCapture.error,
      },
      schedules: {
        checksum: schedule?.checksumSha256 ?? null,
        rowsRead: schedule?.rowsRead ?? 0,
        rowsRejected: schedule?.rowsRejected ?? 0,
        error: scheduleCapture.error,
      },
    });
  }

  const report = auditHistoricalRosCoverage({ seasons, heldOutSeasons, players, schedules });
  const output = {
    validationMode: "read-only-historical-ros-coverage",
    generatedAt: new Date().toISOString(),
    elapsedSeconds: (Date.now() - startedAt) / 1_000,
    sourcePolicy: "official-nflverse-artifacts; no database writes",
    sources,
    report,
  };
  const rendered = process.argv.includes("--summary")
    ? {
        validationMode: output.validationMode,
        generatedAt: output.generatedAt,
        elapsedSeconds: output.elapsedSeconds,
        sourcePolicy: output.sourcePolicy,
        sources,
        report: {
          state: report.state,
          heldOutSeasonsRequested: report.heldOutSeasonsRequested,
          fullyHeldOutSeasons: report.fullyHeldOutSeasons,
          completeAsOfBatches: report.completeAsOfBatches,
          totalAsOfBatches: report.totalAsOfBatches,
          reasons: report.reasons,
          seasons: report.seasons.map((season) => ({
            season: season.season,
            priorSeasons: season.priorSeasons,
            eligibleAsOfWeeks: season.eligibleAsOfWeeks,
            completeAsOfWeeks: season.completeAsOfWeeks,
            fullyHeldOut: season.fullyHeldOut,
            reasons: season.reasons,
            incompleteWeeks: season.weeks
              .filter((week) => !week.complete)
              .map((week) => ({
                targetWeek: week.targetWeek,
                reasons: week.reasons,
                positions: week.positions
                  .filter((position) => !position.complete)
                  .map((position) => ({
                    position: position.position,
                    reasons: position.reasons,
                  })),
              })),
          })),
        },
      }
    : output;
  process.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`);
  if (report.state !== "qualified" && !process.argv.includes("--allow-incomplete")) {
    process.exitCode = 1;
  }
}

await main();
