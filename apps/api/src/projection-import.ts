import { randomUUID } from "node:crypto";

import type {
  ProjectionImportCommitResponse,
  ProjectionImportPreviewResponse,
  ProjectionSetListResponse,
  ProjectionSetSummary,
  ProjectionVisibility as ContractProjectionVisibility,
} from "@fantasy/contracts";
import {
  leagueMemberships,
  leagues,
  leagueSeasons,
  playerProjections,
  players,
  projectionModelRuns,
  projectionSets,
  users,
  type ApplicationRole,
  type Database,
  type LeagueMembershipRole,
  type ProjectionVisibility,
  type ProviderName,
} from "@fantasy/db";
import {
  parseProjectionCsv,
  ProjectionCsvError,
  ProjectionImportMetadataError,
  previewProjectionImport,
  validateProjectionImportMetadata,
  type NormalizedProjectionImport,
  type ProjectionImportMetadata,
  type ProjectionImportMetadataInput,
  type ProjectionPlayerReference,
  type ProjectionPlayerResolution,
} from "@fantasy/projections";
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";

import { leagueScopedPlayerCatalogFilter } from "./espn-sync-persistence.js";
import { projectionTimestampProvenance } from "./projection-provenance.js";

const MAX_ACCESSIBLE_SETS = 100;
const MAX_RESOLVER_PLAYERS = 30_000;
const INSERT_CHUNK_SIZE = 500;
const SOURCE_FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ProjectionLeagueScope {
  readonly leagueSeasonId: string;
  readonly leagueId: string;
  readonly leagueName: string;
  readonly provider: ProviderName;
  readonly season: number;
  readonly currentWeek: number | null;
  readonly membershipRole: LeagueMembershipRole;
  readonly applicationRole: ApplicationRole;
}

export interface ProjectionResolverPlayer {
  readonly id: string;
  readonly gsisId: string | null;
  readonly fullName: string;
}

export interface StoredProjectionSet {
  readonly id: string;
  readonly leagueSeasonId: string;
  readonly creatorUserId: string | null;
  readonly creatorDisplayName: string | null;
  readonly visibility: Exclude<ProjectionVisibility, "global">;
  readonly source: string;
  readonly season: number;
  readonly week: number;
  readonly horizon: "week" | "rest-of-season";
  readonly inputChecksum: string;
  readonly metadata: Record<string, unknown>;
  readonly fetchedAt: Date;
  readonly createdAt: Date;
  readonly playerCount: number;
}

export interface CommitProjectionSetInput {
  readonly actorUserId: string;
  readonly leagueSeasonId: string;
  readonly visibility: ContractProjectionVisibility;
  readonly normalized: NormalizedProjectionImport;
  readonly sourceFileName: string | null;
  readonly importedAt: Date;
}

export interface ProjectionImportRepository {
  findScope(
    actorUserId: string,
    leagueSeasonId: string,
  ): Promise<ProjectionLeagueScope | undefined>;
  listResolverPlayers(
    leagueSeasonId: string,
    season: number,
    referencedIds: readonly string[],
  ): Promise<readonly ProjectionResolverPlayer[]>;
  listAccessibleSets(
    actorUserId: string,
    leagueSeasonId: string,
  ): Promise<readonly StoredProjectionSet[]>;
  latestManagedRunStatus?(
    leagueSeasonId: string,
    season: number,
    week: number,
  ): Promise<
    | {
        readonly evaluatedAt: Date;
        readonly qualityState: "publishable" | "degraded" | "rejected";
        readonly reasons: readonly string[];
      }
    | undefined
  >;
  commitProjectionSet(
    input: CommitProjectionSetInput,
  ): Promise<{ readonly row: StoredProjectionSet; readonly deduplicated: boolean }>;
}

type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function chunks<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function metadataInteger(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function metadataIsoDate(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function metadataWeekReference(
  metadata: Record<string, unknown>,
  key: string,
): { readonly season: number; readonly week: number | null } | null {
  const value = record(metadata[key]);
  if (!value) return null;
  const season = value.season;
  const week = value.week;
  if (
    typeof season !== "number" ||
    !Number.isSafeInteger(season) ||
    season < 2000 ||
    season > 2100 ||
    (week !== null &&
      (typeof week !== "number" || !Number.isSafeInteger(week) || week < 1 || week > 25))
  ) {
    return null;
  }
  return { season, week };
}

function metadataCoverage(metadata: Record<string, unknown>) {
  const coverage = record(metadata.coverage);
  if (!coverage) return null;
  const projected = coverage.projected;
  const eligible = coverage.eligible;
  const ratio = coverage.ratio;
  if (
    typeof projected !== "number" ||
    !Number.isSafeInteger(projected) ||
    projected < 0 ||
    projected > 5_000 ||
    typeof eligible !== "number" ||
    !Number.isSafeInteger(eligible) ||
    eligible < 0 ||
    eligible > 5_000 ||
    typeof ratio !== "number" ||
    !Number.isFinite(ratio) ||
    ratio < 0 ||
    ratio > 1
  ) {
    return null;
  }
  return { projected, eligible, ratio };
}

function metadataBacktest(metadata: Record<string, unknown>) {
  const backtest = record(metadata.backtest);
  if (!backtest) return null;
  const samples = backtest.samples;
  const mae = backtest.mae;
  const baselineMae = backtest.baselineMae;
  const intervalCoverage = backtest.intervalCoverage;
  if (
    typeof samples !== "number" ||
    !Number.isSafeInteger(samples) ||
    samples < 0 ||
    typeof mae !== "number" ||
    !Number.isFinite(mae) ||
    mae < 0 ||
    (baselineMae !== null &&
      (typeof baselineMae !== "number" || !Number.isFinite(baselineMae) || baselineMae < 0)) ||
    (intervalCoverage !== null &&
      (typeof intervalCoverage !== "number" ||
        !Number.isFinite(intervalCoverage) ||
        intervalCoverage < 0 ||
        intervalCoverage > 1))
  ) {
    return null;
  }
  return {
    samples,
    mae,
    baselineMae,
    intervalCoverage,
  };
}

function metadataWarnings(metadata: Record<string, unknown>): readonly string[] {
  const warnings = metadata.warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings
    .filter((warning): warning is string => typeof warning === "string")
    .map((warning) => warning.trim())
    .filter((warning) => warning.length > 0)
    .slice(0, 20)
    .map((warning) => warning.slice(0, 240));
}

function metadataChampionByPosition(metadata: Record<string, unknown>) {
  const policy = record(metadata.championPolicy);
  const byPosition = record(policy?.byPosition);
  if (!byPosition) return [];
  const positions = ["QB", "RB", "WR", "TE", "K"] as const;
  return positions.flatMap((position) => {
    const choice = record(byPosition[position]);
    if (!choice) return [];
    const strategy = choice.strategy;
    const reason = choice.reason;
    const samples = choice.samples;
    const completedWeekBatches = choice.completedWeekBatches;
    const modelImprovement = choice.modelImprovement;
    if (
      (strategy !== "first-party-model" && strategy !== "recency-only") ||
      (reason !== "insufficient-samples" &&
        reason !== "model-cleared-margin" &&
        reason !== "baseline-defended") ||
      typeof samples !== "number" ||
      !Number.isSafeInteger(samples) ||
      samples < 0 ||
      typeof completedWeekBatches !== "number" ||
      !Number.isSafeInteger(completedWeekBatches) ||
      completedWeekBatches < 0 ||
      typeof modelImprovement !== "number" ||
      !Number.isFinite(modelImprovement)
    ) {
      return [];
    }
    const validatedStrategy: "first-party-model" | "recency-only" =
      strategy === "first-party-model" ? "first-party-model" : "recency-only";
    const validatedReason: "insufficient-samples" | "model-cleared-margin" | "baseline-defended" =
      reason === "insufficient-samples"
        ? "insufficient-samples"
        : reason === "model-cleared-margin"
          ? "model-cleared-margin"
          : "baseline-defended";
    return [
      {
        position,
        strategy: validatedStrategy,
        reason: validatedReason,
        samples,
        completedWeekBatches,
        modelImprovement,
      },
    ];
  });
}

function isUserVisibility(
  value: ProjectionVisibility,
): value is Exclude<ProjectionVisibility, "global"> {
  return value === "private" || value === "league";
}

export class DrizzleProjectionImportRepository implements ProjectionImportRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async findScope(
    actorUserId: string,
    leagueSeasonId: string,
  ): Promise<ProjectionLeagueScope | undefined> {
    const [row] = await this.#database
      .select({
        leagueSeasonId: leagueSeasons.id,
        leagueId: leagues.id,
        leagueName: leagues.name,
        provider: leagueSeasons.provider,
        season: leagueSeasons.season,
        currentWeek: leagueSeasons.currentWeek,
        membershipRole: leagueMemberships.role,
        applicationRole: users.role,
      })
      .from(leagueSeasons)
      .innerJoin(leagues, eq(leagueSeasons.leagueId, leagues.id))
      .innerJoin(
        leagueMemberships,
        and(eq(leagueMemberships.leagueId, leagues.id), eq(leagueMemberships.userId, actorUserId)),
      )
      .innerJoin(users, eq(users.id, actorUserId))
      .where(eq(leagueSeasons.id, leagueSeasonId))
      .limit(1);
    return row;
  }

  listResolverPlayers(
    leagueSeasonId: string,
    season: number,
    referencedIds: readonly string[],
  ): Promise<readonly ProjectionResolverPlayer[]> {
    const canonicalIds = referencedIds.filter((value) => UUID_PATTERN.test(value));
    const currentPlayer = or(
      gte(players.lastSeason, season - 1),
      gte(players.rookieSeason, season - 1),
      isNull(players.gsisId),
    );
    return this.#database
      .select({ id: players.id, gsisId: players.gsisId, fullName: players.fullName })
      .from(players)
      .where(
        and(
          canonicalIds.length > 0
            ? or(currentPlayer, inArray(players.id, canonicalIds))
            : currentPlayer,
          leagueScopedPlayerCatalogFilter(leagueSeasonId),
        ),
      )
      .orderBy(asc(players.fullName), asc(players.id))
      .limit(MAX_RESOLVER_PLAYERS);
  }

  async listAccessibleSets(
    actorUserId: string,
    leagueSeasonId: string,
  ): Promise<readonly StoredProjectionSet[]> {
    const rows = await this.#database
      .select({
        id: projectionSets.id,
        leagueSeasonId: projectionSets.leagueSeasonId,
        creatorUserId: projectionSets.createdByUserId,
        creatorDisplayName: users.displayName,
        visibility: projectionSets.visibility,
        source: projectionSets.source,
        season: projectionSets.season,
        week: projectionSets.week,
        horizon: projectionSets.horizon,
        inputChecksum: projectionSets.inputChecksum,
        metadata: projectionSets.metadata,
        fetchedAt: projectionSets.fetchedAt,
        createdAt: projectionSets.createdAt,
        playerCount: sql<number>`(
          select count(*)::int
          from ${playerProjections}
          where ${playerProjections.projectionSetId} = ${projectionSets.id}
        )`,
      })
      .from(projectionSets)
      .innerJoin(leagueSeasons, eq(leagueSeasons.id, projectionSets.leagueSeasonId))
      .innerJoin(
        leagueMemberships,
        and(
          eq(leagueMemberships.leagueId, leagueSeasons.leagueId),
          eq(leagueMemberships.userId, actorUserId),
        ),
      )
      .leftJoin(users, eq(users.id, projectionSets.createdByUserId))
      .where(
        and(
          eq(projectionSets.leagueSeasonId, leagueSeasonId),
          or(
            eq(projectionSets.visibility, "league"),
            and(
              eq(projectionSets.visibility, "private"),
              eq(projectionSets.createdByUserId, actorUserId),
            ),
          ),
        ),
      )
      .orderBy(desc(projectionSets.createdAt), desc(projectionSets.id))
      .limit(MAX_ACCESSIBLE_SETS);
    return rows.flatMap((row) =>
      row.leagueSeasonId &&
      row.week !== null &&
      (row.horizon === "week" || row.horizon === "rest-of-season") &&
      isUserVisibility(row.visibility) &&
      (row.creatorUserId !== null || row.visibility === "league")
        ? [
            {
              ...row,
              leagueSeasonId: row.leagueSeasonId,
              creatorUserId: row.creatorUserId,
              week: row.week,
              horizon: row.horizon,
              visibility: row.visibility,
            },
          ]
        : [],
    );
  }

  async latestManagedRunStatus(leagueSeasonId: string, season: number, week: number) {
    const [run] = await this.#database
      .select({
        createdAt: projectionModelRuns.createdAt,
        qualityState: projectionModelRuns.qualityState,
        metrics: projectionModelRuns.metrics,
      })
      .from(projectionModelRuns)
      .where(and(eq(projectionModelRuns.season, season), eq(projectionModelRuns.targetWeek, week)))
      .orderBy(desc(projectionModelRuns.createdAt))
      .limit(1);
    if (!run) return undefined;
    const leagues = record(record(run.metrics)?.leagues);
    const withheld = Array.isArray(leagues?.withheld) ? leagues.withheld : [];
    const leagueEntry = withheld
      .map(record)
      .find((entry) => entry?.leagueSeasonId === leagueSeasonId);
    const reasons = Array.isArray(leagueEntry?.reasons)
      ? leagueEntry.reasons
          .filter((reason): reason is string => typeof reason === "string")
          .map((reason) => reason.trim())
          .filter(Boolean)
          .slice(0, 10)
      : [];
    const qualityState = run.qualityState;
    if (
      qualityState !== "publishable" &&
      qualityState !== "degraded" &&
      qualityState !== "rejected"
    ) {
      return undefined;
    }
    return {
      evaluatedAt: run.createdAt,
      qualityState,
      reasons,
    };
  }

  async commitProjectionSet(
    input: CommitProjectionSetInput,
  ): Promise<{ readonly row: StoredProjectionSet; readonly deduplicated: boolean }> {
    return this.#database.transaction(async (transaction) => {
      const [authorization] = await transaction
        .select({
          season: leagueSeasons.season,
          membershipRole: leagueMemberships.role,
          applicationRole: users.role,
        })
        .from(leagueSeasons)
        .innerJoin(
          leagueMemberships,
          and(
            eq(leagueMemberships.leagueId, leagueSeasons.leagueId),
            eq(leagueMemberships.userId, input.actorUserId),
          ),
        )
        .innerJoin(users, eq(users.id, input.actorUserId))
        .where(eq(leagueSeasons.id, input.leagueSeasonId))
        .limit(1);
      if (!authorization) {
        throw new ProjectionImportRequestError(404, "not_found", "League season not found");
      }
      if (authorization.season !== input.normalized.metadata.season) {
        throw new ProjectionImportRequestError(
          409,
          "season_mismatch",
          `This league season accepts ${authorization.season} projections`,
        );
      }
      if (
        input.visibility === "league" &&
        authorization.applicationRole !== "admin" &&
        authorization.membershipRole !== "owner" &&
        authorization.membershipRole !== "commissioner"
      ) {
        throw new ProjectionImportRequestError(
          403,
          "forbidden",
          "League-sharing permission changed before the import was saved",
        );
      }

      const existing = await this.#findCommitted(
        transaction,
        input.actorUserId,
        input.leagueSeasonId,
        input.visibility,
        input.normalized.checksum,
      );
      if (existing) return { row: existing, deduplicated: true };

      const version = `${input.visibility}:${input.normalized.checksum.slice(7, 31)}:${randomUUID()}`;
      const metadata = {
        schemaVersion: 2,
        importKind: "user-csv",
        sourceLabel: input.normalized.metadata.sourceLabel,
        sourceObservedAt: input.normalized.metadata.sourceObservedAt,
        sourceChecksum: input.normalized.sourceChecksum,
        sourceFileName: input.sourceFileName,
        rowCount: input.normalized.playerProjections.length,
        resolver: "canonical-id-gsis-exact-name-v1",
        importedAt: input.importedAt.toISOString(),
      } satisfies Record<string, unknown>;
      const [inserted] = await transaction
        .insert(projectionSets)
        .values({
          leagueSeasonId: input.leagueSeasonId,
          createdByUserId: input.actorUserId,
          visibility: input.visibility,
          source: "user-csv",
          version,
          season: input.normalized.metadata.season,
          week: input.normalized.metadata.week,
          horizon: input.normalized.metadata.horizon,
          fetchedAt: new Date(input.normalized.metadata.sourceObservedAt),
          createdAt: input.importedAt,
          inputChecksum: input.normalized.checksum,
          metadata,
        })
        .onConflictDoNothing()
        .returning({ id: projectionSets.id });

      if (!inserted) {
        const concurrent = await this.#findCommitted(
          transaction,
          input.actorUserId,
          input.leagueSeasonId,
          input.visibility,
          input.normalized.checksum,
        );
        if (!concurrent) throw new Error("Projection import conflicted with an unrelated set");
        return { row: concurrent, deduplicated: true };
      }

      for (const batch of chunks(input.normalized.playerProjections, INSERT_CHUNK_SIZE)) {
        await transaction.insert(playerProjections).values(
          batch.map((projection) => ({
            projectionSetId: inserted.id,
            playerId: projection.playerId,
            meanPoints: String(projection.meanPoints),
            floorPoints:
              projection.floorPoints === undefined ? null : String(projection.floorPoints),
            ceilingPoints:
              projection.ceilingPoints === undefined ? null : String(projection.ceilingPoints),
            confidence: projection.confidence === undefined ? null : String(projection.confidence),
            components: {},
          })),
        );
      }

      const committed = await this.#findCommitted(
        transaction,
        input.actorUserId,
        input.leagueSeasonId,
        input.visibility,
        input.normalized.checksum,
      );
      if (!committed) throw new Error("Committed projection set could not be read back");
      return { row: committed, deduplicated: false };
    });
  }

  async #findCommitted(
    database: DatabaseTransaction,
    actorUserId: string,
    leagueSeasonId: string,
    visibility: ContractProjectionVisibility,
    inputChecksum: string,
  ): Promise<StoredProjectionSet | undefined> {
    const [row] = await database
      .select({
        id: projectionSets.id,
        leagueSeasonId: projectionSets.leagueSeasonId,
        creatorUserId: projectionSets.createdByUserId,
        creatorDisplayName: users.displayName,
        visibility: projectionSets.visibility,
        source: projectionSets.source,
        season: projectionSets.season,
        week: projectionSets.week,
        horizon: projectionSets.horizon,
        inputChecksum: projectionSets.inputChecksum,
        metadata: projectionSets.metadata,
        fetchedAt: projectionSets.fetchedAt,
        createdAt: projectionSets.createdAt,
        playerCount: sql<number>`(
          select count(*)::int
          from ${playerProjections}
          where ${playerProjections.projectionSetId} = ${projectionSets.id}
        )`,
      })
      .from(projectionSets)
      .innerJoin(users, eq(users.id, projectionSets.createdByUserId))
      .where(
        and(
          eq(projectionSets.leagueSeasonId, leagueSeasonId),
          eq(projectionSets.createdByUserId, actorUserId),
          eq(projectionSets.visibility, visibility),
          eq(projectionSets.inputChecksum, inputChecksum),
        ),
      )
      .limit(1);
    if (
      !row?.leagueSeasonId ||
      !row.creatorUserId ||
      row.week === null ||
      (row.horizon !== "week" && row.horizon !== "rest-of-season") ||
      !isUserVisibility(row.visibility)
    ) {
      return undefined;
    }
    return {
      ...row,
      leagueSeasonId: row.leagueSeasonId,
      creatorUserId: row.creatorUserId,
      week: row.week,
      horizon: row.horizon,
      visibility: row.visibility,
    };
  }
}

export class ProjectionImportRequestError extends Error {
  readonly statusCode: number;
  readonly code:
    | "not_found"
    | "forbidden"
    | "season_mismatch"
    | "preview_mismatch"
    | "invalid_preview"
    | "invalid_import"
    | "unsupported_horizon"
    | "source_observed_at_future";

  constructor(statusCode: number, code: ProjectionImportRequestError["code"], message: string) {
    super(message);
    this.name = "ProjectionImportRequestError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface ProjectionImportRequest {
  readonly csv: string;
  readonly metadata: ProjectionImportMetadataInput;
  readonly visibility: ContractProjectionVisibility;
  readonly sourceFileName?: string | null | undefined;
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function resolverFor(playersToResolve: readonly ProjectionResolverPlayer[]) {
  const identifiers = new Map<string, ProjectionResolverPlayer[]>();
  const names = new Map<string, ProjectionResolverPlayer[]>();
  const add = (
    map: Map<string, ProjectionResolverPlayer[]>,
    key: string,
    player: ProjectionResolverPlayer,
  ) => map.set(key, [...(map.get(key) ?? []), player]);
  for (const player of playersToResolve) {
    add(identifiers, player.id.toLowerCase(), player);
    if (player.gsisId) add(identifiers, player.gsisId.toLowerCase(), player);
    add(names, normalizeName(player.fullName), player);
  }

  const resolution = (matches: readonly ProjectionResolverPlayer[]): ProjectionPlayerResolution => {
    const unique = [...new Map(matches.map((player) => [player.id, player])).values()];
    if (unique.length === 0) return { status: "unresolved" };
    if (unique.length > 1) {
      return {
        status: "ambiguous",
        candidates: unique.slice(0, 20).map((player) => ({
          playerId: player.id,
          playerName: player.fullName,
        })),
      };
    }
    const [player] = unique;
    return player
      ? { status: "resolved", playerId: player.id, playerName: player.fullName }
      : { status: "unresolved" };
  };

  return (reference: ProjectionPlayerReference): ProjectionPlayerResolution => {
    if (reference.playerId) {
      return resolution(identifiers.get(reference.playerId.toLowerCase()) ?? []);
    }
    return resolution(names.get(normalizeName(reference.playerName ?? "")) ?? []);
  };
}

function canShareLeague(scope: ProjectionLeagueScope): boolean {
  return (
    scope.applicationRole === "admin" ||
    scope.membershipRole === "owner" ||
    scope.membershipRole === "commissioner"
  );
}

function summary(row: StoredProjectionSet, actorUserId: string): ProjectionSetSummary {
  const isManaged = row.source !== "user-csv";
  const sourceLabel =
    metadataString(row.metadata, "sourceLabel") ??
    (isManaged ? "Laces Out weekly forecast" : "Imported projections");
  const sourceChecksum = metadataString(row.metadata, "sourceChecksum") ?? row.inputChecksum;
  const sourceFileName = metadataString(row.metadata, "sourceFileName");
  const timestamps = projectionTimestampProvenance(row);
  const modelVersion = metadataString(row.metadata, "modelVersion");
  const qualityState = row.metadata.qualityState;
  return {
    id: row.id,
    leagueSeasonId: row.leagueSeasonId,
    creatorUserId: row.creatorUserId,
    creatorDisplayName: row.creatorDisplayName,
    origin: isManaged ? "laces-out" : "custom",
    managed: isManaged
      ? {
          modelVersion: modelVersion && modelVersion.length <= 120 ? modelVersion : null,
          computedAt: metadataIsoDate(row.metadata, "computedAt") ?? row.createdAt.toISOString(),
          // For managed sets fetchedAt is the persisted critical-input check time. It deliberately
          // does not inherit computedAt, so a recompute cannot make old inputs look fresh.
          inputCheckedAt: row.fetchedAt.toISOString(),
          trainingCutoff: metadataWeekReference(row.metadata, "trainingCutoff"),
          statsThrough: metadataWeekReference(row.metadata, "statsThrough"),
          qualityState:
            qualityState === "publishable" ||
            qualityState === "degraded" ||
            qualityState === "rejected"
              ? qualityState
              : null,
          championByPosition: metadataChampionByPosition(row.metadata),
          coverage: metadataCoverage(row.metadata),
          warnings: [...metadataWarnings(row.metadata)],
          backtest: metadataBacktest(row.metadata),
        }
      : null,
    visibility: row.visibility,
    sourceLabel,
    sourceFileName,
    season: row.season,
    week: row.week,
    horizon: row.horizon,
    playerCount: metadataInteger(row.metadata, "rowCount") ?? row.playerCount,
    inputChecksum: row.inputChecksum,
    sourceChecksum,
    sourceObservedAt: timestamps.sourceObservedAt?.toISOString() ?? null,
    sourceObservedAtStatus: timestamps.sourceObservedAtStatus,
    importedAt: timestamps.importedAt.toISOString(),
    isOwnedByCurrentUser: row.creatorUserId !== null && row.creatorUserId === actorUserId,
  };
}

export class ProjectionImportService {
  readonly #repository: ProjectionImportRepository;
  readonly #clock: () => Date;

  constructor(repository: ProjectionImportRepository, clock: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#clock = clock;
  }

  async list(actorUserId: string, leagueSeasonId: string): Promise<ProjectionSetListResponse> {
    const scope = await this.#requireScope(actorUserId, leagueSeasonId);
    const [sets, managedRun] = await Promise.all([
      this.#repository.listAccessibleSets(actorUserId, leagueSeasonId),
      scope.currentWeek && this.#repository.latestManagedRunStatus
        ? this.#repository.latestManagedRunStatus(leagueSeasonId, scope.season, scope.currentWeek)
        : Promise.resolve(undefined),
    ]);
    const summaries = sets
      .filter(
        (row) =>
          row.leagueSeasonId === leagueSeasonId &&
          (row.visibility === "league" ||
            (row.creatorUserId !== null && row.creatorUserId === actorUserId)),
      )
      .map((row) => summary(row, actorUserId));
    const currentManaged = summaries.find(
      (projection) => projection.origin === "laces-out" && projection.week === scope.currentWeek,
    );
    const currentManagedAt = currentManaged?.managed?.computedAt ?? currentManaged?.importedAt;
    const newerWithheldRun =
      managedRun &&
      managedRun.reasons.length > 0 &&
      (!currentManagedAt || managedRun.evaluatedAt.getTime() > new Date(currentManagedAt).getTime())
        ? managedRun
        : undefined;
    return {
      league: {
        id: scope.leagueId,
        name: scope.leagueName,
        leagueSeasonId: scope.leagueSeasonId,
        provider: scope.provider,
        season: scope.season,
        currentWeek: scope.currentWeek,
        membershipRole: scope.membershipRole,
        canShareLeague: canShareLeague(scope),
      },
      managedForecastStatus: newerWithheldRun
        ? {
            state: "withheld",
            evaluatedAt: newerWithheldRun.evaluatedAt.toISOString(),
            qualityState: newerWithheldRun.qualityState,
            reasons: [...newerWithheldRun.reasons],
          }
        : currentManaged
          ? {
              state: "published",
              evaluatedAt: currentManaged.managed?.computedAt ?? currentManaged.importedAt,
              qualityState: currentManaged.managed?.qualityState ?? null,
              reasons: [],
            }
          : managedRun
            ? {
                state: "withheld",
                evaluatedAt: managedRun.evaluatedAt.toISOString(),
                qualityState: managedRun.qualityState,
                reasons:
                  managedRun.reasons.length > 0
                    ? [...managedRun.reasons]
                    : ["The latest managed forecast did not produce a league-safe publication."],
              }
            : {
                state: "pending",
                evaluatedAt: null,
                qualityState: null,
                reasons: [],
              },
      projectionSets: summaries,
    };
  }

  async preview(
    actorUserId: string,
    leagueSeasonId: string,
    input: ProjectionImportRequest,
  ): Promise<ProjectionImportPreviewResponse> {
    const scope = await this.#requireScope(actorUserId, leagueSeasonId);
    const requestTime = this.#clock();
    const metadata = this.#validateScope(scope, input, requestTime);
    const preview = await this.#prepare(scope, input);
    return {
      metadata: {
        ...preview.metadata,
        horizon: "week",
        sourceObservedAt: metadata.sourceObservedAt,
      },
      visibility: input.visibility,
      sourceChecksum: preview.sourceChecksum,
      importChecksum: preview.normalized?.checksum ?? null,
      rowCount: preview.rowCount,
      resolvedRowCount: preview.resolvedRowCount,
      diagnostics: preview.diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity,
        code: diagnostic.code,
        rowNumber: diagnostic.rowNumber,
        column: diagnostic.column,
        message: diagnostic.message,
        ...(diagnostic.candidates
          ? { candidates: diagnostic.candidates.map((candidate) => ({ ...candidate })) }
          : {}),
      })),
      canCommit: preview.canCommit,
    };
  }

  async commit(
    actorUserId: string,
    leagueSeasonId: string,
    input: ProjectionImportRequest & { readonly expectedImportChecksum: string },
  ): Promise<ProjectionImportCommitResponse> {
    const scope = await this.#requireScope(actorUserId, leagueSeasonId);
    const importedAt = this.#clock();
    this.#validateScope(scope, input, importedAt);
    // Commit deliberately performs the complete parse and player resolution again. The client
    // never submits normalized rows and therefore cannot bypass preview diagnostics.
    const preview = await this.#prepare(scope, input);
    if (!preview.canCommit || !preview.normalized) {
      throw new ProjectionImportRequestError(
        422,
        "invalid_preview",
        "The CSV still contains unresolved, ambiguous, or invalid rows",
      );
    }
    if (preview.normalized.checksum !== input.expectedImportChecksum) {
      throw new ProjectionImportRequestError(
        409,
        "preview_mismatch",
        "The CSV or import settings changed after preview; preview it again before committing",
      );
    }
    const committed = await this.#repository.commitProjectionSet({
      actorUserId,
      leagueSeasonId,
      visibility: input.visibility,
      normalized: preview.normalized,
      sourceFileName: input.sourceFileName ?? null,
      importedAt,
    });
    return {
      projectionSet: summary(committed.row, actorUserId),
      deduplicated: committed.deduplicated,
    };
  }

  async #prepare(scope: ProjectionLeagueScope, input: ProjectionImportRequest) {
    let parsed: ReturnType<typeof parseProjectionCsv>;
    try {
      parsed = parseProjectionCsv(input.csv);
    } catch (error) {
      if (error instanceof ProjectionCsvError || error instanceof ProjectionImportMetadataError) {
        throw new ProjectionImportRequestError(400, "invalid_import", error.message);
      }
      throw error;
    }
    const referencedIds = parsed.rows.flatMap((row) => {
      const value = row.values.player_id?.normalize("NFKC").trim();
      return value ? [value] : [];
    });
    const catalog = await this.#repository.listResolverPlayers(
      scope.leagueSeasonId,
      scope.season,
      referencedIds,
    );
    try {
      return await previewProjectionImport({
        csv: input.csv,
        metadata: input.metadata,
        resolvePlayer: resolverFor(catalog),
      });
    } catch (error) {
      if (error instanceof ProjectionCsvError || error instanceof ProjectionImportMetadataError) {
        throw new ProjectionImportRequestError(400, "invalid_import", error.message);
      }
      throw error;
    }
  }

  async #requireScope(actorUserId: string, leagueSeasonId: string): Promise<ProjectionLeagueScope> {
    const scope = await this.#repository.findScope(actorUserId, leagueSeasonId);
    if (!scope) {
      // A non-member receives the same response as a missing league season to avoid discovery.
      throw new ProjectionImportRequestError(404, "not_found", "League season not found");
    }
    return scope;
  }

  #validateScope(
    scope: ProjectionLeagueScope,
    input: ProjectionImportRequest,
    now: Date,
  ): ProjectionImportMetadata {
    let metadata: ProjectionImportMetadata;
    try {
      metadata = validateProjectionImportMetadata(input.metadata);
    } catch (error) {
      if (error instanceof ProjectionImportMetadataError) {
        throw new ProjectionImportRequestError(400, "invalid_import", error.message);
      }
      throw error;
    }
    if (metadata.horizon !== "week") {
      throw new ProjectionImportRequestError(
        422,
        "unsupported_horizon",
        "League CSV imports currently support single-week projections only",
      );
    }
    if (
      new Date(metadata.sourceObservedAt).getTime() >
      now.getTime() + SOURCE_FUTURE_TOLERANCE_MS
    ) {
      throw new ProjectionImportRequestError(
        422,
        "source_observed_at_future",
        "Projection source as-of time cannot be more than five minutes in the future",
      );
    }
    if (metadata.season !== scope.season) {
      throw new ProjectionImportRequestError(
        409,
        "season_mismatch",
        `This league season accepts ${scope.season} projections`,
      );
    }
    if (input.visibility === "league" && !canShareLeague(scope)) {
      throw new ProjectionImportRequestError(
        403,
        "forbidden",
        "Only a league owner or commissioner can publish league projections",
      );
    }
    return metadata;
  }
}
