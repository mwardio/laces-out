import { randomUUID } from "node:crypto";

import { firstPartyRosCorpusBootstraps, type Database } from "@laces-out/db";
import { ROS_CORPUS_BOOTSTRAP_MAXIMUM_ATTEMPTS, type RosCorpusBootstrapJob } from "@laces-out/jobs";
import {
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
  rosScoringProfile,
} from "@laces-out/projections";
import { and, eq, isNotNull } from "drizzle-orm";

import type { WorkerJobContext } from "./jobs.js";
import type { RosCorpusLock } from "./ros-corpus-lock.js";
import {
  RosBootstrapSourceSnapshotError,
  type RosBootstrapSourceSnapshots,
} from "./ros-bootstrap-source-snapshots.js";
import type { RosProfileValidationRunner } from "./ros-profile-validation-runner.js";
import type { RosExecutionCapacity } from "./ros-execution-capacity.js";
import { rosProfileRecoveryDelayMs } from "./ros-profile-recovery-state.js";
import {
  createSharedRosCorpusValidationRunner,
  readyRosSharedCorpusIdentity,
  rosSharedCorpusRequest,
  ROS_SHARED_CORPUS_BUILD_LOCK,
} from "./ros-shared-corpus-runner.js";

type Row = typeof firstPartyRosCorpusBootstraps.$inferSelect;
type Request = ReturnType<typeof rosSharedCorpusRequest>;
type CommitReady = NonNullable<
  Parameters<typeof createSharedRosCorpusValidationRunner>[0]["commitReady"]
>;
const table = firstPartyRosCorpusBootstraps;
const PROFILE = rosScoringProfile("full-ppr");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    object(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

export interface RosCorpusBootstrapDependencies {
  readonly database: Database;
  readonly directory: string;
  readonly lock: RosCorpusLock;
  readonly snapshots: Pick<
    RosBootstrapSourceSnapshots,
    "prepare" | "markQualified" | "markUnqualified"
  >;
  readonly runner: (options: {
    sourceCacheDirectory: string;
    offline: boolean;
    preflightOnly: boolean;
  }) => RosProfileValidationRunner;
  readonly capacity: RosExecutionCapacity;
  readonly enqueue: (job: RosCorpusBootstrapJob) => Promise<string | null>;
  readonly jobIsOutstanding: (requestIdentity: string) => Promise<boolean>;
  readonly jobIsTerminal?: (requestIdentity: string, attempt: number) => Promise<boolean>;
  readonly readyCorpusForSeason?: (season: number, signal: AbortSignal) => Promise<string | null>;
  /** Test seam at the orchestration boundary; production always uses the shared verifier/lock. */
  readonly buildCorpus?: (input: {
    season: number;
    signal: AbortSignal;
    runner: RosProfileValidationRunner;
    commitReady: CommitReady;
  }) => Promise<Record<string, unknown>>;
  readonly now?: () => Date;
}

/** Call only after the explicit adopter fully verifies the immutable corpus and all vectors. */
export async function recordVerifiedRosCorpusAdoption(
  database: Database,
  season: number,
  corpusIdentity: string,
  now = new Date(),
): Promise<void> {
  if (!sha(corpusIdentity)) throw new Error("Invalid verified ROS corpus identity");
  const request = rosSharedCorpusRequest(season);
  await database
    .insert(table)
    .values({
      requestIdentity: request.identity,
      season,
      protocol: request.protocol,
    })
    .onConflictDoNothing();
  await database.transaction(async (transaction) => {
    const [row] = await transaction
      .select()
      .from(table)
      .where(eq(table.requestIdentity, request.identity))
      .for("update");
    if (
      !row ||
      row.season !== season ||
      canonical(row.protocol) !== canonical(request.protocol) ||
      (row.corpusIdentity !== null && row.corpusIdentity !== corpusIdentity)
    )
      throw new Error("Verified adoption differs from retained ROS identity");
    await transaction
      .update(table)
      .set({
        state: "ready",
        corpusIdentity,
        verifiedAt: now,
        completedAt: now,
        updatedAt: now,
        nextAttemptAt: null,
        reasonCode: null,
        diagnostic: {},
        dispatchReservationId: null,
        dispatchClaimedAt: null,
      })
      .where(eq(table.requestIdentity, request.identity));
  });
}

/** Durable, scoring-independent shared data preparation. Never admits a scoring policy. */
export class RosCorpusBootstrapService {
  constructor(private readonly input: RosCorpusBootstrapDependencies) {}
  private now(): Date {
    return this.input.now?.() ?? new Date();
  }
  private ready(season: number, signal: AbortSignal) {
    return (
      this.input.readyCorpusForSeason?.(season, signal) ??
      readyRosSharedCorpusIdentity(this.input.directory, season, signal)
    );
  }
  private valid(row: Row, request: Request): boolean {
    return (
      row.requestIdentity === request.identity &&
      row.season === request.protocol.season &&
      canonical(row.protocol) === canonical(request.protocol)
    );
  }
  private claimWhere(row: Row) {
    return and(
      eq(table.requestIdentity, row.requestIdentity),
      eq(table.attempt, row.attempt),
      eq(table.state, "building"),
      eq(table.startedAt, row.startedAt!),
    );
  }

  async lookup(season: number): Promise<Row | null> {
    const request = rosSharedCorpusRequest(season);
    const [row] = await this.input.database
      .select()
      .from(table)
      .where(eq(table.requestIdentity, request.identity));
    if (row && !this.valid(row, request))
      throw new Error("ROS bootstrap request identity is inconsistent");
    return row ?? null;
  }

  /** Reconciles adopted data and reserves one due cycle. A failed send retains its cycle. */
  async ensure(season: number, signal: AbortSignal): Promise<string | null> {
    signal.throwIfAborted();
    const request = rosSharedCorpusRequest(season);
    await this.input.database
      .insert(table)
      .values({ requestIdentity: request.identity, season, protocol: request.protocol })
      .onConflictDoNothing();
    const observed = await this.lookup(season);
    if (!observed || observed.state === "blocked-integrity") return null;
    let ready: string | null = null;
    const reservation = await this.input.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(table)
        .where(eq(table.requestIdentity, request.identity))
        .for("update");
      if (!row || !this.valid(row, request)) throw new Error("ROS bootstrap request changed");
      if (row.state === "blocked-integrity") return null;
      const now = this.now();
      let integrityFailure = false;
      try {
        ready = await this.ready(season, signal);
      } catch {
        signal.throwIfAborted();
        integrityFailure = true;
      }
      if (ready !== null && !sha(ready)) integrityFailure = true;
      if (integrityFailure || (row.corpusIdentity !== null && ready !== row.corpusIdentity)) {
        await transaction
          .update(table)
          .set({
            state: "blocked-integrity",
            reasonCode: "committed_corpus_unavailable",
            diagnostic: { retainedCorpusIdentity: row.corpusIdentity },
            updatedAt: now,
            nextAttemptAt: null,
          })
          .where(eq(table.requestIdentity, request.identity));
        return null;
      }
      if (ready !== null) {
        await transaction
          .update(table)
          .set({
            state: "ready",
            corpusIdentity: ready,
            verifiedAt: now,
            completedAt: row.completedAt ?? now,
            updatedAt: now,
            nextAttemptAt: null,
            reasonCode: null,
            diagnostic: {},
            dispatchReservationId: null,
            dispatchClaimedAt: null,
          })
          .where(eq(table.requestIdentity, request.identity));
        return null;
      }
      const outstanding = await this.input.jobIsOutstanding(request.identity);
      if (outstanding) return null;
      if (
        row.state === "pending" &&
        row.attempt > 0 &&
        ((await this.input.jobIsTerminal?.(request.identity, row.attempt)) ||
          (row.jobId !== null &&
            now.getTime() - (row.dispatchClaimedAt ?? row.updatedAt).getTime() >= 5 * 60_000))
      ) {
        await transaction
          .update(table)
          .set({
            state: "retry-wait",
            reasonCode: "bootstrap_dispatch_exhausted",
            completedAt: now,
            updatedAt: now,
            nextAttemptAt: new Date(now.getTime() + rosProfileRecoveryDelayMs(row.attempt)),
            dispatchReservationId: null,
            dispatchClaimedAt: null,
          })
          .where(eq(table.requestIdentity, request.identity));
        return null;
      }
      // A known successful send may be temporarily absent from queue lookup; retain its
      // evidence until the lost-job grace expires instead of resetting the dispatch clock.
      if (row.state === "pending" && row.jobId !== null) return null;
      if (row.state === "building") {
        if (row.startedAt && now.getTime() - row.startedAt.getTime() >= 5 * 60_000) {
          await transaction
            .update(table)
            .set({
              state: "retry-wait",
              reasonCode: "bootstrap_job_lost",
              completedAt: now,
              nextAttemptAt: new Date(
                now.getTime() + rosProfileRecoveryDelayMs(Math.max(1, row.attempt)),
              ),
              updatedAt: now,
            })
            .where(eq(table.requestIdentity, request.identity));
        }
        return null;
      }
      if (row.dispatchClaimedAt && now.getTime() - row.dispatchClaimedAt.getTime() < 30_000)
        return null;
      if (
        (row.state === "retry-wait" || row.state === "waiting-source") &&
        (!row.nextAttemptAt || row.nextAttemptAt > now)
      )
        return null;
      const attempt = row.state === "pending" && row.attempt > 0 ? row.attempt : row.attempt + 1;
      if (
        !Number.isSafeInteger(attempt) ||
        attempt < 1 ||
        attempt > ROS_CORPUS_BOOTSTRAP_MAXIMUM_ATTEMPTS
      )
        return null;
      const reservationId = randomUUID();
      await transaction
        .update(table)
        .set({
          state: "pending",
          attempt,
          dispatchReservationId: reservationId,
          dispatchClaimedAt: now,
          jobId: null,
          updatedAt: now,
          nextAttemptAt: null,
        })
        .where(eq(table.requestIdentity, request.identity));
      return { attempt, reservationId };
    });
    if (!reservation) return (await this.lookup(season))?.state === "ready" ? ready : null;
    const release = async () => {
      await this.input.database
        .update(table)
        .set({ dispatchReservationId: null, dispatchClaimedAt: null })
        .where(
          and(
            eq(table.requestIdentity, request.identity),
            eq(table.state, "pending"),
            eq(table.dispatchReservationId, reservation.reservationId),
          ),
        );
    };
    try {
      signal.throwIfAborted();
      const id = await this.input.enqueue({
        requestIdentity: request.identity,
        season,
        attempt: reservation.attempt,
      });
      if (id === null) await release();
      else
        await this.input.database
          .update(table)
          .set({ jobId: id })
          .where(
            and(
              eq(table.requestIdentity, request.identity),
              eq(table.state, "pending"),
              eq(table.dispatchReservationId, reservation.reservationId),
            ),
          );
    } catch (error) {
      await release();
      throw error;
    }
    return null;
  }

  /** Explicit operator reconciliation after adoptRosSharedCorpus has fully verified all vectors. */
  async recordVerifiedAdoption(season: number, corpusIdentity: string): Promise<void> {
    await recordVerifiedRosCorpusAdoption(this.input.database, season, corpusIdentity, this.now());
  }

  async run(job: RosCorpusBootstrapJob, context: WorkerJobContext): Promise<void> {
    context.signal.throwIfAborted();
    const request = rosSharedCorpusRequest(job.season);
    if (
      request.identity !== job.requestIdentity ||
      !Number.isSafeInteger(job.attempt) ||
      job.attempt < 1 ||
      job.attempt > ROS_CORPUS_BOOTSTRAP_MAXIMUM_ATTEMPTS
    )
      return;
    const claim = await this.input.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(table)
        .where(eq(table.requestIdentity, request.identity))
        .for("update");
      if (
        !row ||
        !this.valid(row, request) ||
        row.attempt !== job.attempt ||
        !["pending", "retry-wait", "building"].includes(row.state) ||
        row.corpusIdentity !== null
      )
        return null;
      const now = this.now();
      const startedAt = new Date(Math.max(now.getTime(), (row.startedAt?.getTime() ?? 0) + 1));
      const fresh = row.sourceSnapshotId === null || row.sourceSnapshotState === "unqualified";
      const [claimed] = await transaction
        .update(table)
        .set({
          state: "building",
          startedAt,
          completedAt: null,
          updatedAt: now,
          jobId: context.jobId,
          dispatchReservationId: null,
          dispatchClaimedAt: null,
          nextAttemptAt: null,
          ...(fresh
            ? {
                sourceSnapshotId: randomUUID(),
                sourceSnapshotState: "capturing" as const,
                sourceSnapshotCreatedAt: now,
                sourceSnapshotQualifiedAt: null,
              }
            : {}),
        })
        .where(eq(table.requestIdentity, request.identity))
        .returning();
      return claimed ?? null;
    });
    if (!claim) return;
    const assertClaim = async (signal: AbortSignal) => {
      signal.throwIfAborted();
      const [current] = await this.input.database
        .select({ id: table.requestIdentity })
        .from(table)
        .where(this.claimWhere(claim));
      if (!current) throw new Error("ROS bootstrap claim changed before execution");
    };
    const finishReady: CommitReady = async ({ corpusIdentity, commit }) => {
      if (!sha(corpusIdentity)) throw new Error("Invalid built ROS corpus identity");
      await this.input.database.transaction(async (transaction) => {
        const [current] = await transaction
          .select()
          .from(table)
          .where(this.claimWhere(claim))
          .for("update");
        if (!current) throw new Error("ROS bootstrap claim was replaced before readiness commit");
        context.signal.throwIfAborted();
        await commit();
        const now = this.now();
        await transaction
          .update(table)
          .set({
            state: "ready",
            corpusIdentity,
            verifiedAt: now,
            completedAt: now,
            updatedAt: now,
            nextAttemptAt: null,
            reasonCode: null,
            diagnostic: {},
          })
          .where(this.claimWhere(claim));
      });
    };
    const setFailure = async (state: "retry-wait" | "waiting-source", reasonCode: string) => {
      const now = this.now();
      await this.input.database
        .update(table)
        .set({
          state,
          reasonCode,
          diagnostic: {},
          completedAt: now,
          updatedAt: now,
          nextAttemptAt: new Date(now.getTime() + rosProfileRecoveryDelayMs(job.attempt)),
        })
        .where(this.claimWhere(claim));
    };
    try {
      await this.input.lock(ROS_SHARED_CORPUS_BUILD_LOCK, context.signal, async (guard) => {
        const signal = guard.signal;
        await assertClaim(signal);
        const ready = await this.ready(job.season, signal);
        if (ready !== null) {
          await finishReady({ corpusIdentity: ready, commit: async () => {} });
          return;
        }
        const references = await this.input.database
          .select({ id: table.sourceSnapshotId })
          .from(table)
          .where(isNotNull(table.sourceSnapshotId));
        const snapshot = await this.input.snapshots.prepare({
          requestIdentity: request.identity,
          snapshotId: claim.sourceSnapshotId!,
          allowCreate: claim.sourceSnapshotState === "capturing",
          protectedSnapshotIds: references.flatMap(({ id }) => (id ? [id] : [])),
        });
        if (claim.sourceSnapshotState === "qualified" && snapshot.state !== "qualified")
          throw new RosBootstrapSourceSnapshotError("source_snapshot_integrity");
        if (snapshot.state === "unqualified") {
          await this.input.database
            .update(table)
            .set({ sourceSnapshotState: "unqualified", sourceSnapshotQualifiedAt: null })
            .where(this.claimWhere(claim));
          await setFailure("waiting-source", "bootstrap_source_coverage_incomplete");
          return;
        }
        const base = { scoringProfileKey: PROFILE.scoringProfileKey, season: job.season, signal };
        if (claim.sourceSnapshotState !== "qualified") {
          const preflight = await this.input.capacity.run(1, signal, async () => {
            await assertClaim(signal);
            return this.input.runner({
              sourceCacheDirectory: snapshot.directory,
              offline: snapshot.state === "qualified",
              preflightOnly: true,
            })(base);
          });
          signal.throwIfAborted();
          if (
            preflight.noDatabaseWrites !== true ||
            preflight.noSimulation !== true ||
            !object(preflight.scoringProfile) ||
            preflight.scoringProfile.digest !== PROFILE.digest ||
            !object(preflight.executionIdentity) ||
            preflight.executionIdentity.modelVersion !== FIRST_PARTY_ROS_MODEL_VERSION ||
            preflight.executionIdentity.policyVersion !== FIRST_PARTY_ROS_POLICY_VERSION ||
            preflight.executionIdentity.scoringProfileKey !== PROFILE.scoringProfileKey ||
            preflight.executionIdentity.evidenceThroughSeason !== job.season - 1
          )
            throw new Error("ROS bootstrap preflight identity is invalid");
          if (
            preflight.state === "blocked-before-modeling" &&
            ((object(preflight.coverage) && preflight.coverage.state !== "qualified") ||
              (object(preflight.componentPreflight) &&
                preflight.componentPreflight.state === "blocked"))
          ) {
            await this.input.snapshots.markUnqualified(request.identity, claim.sourceSnapshotId!);
            await this.input.database
              .update(table)
              .set({ sourceSnapshotState: "unqualified", sourceSnapshotQualifiedAt: null })
              .where(this.claimWhere(claim));
            await setFailure("waiting-source", "bootstrap_source_coverage_incomplete");
            return;
          }
          if (
            preflight.state !== "component-preflight-qualified" ||
            !object(preflight.coverage) ||
            preflight.coverage.state !== "qualified" ||
            canonical(preflight.coverage.fullyHeldOutSeasons) !==
              canonical(request.protocol.heldOutSeasons) ||
            !object(preflight.componentPreflight) ||
            preflight.componentPreflight.state !== "qualified"
          )
            throw new Error("ROS bootstrap preflight identity is invalid");
          await this.input.snapshots.markQualified(request.identity, claim.sourceSnapshotId!);
          const qualified = await this.input.database
            .update(table)
            .set({
              sourceSnapshotState: "qualified",
              sourceSnapshotQualifiedAt: this.now(),
              updatedAt: this.now(),
            })
            .where(this.claimWhere(claim))
            .returning({ id: table.requestIdentity });
          if (qualified.length !== 1)
            throw new Error("ROS bootstrap claim changed before modeling");
        }
        const runner: RosProfileValidationRunner = (input) =>
          this.input.capacity.run(input.replayCorpusIdentity ? 1 : 2, input.signal, async () => {
            await assertClaim(input.signal);
            return this.input.runner({
              sourceCacheDirectory: snapshot.directory,
              offline: true,
              preflightOnly: false,
            })(input);
          });
        const report = this.input.buildCorpus
          ? await this.input.buildCorpus({
              season: job.season,
              signal,
              runner,
              commitReady: finishReady,
            })
          : await createSharedRosCorpusValidationRunner({
              directory: this.input.directory,
              lock: async (identity, _signal, run) => {
                if (identity !== ROS_SHARED_CORPUS_BUILD_LOCK)
                  throw new Error("Unexpected ROS bootstrap lock");
                await guard.assertHeld();
                return run(guard);
              },
              runner,
              commitReady: finishReady,
            })(base);
        signal.throwIfAborted();
        const identity = await this.ready(job.season, signal);
        if (!sha(report.outcomeCorpusIdentity) || report.outcomeCorpusIdentity !== identity)
          throw new Error("ROS bootstrap completion lacks verified ready data");
        // Another verified builder/adopter may have won while this job waited on the global lock.
        const current = await this.lookup(job.season);
        if (current?.state === "building")
          await finishReady({ corpusIdentity: identity, commit: async () => {} });
      });
    } catch (error) {
      if (
        error instanceof RosBootstrapSourceSnapshotError &&
        error.code === "source_snapshot_integrity"
      ) {
        await this.input.database
          .update(table)
          .set({
            state: "blocked-integrity",
            reasonCode: error.code,
            completedAt: this.now(),
            updatedAt: this.now(),
            nextAttemptAt: null,
          })
          .where(this.claimWhere(claim));
      } else {
        await setFailure(
          "retry-wait",
          error instanceof RosBootstrapSourceSnapshotError
            ? error.code
            : "bootstrap_execution_failed",
        );
      }
      throw error;
    }
  }
}

/** February prepares the next league year without changing the current season request. */
export function rosBootstrapSeasons(season: number, now = new Date()): readonly number[] {
  return now.getUTCMonth() === 1 && season + 1 === now.getUTCFullYear()
    ? [season, season + 1]
    : [season];
}
