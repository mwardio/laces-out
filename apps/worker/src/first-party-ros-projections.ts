import { createHash } from "node:crypto";

import {
  dataSources,
  firstPartyRosChampionArtifacts,
  nflScheduleObservations,
  playerProjections,
  playerRosProjectionSummaries,
  projectionModelRuns,
  projectionObservations,
  projectionSets,
  syncRuns,
  type Database,
} from "@fantasy/db";
import {
  FIRST_PARTY_ROS_MINIMUM_BATCHES,
  FIRST_PARTY_ROS_MINIMUM_HELD_OUT_SEASONS,
  FIRST_PARTY_ROS_MINIMUM_SAMPLES,
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_PROJECTION_MODEL_VERSION,
  type FirstPartyRosChampionPolicy,
} from "@fantasy/projections";
import { and, desc, eq, inArray } from "drizzle-orm";

import {
  buildFirstPartyRosPlayerPersistenceRow,
  buildFirstPartyRosRunPayload,
  evaluateFirstPartyRosPublication,
  type FirstPartyRosPublicationDecision,
  type FirstPartyRosReleasedPlayer,
  type FirstPartyRosRunConvergence,
  type LoadedFirstPartyRosChampionArtifact,
} from "./first-party-ros-publication.js";
import { FIRST_PARTY_PROJECTION_SOURCE_KEY } from "./first-party-projections.js";
import type { ProjectionRefreshJob, ProjectionRefreshService, WorkerJobContext } from "./jobs.js";

export const FIRST_PARTY_ROS_RELEASE_SET_SOURCE = "laces-out-first-party-ros";

/**
 * Supplies league-scoped publication targets for an admitted champion artifact: the per-bucket live
 * release evidence, the released players' selected-strategy simulations, and a persistable bounded
 * convergence diagnostic. A real provider enumerates leagues whose scoring profile matches the
 * artifact and builds future-week centers; the default provider yields none, so the rail fails
 * closed even if an artifact somehow exists without a configured builder.
 */
export interface FirstPartyRosPublicationTarget {
  readonly leagueSeasonId: string;
  readonly leagueScoringProfileKey: string;
  readonly futureWindowComplete: boolean;
  readonly evidence: Parameters<typeof evaluateFirstPartyRosPublication>[0]["evidence"];
  readonly convergence: FirstPartyRosRunConvergence;
  readonly released: readonly FirstPartyRosReleasedPlayer[];
  readonly sourceAsOf: Date;
}

export interface FirstPartyRosCandidateContext {
  readonly artifact: LoadedFirstPartyRosChampionArtifact;
  readonly season: number;
  readonly window: FirstPartyRosWindow;
  readonly now: Date;
}

export interface FirstPartyRosCandidateProvider {
  buildTargets(
    context: FirstPartyRosCandidateContext,
  ): Promise<readonly FirstPartyRosPublicationTarget[]>;
}

export const nullFirstPartyRosCandidateProvider: FirstPartyRosCandidateProvider = {
  buildTargets() {
    return Promise.resolve([]);
  },
};

export const FIRST_PARTY_ROS_SHADOW_SOURCE_KEY = "laces-out.projections.first-party-ros-shadow";
export const FIRST_PARTY_ROS_SHADOW_MODEL_VERSION = `${FIRST_PARTY_ROS_MODEL_VERSION}-shadow-rail-v1`;

const scheduleSourceKey = (season: number) => `nflverse.schedules.${season}`;
const checkIntervalMinutes = 60;
const sourceSchemaVersion = 1;
const regularSeasonEndWeek = 18;

export interface FirstPartyRosScheduleFact {
  readonly week: number;
  readonly kickoffAt: Date | null;
  readonly status: "scheduled" | "in-progress" | "final" | "postponed" | "cancelled";
  readonly awayScore: number | null;
  readonly homeScore: number | null;
}

export interface FirstPartyRosWindow {
  readonly asOfWeek: number;
  readonly currentWeek: number;
  readonly windowStartWeek: number;
  readonly windowEndWeek: typeof regularSeasonEndWeek;
  readonly currentWeekStarted: boolean;
}

export interface FirstPartyRosEvidence {
  readonly heldOutSeasons: number;
  readonly batches: number;
  readonly samples: number;
  readonly calibratedIntervals: boolean;
}

export interface FirstPartyRosEvidenceGate {
  readonly cleared: boolean;
  readonly heldOutSeasons: number;
  readonly batches: number;
  readonly samples: number;
  readonly calibratedIntervals: boolean;
  readonly requirements: {
    readonly heldOutSeasons: number;
    readonly batches: number;
    readonly samples: number;
    readonly calibratedIntervals: true;
  };
  readonly reasons: readonly string[];
}

export interface FirstPartyRosWeeklyPin {
  readonly week: number;
  readonly inputChecksum: string;
  readonly qualityState: "publishable" | "degraded" | "rejected";
  readonly playersPublished: number;
  readonly observationCount: number;
  readonly sourceAsOf: Date;
  readonly createdAt: Date;
}

export interface FirstPartyRosShadowPlan {
  readonly qualityState: "degraded";
  readonly canEvaluatePlayers: boolean;
  readonly canPublish: false;
  readonly expectedWeeks: readonly number[];
  readonly pinnedWeeks: readonly number[];
  readonly missingWeeks: readonly number[];
  readonly evidenceGate: FirstPartyRosEvidenceGate;
  readonly diagnostics: readonly string[];
}

interface ManagedSourceState {
  readonly id: string;
  readonly key: string;
  readonly enabled: boolean;
  readonly lastChecksum: string | null;
  readonly lastSuccessfulAt: Date | null;
  readonly lastCheckedAt: Date | null;
  readonly lastChangedAt: Date | null;
  readonly consecutiveFailures: number;
  readonly checkIntervalMinutes: number;
}

interface RosChecksumInput {
  readonly season: number;
  readonly window: FirstPartyRosWindow;
  readonly schedule: { readonly sourceKey: string; readonly checksum: string };
  readonly weeklySource: { readonly sourceKey: string; readonly checksum: string } | null;
  readonly weeklyPins: readonly FirstPartyRosWeeklyPin[];
  readonly evidence: FirstPartyRosEvidence;
  readonly gateInputs: {
    readonly scheduleFresh: boolean;
    readonly weeklySourcePresent: boolean;
    readonly weeklySourceFresh: boolean;
    readonly candidatePairsPersisted: boolean;
  };
}

function isCompletedGame(game: FirstPartyRosScheduleFact): boolean {
  return (
    game.status === "final" ||
    game.status === "cancelled" ||
    (game.awayScore !== null && game.homeScore !== null)
  );
}

function hasKickedOff(game: FirstPartyRosScheduleFact, now: Date): boolean {
  if (game.status === "cancelled" || game.status === "postponed") return false;
  return (
    game.status === "in-progress" ||
    game.status === "final" ||
    (game.awayScore !== null && game.homeScore !== null) ||
    (game.kickoffAt !== null && game.kickoffAt.getTime() <= now.getTime())
  );
}

/**
 * Chooses an untouched regular-season ROS window. Once any game in the current NFL week starts,
 * that entire week is excluded so a late refresh cannot mix realized and forecast production.
 */
export function firstPartyRosWindow(
  schedule: readonly FirstPartyRosScheduleFact[],
  now: Date,
): FirstPartyRosWindow | null {
  if (!Number.isFinite(now.getTime())) throw new TypeError("ROS refresh time must be valid");
  const byWeek = new Map<number, FirstPartyRosScheduleFact[]>();
  for (const game of schedule) {
    if (!Number.isSafeInteger(game.week) || game.week < 1 || game.week > regularSeasonEndWeek) {
      continue;
    }
    const games = byWeek.get(game.week) ?? [];
    games.push(game);
    byWeek.set(game.week, games);
  }
  const weeks = [...byWeek.keys()].sort((left, right) => left - right);
  const currentWeek = weeks.find((week) => {
    const games = byWeek.get(week) ?? [];
    return games.some((game) => !isCompletedGame(game));
  });
  if (currentWeek === undefined) return null;
  const currentGames = byWeek.get(currentWeek) ?? [];
  const currentWeekStarted = currentGames.some((game) => hasKickedOff(game, now));
  const windowStartWeek = currentWeek + (currentWeekStarted ? 1 : 0);
  if (windowStartWeek > regularSeasonEndWeek) return null;
  return {
    asOfWeek: currentWeekStarted ? currentWeek : Math.max(0, currentWeek - 1),
    currentWeek,
    windowStartWeek,
    windowEndWeek: regularSeasonEndWeek,
    currentWeekStarted,
  };
}

export function evaluateFirstPartyRosEvidenceGate(
  evidence: FirstPartyRosEvidence,
): FirstPartyRosEvidenceGate {
  for (const [label, value] of [
    ["heldOutSeasons", evidence.heldOutSeasons],
    ["batches", evidence.batches],
    ["samples", evidence.samples],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${label} must be a non-negative integer`);
    }
  }
  const reasons = [
    ...(evidence.heldOutSeasons < FIRST_PARTY_ROS_MINIMUM_HELD_OUT_SEASONS
      ? ["held_out_seasons_below_minimum"]
      : []),
    ...(evidence.batches < FIRST_PARTY_ROS_MINIMUM_BATCHES
      ? ["held_out_batches_below_minimum"]
      : []),
    ...(evidence.samples < FIRST_PARTY_ROS_MINIMUM_SAMPLES
      ? ["held_out_samples_below_minimum"]
      : []),
    ...(!evidence.calibratedIntervals ? ["prediction_intervals_not_calibrated"] : []),
  ];
  return {
    cleared: reasons.length === 0,
    ...evidence,
    requirements: {
      heldOutSeasons: FIRST_PARTY_ROS_MINIMUM_HELD_OUT_SEASONS,
      batches: FIRST_PARTY_ROS_MINIMUM_BATCHES,
      samples: FIRST_PARTY_ROS_MINIMUM_SAMPLES,
      calibratedIntervals: true,
    },
    reasons,
  };
}

function normalizeForChecksum(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeForChecksum);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, candidate]) => [key, normalizeForChecksum(candidate)]),
    );
  }
  return value;
}

/** Stable across database row order and wall-clock-only refreshes. */
export function firstPartyRosLiveChecksum(input: RosChecksumInput): string {
  const normalized = {
    schemaVersion: sourceSchemaVersion,
    horizon: "rest-of-season",
    modelVersion: FIRST_PARTY_ROS_SHADOW_MODEL_VERSION,
    simulationModelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
    ...input,
    weeklyPins: [...input.weeklyPins].sort((left, right) => left.week - right.week),
  };
  return createHash("sha256")
    .update(JSON.stringify(normalizeForChecksum(normalized)))
    .digest("hex");
}

export function firstPartyRosShadowIdempotencyKey(input: {
  readonly season: number;
  readonly window: FirstPartyRosWindow;
  readonly inputChecksum: string;
}): string {
  if (!Number.isSafeInteger(input.season) || input.season < 2000 || input.season > 2200) {
    throw new RangeError("ROS season must be between 2000 and 2200");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.inputChecksum)) {
    throw new TypeError("ROS input checksum must be a lowercase SHA-256 digest");
  }
  return [
    FIRST_PARTY_ROS_SHADOW_SOURCE_KEY,
    FIRST_PARTY_ROS_SHADOW_MODEL_VERSION,
    "rest-of-season",
    input.season,
    `${input.window.windowStartWeek}-${input.window.windowEndWeek}`,
    `asof-${input.window.asOfWeek}`,
    input.inputChecksum,
  ].join(":");
}

export function planFirstPartyRosShadow(input: {
  readonly window: FirstPartyRosWindow;
  readonly scheduleFresh: boolean;
  readonly weeklySourcePresent: boolean;
  readonly weeklySourceFresh: boolean;
  readonly weeklyPins: readonly FirstPartyRosWeeklyPin[];
  readonly evidence: FirstPartyRosEvidence;
  /** The weekly rail currently persists the selected candidate, not both champion candidates. */
  readonly candidatePairsPersisted: boolean;
}): FirstPartyRosShadowPlan {
  const expectedWeeks = Array.from(
    { length: input.window.windowEndWeek - input.window.windowStartWeek + 1 },
    (_, index) => input.window.windowStartWeek + index,
  );
  const usablePins = [...input.weeklyPins]
    .filter(
      (pin) => pin.week >= input.window.windowStartWeek && pin.week <= input.window.windowEndWeek,
    )
    .sort((left, right) => left.week - right.week);
  const pinnedWeeks = [...new Set(usablePins.map((pin) => pin.week))];
  const missingWeeks = expectedWeeks.filter((week) => !pinnedWeeks.includes(week));
  const evidenceGate = evaluateFirstPartyRosEvidenceGate(input.evidence);
  const diagnostics = [
    ...(!input.scheduleFresh ? ["schedule_source_not_fresh"] : []),
    ...(!input.weeklySourcePresent ? ["weekly_projection_source_missing"] : []),
    ...(input.weeklySourcePresent && !input.weeklySourceFresh
      ? ["weekly_projection_source_not_fresh"]
      : []),
    ...(missingWeeks.length > 0 ? ["weekly_projection_window_incomplete"] : []),
    ...(usablePins.some(
      (pin) =>
        pin.qualityState !== "publishable" ||
        pin.playersPublished <= 0 ||
        pin.observationCount <= 0,
    )
      ? ["weekly_projection_pin_not_publishable"]
      : []),
    ...(!input.candidatePairsPersisted ? ["weekly_candidate_pairs_not_persisted"] : []),
    ...evidenceGate.reasons,
    // This integration remains shadow-only even after the evidence gate clears. Promotion must be
    // an explicit release so recommendations cannot begin consuming it accidentally.
    "shadow_publication_disabled",
  ];
  const canEvaluatePlayers =
    input.scheduleFresh &&
    input.weeklySourcePresent &&
    input.weeklySourceFresh &&
    missingWeeks.length === 0 &&
    usablePins.every(
      (pin) =>
        pin.qualityState === "publishable" && pin.playersPublished > 0 && pin.observationCount > 0,
    ) &&
    input.candidatePairsPersisted &&
    evidenceGate.cleared;
  return {
    qualityState: "degraded",
    canEvaluatePlayers,
    canPublish: false,
    expectedWeeks,
    pinnedWeeks,
    missingWeeks,
    evidenceGate,
    diagnostics: [...new Set(diagnostics)],
  };
}

function sourceIsFresh(source: ManagedSourceState, now: Date): boolean {
  if (
    !source.enabled ||
    source.lastChecksum === null ||
    source.lastSuccessfulAt === null ||
    source.lastCheckedAt === null ||
    source.consecutiveFailures > 0
  ) {
    return false;
  }
  const maximumAgeMinutes = source.checkIntervalMinutes * 3 + 30;
  return now.getTime() - source.lastCheckedAt.getTime() <= maximumAgeMinutes * 60_000;
}

function latestDate(values: readonly Date[]): Date {
  return new Date(Math.max(...values.map((value) => value.getTime())));
}

function earliestDate(values: readonly Date[]): Date {
  return new Date(Math.min(...values.map((value) => value.getTime())));
}

/**
 * Shadow-only ROS orchestration. It audits immutable weekly outputs already in PostgreSQL and
 * records a degraded model run; it deliberately writes no projection observations, sets,
 * summaries, or recommendation-facing rows.
 */
export class FirstPartyRosProjectionShadowService implements ProjectionRefreshService {
  readonly #database: Database;
  readonly #now: () => Date;
  readonly #candidateProvider: FirstPartyRosCandidateProvider;

  constructor(input: {
    readonly database: Database;
    readonly now?: () => Date;
    readonly candidateProvider?: FirstPartyRosCandidateProvider;
  }) {
    this.#database = input.database;
    this.#now = input.now ?? (() => new Date());
    this.#candidateProvider = input.candidateProvider ?? nullFirstPartyRosCandidateProvider;
  }

  async refreshProjections(job: ProjectionRefreshJob, context: WorkerJobContext): Promise<void> {
    const now = this.#now();
    if (!Number.isSafeInteger(job.season) || job.season < 2000 || job.season > 2200) {
      throw new RangeError("ROS season must be between 2000 and 2200");
    }
    if (!Number.isFinite(now.getTime())) throw new TypeError("ROS refresh time must be valid");
    const managed = await this.#ensureManagedSource(now);
    if (!managed.enabled) return;
    try {
      if (context.signal.aborted) throw new Error("ROS shadow refresh was cancelled");
      const sourceRows = await this.#database
        .select({
          id: dataSources.id,
          key: dataSources.key,
          enabled: dataSources.enabled,
          lastChecksum: dataSources.lastChecksum,
          lastSuccessfulAt: dataSources.lastSuccessfulAt,
          lastCheckedAt: dataSources.lastCheckedAt,
          lastChangedAt: dataSources.lastChangedAt,
          consecutiveFailures: dataSources.consecutiveFailures,
          checkIntervalMinutes: dataSources.checkIntervalMinutes,
        })
        .from(dataSources)
        .where(
          inArray(dataSources.key, [
            scheduleSourceKey(job.season),
            FIRST_PARTY_PROJECTION_SOURCE_KEY,
          ]),
        );
      const byKey = new Map(sourceRows.map((row) => [row.key, row]));
      const scheduleSource = byKey.get(scheduleSourceKey(job.season));
      if (!scheduleSource?.lastChecksum) {
        await this.#recordBlocked(managed.id, now, "schedule_source_missing");
        return;
      }
      const scheduleRows = await this.#database
        .select({
          week: nflScheduleObservations.week,
          kickoffAt: nflScheduleObservations.kickoffAt,
          status: nflScheduleObservations.status,
          awayScore: nflScheduleObservations.awayScore,
          homeScore: nflScheduleObservations.homeScore,
          sourceAsOf: nflScheduleObservations.sourceAsOf,
          fetchedAt: nflScheduleObservations.fetchedAt,
        })
        .from(nflScheduleObservations)
        .where(
          and(
            eq(nflScheduleObservations.sourceId, scheduleSource.id),
            eq(nflScheduleObservations.season, job.season),
            eq(nflScheduleObservations.seasonType, "REG"),
            eq(nflScheduleObservations.inputChecksum, scheduleSource.lastChecksum),
          ),
        );
      const window = firstPartyRosWindow(scheduleRows, now);
      if (!window) {
        await this.#recordBlocked(managed.id, now, "no_untouched_regular_season_window");
        return;
      }

      const weeklySource = byKey.get(FIRST_PARTY_PROJECTION_SOURCE_KEY);
      const weeklyRunRows = weeklySource
        ? await this.#database
            .select({
              sourceSyncRunId: projectionModelRuns.sourceSyncRunId,
              targetWeek: projectionModelRuns.targetWeek,
              inputChecksum: projectionModelRuns.inputChecksum,
              qualityState: projectionModelRuns.qualityState,
              playersPublished: projectionModelRuns.playersPublished,
              sourceAsOf: projectionModelRuns.sourceAsOf,
              createdAt: projectionModelRuns.createdAt,
              trainedThroughSeason: projectionModelRuns.trainedThroughSeason,
              trainedThroughWeek: projectionModelRuns.trainedThroughWeek,
            })
            .from(projectionModelRuns)
            .where(
              and(
                eq(projectionModelRuns.sourceId, weeklySource.id),
                eq(projectionModelRuns.season, job.season),
                eq(projectionModelRuns.horizon, "week"),
                eq(projectionModelRuns.modelVersion, FIRST_PARTY_PROJECTION_MODEL_VERSION),
              ),
            )
            .orderBy(desc(projectionModelRuns.createdAt), desc(projectionModelRuns.sourceSyncRunId))
        : [];
      const latestByWeek = new Map<number, (typeof weeklyRunRows)[number]>();
      for (const row of weeklyRunRows) {
        if (
          row.targetWeek !== null &&
          row.targetWeek >= window.windowStartWeek &&
          row.targetWeek <= window.windowEndWeek &&
          !latestByWeek.has(row.targetWeek)
        ) {
          latestByWeek.set(row.targetWeek, row);
        }
      }
      const selectedRuns = [...latestByWeek.values()].sort(
        (left, right) => (left.targetWeek ?? 0) - (right.targetWeek ?? 0),
      );
      const observationRows =
        selectedRuns.length === 0
          ? []
          : await this.#database
              .select({ sourceSyncRunId: projectionObservations.sourceSyncRunId })
              .from(projectionObservations)
              .where(
                inArray(
                  projectionObservations.sourceSyncRunId,
                  selectedRuns.map((row) => row.sourceSyncRunId),
                ),
              );
      const observationCounts = new Map<string, number>();
      for (const observation of observationRows) {
        observationCounts.set(
          observation.sourceSyncRunId,
          (observationCounts.get(observation.sourceSyncRunId) ?? 0) + 1,
        );
      }
      const weeklyPins: FirstPartyRosWeeklyPin[] = selectedRuns.flatMap((row) =>
        row.targetWeek === null
          ? []
          : [
              {
                week: row.targetWeek,
                inputChecksum: row.inputChecksum,
                qualityState: row.qualityState,
                playersPublished: row.playersPublished,
                observationCount: observationCounts.get(row.sourceSyncRunId) ?? 0,
                sourceAsOf: row.sourceAsOf,
                createdAt: row.createdAt,
              },
            ],
      );
      // No held-out ROS forecasts or conformal interval calibration have been persisted yet.
      // Counting live shadow runs as held-out evidence would leak the current season into its own
      // publication decision, so the evidence stays explicitly empty.
      const evidence: FirstPartyRosEvidence = {
        heldOutSeasons: 0,
        batches: 0,
        samples: 0,
        calibratedIntervals: false,
      };
      const gateInputs = {
        scheduleFresh: sourceIsFresh(scheduleSource, now),
        weeklySourcePresent: weeklySource !== undefined,
        weeklySourceFresh: weeklySource ? sourceIsFresh(weeklySource, now) : false,
        candidatePairsPersisted: false,
      } as const;
      const plan = planFirstPartyRosShadow({
        window,
        ...gateInputs,
        weeklyPins,
        evidence,
      });
      const inputChecksum = firstPartyRosLiveChecksum({
        season: job.season,
        window,
        schedule: {
          sourceKey: scheduleSource.key,
          checksum: scheduleSource.lastChecksum,
        },
        weeklySource: weeklySource?.lastChecksum
          ? { sourceKey: weeklySource.key, checksum: weeklySource.lastChecksum }
          : null,
        weeklyPins,
        evidence,
        gateInputs,
      });
      const sourceDates = [
        ...scheduleRows.map((row) => row.sourceAsOf),
        ...weeklyPins.map((pin) => pin.sourceAsOf),
      ];
      const asOfDates = [
        ...scheduleRows.map((row) => row.fetchedAt),
        ...weeklyPins.map((pin) => pin.createdAt),
      ];
      const oldestSourceAsOf = earliestDate(sourceDates);
      // This is the newest source fact consumed, not a freshness floor. Persisting the latest
      // timestamp makes the database cutoff capable of detecting a future/leaking input.
      const sourceAsOf = latestDate(sourceDates);
      const asOfAt = latestDate(asOfDates);
      const trainedThrough = selectedRuns
        .filter((row) => row.trainedThroughWeek !== null)
        .sort((left, right) => {
          if (left.trainedThroughSeason !== right.trainedThroughSeason) {
            return right.trainedThroughSeason - left.trainedThroughSeason;
          }
          return (right.trainedThroughWeek ?? 0) - (left.trainedThroughWeek ?? 0);
        })[0];
      const idempotencyKey = firstPartyRosShadowIdempotencyKey({
        season: job.season,
        window,
        inputChecksum,
      });

      // Fail-closed release rail. With no admitted champion artifact this is skipped entirely and
      // the shadow audit below is byte-for-byte unchanged. A persisted artifact only authorizes
      // publication when it validates, its scoring identity matches the target league, and the live
      // release gate clears; otherwise the prior good set stays authoritative.
      const artifact = await this.#loadChampionArtifact(job.season);
      const publishedTargets = artifact
        ? await this.#attemptPublication({
            artifact,
            managedSourceId: managed.id,
            season: job.season,
            window,
            sourceAsOf,
            now,
            context,
          })
        : 0;

      await this.#database.transaction(async (transaction) => {
        const [run] = await transaction
          .insert(syncRuns)
          .values({
            kind: "first-party-ros-projection-shadow",
            state: "running",
            idempotencyKey,
            startedAt: now,
            recordsRead: scheduleRows.length + selectedRuns.length + observationRows.length,
            artifactChecksum: inputChecksum,
          })
          .onConflictDoNothing({ target: syncRuns.idempotencyKey })
          .returning({ id: syncRuns.id });
        if (!run) return;
        await transaction.insert(projectionModelRuns).values({
          sourceSyncRunId: run.id,
          sourceId: managed.id,
          season: job.season,
          horizon: "rest-of-season",
          targetWeek: null,
          windowStartWeek: window.windowStartWeek,
          windowEndWeek: window.windowEndWeek,
          asOfWeek: window.asOfWeek,
          asOfAt,
          // Summaries produced by a later explicit release must identify the mathematical model.
          // The shadow orchestration version remains separate in configuration and checksums.
          modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
          trainingWindowStartSeason: Math.max(1999, job.season - 3),
          trainedThroughSeason: trainedThrough?.trainedThroughSeason ?? job.season - 1,
          trainedThroughWeek: trainedThrough?.trainedThroughWeek ?? null,
          qualityState: plan.qualityState,
          playersEvaluated: 0,
          playersPublished: 0,
          inputChecksum,
          configuration: {
            mode: "shadow",
            sourceSchemaVersion,
            simulationModelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
            orchestrationVersion: FIRST_PARTY_ROS_SHADOW_MODEL_VERSION,
            weeklySourceKey: FIRST_PARTY_PROJECTION_SOURCE_KEY,
            weeklyRunChecksums: weeklyPins.map((pin) => ({
              week: pin.week,
              inputChecksum: pin.inputChecksum,
            })),
            outputPolicy: "no projection sets, observations, summaries, or recommendations",
            windowPolicy: "exclude entire current week after first kickoff",
            inputFreshness: {
              oldestSourceAsOf: oldestSourceAsOf.toISOString(),
              latestSourceAsOf: sourceAsOf.toISOString(),
              forecastAsOfAt: asOfAt.toISOString(),
            },
          },
          calibration: {
            state: "unavailable",
            intervals: "not-calibrated",
            simulationIntervalsAcceptedForPublication: false,
          },
          metrics: {
            gate: plan.evidenceGate,
            diagnostics: plan.diagnostics,
            weeklyWindow: {
              expectedWeeks: plan.expectedWeeks,
              pinnedWeeks: plan.pinnedWeeks,
              missingWeeks: plan.missingWeeks,
            },
            playersEvaluated: 0,
            reason:
              "Stored weekly outputs do not yet contain both champion candidates and held-out calibrated ROS evidence.",
          },
          sourceAsOf,
          createdAt: now,
        });
        await transaction
          .update(syncRuns)
          .set({ state: "complete", finishedAt: now, recordsWritten: 1 })
          .where(eq(syncRuns.id, run.id));
      });
      await this.#recordSuccess(managed.id, now, inputChecksum, {
        season: job.season,
        window: `${window.windowStartWeek}-${window.windowEndWeek}`,
        asOfWeek: window.asOfWeek,
        modelVersion: FIRST_PARTY_ROS_SHADOW_MODEL_VERSION,
        qualityState: "degraded",
        result: publishedTargets > 0 ? "released" : "shadow_evidence_recorded",
        diagnostics: plan.diagnostics.join("|"),
        ...(publishedTargets > 0 ? { publishedTargets } : {}),
      });
    } catch (error) {
      await this.#recordFailure(
        managed.id,
        now,
        "ROS_SHADOW_REFRESH_FAILED",
        error instanceof Error ? error.message : "ROS shadow refresh failed",
      );
      throw error;
    }
  }

  async #loadChampionArtifact(season: number): Promise<LoadedFirstPartyRosChampionArtifact | null> {
    const [row] = await this.#database
      .select({
        season: firstPartyRosChampionArtifacts.season,
        scoringProfileKey: firstPartyRosChampionArtifacts.scoringProfileKey,
        modelVersion: firstPartyRosChampionArtifacts.modelVersion,
        policyVersion: firstPartyRosChampionArtifacts.policyVersion,
        calibrationVersion: firstPartyRosChampionArtifacts.calibrationVersion,
        evidenceThroughSeason: firstPartyRosChampionArtifacts.evidenceThroughSeason,
        sourceChecksums: firstPartyRosChampionArtifacts.sourceChecksums,
        policy: firstPartyRosChampionArtifacts.policy,
        releaseGate: firstPartyRosChampionArtifacts.releaseGate,
        artifactChecksum: firstPartyRosChampionArtifacts.artifactChecksum,
      })
      .from(firstPartyRosChampionArtifacts)
      .where(eq(firstPartyRosChampionArtifacts.season, season))
      .orderBy(desc(firstPartyRosChampionArtifacts.admittedAt))
      .limit(1);
    if (!row) return null;
    return {
      season: row.season,
      scoringProfileKey: row.scoringProfileKey,
      modelVersion: row.modelVersion,
      policyVersion: row.policyVersion,
      calibrationVersion: row.calibrationVersion,
      evidenceThroughSeason: row.evidenceThroughSeason,
      sourceChecksums: row.sourceChecksums,
      policy: row.policy as unknown as FirstPartyRosChampionPolicy,
      releaseGate: row.releaseGate,
      artifactChecksum: row.artifactChecksum,
    };
  }

  async #attemptPublication(input: {
    readonly artifact: LoadedFirstPartyRosChampionArtifact;
    readonly managedSourceId: string;
    readonly season: number;
    readonly window: FirstPartyRosWindow;
    readonly sourceAsOf: Date;
    readonly now: Date;
    readonly context: WorkerJobContext;
  }): Promise<number> {
    const targets = await this.#candidateProvider.buildTargets({
      artifact: input.artifact,
      season: input.season,
      window: input.window,
      now: input.now,
    });
    let published = 0;
    for (const target of targets) {
      if (input.context.signal.aborted) throw new Error("ROS shadow refresh was cancelled");
      const decision = evaluateFirstPartyRosPublication({
        artifact: input.artifact,
        leagueScoringProfileKey: target.leagueScoringProfileKey,
        evidence: target.evidence,
        futureWindowComplete: target.futureWindowComplete,
      });
      if (!decision.canPublish) continue;
      const releasing = new Set(
        decision.releasingBuckets.map((bucket) => `${bucket.position}:${bucket.bucket}`),
      );
      const releasedPlayers = target.released.filter((player) =>
        releasing.has(`${player.projection.position}:${player.bucket}`),
      );
      if (releasedPlayers.length === 0) continue;
      const committed = await this.#persistPublication({
        artifact: input.artifact,
        managedSourceId: input.managedSourceId,
        decision,
        target,
        releasedPlayers,
        season: input.season,
        window: input.window,
        sourceAsOf: input.sourceAsOf,
        now: input.now,
      });
      if (committed) published += 1;
    }
    return published;
  }

  /**
   * Persists one league-scoped released ROS set — model run, projection set, player projections,
   * and ROS summaries — in a single idempotent transaction. A repeated run collides on the sync-run
   * idempotency key and becomes a no-op, so the previously published set stays authoritative and is
   * never deleted or overwritten.
   */
  async #persistPublication(input: {
    readonly artifact: LoadedFirstPartyRosChampionArtifact;
    readonly managedSourceId: string;
    readonly decision: FirstPartyRosPublicationDecision;
    readonly target: FirstPartyRosPublicationTarget;
    readonly releasedPlayers: readonly FirstPartyRosReleasedPlayer[];
    readonly season: number;
    readonly window: FirstPartyRosWindow;
    readonly sourceAsOf: Date;
    readonly now: Date;
  }): Promise<boolean> {
    const { window, season, now } = input;
    const rows = input.releasedPlayers.map(buildFirstPartyRosPlayerPersistenceRow);
    const asOfAtIso = input.releasedPlayers[0]!.projection.provenance.asOfAt;
    const asOfAt = new Date(asOfAtIso);
    const inputChecksum = createHash("sha256")
      .update(
        JSON.stringify({
          version: "first-party-ros-release-v1",
          artifactChecksum: input.artifact.artifactChecksum,
          leagueSeasonId: input.target.leagueSeasonId,
          season,
          window: `${window.windowStartWeek}-${window.windowEndWeek}`,
          asOfWeek: window.asOfWeek,
          asOfAt: asOfAtIso,
          players: input.releasedPlayers
            .map((player) => ({
              id: player.playerId,
              checksum: player.projection.provenance.inputChecksum,
              strategy: player.strategy,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        }),
      )
      .digest("hex");
    const idempotencyKey = [
      FIRST_PARTY_ROS_RELEASE_SET_SOURCE,
      FIRST_PARTY_ROS_MODEL_VERSION,
      input.target.leagueSeasonId,
      season,
      `${window.windowStartWeek}-${window.windowEndWeek}`,
      `asof-${window.asOfWeek}`,
      inputChecksum,
    ].join(":");
    const sourceAsOf = new Date(Math.min(input.sourceAsOf.getTime(), asOfAt.getTime()));
    const runPayload = buildFirstPartyRosRunPayload({
      artifact: input.artifact,
      decision: input.decision,
      convergence: input.target.convergence,
      orchestrationVersion: FIRST_PARTY_ROS_SHADOW_MODEL_VERSION,
      extraConfiguration: { leagueSeasonId: input.target.leagueSeasonId },
    });

    return this.#database.transaction(async (transaction) => {
      const [run] = await transaction
        .insert(syncRuns)
        .values({
          kind: "first-party-ros-projection",
          state: "running",
          leagueSeasonId: input.target.leagueSeasonId,
          idempotencyKey,
          startedAt: now,
          recordsRead: input.releasedPlayers.length,
          artifactChecksum: inputChecksum,
        })
        .onConflictDoNothing({ target: syncRuns.idempotencyKey })
        .returning({ id: syncRuns.id });
      if (!run) return true;
      await transaction.insert(projectionModelRuns).values({
        sourceSyncRunId: run.id,
        sourceId: input.managedSourceId,
        season,
        horizon: "rest-of-season",
        targetWeek: null,
        windowStartWeek: window.windowStartWeek,
        windowEndWeek: window.windowEndWeek,
        asOfWeek: window.asOfWeek,
        asOfAt,
        modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
        trainingWindowStartSeason: Math.max(1999, season - 3),
        trainedThroughSeason: input.artifact.evidenceThroughSeason,
        trainedThroughWeek: null,
        qualityState: "publishable",
        playersEvaluated: rows.length,
        playersPublished: rows.length,
        inputChecksum,
        configuration: runPayload.configuration,
        calibration: runPayload.calibration,
        metrics: runPayload.metrics,
        sourceAsOf,
        createdAt: now,
      });
      const [set] = await transaction
        .insert(projectionSets)
        .values({
          leagueSeasonId: input.target.leagueSeasonId,
          visibility: "league",
          source: FIRST_PARTY_ROS_RELEASE_SET_SOURCE,
          version: `${input.target.leagueSeasonId}:${season}:${window.windowStartWeek}-${window.windowEndWeek}:${inputChecksum}`,
          season,
          week: null,
          horizon: "rest-of-season",
          identityState: "explicit",
          windowStartWeek: window.windowStartWeek,
          windowEndWeek: window.windowEndWeek,
          asOfWeek: window.asOfWeek,
          asOfAt,
          fetchedAt: now,
          inputChecksum,
          metadata: {
            modelInputChecksum: inputChecksum,
            championArtifactChecksum: input.artifact.artifactChecksum,
            scoringProfileKey: input.artifact.scoringProfileKey,
          },
        })
        .returning({ id: projectionSets.id });
      if (!set) throw new Error("ROS release projection set insert returned no row");
      for (const row of rows) {
        await transaction.insert(playerProjections).values({
          projectionSetId: set.id,
          playerId: row.playerId,
          meanPoints: row.playerProjection.meanPoints,
          floorPoints: row.playerProjection.floorPoints,
          ceilingPoints: row.playerProjection.ceilingPoints,
          confidence: null,
          components: row.playerProjection.components,
        });
        await transaction.insert(playerRosProjectionSummaries).values({
          projectionSetId: set.id,
          sourceSyncRunId: run.id,
          playerId: row.playerId,
          season,
          windowStartWeek: window.windowStartWeek,
          windowEndWeek: window.windowEndWeek,
          asOfWeek: window.asOfWeek,
          asOfAt,
          scheduledGames: row.summary.scheduledGames,
          expectedGames: row.summary.expectedGames,
          aggregateMeanPoints: row.summary.aggregateMeanPoints,
          p15Points: row.summary.p15Points,
          p50Points: row.summary.p50Points,
          p85Points: row.summary.p85Points,
          meanPointsPerExpectedGame: row.summary.meanPointsPerExpectedGame,
          pointsStddev: row.summary.pointsStddev,
          availability: row.summary.availability,
          scenarioCount: row.summary.scenarioCount,
          methodVersion: row.summary.methodVersion,
          seedHash: row.summary.seedHash,
          inputChecksum,
          createdAt: now,
        });
      }
      await transaction
        .update(syncRuns)
        .set({ state: "complete", finishedAt: now, recordsWritten: rows.length })
        .where(eq(syncRuns.id, run.id));
      return true;
    });
  }

  async #ensureManagedSource(now: Date): Promise<ManagedSourceState> {
    const [source] = await this.#database
      .insert(dataSources)
      .values({
        key: FIRST_PARTY_ROS_SHADOW_SOURCE_KEY,
        name: "Laces Out first-party rest-of-season shadow projections",
        kind: "projection",
        attribution: "Laces Out",
        checkIntervalMinutes,
        nextCheckAt: now,
        metadata: {
          sourceSchemaVersion,
          modelVersion: FIRST_PARTY_ROS_SHADOW_MODEL_VERSION,
          simulationModelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
          mode: "shadow",
          publishable: false,
          recommendationEligible: false,
        },
      })
      .onConflictDoUpdate({
        target: dataSources.key,
        set: {
          name: "Laces Out first-party rest-of-season shadow projections",
          kind: "projection",
          attribution: "Laces Out",
          checkIntervalMinutes,
          updatedAt: now,
        },
      })
      .returning({
        id: dataSources.id,
        key: dataSources.key,
        enabled: dataSources.enabled,
        lastChecksum: dataSources.lastChecksum,
        lastSuccessfulAt: dataSources.lastSuccessfulAt,
        lastCheckedAt: dataSources.lastCheckedAt,
        lastChangedAt: dataSources.lastChangedAt,
        consecutiveFailures: dataSources.consecutiveFailures,
        checkIntervalMinutes: dataSources.checkIntervalMinutes,
      });
    if (!source) throw new Error("ROS shadow source could not be registered");
    return source;
  }

  async #recordBlocked(sourceId: string, now: Date, reason: string): Promise<void> {
    await this.#recordSuccess(sourceId, now, null, {
      result: "shadow_blocked",
      qualityState: "degraded",
      diagnostics: reason,
    });
  }

  async #recordSuccess(
    sourceId: string,
    now: Date,
    checksum: string | null,
    metadata: Readonly<Record<string, string | number>>,
  ): Promise<void> {
    const [source] = await this.#database
      .select({ metadata: dataSources.metadata, lastChecksum: dataSources.lastChecksum })
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
              lastChecksum: checksum,
              ...(source?.lastChecksum === checksum ? {} : { lastChangedAt: now }),
            }),
        nextCheckAt: new Date(now.getTime() + checkIntervalMinutes * 60_000),
        consecutiveFailures: 0,
        lastErrorAt: null,
        lastErrorCode: null,
        lastErrorDetail: null,
        metadata: {
          ...(source?.metadata ?? {}),
          sourceSchemaVersion,
          modelVersion: FIRST_PARTY_ROS_SHADOW_MODEL_VERSION,
          simulationModelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
          mode: "shadow",
          publishable: false,
          recommendationEligible: false,
          ...metadata,
        },
        updatedAt: now,
      })
      .where(eq(dataSources.id, sourceId));
  }

  async #recordFailure(sourceId: string, now: Date, code: string, detail: string): Promise<void> {
    const [source] = await this.#database
      .select({ consecutiveFailures: dataSources.consecutiveFailures })
      .from(dataSources)
      .where(eq(dataSources.id, sourceId))
      .limit(1);
    await this.#database
      .update(dataSources)
      .set({
        lastCheckedAt: now,
        nextCheckAt: new Date(now.getTime() + 30 * 60_000),
        consecutiveFailures: (source?.consecutiveFailures ?? 0) + 1,
        lastErrorAt: now,
        lastErrorCode: code.slice(0, 64),
        lastErrorDetail: detail.slice(0, 512),
        updatedAt: now,
      })
      .where(eq(dataSources.id, sourceId));
  }
}
