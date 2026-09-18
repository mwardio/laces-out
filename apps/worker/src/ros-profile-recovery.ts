import { randomUUID } from "node:crypto";

import { firstPartyRosProfileValidations, type Database } from "@laces-out/db";
import type { RosProfileValidationJob } from "@laces-out/jobs";
import {
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
  FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
} from "@laces-out/projections";
import { and, eq, inArray, sql } from "drizzle-orm";

import {
  ROS_PROFILE_RECOVERY_VERSION,
  rosProfileRecoveryDelayMs,
  rosProfileBootstrapWait,
  rosProfileRecoveryMarker,
  rosProfileValidationIsTransient,
} from "./ros-profile-recovery-state.js";

import { rosSharedCorpusRequest } from "./ros-shared-corpus-runner.js";

/** Operational recovery may only reuse an already verified complete football corpus. */
export class RosProfileRecoveryService {
  constructor(
    private readonly input: {
      readonly database: Database;
      readonly readyCorpusForSeason: (
        season: number,
        signal: AbortSignal,
      ) => Promise<string | null>;
      readonly enqueueValidation: (job: RosProfileValidationJob) => Promise<string | null>;
      readonly validationJobIsOutstanding: (id: string) => Promise<boolean>;
      readonly validationJobIsTerminal?: (
        profileValidationId: string,
        corpusIdentity: string,
        recoveryAttempt: number,
      ) => Promise<boolean>;
      readonly now?: () => Date;
    },
  ) {}

  async recover(season: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const identity = and(
      eq(firstPartyRosProfileValidations.season, season),
      eq(firstPartyRosProfileValidations.modelVersion, FIRST_PARTY_ROS_MODEL_VERSION),
      eq(firstPartyRosProfileValidations.policyVersion, FIRST_PARTY_ROS_POLICY_VERSION),
      eq(
        firstPartyRosProfileValidations.calibrationVersion,
        FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
      ),
    );
    const candidates = await this.input.database
      .select({ id: firstPartyRosProfileValidations.id })
      .from(firstPartyRosProfileValidations)
      .where(
        and(
          identity,
          inArray(firstPartyRosProfileValidations.state, ["pending", "failed", "withheld"]),
        ),
      );
    if (candidates.length === 0) return;
    const corpusIdentity = await this.input.readyCorpusForSeason(season, signal);
    signal.throwIfAborted();
    if (corpusIdentity === null) return;
    if (!/^[a-f0-9]{64}$/u.test(corpusIdentity))
      throw new Error("Invalid ready ROS corpus identity");
    for (const candidate of candidates) {
      signal.throwIfAborted();
      const reservation = await this.input.database.transaction(async (transaction) => {
        const [row] = await transaction
          .select()
          .from(firstPartyRosProfileValidations)
          .where(and(identity, eq(firstPartyRosProfileValidations.id, candidate.id)))
          .for("update");
        const waiting =
          row?.state === "pending" &&
          rosProfileBootstrapWait(row.report, rosSharedCorpusRequest(season).identity);
        if (!row || (!waiting && !rosProfileValidationIsTransient(row))) return null;
        const previous = rosProfileRecoveryMarker(row.report);
        if (row.report?.automaticRecovery !== undefined && previous === undefined) return null;
        const now = this.input.now?.() ?? new Date();
        const sameCorpus = previous?.corpusIdentity === corpusIdentity;
        const previousAttempt = previous?.recoveryAttempt ?? 1;
        let recoveryAttempt = sameCorpus ? previousAttempt : 1;
        if (sameCorpus && previous.state === "attempted") {
          // A completed scientific/data rejection cannot improve on identical evidence. A dead
          // process or exhausted infrastructure retry can: reserve another replay after backoff.
          if (
            row.state !== "failed" ||
            row.completedAt === null ||
            !Number.isFinite(row.completedAt.getTime()) ||
            now.getTime() - row.completedAt.getTime() <
              rosProfileRecoveryDelayMs(previousAttempt) ||
            previousAttempt === Number.MAX_SAFE_INTEGER
          )
            return null;
          recoveryAttempt += 1;
        }
        if (
          sameCorpus &&
          typeof previous.dispatchClaimedAt === "string" &&
          Date.parse(previous.dispatchClaimedAt) > now.getTime() - 30_000
        )
          return null;
        if (await this.input.validationJobIsOutstanding(row.id)) return null;
        signal.throwIfAborted();
        if (sameCorpus && previous.state === "pending-dispatch") {
          const terminal =
            (await this.input.validationJobIsTerminal?.(row.id, corpusIdentity, previousAttempt)) ??
            false;
          signal.throwIfAborted();
          const missing =
            previous.dispatchedJobId !== undefined &&
            typeof previous.dispatchClaimedAt === "string" &&
            now.getTime() - Date.parse(previous.dispatchClaimedAt) >= 5 * 60_000;
          if (terminal || missing) {
            // The queue accepted this exact cycle, but its consumer never changed the durable
            // marker to attempted. Record an operational failure before applying the existing
            // cooldown; resending the same singleton can otherwise suppress work for 23 hours.
            await transaction
              .update(firstPartyRosProfileValidations)
              .set({
                state: "failed",
                blockers: ["validation_job_lost"],
                completedAt: now,
                updatedAt: now,
                report: {
                  ...row.report,
                  automaticRecovery: {
                    ...previous,
                    state: "attempted",
                    dispatchFailure: {
                      reason: terminal ? "terminal-before-claim" : "missing-before-claim",
                      detectedAt: now.toISOString(),
                      previousState: row.state,
                      previousBlockers: row.blockers,
                    },
                  },
                },
              })
              .where(eq(firstPartyRosProfileValidations.id, row.id));
            return null;
          }
          // A known dispatch retains its ID and original timestamp through the full lost-job
          // grace. A null/error send without queue evidence can retry the same cycle immediately.
          if (previous.dispatchedJobId !== undefined) return null;
        }
        const marker = {
          version: ROS_PROFILE_RECOVERY_VERSION,
          corpusIdentity,
          recoveryAttempt,
          state: "pending-dispatch" as const,
          requestedAt:
            previous?.corpusIdentity === corpusIdentity ? previous.requestedAt : now.toISOString(),
          dispatchReservationId: randomUUID(),
          dispatchClaimedAt: now.toISOString(),
          ...(previous?.dispatchFailure === undefined
            ? {}
            : { dispatchFailure: previous.dispatchFailure }),
        };
        // Keep the transient state so ordinary discovery cannot enqueue an unrestricted build.
        // Replace one operational marker; preserve the original report without nesting history.
        await transaction
          .update(firstPartyRosProfileValidations)
          .set({ report: { ...row.report, automaticRecovery: marker }, updatedAt: now })
          .where(eq(firstPartyRosProfileValidations.id, row.id));
        return { id: marker.dispatchReservationId, recoveryAttempt };
      });
      if (reservation === null) continue;
      const releaseDispatch = async () => {
        await this.input.database
          .update(firstPartyRosProfileValidations)
          .set({
            report: sql`${firstPartyRosProfileValidations.report} #- '{automaticRecovery,dispatchReservationId}' #- '{automaticRecovery,dispatchClaimedAt}'`,
          })
          .where(
            and(
              eq(firstPartyRosProfileValidations.id, candidate.id),
              sql`${firstPartyRosProfileValidations.report} -> 'automaticRecovery' ->> 'dispatchReservationId' = ${reservation.id}`,
              sql`${firstPartyRosProfileValidations.report} -> 'automaticRecovery' ->> 'state' = 'pending-dispatch'`,
              sql`${firstPartyRosProfileValidations.report} -> 'automaticRecovery' -> 'dispatchedJobId' is null`,
            ),
          );
      };
      // Reservation must commit before sending: a fast queue consumer reads this marker before
      // it claims the replay. A short dispatch lease expires after a crash between these steps.
      try {
        signal.throwIfAborted();
        const jobId = await this.input.enqueueValidation({
          profileValidationId: candidate.id,
          recoveryCorpusIdentity: corpusIdentity,
          recoveryAttempt: reservation.recoveryAttempt,
        });
        if (jobId === null) await releaseDispatch();
        else {
          if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(jobId))
            throw new Error("Invalid ROS replay dispatch job identity");
          await this.input.database
            .update(firstPartyRosProfileValidations)
            .set({
              report: sql`jsonb_set(${firstPartyRosProfileValidations.report}, '{automaticRecovery,dispatchedJobId}', ${JSON.stringify(jobId)}::jsonb)`,
            })
            .where(
              and(
                eq(firstPartyRosProfileValidations.id, candidate.id),
                sql`${firstPartyRosProfileValidations.report} -> 'automaticRecovery' ->> 'dispatchReservationId' = ${reservation.id}`,
                sql`${firstPartyRosProfileValidations.report} -> 'automaticRecovery' ->> 'state' = 'pending-dispatch'`,
              ),
            );
        }
      } catch (error) {
        await releaseDispatch();
        throw error;
      }
    }
  }
}
