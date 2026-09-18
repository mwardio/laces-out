export const ROS_PROFILE_RECOVERY_VERSION = "ready-corpus-replay-v1";
export const ROS_PROFILE_RECOVERY_MINIMUM_DELAY_MS = 15 * 60_000;
export const ROS_PROFILE_RECOVERY_MAXIMUM_DELAY_MS = 6 * 60 * 60_000;

/** Queue retries belong to one cycle; a later operational recovery gets a new fenced cycle. */
export function rosProfileRecoveryDelayMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1)
    throw new RangeError("Invalid ROS recovery attempt");
  return Math.min(
    ROS_PROFILE_RECOVERY_MAXIMUM_DELAY_MS,
    ROS_PROFILE_RECOVERY_MINIMUM_DELAY_MS * 2 ** Math.min(attempt - 1, 5),
  );
}

export interface RosProfileRecoveryMarker {
  readonly version: typeof ROS_PROFILE_RECOVERY_VERSION;
  readonly corpusIdentity: string;
  readonly state: "pending-dispatch" | "attempted";
  readonly requestedAt: string;
  /** Missing on legacy markers, which represent cycle 1. */
  readonly recoveryAttempt?: number;
  readonly dispatchReservationId?: string;
  readonly dispatchClaimedAt?: string;
  /** Durable evidence that this cycle reached the queue, even if its worker never claimed it. */
  readonly dispatchedJobId?: string;
  readonly dispatchFailure?: {
    readonly reason: "terminal-before-claim" | "missing-before-claim";
    readonly detectedAt: string;
    readonly previousState: string;
    readonly previousBlockers: readonly string[];
  };
}

export function rosProfileRecoveryMarker(report: unknown): RosProfileRecoveryMarker | undefined {
  if (report === null || typeof report !== "object" || Array.isArray(report)) return undefined;
  const marker = (report as Record<string, unknown>).automaticRecovery;
  if (marker === null || typeof marker !== "object" || Array.isArray(marker)) return undefined;
  const value = marker as Record<string, unknown>;
  if (
    value.version !== ROS_PROFILE_RECOVERY_VERSION ||
    typeof value.corpusIdentity !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.corpusIdentity) ||
    (value.state !== "pending-dispatch" && value.state !== "attempted") ||
    typeof value.requestedAt !== "string" ||
    !Number.isFinite(Date.parse(value.requestedAt)) ||
    (value.recoveryAttempt !== undefined &&
      (!Number.isSafeInteger(value.recoveryAttempt) || Number(value.recoveryAttempt) < 1)) ||
    (value.dispatchedJobId !== undefined &&
      (typeof value.dispatchedJobId !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(
          value.dispatchedJobId,
        ) ||
        typeof value.dispatchClaimedAt !== "string" ||
        !Number.isFinite(Date.parse(value.dispatchClaimedAt))))
  )
    return undefined;
  return value as unknown as RosProfileRecoveryMarker;
}

export function rosProfileValidationIsTransient(record: {
  readonly state: string;
  readonly blockers: readonly string[];
}): boolean {
  if (record.blockers.length === 0) return false;
  if (record.state === "withheld")
    return record.blockers.every(
      (blocker) =>
        blocker === "historical_source_coverage_incomplete" ||
        blocker === "historical_component_coverage_incomplete",
    );
  return (
    record.state === "failed" &&
    record.blockers.every(
      (blocker) => blocker === "validation_execution_failed" || blocker === "validation_job_lost",
    )
  );
}

/** Only an explicitly deferred current bootstrap request can promote a pending profile to replay. */
export function rosProfileBootstrapWait(report: unknown, requestIdentity: string): boolean {
  if (report === null || typeof report !== "object" || Array.isArray(report)) return false;
  const value = (report as Record<string, unknown>).bootstrapWait;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const wait = value as Record<string, unknown>;
  return (
    wait.version === "shared-corpus-wait-v1" &&
    wait.requestIdentity === requestIdentity &&
    typeof wait.requestedAt === "string" &&
    Number.isFinite(Date.parse(wait.requestedAt))
  );
}
