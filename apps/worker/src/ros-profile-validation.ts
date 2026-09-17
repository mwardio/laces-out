import {
  firstPartyRosChampionArtifacts,
  firstPartyRosProfileValidations,
  type Database,
} from "@laces-out/db";
import { rosProfileDefinitionFromKey } from "@laces-out/projections";
import { and, eq, inArray, sql } from "drizzle-orm";

import {
  firstPartyRosAdmissionConstants,
  validateFirstPartyRosAdmission,
  type FirstPartyRosAdmissionValidation,
} from "./first-party-ros-admission.js";
import type { WorkerJobContext } from "./jobs.js";
import {
  createRosProfileValidationRunner,
  type RosProfileValidationRunner,
} from "./ros-profile-validation-runner.js";

export type RosProfileValidationRecord = typeof firstPartyRosProfileValidations.$inferSelect;
type AdmittedValidation = Extract<FirstPartyRosAdmissionValidation, { state: "admissible" }>;

export interface RosProfileValidationRepository {
  get(id: string): Promise<RosProfileValidationRecord | null>;
  begin(id: string, startedAt: Date): Promise<Date | null>;
  complete(input: {
    id: string;
    startedAt: Date;
    completedAt: Date;
    report: Record<string, unknown> | null;
    blockers: readonly string[];
    admission?: AdmittedValidation;
  }): Promise<boolean>;
  fail(id: string, startedAt: Date, completedAt: Date): Promise<void>;
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

  async begin(id: string, startedAt: Date): Promise<Date | null> {
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
      })
      .where(
        and(
          eq(firstPartyRosProfileValidations.id, id),
          inArray(firstPartyRosProfileValidations.state, ["pending", "failed", "validating"]),
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
        .select({ id: firstPartyRosProfileValidations.id })
        .from(firstPartyRosProfileValidations)
        .where(claim)
        .for("update");
      if (!record) return false;
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
          report: input.report,
          artifactId,
          completedAt: input.completedAt,
          updatedAt: input.completedAt,
        })
        .where(claim);
      return true;
    });
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
    },
  ) {
    if (!options.repository && !options.database)
      throw new Error("ROS validation repository is required");
    this.repository =
      options.repository ?? new DrizzleRosProfileValidationRepository(options.database!);
    this.runner = options.runner ?? createRosProfileValidationRunner(options);
    this.now = options.now ?? (() => new Date());
  }

  async validateProfile(
    job: { readonly profileValidationId: string },
    context: WorkerJobContext,
  ): Promise<void> {
    context.signal.throwIfAborted();
    const record = await this.repository.get(job.profileValidationId);
    if (!record) return;
    if (record.state === "admitted") {
      // Retry after an enqueue failure never repeats the expensive historical replay.
      await this.options.enqueueProjectionRefresh(record.season);
      return;
    }
    if (record.state === "withheld") return;
    const startedAt = await this.repository.begin(record.id, this.now());
    if (!startedAt) return;
    try {
      let definition;
      try {
        definition = rosProfileDefinitionFromKey(record.scoringProfileKey);
      } catch {
        await this.repository.complete({
          id: record.id,
          startedAt,
          completedAt: this.now(),
          report: null,
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
          report: null,
          blockers: ["validation_execution_identity_changed"],
        });
        return;
      }
      const report = await this.runner({
        scoringProfileKey: definition.scoringProfileKey,
        season: record.season,
        signal: context.signal,
      });
      context.signal.throwIfAborted();
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
          report,
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
          report,
          blockers: [...new Set([...admission.blockers, ...reported])],
        });
        return;
      }
      const committed = await this.repository.complete({
        id: record.id,
        startedAt,
        completedAt: this.now(),
        report,
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
