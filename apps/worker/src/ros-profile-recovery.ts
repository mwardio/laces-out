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
  rosProfileRecoveryMarker,
  rosProfileValidationIsTransient,
} from "./ros-profile-recovery-state.js";

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
      .where(and(identity, inArray(firstPartyRosProfileValidations.state, ["failed", "withheld"])));
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
        if (!row || !rosProfileValidationIsTransient(row)) return null;
        const previous = rosProfileRecoveryMarker(row.report);
        if (previous?.corpusIdentity === corpusIdentity && previous.state === "attempted")
          return null;
        const now = this.input.now?.() ?? new Date();
        if (
          previous?.corpusIdentity === corpusIdentity &&
          typeof previous.dispatchClaimedAt === "string" &&
          Date.parse(previous.dispatchClaimedAt) > now.getTime() - 30_000
        )
          return null;
        if (await this.input.validationJobIsOutstanding(row.id)) return null;
        signal.throwIfAborted();
        const marker = {
          version: ROS_PROFILE_RECOVERY_VERSION,
          corpusIdentity,
          state: "pending-dispatch" as const,
          requestedAt:
            previous?.corpusIdentity === corpusIdentity ? previous.requestedAt : now.toISOString(),
          dispatchReservationId: randomUUID(),
          dispatchClaimedAt: now.toISOString(),
        };
        // Keep the transient state so ordinary discovery cannot enqueue an unrestricted build.
        // Replace one operational marker; preserve the original report without nesting history.
        await transaction
          .update(firstPartyRosProfileValidations)
          .set({ report: { ...row.report, automaticRecovery: marker }, updatedAt: now })
          .where(eq(firstPartyRosProfileValidations.id, row.id));
        return marker.dispatchReservationId;
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
              sql`${firstPartyRosProfileValidations.report} -> 'automaticRecovery' ->> 'dispatchReservationId' = ${reservation}`,
              sql`${firstPartyRosProfileValidations.report} -> 'automaticRecovery' ->> 'state' = 'pending-dispatch'`,
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
        });
        if (jobId === null) await releaseDispatch();
      } catch (error) {
        await releaseDispatch();
        throw error;
      }
    }
  }
}
