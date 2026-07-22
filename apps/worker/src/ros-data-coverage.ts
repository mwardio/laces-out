export const ROS_COVERAGE_POSITIONS = ["QB", "RB", "WR", "TE", "K"] as const;

export type RosCoveragePosition = (typeof ROS_COVERAGE_POSITIONS)[number];
export type RosCoverageDataset = "weekly-stats" | "weekly-rosters" | "injuries" | "snap-counts";

export interface RosPlayerCoverageFact {
  readonly dataset: RosCoverageDataset;
  readonly season: number;
  readonly week: number;
  readonly position: RosCoveragePosition;
  readonly playerId: string;
}

export interface RosScheduleCoverageFact {
  readonly season: number;
  readonly week: number;
  readonly gameId: string;
  readonly complete: boolean;
}

export interface RosHistoricalCoverageThresholds {
  readonly minimumHeldOutSeasons: number;
  readonly minimumAsOfBatches: number;
  readonly minimumPriorSeasons: number;
  readonly minimumPlayersPerPosition: number;
  readonly minimumRosterMatchRate: number;
  readonly minimumSnapMatchRate: number;
  readonly maximumSeasons: number;
  readonly maximumFacts: number;
}

export interface RosHistoricalCoverageInput {
  readonly seasons: readonly number[];
  readonly heldOutSeasons: readonly number[];
  readonly players: readonly RosPlayerCoverageFact[];
  readonly schedules: readonly RosScheduleCoverageFact[];
  readonly thresholds?: Partial<RosHistoricalCoverageThresholds>;
}

export interface RosPositionCoverage {
  readonly position: RosCoveragePosition;
  readonly outcomePlayers: number;
  readonly priorStatPlayers: number;
  readonly priorRosterPlayers: number;
  readonly priorSnapPlayers: number;
  readonly priorInjuryReports: number;
  readonly rosterMatches: number;
  readonly snapMatches: number;
  readonly rosterMatchRate: number | null;
  readonly snapMatchRate: number | null;
  readonly missingRosterPlayerIds: readonly string[];
  readonly missingSnapPlayerIds: readonly string[];
  readonly complete: boolean;
  readonly reasons: readonly string[];
}

export interface RosWeekCoverage {
  readonly targetWeek: number;
  readonly asOfWeek: number;
  readonly scheduleGames: number;
  readonly completedScheduleGames: number;
  readonly injuryBatchRows: number;
  readonly positions: readonly RosPositionCoverage[];
  readonly complete: boolean;
  readonly reasons: readonly string[];
}

export interface RosSeasonCoverage {
  readonly season: number;
  readonly priorSeasons: readonly number[];
  readonly priorSeasonCoverage: readonly RosPriorSeasonCoverage[];
  readonly expectedWeeks: readonly number[];
  readonly eligibleAsOfWeeks: number;
  readonly completeAsOfWeeks: number;
  readonly fullyHeldOut: boolean;
  readonly reasons: readonly string[];
  readonly weeks: readonly RosWeekCoverage[];
}

export interface RosPriorSeasonCoverage {
  readonly season: number;
  readonly weeklyStatRows: number;
  readonly weeklyRosterRows: number;
  readonly injuryRows: number;
  readonly snapRows: number;
  readonly scheduleGames: number;
  readonly completedScheduleGames: number;
  readonly complete: boolean;
  readonly missingDatasets: readonly string[];
}

export interface RosHistoricalCoverageReport {
  readonly state: "qualified" | "insufficient";
  readonly thresholds: RosHistoricalCoverageThresholds;
  readonly heldOutSeasonsRequested: readonly number[];
  readonly fullyHeldOutSeasons: readonly number[];
  readonly completeAsOfBatches: number;
  readonly totalAsOfBatches: number;
  readonly reasons: readonly string[];
  readonly seasons: readonly RosSeasonCoverage[];
}

const DEFAULT_THRESHOLDS: RosHistoricalCoverageThresholds = {
  minimumHeldOutSeasons: 3,
  minimumAsOfBatches: 30,
  minimumPriorSeasons: 3,
  minimumPlayersPerPosition: 1,
  minimumRosterMatchRate: 0.9,
  minimumSnapMatchRate: 0.85,
  maximumSeasons: 12,
  maximumFacts: 1_000_000,
};

const POSITION_SET = new Set<string>(ROS_COVERAGE_POSITIONS);

function sortedUniqueIntegers(values: readonly number[], label: string): readonly number[] {
  if (values.some((value) => !Number.isSafeInteger(value))) {
    throw new Error(`${label} must contain only integers`);
  }
  return [...new Set(values)].sort((left, right) => left - right);
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function factKey(season: number, week: number, position: RosCoveragePosition): string {
  return `${season}:${week}:${position}`;
}

function scheduleKey(season: number, week: number): string {
  return `${season}:${week}`;
}

function addPlayer(index: Map<string, Set<string>>, key: string, playerId: string): void {
  const players = index.get(key) ?? new Set<string>();
  players.add(playerId);
  index.set(key, players);
}

function validateThresholds(
  overrides: Partial<RosHistoricalCoverageThresholds> | undefined,
): RosHistoricalCoverageThresholds {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...overrides };
  const integerKeys = [
    "minimumHeldOutSeasons",
    "minimumAsOfBatches",
    "minimumPriorSeasons",
    "minimumPlayersPerPosition",
    "maximumSeasons",
    "maximumFacts",
  ] as const;
  for (const key of integerKeys) {
    if (!Number.isSafeInteger(thresholds[key]) || thresholds[key] < 1) {
      throw new Error(`${key} must be a positive integer`);
    }
  }
  for (const key of ["minimumRosterMatchRate", "minimumSnapMatchRate"] as const) {
    if (!Number.isFinite(thresholds[key]) || thresholds[key] < 0 || thresholds[key] > 1) {
      throw new Error(`${key} must be between zero and one`);
    }
  }
  return thresholds;
}

function boundedMissingIds(anchor: ReadonlySet<string>, available: ReadonlySet<string>): string[] {
  return [...anchor]
    .filter((playerId) => !available.has(playerId))
    .sort()
    .slice(0, 25);
}

/**
 * Audits the data needed to build chronological shadow batches. Target-week weekly stats are used
 * only as evaluation outcomes; every feature-coverage comparison is pinned to targetWeek - 1.
 */
export function auditHistoricalRosCoverage(
  input: RosHistoricalCoverageInput,
): RosHistoricalCoverageReport {
  const thresholds = validateThresholds(input.thresholds);
  const seasons = sortedUniqueIntegers(input.seasons, "seasons");
  const heldOutSeasons = sortedUniqueIntegers(input.heldOutSeasons, "heldOutSeasons");
  if (seasons.length === 0 || heldOutSeasons.length === 0) {
    throw new Error("seasons and heldOutSeasons must not be empty");
  }
  if (seasons.length > thresholds.maximumSeasons) {
    throw new Error(`coverage audit is bounded to ${thresholds.maximumSeasons} seasons`);
  }
  if (input.players.length + input.schedules.length > thresholds.maximumFacts) {
    throw new Error(`coverage audit is bounded to ${thresholds.maximumFacts} total facts`);
  }
  if (heldOutSeasons.some((season) => !seasons.includes(season))) {
    throw new Error("every held-out season must be present in seasons");
  }
  if (seasons.some((season) => season < 2009 || season > 2200)) {
    throw new Error("seasons must be between 2009 and 2200");
  }

  const playerIndexes = new Map<RosCoverageDataset, Map<string, Set<string>>>([
    ["weekly-stats", new Map()],
    ["weekly-rosters", new Map()],
    ["injuries", new Map()],
    ["snap-counts", new Map()],
  ]);
  const seasonDatasetRows = new Map<string, number>();
  for (const fact of input.players) {
    if (
      !seasons.includes(fact.season) ||
      !Number.isSafeInteger(fact.week) ||
      fact.week < 1 ||
      fact.week > 25 ||
      !POSITION_SET.has(fact.position) ||
      fact.playerId.trim().length === 0
    ) {
      throw new Error("player coverage facts contain an invalid season, week, position, or id");
    }
    addPlayer(
      playerIndexes.get(fact.dataset) as Map<string, Set<string>>,
      factKey(fact.season, fact.week, fact.position),
      fact.playerId,
    );
    const countKey = `${fact.season}:${fact.dataset}`;
    seasonDatasetRows.set(countKey, (seasonDatasetRows.get(countKey) ?? 0) + 1);
  }

  const schedules = new Map<string, { games: Set<string>; completed: Set<string> }>();
  for (const fact of input.schedules) {
    if (
      !seasons.includes(fact.season) ||
      !Number.isSafeInteger(fact.week) ||
      fact.week < 1 ||
      fact.week > 25 ||
      fact.gameId.trim().length === 0
    ) {
      throw new Error("schedule coverage facts contain an invalid season, week, or game id");
    }
    const key = scheduleKey(fact.season, fact.week);
    const week = schedules.get(key) ?? { games: new Set<string>(), completed: new Set<string>() };
    week.games.add(fact.gameId);
    if (fact.complete) week.completed.add(fact.gameId);
    schedules.set(key, week);
  }

  const seasonReports = heldOutSeasons.map((season): RosSeasonCoverage => {
    const priorSeasonCoverage = seasons
      .filter((candidate) => candidate < season)
      .map((candidate): RosPriorSeasonCoverage => {
        const weeklyStatRows = seasonDatasetRows.get(`${candidate}:weekly-stats`) ?? 0;
        const weeklyRosterRows = seasonDatasetRows.get(`${candidate}:weekly-rosters`) ?? 0;
        const injuryRows = seasonDatasetRows.get(`${candidate}:injuries`) ?? 0;
        const snapRows = seasonDatasetRows.get(`${candidate}:snap-counts`) ?? 0;
        const scheduleWeeks = [...schedules.entries()].filter(([key]) =>
          key.startsWith(`${candidate}:`),
        );
        const scheduleGames = scheduleWeeks.reduce(
          (total, [, value]) => total + value.games.size,
          0,
        );
        const completedScheduleGames = scheduleWeeks.reduce(
          (total, [, value]) => total + value.completed.size,
          0,
        );
        const missingDatasets: string[] = [];
        if (weeklyStatRows === 0) missingDatasets.push("weekly-stats");
        if (weeklyRosterRows === 0) missingDatasets.push("weekly-rosters");
        if (injuryRows === 0) missingDatasets.push("injuries");
        if (snapRows === 0) missingDatasets.push("snap-counts");
        if (scheduleGames === 0) missingDatasets.push("schedules");
        else if (completedScheduleGames !== scheduleGames)
          missingDatasets.push("incomplete-schedules");
        return {
          season: candidate,
          weeklyStatRows,
          weeklyRosterRows,
          injuryRows,
          snapRows,
          scheduleGames,
          completedScheduleGames,
          complete: missingDatasets.length === 0,
          missingDatasets,
        };
      });
    const priorSeasons = priorSeasonCoverage
      .filter((candidate) => candidate.complete)
      .map((candidate) => candidate.season);
    const expectedWeeks: number[] = [];
    for (const key of schedules.keys()) {
      const separator = key.indexOf(":");
      const keySeason = Number(key.slice(0, separator));
      const keyWeek = Number(key.slice(separator + 1));
      if (keySeason === season && keyWeek >= 2) expectedWeeks.push(keyWeek);
    }
    expectedWeeks.sort((left, right) => left - right);
    const weekReports = expectedWeeks.map((targetWeek): RosWeekCoverage => {
      const asOfWeek = targetWeek - 1;
      const schedule = schedules.get(scheduleKey(season, targetWeek));
      const positionReports = ROS_COVERAGE_POSITIONS.map((position): RosPositionCoverage => {
        const targetStats =
          playerIndexes.get("weekly-stats")?.get(factKey(season, targetWeek, position)) ??
          new Set<string>();
        const priorStats =
          playerIndexes.get("weekly-stats")?.get(factKey(season, asOfWeek, position)) ??
          new Set<string>();
        const priorRosters =
          playerIndexes.get("weekly-rosters")?.get(factKey(season, asOfWeek, position)) ??
          new Set<string>();
        const priorSnaps =
          playerIndexes.get("snap-counts")?.get(factKey(season, asOfWeek, position)) ??
          new Set<string>();
        const priorInjuries =
          playerIndexes.get("injuries")?.get(factKey(season, asOfWeek, position)) ??
          new Set<string>();
        const rosterMatches = [...priorStats].filter((playerId) =>
          priorRosters.has(playerId),
        ).length;
        const snapMatches = [...priorStats].filter((playerId) => priorSnaps.has(playerId)).length;
        const rosterMatchRate = rate(rosterMatches, priorStats.size);
        const snapMatchRate = rate(snapMatches, priorStats.size);
        const reasons: string[] = [];
        if (targetStats.size < thresholds.minimumPlayersPerPosition)
          reasons.push("missing_outcomes");
        if (priorStats.size < thresholds.minimumPlayersPerPosition)
          reasons.push("missing_prior_stats");
        if (priorRosters.size < thresholds.minimumPlayersPerPosition)
          reasons.push("missing_rosters");
        if (priorSnaps.size < thresholds.minimumPlayersPerPosition) reasons.push("missing_snaps");
        if (rosterMatchRate === null || rosterMatchRate < thresholds.minimumRosterMatchRate) {
          reasons.push("roster_match_rate");
        }
        if (snapMatchRate === null || snapMatchRate < thresholds.minimumSnapMatchRate) {
          reasons.push("snap_match_rate");
        }
        return {
          position,
          outcomePlayers: targetStats.size,
          priorStatPlayers: priorStats.size,
          priorRosterPlayers: priorRosters.size,
          priorSnapPlayers: priorSnaps.size,
          priorInjuryReports: priorInjuries.size,
          rosterMatches,
          snapMatches,
          rosterMatchRate,
          snapMatchRate,
          missingRosterPlayerIds: boundedMissingIds(priorStats, priorRosters),
          missingSnapPlayerIds: boundedMissingIds(priorStats, priorSnaps),
          complete: reasons.length === 0,
          reasons,
        };
      });
      const injuryBatchRows = positionReports.reduce(
        (total, position) => total + position.priorInjuryReports,
        0,
      );
      const reasons: string[] = [];
      if (!schedule || schedule.games.size === 0) reasons.push("missing_schedule");
      else if (schedule.completed.size !== schedule.games.size) reasons.push("incomplete_schedule");
      if (injuryBatchRows === 0) reasons.push("missing_injury_batch");
      if (positionReports.some((position) => !position.complete)) {
        reasons.push("position_coverage");
      }
      return {
        targetWeek,
        asOfWeek,
        scheduleGames: schedule?.games.size ?? 0,
        completedScheduleGames: schedule?.completed.size ?? 0,
        injuryBatchRows,
        positions: positionReports,
        complete: reasons.length === 0,
        reasons,
      };
    });
    const reasons: string[] = [];
    if (priorSeasons.length < thresholds.minimumPriorSeasons)
      reasons.push("insufficient_prior_seasons");
    if (expectedWeeks.length === 0) reasons.push("missing_regular_season_schedule");
    if (weekReports.some((week) => !week.complete)) reasons.push("incomplete_as_of_batches");
    const fullyHeldOut = reasons.length === 0;
    return {
      season,
      priorSeasons,
      priorSeasonCoverage,
      expectedWeeks,
      eligibleAsOfWeeks: weekReports.length,
      completeAsOfWeeks: weekReports.filter((week) => week.complete).length,
      fullyHeldOut,
      reasons,
      weeks: weekReports,
    };
  });

  const fullyHeldOutSeasons = seasonReports
    .filter((season) => season.fullyHeldOut)
    .map((season) => season.season);
  const completeAsOfBatches = seasonReports.reduce(
    (total, season) => total + season.completeAsOfWeeks,
    0,
  );
  const totalAsOfBatches = seasonReports.reduce(
    (total, season) => total + season.eligibleAsOfWeeks,
    0,
  );
  const reasons: string[] = [];
  if (fullyHeldOutSeasons.length < thresholds.minimumHeldOutSeasons) {
    reasons.push("insufficient_fully_held_out_seasons");
  }
  if (completeAsOfBatches < thresholds.minimumAsOfBatches) {
    reasons.push("insufficient_as_of_week_batches");
  }
  return {
    state: reasons.length === 0 ? "qualified" : "insufficient",
    thresholds,
    heldOutSeasonsRequested: heldOutSeasons,
    fullyHeldOutSeasons,
    completeAsOfBatches,
    totalAsOfBatches,
    reasons,
    seasons: seasonReports,
  };
}
