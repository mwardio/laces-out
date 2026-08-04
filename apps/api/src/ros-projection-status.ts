import {
  dataSources,
  firstPartyRosChampionArtifacts,
  leagueMemberships,
  leagueSeasons,
  leagues,
  nflScheduleObservations,
  playerWeeklyRosterObservations,
  playerProjections,
  projectionModelRuns,
  projectionSets,
  scoringRules,
  type Database,
} from "@fantasy/db";
import {
  FIRST_PARTY_ROS_MODEL_VERSION,
  LEAGUE_SCORING_NORMALIZATION_VERSION,
  normalizeLeagueScoringProfile,
  projectionScoringProfileKey,
  rosAvailableProjectionStatIds,
  rosScoringProfileCatalog,
  type LeagueScoringProvider,
} from "@fantasy/projections";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import {
  deriveAdmittedArtifacts,
  deriveCellGates,
  deriveLeagueReadiness,
  derivePublishedSets,
  deriveScoringProfileCoverage,
  deriveShadowAudit,
  type RosCellDecisionRow,
  type RosCellGateState,
  type RosLeagueInputRow,
  type RosReleaseStatus,
} from "./ros-release-status.js";

/**
 * Read-only visibility for the rest-of-season (ROS) projection rail. This surface only reports the
 * rail's recorded state — admitted artifacts, scoring-profile coverage, the caller's league input
 * readiness, the live per-cell gate, published-set provenance (counts only), and the independent
 * shadow audit. It NEVER exposes a secret and is deliberately not consumed by lineup, waiver, trade,
 * standings, or AI code paths.
 *
 * It returns six separate facts and no summary verdict. The removed `publication` field was computed
 * from the newest run under the managed shadow source — the same source release runs are written
 * under — so a later audit run reported an admitted, release-capable artifact as globally disabled.
 */

/** Bounds. Each read withholds rather than truncating silently past these limits. */
const MAXIMUM_ARTIFACT_ROWS = 64;
const MAXIMUM_LEAGUE_ROWS = 64;
const MAXIMUM_PUBLISHED_SET_ROWS = 64;
const MAXIMUM_SCORING_RULE_ROWS = 4_000;

/**
 * The validation report backing each scoring profile's coverage claim, so a profile that is not
 * provisioned still names the evidence it was judged on rather than reporting a bare absence.
 * Operator-facing provenance only: these are report identities, not fetchable paths.
 */
const ROS_EVIDENCE_REPORTS: Readonly<Record<string, string>> = {
  "full-ppr": "ros-validation-v8-full-ppr-n8-2026-07-28",
  "half-ppr": "ros-validation-v8-half-ppr-n8-2026-07-28",
  standard: "ros-validation-v8-standard-n8-2026-07-28",
  "espn-standard-2pt": "ros-validation-v9-espn-standard-2pt-n8-2026-08-03",
  "espn-standard-2pt-nxm": "ros-validation-v9-espn-standard-2pt-nxm-n8-2026-08-03",
};

// The shadow rail (apps/worker) writes its degraded audit under this managed source key and, when an
// admitted champion artifact authorizes a release, its published sets under this source. Both values
// are stable literals mirrored here so this read-only surface does not import worker internals.
export const FIRST_PARTY_ROS_SHADOW_SOURCE_KEY = "laces-out.projections.first-party-ros-shadow";
export const FIRST_PARTY_ROS_RELEASE_SET_SOURCE = "laces-out-first-party-ros";

export interface RosModelRunAudit {
  readonly sourceSyncRunId: string;
  readonly mode: string;
  readonly qualityState: string;
  readonly canPublish: boolean;
  readonly season: number;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly asOfWeek: number;
  readonly asOfAt: string | null;
  readonly playersEvaluated: number;
  readonly playersPublished: number;
  readonly reasons: readonly string[];
  readonly evidenceGate: Record<string, unknown> | null;
  readonly inputChecksum: string;
  readonly sourceAsOf: string | null;
  readonly createdAt: string;
}

/**
 * The wire response. It is the six separated facts of {@link RosReleaseStatus} and deliberately has
 * no single release verdict. The previous `publication: "fail-closed-shadow" | "publishable"` field
 * was removed because it merged an admitted artifact, a league's inputs, the live per-cell gate and
 * the independent shadow audit into one word, and reading that word produced the wrong conclusion
 * that all ROS publication was disabled.
 */
export type RosProjectionStatusResponse = RosReleaseStatus;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toIso(value: Date | null | undefined): string | null {
  if (!(value instanceof Date)) return null;
  const time = value.getTime();
  return Number.isFinite(time) ? value.toISOString() : null;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Row shape consumed by {@link deriveRunAudit}. Kept structural so the derivation can be unit-tested
 * without a database.
 */
export interface RosModelRunRow {
  readonly sourceSyncRunId: string;
  readonly qualityState: string;
  readonly season: number;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly asOfWeek: number;
  readonly asOfAt: Date | null;
  readonly playersEvaluated: number;
  readonly playersPublished: number;
  readonly inputChecksum: string;
  readonly configuration: Record<string, unknown> | null;
  readonly metrics: Record<string, unknown> | null;
  readonly sourceAsOf: Date | null;
  readonly createdAt: Date;
}

/**
 * Pure derivation of one ROS model-run audit. The shadow rail records degraded runs (mode "shadow",
 * `metrics.diagnostics`); a released run records mode "release" with `metrics.withheldReasons`. A run
 * only reports `canPublish` when it is an actually-published release with at least one player.
 */
export function deriveRunAudit(row: RosModelRunRow): RosModelRunAudit {
  const configuration = isRecord(row.configuration) ? row.configuration : {};
  const metrics = isRecord(row.metrics) ? row.metrics : {};
  const mode = typeof configuration.mode === "string" ? configuration.mode : "unknown";
  const reasons =
    metrics.diagnostics !== undefined
      ? stringList(metrics.diagnostics)
      : stringList(metrics.withheldReasons);
  const evidenceGate = isRecord(metrics.gate) ? metrics.gate : null;
  const canPublish =
    row.qualityState === "publishable" && mode === "release" && row.playersPublished > 0;
  return {
    sourceSyncRunId: row.sourceSyncRunId,
    mode,
    qualityState: row.qualityState,
    canPublish,
    season: row.season,
    windowStartWeek: row.windowStartWeek,
    windowEndWeek: row.windowEndWeek,
    asOfWeek: row.asOfWeek,
    asOfAt: toIso(row.asOfAt),
    playersEvaluated: row.playersEvaluated,
    playersPublished: row.playersPublished,
    reasons,
    evidenceGate,
    inputChecksum: row.inputChecksum,
    sourceAsOf: toIso(row.sourceAsOf),
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
  };
}

export class RosProjectionStatusService {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  /**
   * Assembles the six independent facts. Every read is bounded, and the league-scoped reads are
   * restricted to the caller's own memberships — this endpoint previously returned every league's
   * published set to every authenticated user.
   */
  async getStatus(input: {
    readonly season: number;
    readonly userId: string;
  }): Promise<RosProjectionStatusResponse> {
    const { season, userId } = input;

    // 1. Admitted artifact state: every running-catalog profile admitted for the season, not just
    // the newest row. Immutable rows for retired scoring identities remain in PostgreSQL as audit
    // history but cannot describe what this build is eligible to publish.
    const artifactRows = await this.#database
      .select({
        season: firstPartyRosChampionArtifacts.season,
        scoringProfileKey: firstPartyRosChampionArtifacts.scoringProfileKey,
        modelVersion: firstPartyRosChampionArtifacts.modelVersion,
        policyVersion: firstPartyRosChampionArtifacts.policyVersion,
        calibrationVersion: firstPartyRosChampionArtifacts.calibrationVersion,
        evidenceThroughSeason: firstPartyRosChampionArtifacts.evidenceThroughSeason,
        sourceChecksums: firstPartyRosChampionArtifacts.sourceChecksums,
        artifactChecksum: firstPartyRosChampionArtifacts.artifactChecksum,
        admittedAt: firstPartyRosChampionArtifacts.admittedAt,
      })
      .from(firstPartyRosChampionArtifacts)
      .where(eq(firstPartyRosChampionArtifacts.season, season))
      .orderBy(desc(firstPartyRosChampionArtifacts.admittedAt))
      .limit(MAXIMUM_ARTIFACT_ROWS);

    const activeCatalogKeys = new Set(
      rosScoringProfileCatalog().map((profile) => profile.scoringProfileKey),
    );
    const admittedArtifacts = deriveAdmittedArtifacts(
      artifactRows
        .filter((row) => activeCatalogKeys.has(row.scoringProfileKey))
        .map((row) => ({
          season: row.season,
          scoringProfileKey: row.scoringProfileKey,
          modelVersion: row.modelVersion,
          policyVersion: row.policyVersion,
          calibrationVersion: row.calibrationVersion,
          evidenceThroughSeason: row.evidenceThroughSeason,
          artifactChecksum: row.artifactChecksum,
          admittedAt: row.admittedAt,
          sourceChecksumCount: (row.sourceChecksums ?? []).length,
        })),
    );

    // 2. Supported scoring-profile identity.
    const scoringProfiles = deriveScoringProfileCoverage(admittedArtifacts, ROS_EVIDENCE_REPORTS);
    const admittedScoringProfileKeys = admittedArtifacts.artifacts.map(
      (artifact) => artifact.scoringProfile.scoringProfileKey,
    );

    const [shadowSource] = await this.#database
      .select({ id: dataSources.id })
      .from(dataSources)
      .where(eq(dataSources.key, FIRST_PARTY_ROS_SHADOW_SOURCE_KEY))
      .limit(1);

    // 4 and 6 both live in projection_model_runs under the same managed source, so they are read as
    // two separate, explicitly moded queries. A shadow run must never stand in for a release run.
    let cellGates = deriveCellGates(null);
    let shadowAudit = deriveShadowAudit(null);
    let preservePriorGoodSet = true;
    if (shadowSource) {
      const [releaseRow] = await this.#runQuery(shadowSource.id, season, "release");
      const [shadowRow] = await this.#runQuery(shadowSource.id, season, "shadow");

      if (releaseRow) {
        const metrics = isRecord(releaseRow.metrics) ? releaseRow.metrics : {};
        cellGates = deriveCellGates({
          createdAt: releaseRow.createdAt,
          cellDecisions: parseCellDecisions(metrics.cellDecisions),
        });
        preservePriorGoodSet = metrics.preservePriorGoodSet !== false;
      }
      if (shadowRow) {
        const audit = deriveRunAudit(shadowRow);
        shadowAudit = deriveShadowAudit({
          sourceSyncRunId: audit.sourceSyncRunId,
          mode: audit.mode,
          qualityState: audit.qualityState,
          createdAt: shadowRow.createdAt,
          reasons: audit.reasons,
        });
      }
    }

    // 3 and 5 are scoped to the caller's leagues.
    const leagueRows = await this.#database
      .select({
        leagueSeasonId: leagueSeasons.id,
        provider: leagueSeasons.provider,
        season: leagueSeasons.season,
      })
      .from(leagueMemberships)
      .innerJoin(leagues, eq(leagues.id, leagueMemberships.leagueId))
      .innerJoin(leagueSeasons, eq(leagueSeasons.leagueId, leagues.id))
      .where(and(eq(leagueMemberships.userId, userId), eq(leagueSeasons.season, season)))
      .orderBy(leagueSeasons.id)
      .limit(MAXIMUM_LEAGUE_ROWS);

    const leagueSeasonIds = leagueRows.map((row) => row.leagueSeasonId);
    const leagueInputs = await this.#leagueInputs(
      leagueRows,
      season,
      cellGatesWithheldCount(cellGates),
    );

    const leagueReadiness = deriveLeagueReadiness({
      admittedScoringProfileKeys,
      leagues: leagueInputs,
      now: this.#now(),
    });

    const publishedRows =
      leagueSeasonIds.length === 0
        ? []
        : await this.#database
            .select({
              projectionSetId: projectionSets.id,
              leagueSeasonId: projectionSets.leagueSeasonId,
              season: projectionSets.season,
              windowStartWeek: projectionSets.windowStartWeek,
              windowEndWeek: projectionSets.windowEndWeek,
              asOfWeek: projectionSets.asOfWeek,
              fetchedAt: projectionSets.fetchedAt,
              inputChecksum: projectionSets.inputChecksum,
              metadata: projectionSets.metadata,
              playerCount: sql<number>`(
                select count(*)::int
                from ${playerProjections}
                where ${playerProjections.projectionSetId} = ${projectionSets.id}
              )`,
            })
            .from(projectionSets)
            .where(
              and(
                eq(projectionSets.source, FIRST_PARTY_ROS_RELEASE_SET_SOURCE),
                eq(projectionSets.season, season),
                inArray(projectionSets.leagueSeasonId, leagueSeasonIds),
              ),
            )
            .orderBy(desc(projectionSets.fetchedAt))
            .limit(MAXIMUM_PUBLISHED_SET_ROWS);

    const publishedSets = derivePublishedSets({
      rows: publishedRows.flatMap((row) => {
        if (!row.leagueSeasonId) return [];
        const metadata = isRecord(row.metadata) ? row.metadata : {};
        return [
          {
            projectionSetId: row.projectionSetId,
            leagueSeasonId: row.leagueSeasonId,
            season: row.season,
            playerCount: row.playerCount,
            windowStartWeek: row.windowStartWeek,
            windowEndWeek: row.windowEndWeek,
            asOfWeek: row.asOfWeek,
            fetchedAt: row.fetchedAt,
            inputChecksum: row.inputChecksum,
            championArtifactChecksum:
              typeof metadata.championArtifactChecksum === "string"
                ? metadata.championArtifactChecksum
                : null,
            scoringProfileKey:
              typeof metadata.scoringProfileKey === "string" ? metadata.scoringProfileKey : null,
          },
        ];
      }),
      preservePriorGoodSet,
    });

    return {
      season,
      modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
      admittedArtifacts,
      scoringProfiles,
      leagueReadiness,
      cellGates,
      publishedSets,
      shadowAudit,
    };
  }

  async #runQuery(
    sourceId: string,
    season: number,
    mode: "release" | "shadow",
  ): Promise<readonly RosModelRunRow[]> {
    return this.#database
      .select({
        sourceSyncRunId: projectionModelRuns.sourceSyncRunId,
        qualityState: projectionModelRuns.qualityState,
        season: projectionModelRuns.season,
        windowStartWeek: projectionModelRuns.windowStartWeek,
        windowEndWeek: projectionModelRuns.windowEndWeek,
        asOfWeek: projectionModelRuns.asOfWeek,
        asOfAt: projectionModelRuns.asOfAt,
        playersEvaluated: projectionModelRuns.playersEvaluated,
        playersPublished: projectionModelRuns.playersPublished,
        inputChecksum: projectionModelRuns.inputChecksum,
        configuration: projectionModelRuns.configuration,
        metrics: projectionModelRuns.metrics,
        sourceAsOf: projectionModelRuns.sourceAsOf,
        createdAt: projectionModelRuns.createdAt,
      })
      .from(projectionModelRuns)
      .where(
        and(
          eq(projectionModelRuns.sourceId, sourceId),
          eq(projectionModelRuns.season, season),
          eq(projectionModelRuns.horizon, "rest-of-season"),
          sql`${projectionModelRuns.configuration}->>'mode' = ${mode}`,
        ),
      )
      .orderBy(desc(projectionModelRuns.createdAt), desc(projectionModelRuns.sourceSyncRunId))
      .limit(1);
  }

  /** Bounded per-league input reads backing the structured withholding reasons. */
  async #leagueInputs(
    leagueRows: readonly {
      readonly leagueSeasonId: string;
      readonly provider: string;
      readonly season: number;
    }[],
    season: number,
    nonConvergedCells: number,
  ): Promise<readonly RosLeagueInputRow[]> {
    if (leagueRows.length === 0) return [];
    const leagueSeasonIds = leagueRows.map((row) => row.leagueSeasonId);

    const ruleRows = await this.#database
      .select({
        leagueSeasonId: scoringRules.leagueSeasonId,
        statKey: scoringRules.statKey,
        providerStatId: scoringRules.providerStatId,
        operation: scoringRules.operation,
        points: scoringRules.points,
        thresholdLow: scoringRules.thresholdLow,
        thresholdHigh: scoringRules.thresholdHigh,
      })
      .from(scoringRules)
      .where(inArray(scoringRules.leagueSeasonId, leagueSeasonIds))
      .limit(MAXIMUM_SCORING_RULE_ROWS);

    const sourceKeys = [
      `nflverse.schedules.${season}`,
      `nflverse.weekly-rosters.${season}`,
    ] as const;
    const sourceRows = await this.#database
      .select({
        id: dataSources.id,
        key: dataSources.key,
        lastChecksum: dataSources.lastChecksum,
        lastSuccessfulAt: dataSources.lastSuccessfulAt,
      })
      .from(dataSources)
      .where(inArray(dataSources.key, [...sourceKeys]));
    const sourceByKey = new Map(sourceRows.map((row) => [row.key, row]));
    const scheduleSource = sourceByKey.get(sourceKeys[0]);
    const candidateSource = sourceByKey.get(sourceKeys[1]);

    // ROS is a league-scored player product, not a roster-only product. Before a draft, and for
    // waiver research after it, the candidate universe is the current NFL fantasy player pool.
    // Measure that shared pool from the latest successfully pinned weekly-roster artifact instead
    // of treating an empty fantasy roster as if there were no players to project.
    const [candidateRow] =
      candidateSource?.lastChecksum === null || candidateSource?.lastChecksum === undefined
        ? [{ candidateInputCount: 0 }]
        : await this.#database
            .select({
              candidateInputCount: sql<number>`count(distinct ${playerWeeklyRosterObservations.playerId})::int`,
            })
            .from(playerWeeklyRosterObservations)
            .where(
              and(
                eq(playerWeeklyRosterObservations.sourceId, candidateSource.id),
                eq(playerWeeklyRosterObservations.inputChecksum, candidateSource.lastChecksum),
                eq(playerWeeklyRosterObservations.season, season),
                // Match the publisher's fantasy-position authority. Canonical `players` records
                // NFL primary positions, so joining through that field would omit two-way players
                // whose live roster position is WR/RB/TE.
                inArray(playerWeeklyRosterObservations.position, ["QB", "RB", "WR", "TE", "K"]),
              ),
            );

    const [scheduleRow] = await this.#database
      .select({
        scheduled: sql<number>`count(*) filter (where ${nflScheduleObservations.kickoffAt} is not null)::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(nflScheduleObservations)
      .where(
        and(
          eq(nflScheduleObservations.season, season),
          eq(nflScheduleObservations.seasonType, "REG"),
          ...(scheduleSource?.lastChecksum
            ? [
                eq(nflScheduleObservations.sourceId, scheduleSource.id),
                eq(nflScheduleObservations.inputChecksum, scheduleSource.lastChecksum),
              ]
            : []),
        ),
      );

    // The NFL schedule is shared, not per league: an incomplete regular-season schedule withholds
    // every league equally.
    const scheduleComplete =
      (scheduleRow?.total ?? 0) > 0 && scheduleRow?.scheduled === scheduleRow?.total;
    // A source can be successfully checked without changing immutable observations. Freshness is
    // therefore the latest successful verification, while observation source-as-of remains
    // provenance on the forecast itself.
    const sourceVerifiedAt =
      scheduleSource?.lastSuccessfulAt && candidateSource?.lastSuccessfulAt
        ? new Date(
            Math.min(
              scheduleSource.lastSuccessfulAt.getTime(),
              candidateSource.lastSuccessfulAt.getTime(),
            ),
          )
        : null;

    const rulesByLeague = new Map<string, typeof ruleRows>();
    for (const rule of ruleRows) {
      const rows = rulesByLeague.get(rule.leagueSeasonId) ?? [];
      rows.push(rule);
      rulesByLeague.set(rule.leagueSeasonId, rows);
    }
    return leagueRows.map((league) => {
      const rules = rulesByLeague.get(league.leagueSeasonId) ?? [];
      const normalization = normalizeLeagueScoringProfile({
        id: `league:${league.leagueSeasonId}`,
        label: "League scoring",
        version: LEAGUE_SCORING_NORMALIZATION_VERSION,
        rows: rules.map((rule) => ({
          provider: league.provider as LeagueScoringProvider,
          statKey: rule.statKey,
          providerStatId: rule.providerStatId,
          operation: rule.operation,
          points: rule.points,
          thresholdLow: rule.thresholdLow,
          thresholdHigh: rule.thresholdHigh,
        })),
        availableStatIds: rosAvailableProjectionStatIds(),
      });
      return {
        leagueSeasonId: league.leagueSeasonId,
        scoringProfileKey:
          normalization.state === "available"
            ? projectionScoringProfileKey(normalization.profile)
            : null,
        // Carried forward in full so the readiness surface can report per-position truth instead
        // of collapsing every normalization outcome into a nullable whole-key.
        positions: normalization.positions.map((support) => ({
          position: support.position,
          supported: support.supported,
          reasons: support.reasons.map((reason) => reason.message),
        })),
        scheduleComplete,
        candidatePoolSnapshotAt:
          candidateSource?.lastSuccessfulAt && (candidateRow?.candidateInputCount ?? 0) > 0
            ? new Date(candidateSource.lastSuccessfulAt)
            : null,
        candidateInputCount: candidateRow?.candidateInputCount ?? 0,
        sourceVerifiedAt: sourceVerifiedAt === null ? null : new Date(sourceVerifiedAt),
        nonConvergedCells,
      };
    });
  }
}

function cellGatesWithheldCount(gates: RosCellGateState): number {
  return gates.cells.filter((cell) => cell.decision === "withheld").length;
}

function parseCellDecisions(value: unknown): readonly RosCellDecisionRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const { position, bucket, state } = entry;
    if (typeof position !== "string" || typeof bucket !== "string" || typeof state !== "string") {
      return [];
    }
    return [{ position, bucket, state, reasons: stringList(entry.reasons) }];
  });
}
