import {
  firstPartyRosChampionArtifacts,
  firstPartyRosProfileValidations,
  type Database,
} from "@laces-out/db";
import {
  firstPartyProjectionComponentsForPosition,
  rosProfileDefinitionFromKey,
  SCORING_LONG_TOUCHDOWN_COMPONENTS,
} from "@laces-out/projections";
import { and, eq, inArray, sql } from "drizzle-orm";

import {
  firstPartyRosAdmissionConstants,
  validateFirstPartyRosAdmission,
  type FirstPartyRosAdmissionConstants,
  type FirstPartyRosAdmissionValidation,
} from "./first-party-ros-admission.js";
import type { WorkerJobContext } from "./jobs.js";
import type { RosProfileValidationJob } from "@laces-out/jobs";
import {
  ROS_PROFILE_RECOVERY_VERSION,
  rosProfileRecoveryMarker,
} from "./ros-profile-recovery-state.js";
import {
  createRosProfileValidationRunner,
  type RosProfileValidationRunner,
} from "./ros-profile-validation-runner.js";
import { FIRST_PARTY_ROS_RELEASE_PLAYERS_PER_POSITION } from "./first-party-ros-validation-contract.js";
import { ROS_HISTORICAL_COVERAGE_DEFAULT_THRESHOLDS } from "./ros-data-coverage.js";

export type RosProfileValidationRecord = typeof firstPartyRosProfileValidations.$inferSelect;
type AdmittedValidation = Extract<FirstPartyRosAdmissionValidation, { state: "admissible" }>;

export interface RosProfileValidationRepository {
  get(id: string): Promise<RosProfileValidationRecord | null>;
  begin(
    id: string,
    startedAt: Date,
    recoveryCorpusIdentity?: string,
    recoveryAttempt?: number,
  ): Promise<Date | null>;
  complete(input: {
    id: string;
    startedAt: Date;
    completedAt: Date;
    report: Record<string, unknown> | null;
    blockers: readonly string[];
    admission?: AdmittedValidation;
  }): Promise<boolean>;
  fail(id: string, startedAt: Date, completedAt: Date): Promise<void>;
  deferForCorpus?(id: string, startedAt: Date, requestIdentity: string, now: Date): Promise<void>;
}

export class DrizzleRosProfileValidationRepository implements RosProfileValidationRepository {
  constructor(private readonly database: Database) {}

  async get(id: string): Promise<RosProfileValidationRecord | null> {
    return (
      (
        await this.database
          .select()
          .from(firstPartyRosProfileValidations)
          .where(eq(firstPartyRosProfileValidations.id, id))
          .limit(1)
      )[0] ?? null
    );
  }

  async begin(
    id: string,
    startedAt: Date,
    recoveryCorpusIdentity?: string,
    recoveryAttempt?: number,
  ): Promise<Date | null> {
    if (
      recoveryAttempt !== undefined &&
      (recoveryCorpusIdentity === undefined ||
        !Number.isSafeInteger(recoveryAttempt) ||
        recoveryAttempt < 1)
    )
      return null;
    // Pg-boss owns the long-running lease. A redelivered job may replace a validating attempt
    // left behind by a dead process; the timestamp fences its old completion transaction.
    const rows = await this.database
      .update(firstPartyRosProfileValidations)
      .set({
        state: "validating",
        startedAt: sql`greatest(${startedAt.toISOString()}::timestamptz, ${firstPartyRosProfileValidations.startedAt} + interval '1 millisecond')`,
        completedAt: null,
        blockers: [],
        updatedAt: startedAt,
        ...(recoveryCorpusIdentity === undefined
          ? {}
          : {
              report: sql`jsonb_set(${firstPartyRosProfileValidations.report}, '{automaticRecovery,state}', '"attempted"'::jsonb)`,
            }),
      })
      .where(
        and(
          eq(firstPartyRosProfileValidations.id, id),
          inArray(
            firstPartyRosProfileValidations.state,
            recoveryCorpusIdentity === undefined
              ? ["pending", "failed", "validating"]
              : ["pending", "failed", "withheld", "validating"],
          ),
          recoveryCorpusIdentity === undefined
            ? sql`${firstPartyRosProfileValidations.report} -> 'automaticRecovery' is null`
            : and(
                sql`${firstPartyRosProfileValidations.report} -> 'automaticRecovery' ->> 'version' = ${ROS_PROFILE_RECOVERY_VERSION}`,
                sql`${firstPartyRosProfileValidations.report} -> 'automaticRecovery' ->> 'corpusIdentity' = ${recoveryCorpusIdentity}`,
                sql`(${firstPartyRosProfileValidations.report} -> 'automaticRecovery' -> 'recoveryAttempt' is null or jsonb_typeof(${firstPartyRosProfileValidations.report} -> 'automaticRecovery' -> 'recoveryAttempt') = 'number')`,
                sql`coalesce(${firstPartyRosProfileValidations.report} -> 'automaticRecovery' ->> 'recoveryAttempt', '1') = ${String(recoveryAttempt ?? 1)}`,
                sql`${firstPartyRosProfileValidations.report} -> 'automaticRecovery' ->> 'state' in ('pending-dispatch', 'attempted')`,
                sql`(${firstPartyRosProfileValidations.state} not in ('pending', 'withheld') or ${firstPartyRosProfileValidations.report} -> 'automaticRecovery' ->> 'state' = 'pending-dispatch')`,
              ),
        ),
      )
      .returning({ startedAt: firstPartyRosProfileValidations.startedAt });
    return rows[0]?.startedAt ?? null;
  }

  async complete(
    input: Parameters<RosProfileValidationRepository["complete"]>[0],
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const claim = and(
        eq(firstPartyRosProfileValidations.id, input.id),
        eq(firstPartyRosProfileValidations.state, "validating"),
        eq(firstPartyRosProfileValidations.startedAt, input.startedAt),
      );
      const [record] = await transaction
        .select({
          id: firstPartyRosProfileValidations.id,
          report: firstPartyRosProfileValidations.report,
        })
        .from(firstPartyRosProfileValidations)
        .where(claim)
        .for("update");
      if (!record) return false;
      const recovery = rosProfileRecoveryMarker(record.report);
      let artifactId: string | null = null;
      if (input.admission) {
        const { payload, artifactChecksum } = input.admission;
        const identity = and(
          eq(firstPartyRosChampionArtifacts.season, payload.season),
          eq(firstPartyRosChampionArtifacts.scoringProfileKey, payload.scoringProfileKey),
          eq(firstPartyRosChampionArtifacts.modelVersion, payload.modelVersion),
          eq(firstPartyRosChampionArtifacts.policyVersion, payload.policyVersion),
          eq(firstPartyRosChampionArtifacts.calibrationVersion, payload.calibrationVersion),
          eq(firstPartyRosChampionArtifacts.artifactChecksum, artifactChecksum),
        );
        const inserted = await transaction
          .insert(firstPartyRosChampionArtifacts)
          .values({
            ...payload,
            policy: payload.policy as unknown as Record<string, unknown>,
            artifactChecksum,
            admittedAt: input.completedAt,
          })
          .onConflictDoNothing()
          .returning({ id: firstPartyRosChampionArtifacts.id });
        artifactId =
          inserted[0]?.id ??
          (
            await transaction
              .select({ id: firstPartyRosChampionArtifacts.id })
              .from(firstPartyRosChampionArtifacts)
              .where(identity)
              .limit(1)
          )[0]?.id ??
          null;
        if (!artifactId) throw new Error("ROS validation artifact identity could not be persisted");
      }
      await transaction
        .update(firstPartyRosProfileValidations)
        .set({
          state: input.admission ? "admitted" : "withheld",
          blockers: input.blockers,
          report:
            recovery === undefined
              ? input.report
              : { ...input.report, automaticRecovery: recovery },
          artifactId,
          completedAt: input.completedAt,
          updatedAt: input.completedAt,
        })
        .where(claim);
      return true;
    });
  }

  async deferForCorpus(
    id: string,
    startedAt: Date,
    requestIdentity: string,
    now: Date,
  ): Promise<void> {
    if (!/^[a-f0-9]{64}$/u.test(requestIdentity))
      throw new Error("Invalid bootstrap request identity");
    await this.database
      .update(firstPartyRosProfileValidations)
      .set({
        state: "pending",
        blockers: ["shared_corpus_preparing"],
        completedAt: null,
        updatedAt: now,
        report: sql`coalesce(${firstPartyRosProfileValidations.report}, '{}'::jsonb) || ${JSON.stringify({ bootstrapWait: { version: "shared-corpus-wait-v1", requestIdentity, requestedAt: now.toISOString() } })}::jsonb`,
      })
      .where(
        and(
          eq(firstPartyRosProfileValidations.id, id),
          eq(firstPartyRosProfileValidations.state, "validating"),
          eq(firstPartyRosProfileValidations.startedAt, startedAt),
        ),
      );
  }

  async fail(id: string, startedAt: Date, completedAt: Date): Promise<void> {
    await this.database
      .update(firstPartyRosProfileValidations)
      .set({
        state: "failed",
        blockers: ["validation_execution_failed"],
        completedAt,
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(firstPartyRosProfileValidations.id, id),
          eq(firstPartyRosProfileValidations.state, "validating"),
          eq(firstPartyRosProfileValidations.startedAt, startedAt),
        ),
      );
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A source diagnostic is never a substitute for an identity-checked statistical report. */
function validComponentEvidenceBlock(
  report: Record<string, unknown>,
  record: RosProfileValidationRecord,
  constants: FirstPartyRosAdmissionConstants,
): boolean {
  const boundedInteger = (value: unknown, minimum: number, maximum: number): value is number =>
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum;
  const sameSet = (value: unknown, expected: readonly (string | number)[]): boolean =>
    Array.isArray(value) &&
    value.length === expected.length &&
    new Set(value).size === expected.length &&
    value.every(
      (entry: unknown) =>
        (typeof entry === "string" || typeof entry === "number") && expected.includes(entry),
    );
  const scope = report.validationScope;
  const identity = report.executionIdentity;
  const coverage = report.coverage;
  const preflight = report.componentPreflight;
  const seasons = Array.from({ length: 4 }, (_, index) => record.season - 4 + index);
  const positions = ["QB", "RB", "WR", "TE", "K"];
  if (
    report.state !== "blocked-before-modeling" ||
    report.validationMode !== "read-only-first-party-ros-backtest" ||
    report.noDatabaseWrites !== true ||
    report.noSimulation !== true ||
    report.outcomeCorpusIdentity !== undefined ||
    !object(scope) ||
    scope.completePortfolio !== true ||
    !sameSet(scope.positions, [...positions, "DST"]) ||
    !object(report.scoringProfile) ||
    report.scoringProfile.digest !== record.scoringProfileDigest ||
    !object(identity) ||
    identity.modelVersion !== constants.modelVersion ||
    identity.policyVersion !== constants.policyVersion ||
    identity.calibrationVersion !== constants.calibrationVersion ||
    identity.scoringProfileKey !== record.scoringProfileKey ||
    identity.evidenceThroughSeason !== record.season - 1 ||
    !object(coverage) ||
    coverage.state !== "qualified" ||
    !Array.isArray(coverage.fullyHeldOutSeasons) ||
    coverage.fullyHeldOutSeasons.length <
      ROS_HISTORICAL_COVERAGE_DEFAULT_THRESHOLDS.minimumHeldOutSeasons ||
    coverage.fullyHeldOutSeasons.length > seasons.length ||
    new Set(coverage.fullyHeldOutSeasons).size !== coverage.fullyHeldOutSeasons.length ||
    !coverage.fullyHeldOutSeasons.every(
      (season: unknown) => typeof season === "number" && seasons.includes(season),
    ) ||
    !boundedInteger(
      coverage.completeAsOfBatches,
      ROS_HISTORICAL_COVERAGE_DEFAULT_THRESHOLDS.minimumAsOfBatches,
      seasons.length * 17,
    ) ||
    !object(preflight) ||
    preflight.state !== "blocked" ||
    !boundedInteger(
      preflight.checkedBatches,
      1,
      Math.min(coverage.completeAsOfBatches, coverage.fullyHeldOutSeasons.length * 17),
    ) ||
    !boundedInteger(
      preflight.checkedPlayers,
      1,
      preflight.checkedBatches * positions.length * FIRST_PARTY_ROS_RELEASE_PLAYERS_PER_POSITION,
    ) ||
    !boundedInteger(
      preflight.checkedScheduledWeeks,
      preflight.checkedPlayers,
      preflight.checkedPlayers * 17,
    ) ||
    !Array.isArray(preflight.failures) ||
    preflight.failures.length < 1 ||
    preflight.failures.length > preflight.checkedPlayers
  )
    return false;
  const qualifiedSeasons = coverage.fullyHeldOutSeasons;
  const events = new Set<string>(
    SCORING_LONG_TOUCHDOWN_COMPONENTS.flatMap(({ fortyPlus, fiftyPlus }) => [fortyPlus, fiftyPlus]),
  );
  const seen = new Set<string>();
  return preflight.failures.every((failure: unknown) => {
    if (
      !object(failure) ||
      !boundedInteger(failure.season, record.season - 4, record.season - 1) ||
      !qualifiedSeasons.includes(failure.season) ||
      !boundedInteger(failure.asOfWeek, 1, 17) ||
      !boundedInteger(failure.firstScheduledWeek, failure.asOfWeek + 1, 18) ||
      typeof failure.playerId !== "string" ||
      !/^\d{2}-\d{7}$/u.test(failure.playerId) ||
      typeof failure.position !== "string" ||
      !positions.includes(failure.position)
    )
      return false;
    const required = firstPartyProjectionComponentsForPosition(failure.position).filter((key) =>
      events.has(key),
    );
    const validMissing = (value: unknown): value is readonly string[] =>
      Array.isArray(value) &&
      value.length <= required.length &&
      new Set(value).size === value.length &&
      value.every((key) => typeof key === "string" && required.includes(key));
    if (
      !validMissing(failure.contextualMissing) ||
      !validMissing(failure.recencyMissing) ||
      failure.contextualMissing.length + failure.recencyMissing.length === 0
    )
      return false;
    const key = `${failure.season}:${failure.asOfWeek}:${failure.playerId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const STATISTICAL_ADMISSION_BLOCKERS = new Set([
  "report_global_blockers_present",
  "release_validation_forecasts_below_minimum",
  "release_validation_batches_below_minimum",
  "release_validation_held_out_seasons_below_minimum",
]);

export class RosProfileValidationService {
  private readonly repository: RosProfileValidationRepository;
  private readonly runner: RosProfileValidationRunner;
  private readonly now: () => Date;

  constructor(
    private readonly options: {
      readonly database?: Database;
      readonly repository?: RosProfileValidationRepository;
      readonly runner?: RosProfileValidationRunner;
      readonly enqueueProjectionRefresh: (season: number) => Promise<void>;
      readonly sourceCacheDirectory?: string;
      readonly offline?: boolean;
      readonly validatorPath?: string;
      readonly timeoutMs?: number;
      readonly now?: () => Date;
      readonly sharedCorpus?: (
        season: number,
        signal: AbortSignal,
      ) => Promise<{ requestIdentity: string; corpusIdentity: string | null }>;
    },
  ) {
    if (!options.repository && !options.database)
      throw new Error("ROS validation repository is required");
    this.repository =
      options.repository ?? new DrizzleRosProfileValidationRepository(options.database!);
    this.runner = options.runner ?? createRosProfileValidationRunner(options);
    this.now = options.now ?? (() => new Date());
    if (options.sharedCorpus && !this.repository.deferForCorpus)
      throw new Error("Shared ROS bootstrap requires deferred profile persistence");
  }

  async validateProfile(job: RosProfileValidationJob, context: WorkerJobContext): Promise<void> {
    context.signal.throwIfAborted();
    const record = await this.repository.get(job.profileValidationId);
    if (!record) return;
    const recovery = rosProfileRecoveryMarker(record.report);
    if (job.recoveryCorpusIdentity !== undefined) {
      if (
        recovery?.corpusIdentity !== job.recoveryCorpusIdentity ||
        (recovery.recoveryAttempt ?? 1) !== (job.recoveryAttempt ?? 1)
      )
        return;
    } else if (
      recovery ||
      (object(record.report) && record.report.automaticRecovery !== undefined)
    ) {
      // An older unrestricted queue row cannot claim a newly reserved replay-only recovery.
      return;
    }
    if (record.state === "admitted") {
      // Retry after an enqueue failure never repeats the expensive historical replay. Recovery
      // identity is checked first so an obsolete cycle cannot dispatch a new publication.
      await this.options.enqueueProjectionRefresh(record.season);
      return;
    }
    if (
      record.state === "withheld" &&
      (job.recoveryCorpusIdentity === undefined || recovery?.state !== "pending-dispatch")
    )
      return;
    const startedAt = await this.repository.begin(
      record.id,
      this.now(),
      job.recoveryCorpusIdentity,
      job.recoveryAttempt,
    );
    if (!startedAt) return;
    const recordedReport = (report: Record<string, unknown> | null) =>
      recovery === undefined
        ? report
        : { ...report, automaticRecovery: { ...recovery, state: "attempted" } };
    try {
      let definition;
      try {
        definition = rosProfileDefinitionFromKey(record.scoringProfileKey);
      } catch {
        await this.repository.complete({
          id: record.id,
          startedAt,
          completedAt: this.now(),
          report: recordedReport(null),
          blockers: ["scoring_profile_definition_invalid"],
        });
        return;
      }
      const constants = firstPartyRosAdmissionConstants(definition.profile);
      if (
        definition.digest !== record.scoringProfileDigest ||
        record.modelVersion !== constants.modelVersion ||
        record.policyVersion !== constants.policyVersion ||
        record.calibrationVersion !== constants.calibrationVersion
      ) {
        await this.repository.complete({
          id: record.id,
          startedAt,
          completedAt: this.now(),
          report: recordedReport(null),
          blockers: ["validation_execution_identity_changed"],
        });
        return;
      }
      let requiredReadyCorpusIdentity = job.recoveryCorpusIdentity;
      if (this.options.sharedCorpus) {
        const shared = await this.options.sharedCorpus(record.season, context.signal);
        if (
          job.recoveryCorpusIdentity !== undefined &&
          shared.corpusIdentity !== job.recoveryCorpusIdentity
        )
          throw new Error("Pinned ROS replay corpus is unavailable");
        if (shared.corpusIdentity === null) {
          await this.repository.deferForCorpus!(
            record.id,
            startedAt,
            shared.requestIdentity,
            this.now(),
          );
          return;
        }
        requiredReadyCorpusIdentity = shared.corpusIdentity;
      }
      const report = await this.runner({
        scoringProfileKey: definition.scoringProfileKey,
        season: record.season,
        signal: context.signal,
        ...(requiredReadyCorpusIdentity === undefined ? {} : { requiredReadyCorpusIdentity }),
      });
      context.signal.throwIfAborted();
      if (
        requiredReadyCorpusIdentity !== undefined &&
        report.outcomeCorpusIdentity !== requiredReadyCorpusIdentity
      )
        throw new Error("ROS recovery returned a different ready corpus identity");
      if (report.state === "blocked-before-modeling" && report.componentPreflight !== undefined) {
        if (!validComponentEvidenceBlock(report, record, constants))
          throw new Error("ROS component preflight report failed its execution identity contract");
        await this.repository.complete({
          id: record.id,
          startedAt,
          completedAt: this.now(),
          report: recordedReport(report),
          blockers: ["historical_component_coverage_incomplete"],
        });
        return;
      }
      // A qualified historical corpus is a prerequisite, and the CLI can stop before a champion
      // exists. This is a documented data insufficiency, not a subprocess infrastructure failure.
      if (
        report.state === "blocked-before-modeling" &&
        object(report.scoringProfile) &&
        report.scoringProfile.digest === definition.digest &&
        object(report.coverage) &&
        report.coverage.state !== "qualified"
      ) {
        await this.repository.complete({
          id: record.id,
          startedAt,
          completedAt: this.now(),
          report: recordedReport(report),
          blockers: ["historical_source_coverage_incomplete"],
        });
        return;
      }
      const admission = validateFirstPartyRosAdmission({
        report,
        evidenceThroughSeason: record.season - 1,
        constants,
      });
      if (admission.state === "rejected") {
        if (admission.blockers.some((blocker) => !STATISTICAL_ADMISSION_BLOCKERS.has(blocker))) {
          throw new Error(
            `ROS profile validator report failed its execution identity contract: ${admission.blockers.join(", ")}`,
          );
        }
        const reported =
          object(report.report) && Array.isArray(report.report.blockers)
            ? report.report.blockers.filter(
                (blocker): blocker is string => typeof blocker === "string",
              )
            : [];
        await this.repository.complete({
          id: record.id,
          startedAt,
          completedAt: this.now(),
          report: recordedReport(report),
          blockers: [...new Set([...admission.blockers, ...reported])],
        });
        return;
      }
      const committed = await this.repository.complete({
        id: record.id,
        startedAt,
        completedAt: this.now(),
        report: recordedReport(report),
        blockers: admission.cellBlockers,
        admission,
      });
      if (committed) await this.options.enqueueProjectionRefresh(record.season);
    } catch (error) {
      await this.repository.fail(record.id, startedAt, this.now());
      throw error;
    }
  }
}
