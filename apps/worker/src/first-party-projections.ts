import { createHash } from "node:crypto";

import {
  dataSources,
  fantasyTeams,
  leagueSeasons,
  nflScheduleObservations,
  playerExternalIds,
  playerInjuryReportObservations,
  playerProjections,
  playerSnapCountObservations,
  playerSourceObservations,
  playerWeeklyRosterObservations,
  playerWeeklyStatObservations,
  players,
  projectionModelRuns,
  projectionObservations,
  projectionSets,
  rosterEntries,
  rosterSnapshots,
  scoringRules,
  syncRuns,
  teamWeeklyStatObservations,
  type Database,
} from "@fantasy/db";
import {
  FIRST_PARTY_CHAMPION_MINIMUM_IMPROVEMENT,
  FIRST_PARTY_CHAMPION_MINIMUM_SAMPLES,
  FIRST_PARTY_CHAMPION_MINIMUM_WEEK_BATCHES,
  FIRST_PARTY_PROJECTION_MODEL_VERSION,
  LEAGUE_SCORING_NORMALIZATION_VERSION,
  LEAGUE_SCORING_POSITIONS,
  applyFirstPartyProjectionChampionPolicy,
  applyFirstPartyProjectionFinalPolicy,
  evaluateFirstPartyBacktestForScoringProfile,
  evaluateFirstPartyTeamDefenseBacktestForScoringProfile,
  firstPartyChampionStrategyForPosition,
  firstPartyProjectionComponentsForPosition,
  firstPartyProjectionPositionIsSupported,
  firstPartyTeamDefenseProjectionComponents,
  normalizeLeagueScoringProfile,
  projectFirstPartyRecencyBaselineComponents,
  projectFirstPartyTeamDefenseComponents,
  projectFirstPartyWeeklyComponents,
  projectionScoringProfileKey,
  runFirstPartyProjectionBacktest,
  runFirstPartyTeamDefenseBacktest,
  scoreProjectionStatComponents,
  type FirstPartyPointResidualCalibration,
  type FirstPartyPlayerStatus,
  type FirstPartyProjectionChampionPolicy,
  type FirstPartyProjectionBacktest,
  type FirstPartyScoredBacktestEvaluation,
  type FirstPartyScoredTeamDefenseEvaluation,
  type FirstPartyTeamDefenseBacktest,
  type FirstPartyTeamDefenseProjection,
  type FirstPartyWeeklyProjection,
  type LeagueScoringPosition,
  type LeagueScoringPositionSupport,
  type LeagueScoringUnsupportedReason,
  type ProjectionScoringProfile,
  type ProjectionStatComponents,
} from "@fantasy/projections";
import { and, count, desc, eq, inArray, or, sql, type SQLWrapper } from "drizzle-orm";

import {
  buildFirstPartyDefenseHistory,
  buildFirstPartyPlayerHistory,
  firstPartyInputEpoch,
  firstPartyPlayerStatus,
  projectionInputChecksum,
  recentRoleContext,
  FIRST_PARTY_INPUT_EPOCH_VERSION,
  type ProjectionEpochSource,
  type ProjectionScheduleFact,
  type ProjectionInjuryFact,
  type ProjectionSnapFact,
  type ProjectionRosterFact,
  type ProjectionTeamWeekFact,
  type ProjectionWeeklyFact,
} from "./first-party-projection-inputs.js";
import type { ProjectionRefreshJob, ProjectionRefreshService, WorkerJobContext } from "./jobs.js";

export const FIRST_PARTY_PROJECTION_SOURCE_KEY = "laces-out.projections.first-party";
export const FIRST_PARTY_PROJECTION_SET_SOURCE = "laces-out-first-party";

const projectionCheckIntervalMinutes = 60;
const historySeasonCount = 4;
// v5 adds lock-safe raw publication, exact completeness accounting, and source-availability gates.
const sourceSchemaVersion = 5;
const championPolicyVersion = "walk-forward-mae-v1";
const chunkSize = 500;
const supportedPositions = ["QB", "RB", "WR", "TE", "K"] as const;
const defensePositions = new Set(["D/ST", "DST", "DEF"]);
const espnSelfAssertedPlayerSource = "espn-self-asserted";
// Disclosure of every D/ST modelling choice a league's numbers depend on but cannot be read off
// them. Reaches the published set's metadata and every league's warning list, so a user who asks
// "how was this computed" gets the answer with the number rather than out of band.
const defenseMethodWarnings = [
  "points_allowed_method=provider-neutral-adjusted-score",
  "blocked_kicks_classification=rare blocked-kick returns can be classified differently by Yahoo and ESPN",
  // `docs/plans/ROS_GATE_AND_DST_PLAN.md` WP4 Step 4. Stated as an assumption because it is one: whether
  // ESPN's "yards allowed" is exactly this quantity has not been established from ESPN's own docs.
  "yards_allowed_method=net offensive yards (passing + sack yardage + rushing); the assumption that this equals the provider's own yards-allowed definition is disclosed, not proved",
  // `docs/dst-stat-id-evidence-2026-07-29.md` §4. These two components are modeled at a constant
  // zero under the de minimis criterion, so a league that prices ESPN 206/209 gets the same number
  // as one that does not. Disclosed here because the rule is present and priced — its coefficient
  // is what is bounded, and a reader is entitled to know that before trusting the total.
  "de_minimis_zero_components=defensive_two_point_returns (ESPN 206) and one_point_safeties (ESPN 209) are modeled at constant zero; citable occurrence data bounds each below 0.01 expected points per team-week (docs/dst-stat-id-evidence-2026-07-29.md §4)",
] as const;
const availabilityMethodWarning =
  "Availability adjustments use the latest provider designation within seven days of kickoff; IR/PUP is held out for up to 28 days, then treated as uncertain until a return horizon is known.";
const minimumIntervalCoverage = 0.62;
const maximumIntervalCoverage = 0.78;
const minimumIntervalCoverageSamples = 100;
const minimumPositionScoredSamples = 100;
// Derived from the projection engine's own defense vocabulary rather than hand-typed, so this set
// structurally cannot drift from the components the engine emits (`docs/plans/ROS_GATE_AND_DST_PLAN.md`
// WP2 Step 1, "one source of truth").
const defenseStatIds = new Set(firstPartyTeamDefenseProjectionComponents());

const publicationGateProfile: ProjectionScoringProfile = {
  id: "laces-out-publication-gate-ppr",
  version: "1",
  rules: [
    { statId: "passing_yards", points: 0.04 },
    { statId: "passing_touchdowns", points: 4 },
    { statId: "passing_interceptions", points: -2 },
    { statId: "rushing_yards", points: 0.1 },
    { statId: "rushing_touchdowns", points: 6 },
    { statId: "receptions", points: 1 },
    { statId: "receiving_yards", points: 0.1 },
    { statId: "receiving_touchdowns", points: 6 },
    { statId: "fumbles_lost", points: -2 },
    { statId: "field_goals_made_0_19", points: 3 },
    { statId: "field_goals_made_20_29", points: 3 },
    { statId: "field_goals_made_30_39", points: 3 },
    { statId: "field_goals_made_40_49", points: 4 },
    { statId: "field_goals_made_50_plus", points: 5 },
    { statId: "field_goals_missed", points: -1 },
    { statId: "extra_points_made", points: 1 },
    { statId: "defensive_sacks", points: 1 },
    { statId: "defensive_interceptions", points: 2 },
    { statId: "defensive_fumble_recoveries", points: 2 },
    { statId: "defensive_safeties", points: 2 },
    { statId: "defensive_touchdowns", points: 6 },
    { statId: "defensive_blocked_kicks", points: 2 },
    { statId: "special_teams_touchdowns", points: 6 },
    { statId: "points_allowed_0_probability", points: 10 },
    { statId: "points_allowed_1_6_probability", points: 7 },
    { statId: "points_allowed_7_13_probability", points: 4 },
    { statId: "points_allowed_14_20_probability", points: 1 },
    { statId: "points_allowed_21_27_probability", points: 0 },
    { statId: "points_allowed_28_34_probability", points: -1 },
    { statId: "points_allowed_35_plus_probability", points: -4 },
  ],
};

interface SelectedSource {
  readonly id: string;
  readonly key: string;
  readonly checksum: string;
  readonly lastSuccessfulAt: Date;
  readonly lastCheckedAt: Date;
  readonly checkIntervalMinutes: number;
  readonly metadata: Record<string, unknown>;
}

interface PlayerRow {
  readonly id: string;
  readonly gsisId: string | null;
  readonly fullName: string;
  readonly nflTeam: string | null;
  readonly primaryPosition: string;
  readonly status: string | null;
  readonly lastSeason: number | null;
}

interface LeagueRow {
  readonly id: string;
  readonly provider: string;
  readonly currentWeek: number | null;
  readonly teamCount: number;
}

interface LeagueRuleRow {
  readonly leagueSeasonId: string;
  readonly statKey: string;
  readonly operation: string;
  readonly points: string;
  readonly thresholdLow: string | null;
  readonly thresholdHigh: string | null;
  readonly providerStatId: string | null;
}

interface LeagueRosterPlayer {
  readonly leagueSeasonId: string;
  readonly playerId: string;
  readonly primaryPosition: string;
  readonly nflTeam: string | null;
}

interface PublishedPlayer {
  readonly playerId: string;
  readonly externalPlayerId: string;
  readonly position: string;
  readonly team: string;
  readonly projection: FirstPartyWeeklyProjection;
  readonly modelProjection: FirstPartyWeeklyProjection;
  readonly baselineProjection: FirstPartyWeeklyProjection;
  readonly leagueSeasonScopes: readonly string[];
  readonly canonicalMatchId?: string;
  readonly gameStarted: boolean;
}

interface PublishedDefense {
  readonly team: string;
  readonly projection: FirstPartyTeamDefenseProjection;
  readonly gameStarted: boolean;
}

export interface ScoredProjectionRow {
  readonly playerId: string;
  readonly mean: number;
  readonly floor: number;
  readonly ceiling: number;
  readonly confidence: number;
  readonly components: Record<string, number>;
}

interface LeaguePublication {
  readonly league: LeagueRow;
  readonly profile: ProjectionScoringProfile;
  readonly profileKey: string;
  readonly rows: readonly ScoredProjectionRow[];
  readonly version: string;
  readonly inputChecksum: string;
  readonly metadata: Record<string, unknown>;
}

/**
 * Why one position of one league was withheld. `source` keeps a scoring-rule fact ("this league
 * prices something no supported projection component can express") distinguishable from an
 * operational one ("this position's league-scored backtest did not beat its baseline"), which the
 * flat `reasons` strings alone cannot express.
 */
export interface WithheldLeaguePosition {
  readonly position: LeagueScoringPosition;
  readonly source: "normalization" | "backtest-gate";
  readonly reasons: readonly string[];
}

/**
 * `scope: "league"` is the pre-existing meaning: this league published nothing at all, and
 * `reasons` alone describes why. `scope: "positions"` is new and additive: the league DID publish,
 * but only for the positions absent from `positions`. Both keep `reasons` populated so a reader
 * that only knows the old flat-string shape still sees a truthful explanation.
 */
export interface WithheldLeague {
  readonly leagueSeasonId: string;
  readonly scope: "league" | "positions";
  readonly reasons: readonly string[];
  readonly positions?: readonly WithheldLeaguePosition[];
}

/**
 * Something worth recording about a league that PUBLISHED. Deliberately a separate accumulator from
 * `withheld`: a note must never be mistaken for a withholding, because `apps/api` turns a withheld
 * entry into a "withheld" managed-forecast state and the workbench hides the forecast on that state.
 */
export interface LeaguePublicationNote {
  readonly leagueSeasonId: string;
  readonly code: "pre-draft-roster";
  readonly message: string;
}

interface LeaguePublicationPlan {
  readonly publications: readonly LeaguePublication[];
  readonly withheld: readonly WithheldLeague[];
  readonly notes: readonly LeaguePublicationNote[];
}

interface ModelGate {
  readonly state: "publishable" | "degraded" | "rejected";
  readonly reasons: readonly string[];
}

interface PublicationAttempt {
  readonly committed: boolean;
  readonly published: boolean;
  readonly gate: ModelGate;
}

interface PriorOutputsState {
  readonly complete: boolean;
  readonly immutableOutputIncomplete?: boolean;
  readonly qualityState?: ModelGate["state"];
  readonly qualityReasons?: string;
  readonly lastPublishedAt?: string;
}

interface CachedTrainingArtifacts {
  readonly key: string;
  readonly completedPlayerHistory: ReturnType<typeof buildFirstPartyPlayerHistory>;
  readonly completedDefenseHistory: ReturnType<typeof buildFirstPartyDefenseHistory>;
  readonly basePlayerBacktest: FirstPartyProjectionBacktest;
  readonly playerChampion: ReturnType<typeof applyFirstPartyProjectionChampionPolicy>;
  readonly publicationPlayerBacktest: FirstPartyProjectionBacktest;
  readonly defenseBacktest: FirstPartyTeamDefenseBacktest;
  readonly gate: ModelGate;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Stable app-owned UUID for an NFL team-defense entity; it never aliases provider player IDs. */
export function firstPartyDefensePlayerId(team: string): string {
  const normalized = team.trim().toUpperCase();
  if (!/^[A-Z]{2,4}$/u.test(normalized)) {
    throw new TypeError("NFL team code must contain two to four uppercase letters");
  }
  const bytes = Buffer.from(
    sha256(`laces-out:first-party-defense:${normalized}`).slice(0, 32),
    "hex",
  );
  // UUIDv8 reserves this version for application-defined, deterministic payloads.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function numeric(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError("Database numeric value is not finite");
  return parsed;
}

function upper(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase();
  return normalized ? normalized : null;
}

function playerIdentityKey(
  player: Pick<PlayerRow, "fullName" | "nflTeam" | "primaryPosition">,
): string | undefined {
  const team = upper(player.nflTeam);
  const name = player.fullName.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  const position = player.primaryPosition.trim().toUpperCase();
  return name && team && position ? `${name}|${team}|${position}` : undefined;
}

/** Explicit provider crosswalks outrank display-name matching for a non-canonical roster row. */
export function canonicalProjectionPlayerId(input: {
  readonly playerId: string;
  readonly hasGsisId: boolean;
  readonly explicitMatchId?: string;
  readonly exactMatchId?: string;
}): string {
  if (input.hasGsisId) return input.playerId;
  return input.explicitMatchId ?? input.exactMatchId ?? input.playerId;
}

/** Returns the owning league-season encoded by an ESPN self-asserted player observation. */
export function espnSelfAssertedProjectionLeague(externalId: string): string | undefined {
  const separator = externalId.indexOf(":");
  const candidate = separator < 0 ? "" : externalId.slice(0, separator).toLowerCase();
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
    candidate,
  )
    ? candidate
    : undefined;
}

function scheduleWeekKey(season: number, week: number): string {
  return `${season}:${week}`;
}

const CONSERVATIVE_FINAL_ELAPSED_MS = 4 * 60 * 60 * 1000;

/**
 * The nflverse schedule feed only distinguishes `scheduled`/`final` by score presence, so a score
 * appearing while a game is still live could otherwise read as a completed week (see
 * remaining weekly-production risks). A game is trusted as final only
 * once an in-progress/scheduled/postponed status is ruled out, scores are present, and, when the
 * kickoff time is known, a conservative floor has elapsed since kickoff. An unknown kickoff falls
 * back to the score-presence signal alone, the only completeness signal this feed provides.
 */
export function projectionGameIsConservativelyFinal(
  game: Pick<ProjectionScheduleFact, "awayScore" | "homeScore" | "kickoffAt" | "status">,
  now: Date,
): boolean {
  if (game.status === "in-progress" || game.status === "scheduled" || game.status === "postponed") {
    return false;
  }
  if (game.awayScore === null || game.homeScore === null) return false;
  if (game.kickoffAt === null || game.kickoffAt === undefined) return true;
  return now.getTime() - game.kickoffAt.getTime() >= CONSERVATIVE_FINAL_ELAPSED_MS;
}

function completedScheduleWeekKeys(
  schedule: readonly Pick<
    ProjectionScheduleFact,
    "season" | "week" | "awayScore" | "homeScore" | "kickoffAt" | "status"
  >[],
  now: Date,
): ReadonlySet<string> {
  const progress = new Map<string, { games: number; final: number }>();
  for (const game of schedule) {
    const key = scheduleWeekKey(game.season, game.week);
    const current = progress.get(key) ?? { games: 0, final: 0 };
    current.games += 1;
    if (projectionGameIsConservativelyFinal(game, now)) current.final += 1;
    progress.set(key, current);
  }
  return new Set(
    [...progress].flatMap(([key, value]) =>
      value.games > 0 && value.final === value.games ? [key] : [],
    ),
  );
}

export function projectionStatusWeek(
  schedule: readonly Pick<
    ProjectionScheduleFact,
    "season" | "week" | "awayScore" | "homeScore" | "kickoffAt" | "status"
  >[],
  season: number,
  now: Date = new Date(),
): number | undefined {
  const progress = new Map<number, { games: number; final: number }>();
  for (const game of schedule) {
    if (game.season !== season || game.week < 1 || game.week > 18) continue;
    const current = progress.get(game.week) ?? { games: 0, final: 0 };
    current.games += 1;
    if (projectionGameIsConservativelyFinal(game, now)) current.final += 1;
    progress.set(game.week, current);
  }
  const firstIncomplete = [...progress]
    .filter(([, value]) => value.final < value.games)
    .sort(([left], [right]) => left - right)[0];
  return firstIncomplete?.[0];
}

/** Bounds current provider designations to the game horizon where they remain actionable. */
export function firstPartyStatusForKickoff(
  values: readonly (string | null | undefined)[],
  kickoffAt: Date | null | undefined,
  now: Date,
): FirstPartyPlayerStatus {
  const status = firstPartyPlayerStatus(...values);
  const window = projectionStatusWindow(kickoffAt, now);
  if (window === "short-window" || window === "started") return status;
  if ((status === "ir" || status === "pup") && window === "reserve-window") return status;
  return "unknown";
}

export function projectionStatusWindow(
  kickoffAt: Date | null | undefined,
  now: Date,
): "unknown-time" | "outside-28d" | "reserve-window" | "short-window" | "started" {
  if (kickoffAt === null || kickoffAt === undefined) return "unknown-time";
  const millisecondsToKickoff = kickoffAt.getTime() - now.getTime();
  if (millisecondsToKickoff <= 0) return "started";
  const daysToKickoff = millisecondsToKickoff / (24 * 60 * 60 * 1_000);
  if (daysToKickoff <= 7) return "short-window";
  if (daysToKickoff <= 28) return "reserve-window";
  return "outside-28d";
}

export function projectionTrainingCacheKey(input: {
  readonly firstTargetWeek: number;
  readonly statisticalSources: readonly { readonly key: string; readonly checksum: string }[];
  readonly playerPositions: readonly { readonly id: string; readonly position: string }[];
  readonly completedSchedule: readonly {
    readonly season: number;
    readonly week: number;
    readonly gameId: string;
    readonly awayTeam: string;
    readonly homeTeam: string;
    readonly awayScore: number | null;
    readonly homeScore: number | null;
  }[];
}): string {
  return projectionInputChecksum({
    modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
    sourceSchemaVersion,
    ...input,
  });
}

function isDefensePosition(position: string): boolean {
  return defensePositions.has(position.trim().toUpperCase());
}

function chunks<T>(rows: readonly T[]): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += chunkSize) {
    result.push(rows.slice(index, index + chunkSize));
  }
  return result;
}

export function projectionHistorySeasons(season: number): readonly number[] {
  if (!Number.isSafeInteger(season) || season < 2000 || season > 2200) {
    throw new RangeError("Projection season must be between 2000 and 2200");
  }
  return Array.from({ length: historySeasonCount }, (_, index) => season - 3 + index);
}

export function requiredFirstPartyProjectionSourceKeys(season: number): {
  readonly required: readonly string[];
  readonly optional: readonly string[];
} {
  const seasons = projectionHistorySeasons(season);
  const completed = seasons.filter((candidate) => candidate < season);
  return {
    required: [
      "nflverse.players",
      "sleeper.players",
      ...seasons.map((candidate) => `nflverse.schedules.${candidate}`),
      ...completed.map((candidate) => `nflverse.stats-player-week.${candidate}`),
      ...completed.map((candidate) => `nflverse.stats-team-week.${candidate}`),
      ...completed.map((candidate) => `nflverse.snap-counts.${candidate}`),
      ...completed.map((candidate) => `nflverse.weekly-rosters.${candidate}`),
      ...completed.map((candidate) => `nflverse.injuries.${candidate}`),
    ],
    optional: [
      `nflverse.stats-player-week.${season}`,
      `nflverse.stats-team-week.${season}`,
      `nflverse.snap-counts.${season}`,
      `nflverse.weekly-rosters.${season}`,
      `nflverse.injuries.${season}`,
    ],
  };
}

export function projectionTargetWeeks(
  schedule: readonly Pick<
    ProjectionScheduleFact,
    "season" | "week" | "awayScore" | "homeScore" | "kickoffAt" | "status"
  >[],
  season: number,
  requestedWeek?: number,
  now: Date = new Date(),
): readonly number[] {
  if (requestedWeek !== undefined) {
    if (!Number.isSafeInteger(requestedWeek) || requestedWeek < 1 || requestedWeek > 18) {
      throw new RangeError("Projection week must be between 1 and 18");
    }
    const requestedGames = schedule.filter(
      (game) => game.season === season && game.week === requestedWeek,
    );
    if (requestedGames.length === 0) {
      throw new Error(`No regular-season schedule was available for week ${requestedWeek}`);
    }
    if (requestedGames.every((game) => projectionGameIsConservativelyFinal(game, now))) {
      throw new Error(`Projection week ${requestedWeek} has already finished`);
    }
    return [requestedWeek];
  }
  const weeks = new Map<number, { games: number; final: number }>();
  for (const game of schedule) {
    if (game.season !== season || game.week < 1 || game.week > 18) continue;
    const current = weeks.get(game.week) ?? { games: 0, final: 0 };
    current.games += 1;
    if (projectionGameIsConservativelyFinal(game, now)) current.final += 1;
    weeks.set(game.week, current);
  }
  return [...weeks]
    .filter(([, progress]) => progress.games > 0 && progress.final < progress.games)
    .map(([week]) => week)
    .sort((left, right) => left - right)
    .slice(0, 2);
}

/** A scheduled game without a trustworthy kickoff must never remain mutable indefinitely. */
export function projectionWeekHasUnknownKickoff(
  schedule: readonly Pick<
    ProjectionScheduleFact,
    "season" | "week" | "kickoffAt" | "awayScore" | "homeScore" | "status"
  >[],
  season: number,
  week: number,
): boolean {
  return schedule.some(
    (game) =>
      game.season === season &&
      game.week === week &&
      game.status !== "final" &&
      game.status !== "cancelled" &&
      (game.awayScore === null || game.homeScore === null) &&
      (game.kickoffAt === null || game.status === "postponed"),
  );
}

/** Raw model components remain anchored to the final observation written before kickoff. */
export function projectionRawObservationIsUnlocked(gameStarted: boolean): boolean {
  return !gameStarted;
}

/** Applies the kickoff immutability rule to the exact rows offered to raw publication. */
export function projectionUnlockedRawRows<T extends { readonly gameStarted: boolean }>(
  rows: readonly T[],
): readonly T[] {
  return rows.filter((row) => projectionRawObservationIsUnlocked(row.gameStarted));
}

export function projectionModelGate(input: {
  readonly player: FirstPartyScoredBacktestEvaluation;
  readonly defense: FirstPartyScoredTeamDefenseEvaluation;
  readonly playerPredictions: number;
  readonly defensePredictions: number;
}): ModelGate {
  const reasons: string[] = [];
  if (input.playerPredictions === 0 || input.player.overall.samples < 100) {
    reasons.push("player_backtest_sample_too_small");
  }
  if (input.defensePredictions === 0 || input.defense.overall.samples < 48) {
    reasons.push("defense_backtest_sample_too_small");
  }
  for (const position of supportedPositions) {
    const evaluation = input.player.byPosition[position];
    if (!evaluation || evaluation.samples < minimumPositionScoredSamples) {
      reasons.push(`player_${position.toLowerCase()}_sample_too_small`);
      continue;
    }
    if (evaluation.baselineMae <= 0 || evaluation.mae > evaluation.baselineMae) {
      reasons.push(`player_${position.toLowerCase()}_did_not_clear_recency_baseline`);
    }
    if (
      evaluation.intervalCoverage === null ||
      evaluation.intervalCoverageSamples < minimumIntervalCoverageSamples
    ) {
      reasons.push(`player_${position.toLowerCase()}_interval_sample_too_small`);
    } else if (
      evaluation.intervalCoverage < minimumIntervalCoverage ||
      evaluation.intervalCoverage > maximumIntervalCoverage
    ) {
      reasons.push(`player_${position.toLowerCase()}_interval_miscalibrated`);
    }
    if (Math.abs(evaluation.bias) > pointBiasLimit(evaluation)) {
      reasons.push(`player_${position.toLowerCase()}_bias_exceeded`);
    }
  }
  if (
    input.player.overall.baselineMae <= 0 ||
    input.player.overall.mae > input.player.overall.baselineMae
  ) {
    reasons.push("player_model_did_not_clear_recency_baseline");
  }
  if (
    input.defense.overall.baselineMae <= 0 ||
    input.defense.overall.mae > input.defense.overall.baselineMae
  ) {
    reasons.push("defense_model_did_not_clear_recency_baseline");
  }
  for (const [label, evaluation] of [
    ["player", input.player.overall],
    ["defense", input.defense.overall],
  ] as const) {
    if (
      evaluation.intervalCoverage === null ||
      evaluation.intervalCoverageSamples < minimumIntervalCoverageSamples
    ) {
      reasons.push(`${label}_interval_sample_too_small`);
    } else if (
      evaluation.intervalCoverage < minimumIntervalCoverage ||
      evaluation.intervalCoverage > maximumIntervalCoverage
    ) {
      reasons.push(`${label}_interval_miscalibrated`);
    }
    if (Math.abs(evaluation.bias) > pointBiasLimit(evaluation)) {
      reasons.push(`${label}_bias_exceeded`);
    }
  }
  if (reasons.some((reason) => reason.endsWith("sample_too_small"))) {
    return { state: "rejected", reasons };
  }
  return reasons.length === 0
    ? { state: "publishable", reasons: [] }
    : { state: "degraded", reasons };
}

function pointBiasLimit(evaluation: FirstPartyPointResidualCalibration): number {
  return Math.max(0.5, Math.min(1, evaluation.mae * 0.15));
}

export function leagueScoredInterval(
  mean: number,
  calibration: FirstPartyPointResidualCalibration,
): { readonly floor: number; readonly ceiling: number } {
  const lower = mean + calibration.lowerError;
  const upper = mean + calibration.upperError;
  return {
    floor: Math.min(mean, lower, upper),
    ceiling: Math.max(mean, lower, upper),
  };
}

export function leagueScoredMean(
  rawMean: number,
  calibration: FirstPartyPointResidualCalibration,
): number {
  return rawMean + calibration.centerAdjustment;
}

export function rescoreFrozenProjection(
  row: ScoredProjectionRow,
  profile: ProjectionScoringProfile,
  calibration: FirstPartyPointResidualCalibration,
): ScoredProjectionRow {
  const rawMean = scoreProjectionStatComponents(row.components, profile);
  const mean = leagueScoredMean(rawMean, calibration);
  const interval =
    row.floor === row.mean && row.ceiling === row.mean
      ? { floor: mean, ceiling: mean }
      : leagueScoredInterval(mean, calibration);
  return { ...row, mean, ...interval };
}

function augmentedKickerComponents(components: ProjectionStatComponents): Record<string, number> {
  return {
    ...components,
    field_goals_made_50_plus:
      (components.field_goals_made_50_59 ?? 0) + (components.field_goals_made_60_plus ?? 0),
  };
}

function projectionComponents(position: string, components: ProjectionStatComponents) {
  return position.trim().toUpperCase() === "K" ? augmentedKickerComponents(components) : components;
}

export function firstPartyAvailableProjectionComponents(): readonly string[] {
  return [
    ...new Set([
      ...supportedPositions.flatMap((position) =>
        firstPartyProjectionComponentsForPosition(position),
      ),
      "field_goals_made_50_plus",
      ...firstPartyTeamDefenseProjectionComponents(),
    ]),
  ].sort();
}

function residualForPlayer(
  evaluation: FirstPartyScoredBacktestEvaluation,
  _playerId: string,
  position: string,
): FirstPartyPointResidualCalibration {
  return (
    evaluation.byPosition[position.trim().toUpperCase() as keyof typeof evaluation.byPosition] ??
    evaluation.overall
  );
}

/**
 * The user-visible "Locked backtest" summary, aggregated ONLY over the positions this league's own
 * scoring rules support — never `evaluation.overall`, which aggregates across every backtested
 * position (QB/RB/WR/TE/K) regardless of what the league prices. A league whose emitted profile
 * prices kickers only still backtests every position, and every QB/RB/WR/TE prediction scores
 * `actual === projected === baseline === 0` (`scoreProjectionStatComponents` returns 0 for a
 * component the profile never rates) — an exactly-zero residual that deflates `overall.mae` and
 * `overall.baselineMae` toward "perfect" for a set that never publishes those positions at all.
 * Weighted by each supported position's own `samples` (and, for interval coverage, its own
 * `intervalCoverageSamples`) so a position with more evaluated weeks counts proportionally more.
 */
function backtestSummaryForSupportedPositions(
  evaluation: FirstPartyScoredBacktestEvaluation,
  supportedByLeague: ReadonlySet<LeagueScoringPosition>,
): {
  readonly samples: number;
  readonly mae: number;
  readonly baselineMae: number;
  readonly intervalCoverage: number | null;
} {
  let samples = 0;
  let maeTotal = 0;
  let baselineMaeTotal = 0;
  let coverageSamples = 0;
  let coverageTotal = 0;
  for (const position of supportedPositions) {
    if (!supportedByLeague.has(position)) continue;
    const positionEvaluation = evaluation.byPosition[position];
    if (positionEvaluation === undefined || positionEvaluation.samples === 0) continue;
    samples += positionEvaluation.samples;
    maeTotal += positionEvaluation.mae * positionEvaluation.samples;
    baselineMaeTotal += positionEvaluation.baselineMae * positionEvaluation.samples;
    if (positionEvaluation.intervalCoverage !== null) {
      coverageTotal +=
        positionEvaluation.intervalCoverage * positionEvaluation.intervalCoverageSamples;
      coverageSamples += positionEvaluation.intervalCoverageSamples;
    }
  }
  return {
    samples,
    mae: samples === 0 ? 0 : maeTotal / samples,
    baselineMae: samples === 0 ? 0 : baselineMaeTotal / samples,
    intervalCoverage: coverageSamples === 0 ? null : coverageTotal / coverageSamples,
  };
}

function residualForDefense(
  evaluation: FirstPartyScoredTeamDefenseEvaluation,
): FirstPartyPointResidualCalibration {
  return evaluation.overall;
}

function hasRelevantRules(profile: ProjectionScoringProfile, defense: boolean): boolean {
  return profile.rules.some((rule) => defenseStatIds.has(rule.statId) === defense);
}

function pointEvaluationClearsGate(evaluation: FirstPartyPointResidualCalibration): boolean {
  return (
    evaluation.samples >= minimumPositionScoredSamples &&
    evaluation.baselineMae > 0 &&
    evaluation.mae <= evaluation.baselineMae &&
    evaluation.intervalCoverage !== null &&
    evaluation.intervalCoverageSamples >= minimumIntervalCoverageSamples &&
    evaluation.intervalCoverage >= minimumIntervalCoverage &&
    evaluation.intervalCoverage <= maximumIntervalCoverage &&
    Math.abs(evaluation.bias) <= pointBiasLimit(evaluation)
  );
}

function defenseEvaluationClearsGate(
  evaluation: FirstPartyScoredBacktestEvaluation | FirstPartyScoredTeamDefenseEvaluation,
): boolean {
  return pointEvaluationClearsGate(evaluation.overall);
}

/**
 * One position's own league-scored backtest verdict. A position the profile prices nothing for is
 * not gated here (there is nothing to score); a position it does price must clear its own residual
 * gate. The verdict is deliberately NOT collapsed across positions: a failing K must withhold K,
 * not the league.
 */
function playerPositionEvaluationClearsGate(
  evaluation: FirstPartyScoredBacktestEvaluation,
  profile: ProjectionScoringProfile,
  position: (typeof supportedPositions)[number],
): boolean {
  const scoredStats = new Set(profile.rules.map((rule) => rule.statId));
  const components = firstPartyProjectionComponentsForPosition(position);
  const relevant =
    components.some((component) => scoredStats.has(component)) ||
    (position === "K" && scoredStats.has("field_goals_made_50_plus"));
  if (!relevant) return true;
  const positionEvaluation = evaluation.byPosition[position];
  return positionEvaluation !== undefined && pointEvaluationClearsGate(positionEvaluation);
}

/** The long-standing flat reason string for one normalization failure; shape unchanged. */
function normalizationReasonText(reason: LeagueScoringUnsupportedReason): string {
  return `${reason.code}: ${reason.message}`;
}

/**
 * The positions normalization could not price, each with its own attributed reasons. Present on
 * both normalization states, so the fully-unavailable branch reports per-position provenance too
 * instead of only a flat union.
 */
function normalizationWithheldPositions(
  positions: readonly LeagueScoringPositionSupport[],
): WithheldLeaguePosition[] {
  return positions
    .filter((item) => !item.supported)
    .map((item) => ({
      position: item.position,
      source: "normalization" as const,
      reasons: item.reasons.map(normalizationReasonText),
    }));
}

/**
 * Flattens per-position withholding into the pre-existing `reasons: readonly string[]` shape, so a
 * reader that predates `positions` still learns which positions were withheld and why.
 */
function withheldPositionReasonText(
  positions: readonly WithheldLeaguePosition[],
): readonly string[] {
  return positions.flatMap((item) =>
    item.reasons.map((reason) => `${item.position} withheld: ${reason}`),
  );
}

/** The placeholder `#loadLatestRosters` appends when a league's roster snapshots do not add up. */
function isIncompleteRosterSentinel(rosterPlayer: LeagueRosterPlayer): boolean {
  return rosterPlayer.playerId.startsWith("INCOMPLETE-ROSTER:");
}

export type LeagueRosterCoverage = "complete" | "pre-draft" | "unknown";

/**
 * What the loaded roster proves about a league, and nothing more.
 *
 * - `"complete"` — at least one real rostered player was loaded. (If an incomplete-snapshot
 *   sentinel sits alongside them the league is partially synced, and the roster-gap branch below
 *   withholds it before this ever reaches a published set.)
 * - `"pre-draft"` — snapshots exist for this league but yielded no rostered player anywhere, which
 *   is what a synced-but-undrafted league looks like: a snapshot per team, all of them empty.
 *   Nobody has drafted, so there is no roster coverage to verify and nothing to fail closed about.
 * - `"unknown"` — no roster rows at all, i.e. nothing was observed either way. This is NOT read as
 *   pre-draft: absence of evidence is not evidence of an undrafted league.
 *
 * The distinction that matters is real-player presence. It cannot be faked by a partial sync: the
 * moment one team's snapshot carries a player, the league is `"complete"` and takes the unchanged
 * roster-gap path.
 */
function leagueRosterCoverage(roster: readonly LeagueRosterPlayer[]): LeagueRosterCoverage {
  if (roster.length === 0) return "unknown";
  return roster.some((rosterPlayer) => !isIncompleteRosterSentinel(rosterPlayer))
    ? "complete"
    : "pre-draft";
}

/**
 * The publishable position a player row would carry, or `undefined` when the player's position is
 * withheld — or is not one this rail projects at all, which fails closed rather than publishing.
 */
function publishablePlayerPositionOf(
  publishable: ReadonlySet<(typeof supportedPositions)[number]>,
  position: string,
): (typeof supportedPositions)[number] | undefined {
  const normalized = position.trim().toUpperCase();
  return supportedPositions.find(
    (candidate) => candidate === normalized && publishable.has(candidate),
  );
}

function zeroComponents(keys: readonly string[]): Record<string, number> {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function normalizePlayerProjectionForSchedule(
  projection: FirstPartyWeeklyProjection,
  position: string,
  hasOpponent: boolean,
): FirstPartyWeeklyProjection {
  if (hasOpponent) return projection;
  const zeros = zeroComponents(firstPartyProjectionComponentsForPosition(position));
  return {
    ...projection,
    state: "zero",
    components: zeros,
    floorComponents: zeros,
    ceilingComponents: zeros,
    reasons: ["The player's NFL team has a confirmed bye in this week."],
  };
}

function sourceIsFresh(
  source: {
    readonly lastCheckedAt: Date | null;
    readonly lastSuccessfulAt: Date | null;
    readonly lastChecksum: string | null;
    readonly consecutiveFailures: number;
    readonly checkIntervalMinutes: number;
  },
  now: Date,
): boolean {
  if (
    source.lastCheckedAt === null ||
    source.lastSuccessfulAt === null ||
    source.lastChecksum === null ||
    source.consecutiveFailures > 0
  ) {
    return false;
  }
  const maximumAgeMinutes = source.checkIntervalMinutes * 3 + 30;
  const maximumAgeMilliseconds = maximumAgeMinutes * 60_000;
  return (
    now.getTime() - source.lastCheckedAt.getTime() <= maximumAgeMilliseconds &&
    now.getTime() - source.lastSuccessfulAt.getTime() <= maximumAgeMilliseconds
  );
}

export function sourceIsUsableForProjection(
  source: Parameters<typeof sourceIsFresh>[0] & {
    readonly metadata: Readonly<Record<string, unknown>>;
  },
  now: Date,
): boolean {
  // Observation ingestors deliberately retain a checksum for failed coverage gates so the bad
  // artifact remains auditable. A fresh checksum therefore is not, by itself, publication-safe.
  // Likewise, an upstream dataset can disappear temporarily after having published a valid
  // artifact. Its retained checksum is useful provenance, but `lastCheckedAt` must not make that
  // unavailable artifact look current to the projection release gate.
  const availability = source.metadata.availability;
  const refreshClaimedAt = source.metadata.refreshClaimedAt;
  return (
    source.metadata.publishable !== false &&
    (availability === undefined || availability === "available") &&
    refreshClaimedAt === undefined &&
    sourceIsFresh(source, now)
  );
}

function sourceVersionPredicate(
  sources: readonly SelectedSource[],
  sourceColumn: SQLWrapper,
  checksumColumn: SQLWrapper,
) {
  const conditions = sources.map((source) =>
    and(sql`${sourceColumn} = ${source.id}`, sql`${checksumColumn} = ${source.checksum}`),
  );
  return or(...conditions);
}

export class FirstPartyProjectionService implements ProjectionRefreshService {
  readonly #database: Database;
  readonly #now: () => Date;
  #trainingCache: CachedTrainingArtifacts | undefined;

  constructor(input: { readonly database: Database; readonly now?: () => Date }) {
    this.#database = input.database;
    this.#now = input.now ?? (() => new Date());
  }

  async refreshProjections(job: ProjectionRefreshJob, context: WorkerJobContext): Promise<void> {
    const now = this.#now();
    const source = await this.#ensureManagedSource(now);
    try {
      if (context.signal.aborted) throw new Error("Projection refresh was cancelled");
      const selectedSources = await this.#selectSources(job.season, now);
      // Captured immediately once every required source has been validated as fresh and usable.
      // Recomputed again just before persisting (see below), this proves no required source
      // (player stats, team stats, rosters, injuries, snaps, schedule, Sleeper availability)
      // changed mid-assembly - the explicit cross-source "input epoch" identity called out in
      // weekly-production risk #2.
      const requiredSourceKeys = requiredFirstPartyProjectionSourceKeys(job.season).required;
      const startInputEpoch = firstPartyInputEpoch(
        this.#requiredSourceEpochInputs(requiredSourceKeys, selectedSources),
      );
      const input = await this.#loadInputs(job.season, selectedSources, now);
      const targetWeeks = projectionTargetWeeks(input.schedules, job.season, job.week, now);
      if (targetWeeks.length === 0) {
        await this.#recordSourceSuccess(source.id, now, null, {
          targetWeeks: "none",
          result: "no_unplayed_regular_season_weeks",
        });
        return;
      }

      const sourceAsOf = new Date(
        Math.min(...selectedSources.map((selected) => selected.lastSuccessfulAt.getTime())),
      );
      const baseChecksum = projectionInputChecksum({
        modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
        championPolicy: {
          version: championPolicyVersion,
          minimumModelImprovement: FIRST_PARTY_CHAMPION_MINIMUM_IMPROVEMENT,
          minimumSamples: FIRST_PARTY_CHAMPION_MINIMUM_SAMPLES,
          minimumWeekBatches: FIRST_PARTY_CHAMPION_MINIMUM_WEEK_BATCHES,
          gateScoringProfile: projectionScoringProfileKey(publicationGateProfile),
        },
        sourceSchemaVersion,
        sources: selectedSources
          .filter(
            (selected) =>
              selected.key.startsWith("nflverse.stats-") ||
              selected.key.startsWith("nflverse.snap-counts.") ||
              selected.key.startsWith("nflverse.weekly-rosters.") ||
              selected.key.startsWith("nflverse.injuries.") ||
              selected.key.startsWith("nflverse.schedules."),
          )
          .map(({ key, checksum }) => ({ key, checksum })),
        players: input.playerRows
          .map((player) => ({
            id: player.id,
            gsisId: player.gsisId,
            team: player.nflTeam,
            position: player.primaryPosition,
            status: player.status,
            lastSeason: player.lastSeason,
            sleeperStatus:
              input.statusByPlayer
                .get(player.id)
                ?.map((value) => value ?? "")
                .sort() ?? null,
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
        leagues: [...input.leagues].sort((left, right) => left.id.localeCompare(right.id)),
        rules: [...input.rules].sort(
          (left, right) =>
            left.leagueSeasonId.localeCompare(right.leagueSeasonId) ||
            (left.providerStatId ?? left.statKey).localeCompare(
              right.providerStatId ?? right.statKey,
            ) ||
            left.operation.localeCompare(right.operation) ||
            left.points.localeCompare(right.points) ||
            (left.thresholdLow ?? "").localeCompare(right.thresholdLow ?? "") ||
            (left.thresholdHigh ?? "").localeCompare(right.thresholdHigh ?? ""),
        ),
        rosters: [...input.rosters].sort(
          (left, right) =>
            left.leagueSeasonId.localeCompare(right.leagueSeasonId) ||
            left.playerId.localeCompare(right.playerId),
        ),
        playerScopes: [...input.leagueSeasonScopesByPlayer]
          .map(([playerId, leagueSeasonIds]) => ({ playerId, leagueSeasonIds }))
          .sort((left, right) => left.playerId.localeCompare(right.playerId)),
        canonicalMatches: [...input.canonicalMatchByPlayer]
          .map(([playerId, canonicalPlayerId]) => ({ playerId, canonicalPlayerId }))
          .sort((left, right) => left.playerId.localeCompare(right.playerId)),
        statusWindows: input.schedules
          .filter((game) => game.season === job.season && targetWeeks.includes(game.week))
          .map((game) => ({
            gameId: game.gameId,
            week: game.week,
            window: projectionStatusWindow(game.kickoffAt, now),
          }))
          .sort((left, right) => left.gameId.localeCompare(right.gameId)),
      });
      const priorOutputs = await this.#priorOutputsState(
        source.id,
        job.season,
        targetWeeks,
        baseChecksum,
      );
      if (priorOutputs.complete) {
        await this.#recordSourceSuccess(source.id, now, baseChecksum, {
          targetWeeks: targetWeeks.join(","),
          publishedWeeks: 0,
          modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
          sourceAsOf: sourceAsOf.toISOString(),
          qualityState: priorOutputs.qualityState ?? "rejected",
          qualityReasons: priorOutputs.qualityReasons ?? "model_run_quality_missing",
          lastEvaluationAt: now.toISOString(),
          ...(priorOutputs.lastPublishedAt
            ? { lastPublishedAt: priorOutputs.lastPublishedAt }
            : {}),
          result:
            priorOutputs.qualityState === "publishable"
              ? "unchanged"
              : "prior_good_output_preserved",
        });
        return;
      }
      if (priorOutputs.immutableOutputIncomplete === true) {
        throw new Error(
          "A matching immutable projection run is incomplete; refusing to overwrite or relabel it",
        );
      }
      if (source.lastChecksum === baseChecksum) {
        throw new Error(
          "A committed projection input is missing immutable model or publication output",
        );
      }

      const firstTargetWeek = targetWeeks[0];
      if (firstTargetWeek === undefined) throw new Error("Projection target week is required");
      const completedWeeks = completedScheduleWeekKeys(input.schedules, now);
      const trainingKey = projectionTrainingCacheKey({
        firstTargetWeek,
        statisticalSources: selectedSources
          .filter(
            (selected) =>
              selected.key.includes("stats-player-week") ||
              selected.key.includes("stats-team-week") ||
              selected.key.includes("snap-counts") ||
              selected.key.includes("weekly-rosters") ||
              selected.key.includes("injuries"),
          )
          .map(({ key, checksum }) => ({ key, checksum })),
        playerPositions: input.playerRows
          .map((player) => ({ id: player.id, position: player.primaryPosition }))
          .sort((left, right) => left.id.localeCompare(right.id)),
        completedSchedule: input.schedules
          .filter((game) => completedWeeks.has(scheduleWeekKey(game.season, game.week)))
          .map((game) => ({
            season: game.season,
            week: game.week,
            gameId: game.gameId,
            awayTeam: game.awayTeam,
            homeTeam: game.homeTeam,
            awayScore: game.awayScore,
            homeScore: game.homeScore,
          }))
          .sort((left, right) => left.gameId.localeCompare(right.gameId)),
      });
      if (this.#trainingCache?.key !== trainingKey) {
        const playerHistory = buildFirstPartyPlayerHistory(
          input.weekly,
          input.snaps,
          input.weeklyRosters,
          input.schedules,
          input.injuries,
        );
        const defenseHistory = buildFirstPartyDefenseHistory(input.teamWeekly, input.schedules);
        const completedPlayerHistory = playerHistory.filter((row) =>
          completedWeeks.has(scheduleWeekKey(row.season, row.week)),
        );
        const completedDefenseHistory = defenseHistory.filter((row) =>
          completedWeeks.has(scheduleWeekKey(row.season, row.week)),
        );
        // A partially completed NFL week can already exist in the immutable source rows.
        // Backtests stop before the earliest target so Sunday results cannot leak into Monday.
        const backtestPlayerHistory = completedPlayerHistory.filter(
          (row) =>
            row.season < job.season || (row.season === job.season && row.week < firstTargetWeek),
        );
        const backtestDefenseHistory = completedDefenseHistory.filter(
          (row) =>
            row.season < job.season || (row.season === job.season && row.week < firstTargetWeek),
        );
        const basePlayerBacktest = runFirstPartyProjectionBacktest(backtestPlayerHistory);
        const playerChampion = applyFirstPartyProjectionChampionPolicy(
          basePlayerBacktest,
          publicationGateProfile,
        );
        const publicationPlayerBacktest = applyFirstPartyProjectionFinalPolicy(
          basePlayerBacktest,
          playerChampion.policy,
        );
        const defenseBacktest = runFirstPartyTeamDefenseBacktest(backtestDefenseHistory);
        const gatePlayer = evaluateFirstPartyBacktestForScoringProfile(
          publicationPlayerBacktest,
          publicationGateProfile,
        );
        const gateDefense = evaluateFirstPartyTeamDefenseBacktestForScoringProfile(
          defenseBacktest,
          publicationGateProfile,
        );
        this.#trainingCache = {
          key: trainingKey,
          completedPlayerHistory,
          completedDefenseHistory,
          basePlayerBacktest,
          playerChampion,
          publicationPlayerBacktest,
          defenseBacktest,
          gate: projectionModelGate({
            player: gatePlayer,
            defense: gateDefense,
            playerPredictions: publicationPlayerBacktest.predictions.length,
            defensePredictions: defenseBacktest.predictions.length,
          }),
        };
      }
      const training = this.#trainingCache;
      const playerBacktest = training.publicationPlayerBacktest;

      // Recomputed from the live `data_sources` rows - not the `selectedSources` snapshot already
      // in hand - so a required source that finished a concurrent refresh while this run loaded
      // history and trained is actually detected instead of trivially matching itself.
      const endInputEpoch = firstPartyInputEpoch(
        await this.#currentRequiredSourceEpochInputs(requiredSourceKeys),
      );
      if (endInputEpoch !== startInputEpoch) {
        await this.#recordSourceSuccess(source.id, now, null, {
          targetWeeks: targetWeeks.join(","),
          publishedWeeks: 0,
          modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
          sourceAsOf: sourceAsOf.toISOString(),
          qualityState: "rejected",
          qualityReasons: "input_epoch_changed",
          lastEvaluationAt: now.toISOString(),
          result: "input_epoch_changed",
        });
        return;
      }

      let publishedWeeks = 0;
      const publicationGates: ModelGate[] = [];
      for (const week of targetWeeks) {
        if (context.signal.aborted) throw new Error("Projection refresh was cancelled");
        const inputChecksum = projectionInputChecksum({ baseChecksum, season: job.season, week });
        const publication = await this.#publishWeek({
          sourceId: source.id,
          season: job.season,
          week,
          now,
          sourceAsOf,
          inputChecksum,
          inputEpoch: startInputEpoch,
          gate: training.gate,
          playerHistory: training.completedPlayerHistory,
          defenseHistory: training.completedDefenseHistory,
          playerBacktest,
          basePlayerBacktest: training.basePlayerBacktest,
          playerChampionPolicy: training.playerChampion.policy,
          defenseBacktest: training.defenseBacktest,
          players: input.playerRows,
          statusByPlayer: input.statusByPlayer,
          schedules: input.schedules,
          leagues: input.leagues,
          rules: input.rules,
          rosters: input.rosters,
          leagueSeasonScopesByPlayer: input.leagueSeasonScopesByPlayer,
          canonicalMatchByPlayer: input.canonicalMatchByPlayer,
        });
        publicationGates.push(publication.gate);
        if (publication.published) publishedWeeks += 1;
      }

      const effectiveGate: ModelGate = {
        state: publicationGates.some((gate) => gate.state === "rejected")
          ? "rejected"
          : publicationGates.some((gate) => gate.state === "degraded")
            ? "degraded"
            : "publishable",
        reasons: [...new Set(publicationGates.flatMap((gate) => gate.reasons))],
      };

      await this.#recordSourceSuccess(source.id, now, baseChecksum, {
        targetWeeks: targetWeeks.join(","),
        publishedWeeks,
        modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
        sourceAsOf: sourceAsOf.toISOString(),
        qualityState: effectiveGate.state,
        qualityReasons: effectiveGate.reasons.join("|") || "none",
        lastEvaluationAt: now.toISOString(),
        ...(publishedWeeks > 0 ? { lastPublishedAt: now.toISOString() } : {}),
        result:
          publishedWeeks > 0
            ? "published"
            : effectiveGate.state === "publishable"
              ? "unchanged"
              : "prior_good_output_preserved",
      });
    } catch (error) {
      await this.#recordSourceFailure(
        source.id,
        now,
        "PROJECTION_REFRESH_FAILED",
        error instanceof Error ? error.message : "First-party projection refresh failed",
      );
      throw error;
    }
  }

  async #ensureManagedSource(now: Date) {
    const [source] = await this.#database
      .insert(dataSources)
      .values({
        key: FIRST_PARTY_PROJECTION_SOURCE_KEY,
        name: "Laces Out first-party weekly projections",
        kind: "projection",
        attribution: "Laces Out",
        checkIntervalMinutes: projectionCheckIntervalMinutes,
        nextCheckAt: now,
        metadata: {
          sourceSchemaVersion,
          modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
          cadenceMinutes: projectionCheckIntervalMinutes,
        },
      })
      .onConflictDoUpdate({
        target: dataSources.key,
        set: {
          name: "Laces Out first-party weekly projections",
          kind: "projection",
          attribution: "Laces Out",
          checkIntervalMinutes: projectionCheckIntervalMinutes,
          updatedAt: now,
        },
      })
      .returning({ id: dataSources.id, lastChecksum: dataSources.lastChecksum });
    if (!source) throw new Error("First-party projection source could not be registered");
    return source;
  }

  async #priorOutputsState(
    sourceId: string,
    season: number,
    weeks: readonly number[],
    baseChecksum: string,
  ): Promise<PriorOutputsState> {
    let qualityState: ModelGate["state"] | undefined;
    let qualityReasons: string | undefined;
    let lastPublishedAt: string | undefined;
    for (const week of weeks) {
      const inputChecksum = projectionInputChecksum({ baseChecksum, season, week });
      const [run] = await this.#database
        .select({
          sourceSyncRunId: projectionModelRuns.sourceSyncRunId,
          playersPublished: projectionModelRuns.playersPublished,
          qualityState: projectionModelRuns.qualityState,
          createdAt: projectionModelRuns.createdAt,
          metrics: projectionModelRuns.metrics,
        })
        .from(projectionModelRuns)
        .where(
          and(
            eq(projectionModelRuns.sourceId, sourceId),
            eq(projectionModelRuns.season, season),
            eq(projectionModelRuns.targetWeek, week),
            eq(projectionModelRuns.modelVersion, FIRST_PARTY_PROJECTION_MODEL_VERSION),
            eq(projectionModelRuns.inputChecksum, inputChecksum),
          ),
        )
        .limit(1);
      if (!run) return { complete: false };
      if (qualityState !== undefined && qualityState !== run.qualityState) {
        return { complete: false, immutableOutputIncomplete: true };
      }
      qualityState = run.qualityState;
      const gateReasons = (() => {
        const gate = (run.metrics as { gate?: unknown }).gate;
        if (!gate || typeof gate !== "object") return undefined;
        const reasons = (gate as { reasons?: unknown }).reasons;
        return Array.isArray(reasons) && reasons.every((reason) => typeof reason === "string")
          ? reasons.join("|") || "none"
          : undefined;
      })();
      qualityReasons = gateReasons ?? qualityReasons;
      if (run.qualityState === "publishable") {
        const candidate = run.createdAt.toISOString();
        if (!lastPublishedAt || candidate > lastPublishedAt) lastPublishedAt = candidate;
      }
      const [raw] = await this.#database
        .select({ count: count() })
        .from(projectionObservations)
        .where(eq(projectionObservations.sourceSyncRunId, run.sourceSyncRunId));
      if ((raw?.count ?? 0) !== run.playersPublished) {
        return { complete: false, immutableOutputIncomplete: true };
      }
      const expectedLeagueSets = (() => {
        const leagues = (run.metrics as { leagues?: unknown }).leagues;
        if (!leagues || typeof leagues !== "object") return 0;
        const published = (leagues as { published?: unknown }).published;
        return typeof published === "number" && Number.isSafeInteger(published) && published >= 0
          ? published
          : 0;
      })();
      const expectedLeagueRows = (() => {
        const leagues = (run.metrics as { leagues?: unknown }).leagues;
        if (!leagues || typeof leagues !== "object") return 0;
        const rowsPublished = (leagues as { rowsPublished?: unknown }).rowsPublished;
        return typeof rowsPublished === "number" &&
          Number.isSafeInteger(rowsPublished) &&
          rowsPublished >= 0
          ? rowsPublished
          : 0;
      })();
      if (expectedLeagueSets > 0) {
        const sets = await this.#database
          .select({ id: projectionSets.id })
          .from(projectionSets)
          .where(
            and(
              eq(projectionSets.source, FIRST_PARTY_PROJECTION_SET_SOURCE),
              eq(projectionSets.season, season),
              eq(projectionSets.week, week),
              sql`${projectionSets.metadata}->>'modelInputChecksum' = ${inputChecksum}`,
            ),
          );
        if (sets.length !== expectedLeagueSets) {
          return { complete: false, immutableOutputIncomplete: true };
        }
        const [leagueRows] = await this.#database
          .select({ count: count() })
          .from(playerProjections)
          .where(
            inArray(
              playerProjections.projectionSetId,
              sets.map((set) => set.id),
            ),
          );
        if ((leagueRows?.count ?? 0) !== expectedLeagueRows) {
          return { complete: false, immutableOutputIncomplete: true };
        }
      } else if (expectedLeagueRows !== 0) {
        return { complete: false, immutableOutputIncomplete: true };
      }
    }
    return {
      complete: true,
      ...(qualityState ? { qualityState } : {}),
      ...(qualityReasons ? { qualityReasons } : {}),
      ...(lastPublishedAt ? { lastPublishedAt } : {}),
    };
  }

  async #selectSources(season: number, now: Date): Promise<readonly SelectedSource[]> {
    const keys = requiredFirstPartyProjectionSourceKeys(season);
    const allKeys = [...keys.required, ...keys.optional];
    const rows = await this.#database
      .select({
        id: dataSources.id,
        key: dataSources.key,
        enabled: dataSources.enabled,
        lastChecksum: dataSources.lastChecksum,
        lastSuccessfulAt: dataSources.lastSuccessfulAt,
        lastCheckedAt: dataSources.lastCheckedAt,
        consecutiveFailures: dataSources.consecutiveFailures,
        checkIntervalMinutes: dataSources.checkIntervalMinutes,
        metadata: dataSources.metadata,
      })
      .from(dataSources)
      .where(inArray(dataSources.key, allKeys));
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const missing = keys.required.filter((key) => {
      const row = byKey.get(key);
      return !row?.enabled || !sourceIsUsableForProjection(row, now);
    });
    if (missing.length > 0) {
      throw new Error(
        `Required projection inputs are missing, stale, or degraded: ${missing.join(", ")}`,
      );
    }
    const degradedOptional = keys.optional.filter((key) => {
      const row = byKey.get(key);
      return (
        row?.lastChecksum !== null &&
        row?.lastChecksum !== undefined &&
        !sourceIsUsableForProjection(row, now)
      );
    });
    if (degradedOptional.length > 0) {
      throw new Error(
        `Previously available projection inputs are stale or degraded: ${degradedOptional.join(", ")}`,
      );
    }
    const currentStats = [
      `nflverse.stats-player-week.${season}`,
      `nflverse.stats-team-week.${season}`,
    ];
    const availableCurrentStats = currentStats.filter((key) => byKey.get(key)?.lastChecksum);
    if (availableCurrentStats.length === 1) {
      throw new Error(
        "Current-season player and team observations must be refreshed as one complete model input",
      );
    }
    if (
      availableCurrentStats.length === currentStats.length &&
      !byKey.get(`nflverse.weekly-rosters.${season}`)?.lastChecksum
    ) {
      throw new Error(
        "Current-season weekly rosters are required once completed player observations are available",
      );
    }
    return allKeys.flatMap((key): SelectedSource[] => {
      const row = byKey.get(key);
      if (!row?.enabled || !sourceIsUsableForProjection(row, now)) return [];
      return [
        {
          id: row.id,
          key: row.key,
          checksum: row.lastChecksum as string,
          lastSuccessfulAt: row.lastSuccessfulAt as Date,
          lastCheckedAt: row.lastCheckedAt as Date,
          checkIntervalMinutes: row.checkIntervalMinutes,
          metadata: row.metadata,
        },
      ];
    });
  }

  /** Maps each required source key to its `{key, checksum, asOf}` epoch triple, missing-safe. */
  #requiredSourceEpochInputs(
    keys: readonly string[],
    sources: readonly SelectedSource[],
  ): readonly ProjectionEpochSource[] {
    const byKey = new Map(sources.map((source) => [source.key, source]));
    return keys.map((key) => {
      const source = byKey.get(key);
      return { key, checksum: source?.checksum ?? "", asOf: source?.lastSuccessfulAt ?? "" };
    });
  }

  /**
   * Re-reads the live `data_sources` rows for the given keys, independent of any prior snapshot,
   * and maps them to the same `{key, checksum, asOf}` epoch shape as `#requiredSourceEpochInputs`.
   */
  async #currentRequiredSourceEpochInputs(
    keys: readonly string[],
  ): Promise<readonly ProjectionEpochSource[]> {
    const rows = await this.#database
      .select({
        key: dataSources.key,
        lastChecksum: dataSources.lastChecksum,
        lastSuccessfulAt: dataSources.lastSuccessfulAt,
      })
      .from(dataSources)
      .where(inArray(dataSources.key, keys));
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return keys.map((key) => {
      const row = byKey.get(key);
      return { key, checksum: row?.lastChecksum ?? "", asOf: row?.lastSuccessfulAt ?? "" };
    });
  }

  async #loadInputs(season: number, selectedSources: readonly SelectedSource[], now: Date) {
    const selectedByKey = new Map(selectedSources.map((source) => [source.key, source]));
    const weeklyVersion = sourceVersionPredicate(
      selectedSources,
      playerWeeklyStatObservations.sourceId,
      playerWeeklyStatObservations.inputChecksum,
    );
    const snapVersion = sourceVersionPredicate(
      selectedSources,
      playerSnapCountObservations.sourceId,
      playerSnapCountObservations.inputChecksum,
    );
    const rosterVersion = sourceVersionPredicate(
      selectedSources,
      playerWeeklyRosterObservations.sourceId,
      playerWeeklyRosterObservations.inputChecksum,
    );
    const injuryVersion = sourceVersionPredicate(
      selectedSources,
      playerInjuryReportObservations.sourceId,
      playerInjuryReportObservations.inputChecksum,
    );
    const teamVersion = sourceVersionPredicate(
      selectedSources,
      teamWeeklyStatObservations.sourceId,
      teamWeeklyStatObservations.inputChecksum,
    );
    const scheduleVersion = sourceVersionPredicate(
      selectedSources,
      nflScheduleObservations.sourceId,
      nflScheduleObservations.inputChecksum,
    );
    if (
      !weeklyVersion ||
      !snapVersion ||
      !rosterVersion ||
      !injuryVersion ||
      !teamVersion ||
      !scheduleVersion
    ) {
      throw new Error("No projection input versions were selected");
    }
    const seasons = projectionHistorySeasons(season);
    const [
      weeklyRows,
      rosterRows,
      injuryRows,
      snapRows,
      teamRows,
      scheduleRows,
      playerRows,
      leagueRows,
      ruleRows,
    ] = await Promise.all([
      this.#database
        .select({
          playerId: playerWeeklyStatObservations.playerId,
          position: players.primaryPosition,
          season: playerWeeklyStatObservations.season,
          week: playerWeeklyStatObservations.week,
          gameId: playerWeeklyStatObservations.gameId,
          team: playerWeeklyStatObservations.team,
          opponentTeam: playerWeeklyStatObservations.opponentTeam,
          components: playerWeeklyStatObservations.components,
          advanced: playerWeeklyStatObservations.advanced,
        })
        .from(playerWeeklyStatObservations)
        .innerJoin(players, eq(players.id, playerWeeklyStatObservations.playerId))
        .where(
          and(
            weeklyVersion,
            inArray(playerWeeklyStatObservations.season, seasons),
            eq(playerWeeklyStatObservations.seasonType, "REG"),
          ),
        ),
      this.#database
        .select({
          playerId: playerWeeklyRosterObservations.playerId,
          position: players.primaryPosition,
          season: playerWeeklyRosterObservations.season,
          week: playerWeeklyRosterObservations.week,
          team: playerWeeklyRosterObservations.team,
          status: playerWeeklyRosterObservations.rosterStatus,
        })
        .from(playerWeeklyRosterObservations)
        .innerJoin(players, eq(players.id, playerWeeklyRosterObservations.playerId))
        .where(and(rosterVersion, inArray(playerWeeklyRosterObservations.season, seasons))),
      this.#database
        .select({
          playerId: playerInjuryReportObservations.playerId,
          season: playerInjuryReportObservations.season,
          week: playerInjuryReportObservations.week,
          reportStatus: playerInjuryReportObservations.reportStatus,
          practiceStatus: playerInjuryReportObservations.practiceStatus,
        })
        .from(playerInjuryReportObservations)
        .innerJoin(players, eq(players.id, playerInjuryReportObservations.playerId))
        .where(
          and(
            injuryVersion,
            inArray(playerInjuryReportObservations.season, seasons),
            eq(playerInjuryReportObservations.seasonType, "REG"),
          ),
        ),
      this.#database
        .select({
          playerId: playerSnapCountObservations.playerId,
          position: players.primaryPosition,
          season: playerSnapCountObservations.season,
          week: playerSnapCountObservations.week,
          gameId: playerSnapCountObservations.gameId,
          team: playerSnapCountObservations.team,
          opponentTeam: playerSnapCountObservations.opponentTeam,
          offenseShare: playerSnapCountObservations.offenseShare,
          specialTeamsShare: playerSnapCountObservations.specialTeamsShare,
        })
        .from(playerSnapCountObservations)
        .innerJoin(players, eq(players.id, playerSnapCountObservations.playerId))
        .where(
          and(
            snapVersion,
            inArray(playerSnapCountObservations.season, seasons),
            eq(playerSnapCountObservations.seasonType, "REG"),
          ),
        ),
      this.#database
        .select({
          season: teamWeeklyStatObservations.season,
          week: teamWeeklyStatObservations.week,
          gameId: teamWeeklyStatObservations.gameId,
          team: teamWeeklyStatObservations.team,
          opponentTeam: teamWeeklyStatObservations.opponentTeam,
          components: teamWeeklyStatObservations.components,
        })
        .from(teamWeeklyStatObservations)
        .where(
          and(
            teamVersion,
            inArray(teamWeeklyStatObservations.season, seasons),
            eq(teamWeeklyStatObservations.seasonType, "REG"),
          ),
        ),
      this.#database
        .select({
          season: nflScheduleObservations.season,
          week: nflScheduleObservations.week,
          gameId: nflScheduleObservations.externalGameId,
          awayTeam: nflScheduleObservations.awayTeam,
          homeTeam: nflScheduleObservations.homeTeam,
          awayScore: nflScheduleObservations.awayScore,
          homeScore: nflScheduleObservations.homeScore,
          kickoffAt: nflScheduleObservations.kickoffAt,
          status: nflScheduleObservations.status,
        })
        .from(nflScheduleObservations)
        .where(
          and(
            scheduleVersion,
            inArray(nflScheduleObservations.season, seasons),
            eq(nflScheduleObservations.seasonType, "REG"),
          ),
        ),
      this.#database
        .select({
          id: players.id,
          gsisId: players.gsisId,
          fullName: players.fullName,
          nflTeam: players.nflTeam,
          primaryPosition: players.primaryPosition,
          status: players.status,
          lastSeason: players.lastSeason,
        })
        .from(players),
      this.#database
        .select({
          id: leagueSeasons.id,
          provider: leagueSeasons.provider,
          currentWeek: leagueSeasons.currentWeek,
          teamCount: leagueSeasons.teamCount,
        })
        .from(leagueSeasons)
        .where(eq(leagueSeasons.season, season)),
      this.#database
        .select({
          leagueSeasonId: scoringRules.leagueSeasonId,
          statKey: scoringRules.statKey,
          operation: scoringRules.operation,
          points: scoringRules.points,
          thresholdLow: scoringRules.thresholdLow,
          thresholdHigh: scoringRules.thresholdHigh,
          providerStatId: scoringRules.providerStatId,
        })
        .from(scoringRules)
        .innerJoin(leagueSeasons, eq(leagueSeasons.id, scoringRules.leagueSeasonId))
        .where(eq(leagueSeasons.season, season)),
    ]);

    const sleeper = selectedByKey.get("sleeper.players");
    const statusRows = sleeper
      ? await this.#database
          .select({
            playerId: playerSourceObservations.playerId,
            gsisId: playerSourceObservations.gsisId,
            status: playerSourceObservations.status,
            injuryStatus: playerSourceObservations.injuryStatus,
            practice: playerSourceObservations.practiceParticipation,
          })
          .from(playerSourceObservations)
          .where(eq(playerSourceObservations.sourceId, sleeper.id))
      : [];
    const providerExternalRows = await this.#database
      .select({
        playerId: playerExternalIds.playerId,
        source: playerExternalIds.source,
        externalId: playerExternalIds.externalId,
      })
      .from(playerExternalIds)
      .where(
        inArray(playerExternalIds.source, [
          espnSelfAssertedPlayerSource,
          "espn",
          "yahoo",
          "sleeper-espn",
          "sleeper-yahoo",
        ]),
      );
    const statusByPlayer = new Map<string, readonly (string | null)[]>();
    for (const row of statusRows) {
      if (!row.playerId) continue;
      statusByPlayer.set(row.playerId, [
        ...(statusByPlayer.get(row.playerId) ?? []),
        row.status,
        row.injuryStatus,
        row.practice,
      ]);
    }
    const currentStatusWeek = projectionStatusWeek(scheduleRows, season, now);
    if (currentStatusWeek !== undefined) {
      for (const row of injuryRows) {
        if (!row.playerId || row.season !== season || row.week !== currentStatusWeek) continue;
        statusByPlayer.set(row.playerId, [
          ...(statusByPlayer.get(row.playerId) ?? []),
          row.reportStatus,
          row.practiceStatus,
        ]);
      }
    }

    const defensePlayerRows = await this.#ensureDefensePlayers(scheduleRows, season, now);
    const rosters = await this.#loadLatestRosters(leagueRows);
    const rosterScopes = new Map<string, Set<string>>();
    for (const roster of rosters) {
      const scopes = rosterScopes.get(roster.playerId) ?? new Set<string>();
      scopes.add(roster.leagueSeasonId);
      rosterScopes.set(roster.playerId, scopes);
    }
    const espnOwnerScopes = new Map<string, Set<string>>();
    const canonicalProviderPlayerByExternalId = new Map(
      providerExternalRows.flatMap((row) =>
        row.source === "sleeper-espn" || row.source === "sleeper-yahoo"
          ? [[`${row.source}:${row.externalId}`, row.playerId] as const]
          : [],
      ),
    );
    const canonicalPlayerByGsis = new Map(
      playerRows.flatMap((player) => (player.gsisId ? [[player.gsisId, player.id] as const] : [])),
    );
    const canonicalMatchByPlayer = new Map<string, string>();
    for (const row of statusRows) {
      const canonicalPlayerId = row.gsisId ? canonicalPlayerByGsis.get(row.gsisId) : undefined;
      if (row.playerId && canonicalPlayerId && row.playerId !== canonicalPlayerId) {
        canonicalMatchByPlayer.set(row.playerId, canonicalPlayerId);
      }
    }
    for (const row of providerExternalRows) {
      const crosswalkSource =
        row.source === "espn"
          ? "sleeper-espn"
          : row.source === "yahoo"
            ? "sleeper-yahoo"
            : undefined;
      if (!crosswalkSource) continue;
      const canonicalPlayerId = canonicalProviderPlayerByExternalId.get(
        `${crosswalkSource}:${row.externalId}`,
      );
      if (canonicalPlayerId && canonicalPlayerId !== row.playerId) {
        canonicalMatchByPlayer.set(row.playerId, canonicalPlayerId);
      }
    }
    for (const row of providerExternalRows.filter(
      (candidate) => candidate.source === espnSelfAssertedPlayerSource,
    )) {
      const leagueSeasonId = espnSelfAssertedProjectionLeague(row.externalId);
      if (!leagueSeasonId) continue;
      const scopes = espnOwnerScopes.get(row.playerId) ?? new Set<string>();
      scopes.add(leagueSeasonId);
      espnOwnerScopes.set(row.playerId, scopes);
      const providerPlayerId = row.externalId.slice(row.externalId.indexOf(":") + 1);
      const canonicalPlayerId =
        canonicalProviderPlayerByExternalId.get(`sleeper-espn:${providerPlayerId}`) ??
        providerExternalRows.find(
          (candidate) => candidate.source === "espn" && candidate.externalId === providerPlayerId,
        )?.playerId;
      if (canonicalPlayerId && canonicalPlayerId !== row.playerId) {
        canonicalMatchByPlayer.set(row.playerId, canonicalPlayerId);
      }
    }
    const leagueSeasonScopesByPlayer = new Map<string, readonly string[]>();
    for (const player of playerRows) {
      if (player.gsisId) continue;
      const rostered = rosterScopes.get(player.id) ?? new Set<string>();
      const asserted = espnOwnerScopes.get(player.id);
      const scopes = [...rostered]
        .filter((leagueSeasonId) => asserted === undefined || asserted.has(leagueSeasonId))
        .sort();
      if (scopes.length > 0) leagueSeasonScopesByPlayer.set(player.id, scopes);
    }
    return {
      weekly: weeklyRows.flatMap((row): ProjectionWeeklyFact[] =>
        row.playerId
          ? [
              {
                playerId: row.playerId,
                position: row.position,
                season: row.season,
                week: row.week,
                gameId: row.gameId,
                team: row.team,
                opponentTeam: row.opponentTeam,
                components: row.components,
                advanced: row.advanced,
              },
            ]
          : [],
      ),
      snaps: snapRows.flatMap((row): ProjectionSnapFact[] =>
        row.playerId
          ? [
              {
                playerId: row.playerId,
                position: row.position,
                season: row.season,
                week: row.week,
                gameId: row.gameId,
                team: row.team,
                opponentTeam: row.opponentTeam,
                offenseShare: numeric(row.offenseShare),
                specialTeamsShare: numeric(row.specialTeamsShare),
              },
            ]
          : [],
      ),
      weeklyRosters: rosterRows.flatMap((row): ProjectionRosterFact[] =>
        row.playerId
          ? [
              {
                playerId: row.playerId,
                position: row.position,
                season: row.season,
                week: row.week,
                team: row.team,
                status: row.status,
              },
            ]
          : [],
      ),
      injuries: injuryRows.flatMap((row): ProjectionInjuryFact[] =>
        row.playerId
          ? [
              {
                playerId: row.playerId,
                season: row.season,
                week: row.week,
                reportStatus: row.reportStatus,
                practiceStatus: row.practiceStatus,
              },
            ]
          : [],
      ),
      teamWeekly: teamRows satisfies readonly ProjectionTeamWeekFact[],
      schedules: scheduleRows satisfies readonly ProjectionScheduleFact[],
      playerRows: [
        ...playerRows.filter(
          (player) => !defensePlayerRows.some((defense) => defense.id === player.id),
        ),
        ...defensePlayerRows,
      ] satisfies readonly PlayerRow[],
      leagues: leagueRows satisfies readonly LeagueRow[],
      rules: ruleRows satisfies readonly LeagueRuleRow[],
      rosters,
      statusByPlayer,
      leagueSeasonScopesByPlayer,
      canonicalMatchByPlayer,
    };
  }

  async #ensureDefensePlayers(
    schedules: readonly ProjectionScheduleFact[],
    season: number,
    now: Date,
  ): Promise<readonly PlayerRow[]> {
    const teams = [
      ...new Set(
        schedules
          .filter((game) => game.season === season)
          .flatMap((game) => [game.awayTeam.toUpperCase(), game.homeTeam.toUpperCase()]),
      ),
    ].sort();
    if (teams.length !== 32) {
      throw new Error(`Expected 32 scheduled NFL teams, received ${teams.length}`);
    }
    for (const batch of chunks(teams)) {
      await this.#database
        .insert(players)
        .values(
          batch.map((team) => ({
            id: firstPartyDefensePlayerId(team),
            fullName: `${team} D/ST`,
            nflTeam: team,
            primaryPosition: "D/ST",
            eligiblePositions: ["D/ST"],
            status: "active",
            lastSeason: season,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .onConflictDoNothing({ target: players.id });
    }
    const ids = teams.map(firstPartyDefensePlayerId);
    const rows = await this.#database
      .select({
        id: players.id,
        gsisId: players.gsisId,
        fullName: players.fullName,
        nflTeam: players.nflTeam,
        primaryPosition: players.primaryPosition,
        status: players.status,
        lastSeason: players.lastSeason,
      })
      .from(players)
      .where(inArray(players.id, ids));
    const byId = new Map(rows.map((row) => [row.id, row]));
    return teams.map((team): PlayerRow => {
      const id = firstPartyDefensePlayerId(team);
      const row = byId.get(id);
      if (
        !row ||
        row.fullName !== `${team} D/ST` ||
        row.nflTeam !== team ||
        row.primaryPosition !== "D/ST"
      ) {
        throw new Error(`Stable first-party D/ST identity collision for ${team}`);
      }
      return row;
    });
  }

  async #loadLatestRosters(leagues: readonly LeagueRow[]): Promise<readonly LeagueRosterPlayer[]> {
    if (leagues.length === 0) return [];
    const snapshotRows = await this.#database
      .select({
        leagueSeasonId: fantasyTeams.leagueSeasonId,
        teamId: fantasyTeams.id,
        snapshotId: rosterSnapshots.id,
        effectiveAt: rosterSnapshots.effectiveAt,
      })
      .from(fantasyTeams)
      .innerJoin(rosterSnapshots, eq(rosterSnapshots.teamId, fantasyTeams.id))
      .where(
        inArray(
          fantasyTeams.leagueSeasonId,
          leagues.map((league) => league.id),
        ),
      )
      .orderBy(fantasyTeams.id, desc(rosterSnapshots.effectiveAt), rosterSnapshots.id);
    const latestSnapshotByTeam = new Map<
      string,
      { readonly leagueSeasonId: string; readonly snapshotId: string }
    >();
    for (const row of snapshotRows) {
      if (!latestSnapshotByTeam.has(row.teamId)) {
        latestSnapshotByTeam.set(row.teamId, {
          leagueSeasonId: row.leagueSeasonId,
          snapshotId: row.snapshotId,
        });
      }
    }
    const latestSnapshots = [...latestSnapshotByTeam.values()];
    if (latestSnapshots.length === 0) return [];
    const entryRows = await this.#database
      .select({
        snapshotId: rosterEntries.snapshotId,
        playerId: rosterEntries.playerId,
        primaryPosition: players.primaryPosition,
        nflTeam: players.nflTeam,
      })
      .from(rosterEntries)
      .innerJoin(players, eq(players.id, rosterEntries.playerId))
      .where(
        inArray(
          rosterEntries.snapshotId,
          latestSnapshots.map((row) => row.snapshotId),
        ),
      );
    const leagueBySnapshot = new Map(
      latestSnapshots.map((row) => [row.snapshotId, row.leagueSeasonId]),
    );
    const result: LeagueRosterPlayer[] = entryRows.flatMap((row): LeagueRosterPlayer[] => {
      const leagueSeasonId = leagueBySnapshot.get(row.snapshotId);
      return leagueSeasonId
        ? [
            {
              leagueSeasonId,
              playerId: row.playerId,
              primaryPosition: row.primaryPosition,
              nflTeam: row.nflTeam,
            },
          ]
        : [];
    });
    const snapshotsByLeague = new Map<string, string[]>();
    for (const row of latestSnapshots) {
      const ids = snapshotsByLeague.get(row.leagueSeasonId) ?? [];
      ids.push(row.snapshotId);
      snapshotsByLeague.set(row.leagueSeasonId, ids);
    }
    const snapshotsWithEntries = new Set(entryRows.map((row) => row.snapshotId));
    for (const league of leagues) {
      const snapshots = snapshotsByLeague.get(league.id) ?? [];
      if (
        snapshots.length > 0 &&
        (snapshots.length !== league.teamCount ||
          snapshots.some((snapshotId) => !snapshotsWithEntries.has(snapshotId)))
      ) {
        result.push({
          leagueSeasonId: league.id,
          playerId: `INCOMPLETE-ROSTER:${league.id}`,
          primaryPosition: "UNRESOLVED",
          nflTeam: null,
        });
      }
    }
    return result;
  }

  async #publishWeek(input: {
    readonly sourceId: string;
    readonly season: number;
    readonly week: number;
    readonly now: Date;
    readonly sourceAsOf: Date;
    readonly inputChecksum: string;
    readonly inputEpoch: string;
    readonly gate: ModelGate;
    readonly playerHistory: ReturnType<typeof buildFirstPartyPlayerHistory>;
    readonly defenseHistory: ReturnType<typeof buildFirstPartyDefenseHistory>;
    readonly playerBacktest: FirstPartyProjectionBacktest;
    readonly basePlayerBacktest: FirstPartyProjectionBacktest;
    readonly playerChampionPolicy: FirstPartyProjectionChampionPolicy;
    readonly defenseBacktest: FirstPartyTeamDefenseBacktest;
    readonly players: readonly PlayerRow[];
    readonly statusByPlayer: ReadonlyMap<string, readonly (string | null)[]>;
    readonly schedules: readonly ProjectionScheduleFact[];
    readonly leagues: readonly LeagueRow[];
    readonly rules: readonly LeagueRuleRow[];
    readonly rosters: readonly LeagueRosterPlayer[];
    readonly leagueSeasonScopesByPlayer: ReadonlyMap<string, readonly string[]>;
    readonly canonicalMatchByPlayer: ReadonlyMap<string, string>;
  }): Promise<PublicationAttempt> {
    const idempotencyKey = `${FIRST_PARTY_PROJECTION_SOURCE_KEY}:${FIRST_PARTY_PROJECTION_MODEL_VERSION}:${input.season}:W${input.week}:${input.inputChecksum}`;
    const matchups = this.#matchups(input.schedules, input.season, input.week, input.now);
    const unknownKickoff = projectionWeekHasUnknownKickoff(
      input.schedules,
      input.season,
      input.week,
    );
    const releaseGate: ModelGate = unknownKickoff
      ? {
          state: input.gate.state === "rejected" ? "rejected" : "degraded",
          reasons: [...new Set([...input.gate.reasons, "scheduled_game_kickoff_unknown"])],
        }
      : input.gate;
    const [existing] = await this.#database
      .select({ id: syncRuns.id })
      .from(syncRuns)
      .where(eq(syncRuns.idempotencyKey, idempotencyKey))
      .limit(1);
    if (existing) return { committed: false, published: false, gate: releaseGate };

    const rosterIds = new Set(input.rosters.map((row) => row.playerId));
    const latestHistoryByPlayer = new Map<string, (typeof input.playerHistory)[number]>();
    for (const row of input.playerHistory) latestHistoryByPlayer.set(row.playerId, row);
    const canonicalByIdentity = new Map<string, PlayerRow | null>();
    const playerById = new Map(input.players.map((player) => [player.id, player]));
    for (const player of input.players) {
      if (!player.gsisId || isDefensePosition(player.primaryPosition)) continue;
      const key = playerIdentityKey(player);
      if (!key) continue;
      const existing = canonicalByIdentity.get(key);
      if (existing === undefined) canonicalByIdentity.set(key, player);
      else if (existing === null || existing.id !== player.id) canonicalByIdentity.set(key, null);
    }
    const eligiblePlayers = input.players.filter((player) => {
      if (!firstPartyProjectionPositionIsSupported(player.primaryPosition)) return false;
      const scopes = input.leagueSeasonScopesByPlayer.get(player.id);
      if (!player.gsisId)
        return scopes !== undefined && scopes.length > 0 && rosterIds.has(player.id);
      return (
        rosterIds.has(player.id) ||
        player.lastSeason === null ||
        player.lastSeason >= input.season - 1
      );
    });
    const publishedPlayers: PublishedPlayer[] = [];
    for (const player of eligiblePlayers) {
      const identityKey = playerIdentityKey(player);
      const explicitlyMatchedPlayerId = input.canonicalMatchByPlayer.get(player.id);
      const exactMatch = identityKey
        ? (canonicalByIdentity.get(identityKey) ?? undefined)
        : undefined;
      const canonicalPlayerId = canonicalProjectionPlayerId({
        playerId: player.id,
        hasGsisId: player.gsisId !== null,
        ...(explicitlyMatchedPlayerId ? { explicitMatchId: explicitlyMatchedPlayerId } : {}),
        ...(exactMatch ? { exactMatchId: exactMatch.id } : {}),
      });
      const canonicalMatch = playerById.get(canonicalPlayerId);
      const historyPlayerId = canonicalMatch?.id ?? player.id;
      const latest = latestHistoryByPlayer.get(historyPlayerId);
      const team = upper(player.nflTeam) ?? upper(canonicalMatch?.nflTeam) ?? upper(latest?.team);
      if (!team) continue;
      const matchup = matchups.get(team);
      const opponent = matchup?.opponent;
      const gameStarted =
        matchup?.final === true ||
        (matchup?.status !== "postponed" &&
          matchup?.status !== "cancelled" &&
          matchup?.kickoffAt !== null &&
          matchup?.kickoffAt !== undefined &&
          matchup.kickoffAt.getTime() <= input.now.getTime());
      const statusSignals = [
        player.status,
        ...(input.statusByPlayer.get(player.id) ?? []),
        ...(canonicalMatch && canonicalMatch.id !== player.id
          ? [canonicalMatch.status, ...(input.statusByPlayer.get(canonicalMatch.id) ?? [])]
          : []),
      ];
      const role = recentRoleContext(input.playerHistory, historyPlayerId);
      const target = {
        playerId: historyPlayerId,
        position: player.primaryPosition,
        season: input.season,
        week: input.week,
        team,
        ...(opponent ? { opponent } : {}),
        scheduled: opponent !== undefined,
        isBye: opponent === undefined,
        status: firstPartyStatusForKickoff(statusSignals, matchup?.kickoffAt, input.now),
        ...(role === undefined ? {} : { role }),
      } as const;
      const modelProjection = normalizePlayerProjectionForSchedule(
        projectFirstPartyWeeklyComponents({
          target,
          history: input.playerHistory,
          calibration: input.playerBacktest.calibration,
        }),
        player.primaryPosition,
        opponent !== undefined,
      );
      const baselineProjection = normalizePlayerProjectionForSchedule(
        projectFirstPartyRecencyBaselineComponents({
          target,
          history: input.playerHistory,
          calibration: input.playerBacktest.calibration,
        }),
        player.primaryPosition,
        opponent !== undefined,
      );
      const projection =
        firstPartyChampionStrategyForPosition(
          input.playerChampionPolicy,
          player.primaryPosition,
        ) === "first-party-model"
          ? modelProjection
          : baselineProjection;
      if (projection.state === "unavailable") continue;
      publishedPlayers.push({
        playerId: player.id,
        externalPlayerId: player.gsisId ?? `PLAYER:${player.id}`,
        position: player.primaryPosition.trim().toUpperCase(),
        team,
        projection,
        modelProjection,
        baselineProjection,
        leagueSeasonScopes: input.leagueSeasonScopesByPlayer.get(player.id) ?? [],
        ...(canonicalMatch && canonicalMatch.id !== player.id
          ? { canonicalMatchId: canonicalMatch.id }
          : {}),
        gameStarted,
      });
    }

    const allTeams = [
      ...new Set(
        input.schedules
          .filter((game) => game.season === input.season)
          .flatMap((game) => [game.awayTeam, game.homeTeam]),
      ),
    ]
      .map((team) => team.toUpperCase())
      .sort();
    const publishedDefenses: PublishedDefense[] = allTeams.map((team) => {
      const matchup = matchups.get(team);
      const opponent = matchup?.opponent;
      const gameStarted =
        matchup?.final === true ||
        (matchup?.status !== "postponed" &&
          matchup?.status !== "cancelled" &&
          matchup?.kickoffAt !== null &&
          matchup?.kickoffAt !== undefined &&
          matchup.kickoffAt.getTime() <= input.now.getTime());
      const projection = projectFirstPartyTeamDefenseComponents({
        target: {
          team,
          season: input.season,
          week: input.week,
          ...(opponent ? { opponent } : {}),
          scheduled: opponent !== undefined,
          isBye: opponent === undefined,
        },
        history: input.defenseHistory,
        calibration: input.defenseBacktest.calibration,
      });
      return {
        team,
        gameStarted,
        projection:
          opponent === undefined
            ? {
                ...projection,
                state: "projected" as const,
                components: zeroComponents(firstPartyTeamDefenseProjectionComponents()),
                lowerComponents: zeroComponents(firstPartyTeamDefenseProjectionComponents()),
                upperComponents: zeroComponents(firstPartyTeamDefenseProjectionComponents()),
                reasons: ["This NFL team has a confirmed bye in this week."],
              }
            : projection,
      };
    });
    const previousRowsByLeague = await this.#loadPreviousLeagueProjectionRows(
      input.leagues.map((league) => league.id),
      input.season,
      input.week,
    );

    const leaguePlan: LeaguePublicationPlan =
      releaseGate.state === "publishable"
        ? buildFirstPartyLeaguePublications({
            ...input,
            publishedPlayers,
            publishedDefenses,
            previousRowsByLeague,
          })
        : {
            publications: [],
            withheld: input.leagues.map((league) => ({
              leagueSeasonId: league.id,
              scope: "league" as const,
              reasons: releaseGate.reasons,
            })),
            notes: [],
          };
    const leaguePublications = leaguePlan.publications;
    // Canonical raw observations are immutable once their NFL game starts. League-scored sets
    // separately reuse their latest pre-kickoff rows; omitting locked raw rows here leaves that
    // earlier observation authoritative instead of relabeling recomputed components as current.
    const rawPlayers = projectionUnlockedRawRows(publishedPlayers);
    const rawDefenses = projectionUnlockedRawRows(publishedDefenses);
    const evaluatedCount = publishedPlayers.length + publishedDefenses.length;
    const rawCount = rawPlayers.length + rawDefenses.length;
    const trainedThrough = [...input.playerHistory]
      .filter(
        (row) =>
          row.season < input.season || (row.season === input.season && row.week < input.week),
      )
      .at(-1);

    const inserted = await this.#database.transaction(async (transaction) => {
      const [run] = await transaction
        .insert(syncRuns)
        .values({
          kind: "first-party-projection",
          state: "running",
          idempotencyKey,
          startedAt: input.now,
          recordsRead: input.playerHistory.length + input.defenseHistory.length,
          artifactChecksum: input.inputChecksum,
        })
        .onConflictDoNothing({ target: syncRuns.idempotencyKey })
        .returning({ id: syncRuns.id });
      if (!run) return false;

      await transaction.insert(projectionModelRuns).values({
        sourceSyncRunId: run.id,
        sourceId: input.sourceId,
        season: input.season,
        targetWeek: input.week,
        modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
        trainingWindowStartSeason: input.season - 3,
        trainedThroughSeason: trainedThrough?.season ?? input.season - 1,
        trainedThroughWeek: trainedThrough?.week ?? null,
        qualityState: releaseGate.state,
        playersEvaluated: evaluatedCount,
        playersPublished: releaseGate.state === "publishable" ? rawCount : 0,
        inputChecksum: input.inputChecksum,
        configuration: {
          historySeasons: historySeasonCount,
          publicationGate: "walk-forward champion MAE <= recency-only baseline",
          championPolicy: input.playerChampionPolicy,
          pointIntervals: "league-scored residual quantiles",
          byes: "explicit zero",
          defenseMethodWarnings,
          // The cross-source completed-batch identity proving every required source (player
          // stats, team stats, rosters, injuries, snaps, schedule, Sleeper availability) was the
          // same at the start of this refresh as it was immediately before this transaction; see
          // weekly-production risk #2.
          inputEpoch: { version: FIRST_PARTY_INPUT_EPOCH_VERSION, value: input.inputEpoch },
        },
        calibration: {
          player: input.playerBacktest.calibration,
          defense: input.defenseBacktest.calibration,
        },
        metrics: {
          gate: releaseGate,
          player: input.playerBacktest.overall,
          playerChampionPolicy: input.playerChampionPolicy,
          defense: input.defenseBacktest.overall,
          leagues: {
            eligible: input.leagues.length,
            published: leaguePublications.length,
            rowsPublished: leaguePublications.reduce(
              (total, publication) => total + publication.rows.length,
              0,
            ),
            withheld: leaguePlan.withheld,
            // Leagues that PUBLISHED under a caveat. Kept out of `withheld` on purpose: every
            // reader of that array treats an entry as a reason a league did not publish.
            notes: leaguePlan.notes,
          },
        },
        sourceAsOf: input.sourceAsOf,
        createdAt: input.now,
      });

      if (releaseGate.state === "publishable") {
        const observationRows = [
          ...rawPlayers.map((row) => ({
            sourceId: input.sourceId,
            sourceSyncRunId: run.id,
            externalPlayerId: row.externalPlayerId,
            playerId: row.playerId,
            kind: "stat-components" as const,
            sourceVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
            independenceKey: "laces-out-first-party",
            season: input.season,
            week: input.week,
            horizon: "week" as const,
            components: projectionComponents(row.position, row.projection.components),
            sourceAsOf: input.sourceAsOf,
            fetchedAt: input.sourceAsOf,
            inputChecksum: input.inputChecksum,
            createdAt: input.now,
          })),
          ...rawDefenses.map((row) => ({
            sourceId: input.sourceId,
            sourceSyncRunId: run.id,
            externalPlayerId: `DST:${row.team}`,
            playerId: firstPartyDefensePlayerId(row.team),
            kind: "stat-components" as const,
            sourceVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
            independenceKey: "laces-out-first-party-defense",
            season: input.season,
            week: input.week,
            horizon: "week" as const,
            components: row.projection.components,
            sourceAsOf: input.sourceAsOf,
            fetchedAt: input.sourceAsOf,
            inputChecksum: input.inputChecksum,
            createdAt: input.now,
          })),
        ];
        for (const batch of chunks(observationRows)) {
          await transaction.insert(projectionObservations).values([...batch]);
        }

        for (const publication of leaguePublications) {
          const [set] = await transaction
            .insert(projectionSets)
            .values({
              leagueSeasonId: publication.league.id,
              createdByUserId: null,
              visibility: "league",
              source: FIRST_PARTY_PROJECTION_SET_SOURCE,
              version: publication.version,
              season: input.season,
              week: input.week,
              horizon: "week",
              fetchedAt: input.sourceAsOf,
              inputChecksum: publication.inputChecksum,
              metadata: publication.metadata,
              createdAt: input.now,
            })
            .onConflictDoNothing({
              target: [projectionSets.source, projectionSets.version],
            })
            .returning({ id: projectionSets.id });
          if (!set) continue;
          for (const batch of chunks(publication.rows)) {
            await transaction.insert(playerProjections).values(
              batch.map((row) => ({
                projectionSetId: set.id,
                playerId: row.playerId,
                meanPoints: row.mean.toFixed(3),
                floorPoints: row.floor.toFixed(3),
                ceilingPoints: row.ceiling.toFixed(3),
                confidence: row.confidence.toFixed(4),
                components: row.components,
              })),
            );
          }
        }
      }

      await transaction
        .update(syncRuns)
        .set({
          state: "complete",
          finishedAt: input.now,
          recordsWritten:
            releaseGate.state === "publishable"
              ? rawCount + leaguePublications.reduce((sum, league) => sum + league.rows.length, 0)
              : 1,
        })
        .where(eq(syncRuns.id, run.id));
      return true;
    });
    return {
      committed: inserted,
      published: inserted && releaseGate.state === "publishable",
      gate: releaseGate,
    };
  }

  #matchups(
    schedules: readonly ProjectionScheduleFact[],
    season: number,
    week: number,
    now: Date,
  ): ReadonlyMap<
    string,
    {
      readonly opponent: string;
      readonly kickoffAt: Date | null;
      readonly final: boolean;
      readonly status: NonNullable<ProjectionScheduleFact["status"]>;
    }
  > {
    const result = new Map<
      string,
      {
        readonly opponent: string;
        readonly kickoffAt: Date | null;
        readonly final: boolean;
        readonly status: NonNullable<ProjectionScheduleFact["status"]>;
      }
    >();
    for (const game of schedules) {
      if (game.season !== season || game.week !== week) continue;
      const status =
        game.status ?? (game.awayScore !== null && game.homeScore !== null ? "final" : "scheduled");
      if (status === "cancelled") continue;
      const final = projectionGameIsConservativelyFinal({ ...game, status }, now);
      result.set(game.awayTeam.toUpperCase(), {
        opponent: game.homeTeam.toUpperCase(),
        kickoffAt: game.kickoffAt ?? null,
        final,
        status,
      });
      result.set(game.homeTeam.toUpperCase(), {
        opponent: game.awayTeam.toUpperCase(),
        kickoffAt: game.kickoffAt ?? null,
        final,
        status,
      });
    }
    return result;
  }

  async #loadPreviousLeagueProjectionRows(
    leagueSeasonIds: readonly string[],
    season: number,
    week: number,
  ): Promise<ReadonlyMap<string, ReadonlyMap<string, ScoredProjectionRow>>> {
    if (leagueSeasonIds.length === 0) return new Map();
    const sets = await this.#database
      .select({ id: projectionSets.id, leagueSeasonId: projectionSets.leagueSeasonId })
      .from(projectionSets)
      .where(
        and(
          inArray(projectionSets.leagueSeasonId, [...leagueSeasonIds]),
          eq(projectionSets.source, FIRST_PARTY_PROJECTION_SET_SOURCE),
          eq(projectionSets.season, season),
          eq(projectionSets.week, week),
          eq(projectionSets.horizon, "week"),
        ),
      )
      .orderBy(desc(projectionSets.fetchedAt), desc(projectionSets.createdAt));
    const latestSetByLeague = new Map<string, string>();
    for (const set of sets) {
      if (set.leagueSeasonId === null) continue;
      if (!latestSetByLeague.has(set.leagueSeasonId)) {
        latestSetByLeague.set(set.leagueSeasonId, set.id);
      }
    }
    const selectedSetIds = [...latestSetByLeague.values()];
    if (selectedSetIds.length === 0) return new Map();
    const rows = await this.#database
      .select({
        projectionSetId: playerProjections.projectionSetId,
        playerId: playerProjections.playerId,
        meanPoints: playerProjections.meanPoints,
        floorPoints: playerProjections.floorPoints,
        ceilingPoints: playerProjections.ceilingPoints,
        confidence: playerProjections.confidence,
        components: playerProjections.components,
      })
      .from(playerProjections)
      .where(inArray(playerProjections.projectionSetId, selectedSetIds));
    const leagueBySet = new Map(
      [...latestSetByLeague].map(([leagueSeasonId, setId]) => [setId, leagueSeasonId]),
    );
    const result = new Map<string, Map<string, ScoredProjectionRow>>();
    for (const row of rows) {
      const leagueSeasonId = leagueBySet.get(row.projectionSetId);
      if (!leagueSeasonId) continue;
      const leagueRows = result.get(leagueSeasonId) ?? new Map<string, ScoredProjectionRow>();
      const mean = numeric(row.meanPoints);
      leagueRows.set(row.playerId, {
        playerId: row.playerId,
        mean,
        floor: row.floorPoints === null ? mean : numeric(row.floorPoints),
        ceiling: row.ceilingPoints === null ? mean : numeric(row.ceilingPoints),
        confidence: row.confidence === null ? 0 : numeric(row.confidence),
        components: row.components,
      });
      result.set(leagueSeasonId, leagueRows);
    }
    return result;
  }

  async #recordSourceSuccess(
    sourceId: string,
    now: Date,
    checksum: string | null,
    metadata: Record<string, string | number>,
  ): Promise<void> {
    const [source] = await this.#database
      .select({ metadata: dataSources.metadata })
      .from(dataSources)
      .where(eq(dataSources.id, sourceId))
      .limit(1);
    await this.#database
      .update(dataSources)
      .set({
        lastCheckedAt: now,
        lastSuccessfulAt: now,
        ...(checksum === null
          ? {}
          : {
              // A bare Date inside a raw sql fragment bypasses the column's Date mapping and
              // crashes the postgres-js binder; serialize explicitly.
              lastChangedAt: sql`case when ${dataSources.lastChecksum} is distinct from ${checksum} then ${now.toISOString()} else ${dataSources.lastChangedAt} end`,
              lastChecksum: checksum,
            }),
        nextCheckAt: new Date(now.getTime() + projectionCheckIntervalMinutes * 60_000),
        consecutiveFailures: 0,
        lastErrorAt: null,
        lastErrorCode: null,
        lastErrorDetail: null,
        metadata: {
          ...(source?.metadata ?? {}),
          sourceSchemaVersion,
          modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
          cadenceMinutes: projectionCheckIntervalMinutes,
          ...metadata,
        },
        updatedAt: now,
      })
      .where(eq(dataSources.id, sourceId));
  }

  async #recordSourceFailure(
    sourceId: string,
    now: Date,
    code: string,
    detail: string,
  ): Promise<void> {
    const [row] = await this.#database
      .select({ consecutiveFailures: dataSources.consecutiveFailures })
      .from(dataSources)
      .where(eq(dataSources.id, sourceId));
    await this.#database
      .update(dataSources)
      .set({
        lastCheckedAt: now,
        nextCheckAt: new Date(now.getTime() + 30 * 60_000),
        consecutiveFailures: (row?.consecutiveFailures ?? 0) + 1,
        lastErrorAt: now,
        lastErrorCode: code.slice(0, 64),
        lastErrorDetail: detail.slice(0, 512),
        updatedAt: now,
      })
      .where(eq(dataSources.id, sourceId));
  }
}

/**
 * Plans one week of league-scored publications, one league at a time.
 *
 * Publication is decided per POSITION, never per league: `normalizeLeagueScoringProfile` reports
 * which of QB/RB/WR/TE/K/DST a league's rules can actually be priced for, and each of those
 * positions then clears (or fails) its own league-scored backtest gate. A position that cannot be
 * priced, or whose own backtest fails, is withheld alone and reported with its reasons — it never
 * withholds the positions around it.
 *
 * Exported (rather than a private method) because this is the only place per-position withholding
 * is decided, and it is a pure function of its inputs; driving it directly is the only way to
 * cover the partial-support branches without seeding a full multi-season training history.
 */
export function buildFirstPartyLeaguePublications(input: {
  readonly season: number;
  readonly week: number;
  readonly now: Date;
  readonly sourceAsOf: Date;
  readonly inputChecksum: string;
  readonly playerBacktest: FirstPartyProjectionBacktest;
  readonly basePlayerBacktest: FirstPartyProjectionBacktest;
  readonly defenseBacktest: FirstPartyTeamDefenseBacktest;
  readonly players: readonly PlayerRow[];
  readonly leagues: readonly LeagueRow[];
  readonly rules: readonly LeagueRuleRow[];
  readonly rosters: readonly LeagueRosterPlayer[];
  readonly publishedPlayers: readonly PublishedPlayer[];
  readonly publishedDefenses: readonly PublishedDefense[];
  readonly previousRowsByLeague: ReadonlyMap<string, ReadonlyMap<string, ScoredProjectionRow>>;
}): LeaguePublicationPlan {
  const rulesByLeague = new Map<string, LeagueRuleRow[]>();
  for (const rule of input.rules) {
    const rows = rulesByLeague.get(rule.leagueSeasonId) ?? [];
    rows.push(rule);
    rulesByLeague.set(rule.leagueSeasonId, rows);
  }
  const rosterByLeague = new Map<string, LeagueRosterPlayer[]>();
  for (const player of input.rosters) {
    const rows = rosterByLeague.get(player.leagueSeasonId) ?? [];
    rows.push(player);
    rosterByLeague.set(player.leagueSeasonId, rows);
  }
  const defenseByTeam = new Map(input.publishedDefenses.map((defense) => [defense.team, defense]));
  const canonicalDefensePlayers = input.players.filter((player) => {
    const team = upper(player.nflTeam);
    return (
      isDefensePosition(player.primaryPosition) &&
      team !== null &&
      defenseByTeam.has(team) &&
      player.id === firstPartyDefensePlayerId(team)
    );
  });

  const publications: LeaguePublication[] = [];
  const withheld: WithheldLeague[] = [];
  const notes: LeaguePublicationNote[] = [];
  for (const league of input.leagues) {
    const visiblePlayers = input.publishedPlayers.filter(
      (player) =>
        player.leagueSeasonScopes.length === 0 || player.leagueSeasonScopes.includes(league.id),
    );
    const shadowedCanonicalIds = new Set(
      visiblePlayers.flatMap((player) =>
        player.leagueSeasonScopes.length > 0 && player.canonicalMatchId
          ? [player.canonicalMatchId]
          : [],
      ),
    );
    const leaguePlayers = visiblePlayers.filter(
      (player) =>
        player.leagueSeasonScopes.length > 0 || !shadowedCanonicalIds.has(player.playerId),
    );
    const playerById = new Map(leaguePlayers.map((player) => [player.playerId, player]));
    const normalization = normalizeLeagueScoringProfile({
      id: `league:${league.id}`,
      label: "League scoring",
      version: LEAGUE_SCORING_NORMALIZATION_VERSION,
      rows: (rulesByLeague.get(league.id) ?? []).map((rule) => ({
        provider: league.provider,
        statKey: rule.statKey,
        providerStatId: rule.providerStatId,
        operation: rule.operation,
        points: rule.points,
        thresholdLow: rule.thresholdLow,
        thresholdHigh: rule.thresholdHigh,
      })),
      availableStatIds: firstPartyAvailableProjectionComponents(),
    });
    if (normalization.state === "unavailable") {
      withheld.push({
        leagueSeasonId: league.id,
        scope: "league",
        reasons: normalization.reasons.map(normalizationReasonText),
        positions: normalizationWithheldPositions(normalization.positions),
      });
      continue;
    }
    const profile = normalization.profile;
    const profileKey = projectionScoringProfileKey(profile);
    const playerChampion = applyFirstPartyProjectionChampionPolicy(
      input.basePlayerBacktest,
      profile,
    );
    const publicationPlayerBacktest = applyFirstPartyProjectionFinalPolicy(
      input.basePlayerBacktest,
      playerChampion.policy,
    );
    const playerEvaluation = evaluateFirstPartyBacktestForScoringProfile(
      publicationPlayerBacktest,
      profile,
    );
    const defenseEvaluation = evaluateFirstPartyTeamDefenseBacktestForScoringProfile(
      input.defenseBacktest,
      profile,
    );
    // Normalization decides which positions this league's rules can be priced for at all; each
    // surviving position then answers for its own backtest. Neither verdict is collapsed into a
    // league-wide one: a D/ST the model cannot price, or a K whose residuals miss the gate, must
    // not take QB/RB/WR/TE down with it.
    const supportedByLeague = new Set(
      normalization.positions.filter((item) => item.supported).map((item) => item.position),
    );
    const withheldPositions: WithheldLeaguePosition[] = normalizationWithheldPositions(
      normalization.positions,
    );
    const publishablePlayerPositions = new Set<(typeof supportedPositions)[number]>();
    for (const position of supportedPositions) {
      if (!supportedByLeague.has(position)) continue;
      if (playerPositionEvaluationClearsGate(playerEvaluation, profile, position)) {
        publishablePlayerPositions.add(position);
        continue;
      }
      withheldPositions.push({
        position,
        source: "backtest-gate",
        reasons: [
          `The ${position} league-scored backtest did not clear the recency-only baseline gate.`,
        ],
      });
    }
    // The D/ST gate is evaluated only when D/ST is a position this league can be priced for. It
    // used to run whenever the profile carried any D/ST-relevant rule and withhold the whole
    // league on failure, which is how a D/ST-only problem silently deleted every offensive
    // projection in the league.
    //
    // `defenseRelevant` is unreachable-false today: normalization marks a position it prices
    // nothing for as unsupported, and D/ST's vocabulary is a subset of `defenseStatIds` — true by
    // construction now that both derive from `firstPartyTeamDefenseProjectionComponents()`. It
    // stays as fail-closed defense-in-depth — but it reports its OWN cause, because blaming a
    // backtest that was never consulted would be a lie in the run metrics.
    const defenseRelevant = hasRelevantRules(profile, true);
    const defensePublishable =
      supportedByLeague.has("DST") &&
      defenseRelevant &&
      defenseEvaluationClearsGate(defenseEvaluation);
    if (supportedByLeague.has("DST") && !defensePublishable) {
      withheldPositions.push(
        defenseRelevant
          ? {
              position: "DST",
              source: "backtest-gate",
              reasons: [
                "The D/ST league-scored backtest did not clear the recency-only baseline gate.",
              ],
            }
          : {
              position: "DST",
              source: "normalization",
              reasons: [
                "The emitted scoring profile carries no D/ST rule this projection run can price.",
              ],
            },
      );
    }
    if (publishablePlayerPositions.size === 0 && !defensePublishable) {
      withheld.push({
        leagueSeasonId: league.id,
        scope: "league",
        reasons: withheldPositionReasonText(withheldPositions),
        positions: withheldPositions,
      });
      continue;
    }

    const leagueRoster = rosterByLeague.get(league.id) ?? [];
    const leagueRosterIds = new Set(leagueRoster.map((player) => player.playerId));
    const rosteredDefenseByTeam = new Map<string, LeagueRosterPlayer[]>();
    for (const rosterPlayer of leagueRoster) {
      const team = upper(rosterPlayer.nflTeam);
      if (!team || !isDefensePosition(rosterPlayer.primaryPosition)) continue;
      const rows = rosteredDefenseByTeam.get(team) ?? [];
      rows.push(rosterPlayer);
      rosteredDefenseByTeam.set(team, rows);
    }
    // A league nobody has drafted in has no roster coverage to verify: every team is snapshotted
    // and every snapshot is empty, so the only roster row is the incomplete-snapshot sentinel and
    // the gap check below would withhold the league for the entire pre-season. Publishing its
    // player pool is what the operator chose here — but ONLY for this unambiguous case. One real
    // rostered player anywhere makes the league `"complete"`, which is a partial sync, and that
    // keeps failing closed exactly as before.
    const rosterCoverage = leagueRosterCoverage(leagueRoster);
    const rosterGaps =
      rosterCoverage === "pre-draft"
        ? []
        : leagueRoster.filter((rosterPlayer) => {
            if (isDefensePosition(rosterPlayer.primaryPosition)) {
              return (
                !rosterPlayer.nflTeam || !defenseByTeam.has(rosterPlayer.nflTeam.toUpperCase())
              );
            }
            return (
              !firstPartyProjectionPositionIsSupported(rosterPlayer.primaryPosition) ||
              !playerById.has(rosterPlayer.playerId)
            );
          });
    if (rosterGaps.length > 0) {
      const snapshotsIncomplete = rosterGaps.some((player) =>
        player.playerId.startsWith("INCOMPLETE-ROSTER:"),
      );
      withheld.push({
        leagueSeasonId: league.id,
        scope: "league",
        reasons: [
          snapshotsIncomplete
            ? "League roster snapshots are incomplete."
            : `Roster coverage is incomplete for ${rosterGaps.length} player${rosterGaps.length === 1 ? "" : "s"}.`,
        ],
        // Positions this league could not have published either way stay recorded even when an
        // unrelated operational failure is what actually stopped the league.
        ...(withheldPositions.length === 0 ? {} : { positions: withheldPositions }),
      });
      continue;
    }

    const scored = new Map<string, ScoredProjectionRow>();
    // Position per emitted row, so published coverage is reported from the rows this set actually
    // carries rather than from the gate verdicts that merely permitted them.
    const rowPositions = new Map<string, LeagueScoringPosition>();
    const previousRows =
      input.previousRowsByLeague.get(league.id) ?? new Map<string, ScoredProjectionRow>();
    const lockedRosterWithoutBaseline: string[] = [];
    let frozenPlayerCount = 0;
    const frozenPlayerIds = new Set<string>();
    for (const player of leaguePlayers) {
      // The player's position is the withholding unit; a withheld one contributes no rows and no
      // locked-roster accounting, so it can neither be published nor withhold anything else.
      const rowPosition = publishablePlayerPositionOf(publishablePlayerPositions, player.position);
      if (rowPosition === undefined) continue;
      if (player.gameStarted) {
        const previous = previousRows.get(player.playerId);
        if (previous) {
          scored.set(
            player.playerId,
            rescoreFrozenProjection(
              previous,
              profile,
              residualForPlayer(playerEvaluation, player.playerId, player.position),
            ),
          );
          rowPositions.set(player.playerId, rowPosition);
          frozenPlayerCount += 1;
          frozenPlayerIds.add(player.playerId);
        } else if (leagueRosterIds.has(player.playerId)) {
          lockedRosterWithoutBaseline.push(player.playerId);
        }
        continue;
      }
      const selectedProjection =
        firstPartyChampionStrategyForPosition(playerChampion.policy, player.position) ===
        "first-party-model"
          ? player.modelProjection
          : player.baselineProjection;
      const components = projectionComponents(player.position, selectedProjection.components);
      const rawMean = scoreProjectionStatComponents(components, profile);
      const calibration = residualForPlayer(playerEvaluation, player.playerId, player.position);
      const mean =
        selectedProjection.state === "zero" ? rawMean : leagueScoredMean(rawMean, calibration);
      const interval =
        selectedProjection.state === "zero"
          ? { floor: mean, ceiling: mean }
          : leagueScoredInterval(mean, calibration);
      scored.set(player.playerId, {
        playerId: player.playerId,
        mean,
        ...interval,
        confidence: selectedProjection.quality.confidence,
        components,
      });
      rowPositions.set(player.playerId, rowPosition);
    }
    for (const player of defensePublishable ? canonicalDefensePlayers : []) {
      const team = upper(player.nflTeam);
      const defense = team ? defenseByTeam.get(team) : undefined;
      if (!team || !defense) continue;
      const rosterAliases = rosteredDefenseByTeam.get(team) ?? [];
      const outputPlayerIds =
        rosterAliases.length > 0 ? rosterAliases.map((row) => row.playerId) : [player.id];
      for (const outputPlayerId of outputPlayerIds) {
        if (defense.gameStarted) {
          const previous = previousRows.get(outputPlayerId);
          if (previous) {
            scored.set(
              outputPlayerId,
              rescoreFrozenProjection(previous, profile, residualForDefense(defenseEvaluation)),
            );
            rowPositions.set(outputPlayerId, "DST");
            frozenPlayerCount += 1;
            frozenPlayerIds.add(outputPlayerId);
          } else if (leagueRosterIds.has(outputPlayerId)) {
            lockedRosterWithoutBaseline.push(outputPlayerId);
          }
          continue;
        }
        const components = defense.projection.components;
        const rawMean = scoreProjectionStatComponents(components, profile);
        const calibration = residualForDefense(defenseEvaluation);
        const bye = defense.projection.reasons.some((reason) => reason.includes("confirmed bye"));
        const mean = bye ? rawMean : leagueScoredMean(rawMean, calibration);
        const interval = defense.projection.reasons.some((reason) =>
          reason.includes("confirmed bye"),
        )
          ? { floor: mean, ceiling: mean }
          : leagueScoredInterval(mean, calibration);
        scored.set(outputPlayerId, {
          playerId: outputPlayerId,
          mean,
          ...interval,
          confidence: defense.projection.quality.confidence,
          components: { ...components },
        });
        rowPositions.set(outputPlayerId, "DST");
      }
    }
    if (lockedRosterWithoutBaseline.length > 0) {
      withheld.push({
        leagueSeasonId: league.id,
        scope: "league",
        reasons: [
          `No pre-kickoff forecast was available for ${lockedRosterWithoutBaseline.length} locked roster player${lockedRosterWithoutBaseline.length === 1 ? "" : "s"}.`,
        ],
        ...(withheldPositions.length === 0 ? {} : { positions: withheldPositions }),
      });
      continue;
    }
    if (scored.size === 0) {
      withheld.push({
        leagueSeasonId: league.id,
        scope: "league",
        reasons: ["No safely scored player projections were available."],
        ...(withheldPositions.length === 0 ? {} : { positions: withheldPositions }),
      });
      continue;
    }
    // The league publishes, but not for everything it asked for. Recording that here — instead of
    // only in the publication's own metadata — keeps every withholding this run performed visible
    // in one place, and `scope` tells a reader this league still produced rows.
    if (withheldPositions.length > 0) {
      withheld.push({
        leagueSeasonId: league.id,
        scope: "positions",
        reasons: withheldPositionReasonText(withheldPositions),
        positions: withheldPositions,
      });
    }

    const setChecksum = projectionInputChecksum({
      modelInputChecksum: input.inputChecksum,
      leagueSeasonId: league.id,
      profileKey,
      roster: leagueRoster.map((player) => player.playerId).sort(),
      frozenRows:
        frozenPlayerCount === 0
          ? []
          : [...scored.values()]
              .filter((row) => frozenPlayerIds.has(row.playerId))
              .sort((left, right) => left.playerId.localeCompare(right.playerId)),
    });
    const publishedPositionSet = new Set<LeagueScoringPosition>();
    for (const playerId of scored.keys()) {
      const rowPosition = rowPositions.get(playerId);
      if (rowPosition !== undefined) publishedPositionSet.add(rowPosition);
    }
    const profileDigest = sha256(profileKey).slice(0, 16);
    const version = `${FIRST_PARTY_PROJECTION_MODEL_VERSION}:${input.season}:W${input.week}:${league.id}:${profileDigest}:${setChecksum.slice(0, 16)}`;
    const eligible = scored.size;
    const trainingCutoff = playerEvaluation.generatedThrough ??
      defenseEvaluation.generatedThrough ?? { season: input.season - 1, week: 18 };
    publications.push({
      league,
      profile,
      profileKey,
      rows: [...scored.values()].sort((left, right) => left.playerId.localeCompare(right.playerId)),
      version,
      inputChecksum: setChecksum,
      metadata: {
        managed: true,
        sourceLabel: "Laces Out first-party projections",
        modelVersion: FIRST_PARTY_PROJECTION_MODEL_VERSION,
        modelInputChecksum: input.inputChecksum,
        scoringProfile: profile,
        scoringProfileKey: profileKey,
        scoringMappingVersion: LEAGUE_SCORING_NORMALIZATION_VERSION,
        championPolicy: playerChampion.policy,
        scoringWarnings: normalization.warnings,
        // Coverage is per position, so state it per position. `supportedPositions` is what the
        // league's rules can be priced for; `publishedPositions` is derived from the rows this set
        // actually carries, so it never claims a position whose gate cleared but which produced no
        // row (every kicker unavailable, no canonical defense entity, …). A consumer must read the
        // second.
        supportedPositions: [...supportedByLeague],
        publishedPositions: LEAGUE_SCORING_POSITIONS.filter((position) =>
          publishedPositionSet.has(position),
        ),
        withheldPositions,
        computedAt: input.now.toISOString(),
        sourceAsOf: input.sourceAsOf.toISOString(),
        inputCheckedAt: input.sourceAsOf.toISOString(),
        trainingCutoff,
        statsThrough: trainingCutoff,
        qualityState: "publishable",
        coverage: {
          projected: scored.size,
          eligible,
          ratio: eligible === 0 ? 0 : scored.size / eligible,
        },
        warnings: [
          ...normalization.warnings.map((warning) => warning.message),
          ...defenseMethodWarnings,
          availabilityMethodWarning,
          ...(frozenPlayerCount > 0
            ? ["Players whose games started retain their last pre-kickoff forecast."]
            : []),
        ],
        backtest: backtestSummaryForSupportedPositions(playerEvaluation, supportedByLeague),
        season: input.season,
        week: input.week,
        pointIntervals: "league-scored residual quantiles",
        baseline: "recency-only",
        playerBacktest: playerEvaluation.overall,
        defenseBacktest: defenseEvaluation.overall,
        // What the roster told us, and whether it was actually verifiable. A pre-draft set has no
        // coverage to check, so it must not claim one was performed.
        rosterCoverage,
        rosterCoverageChecked: rosterCoverage === "complete",
        frozenPlayerCount,
      },
    });
    if (rosterCoverage === "pre-draft") {
      notes.push({
        leagueSeasonId: league.id,
        code: "pre-draft-roster",
        message:
          "No team has a rostered player yet, so this league published its player pool without a roster coverage check.",
      });
    }
  }
  return { publications, withheld, notes };
}
