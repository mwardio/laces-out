export const ROS_PROFILE_RECOVERY_VERSION = "ready-corpus-replay-v1";

export interface RosProfileRecoveryMarker {
  readonly version: typeof ROS_PROFILE_RECOVERY_VERSION;
  readonly corpusIdentity: string;
  readonly state: "pending-dispatch" | "attempted";
  readonly requestedAt: string;
  readonly dispatchReservationId?: string;
  readonly dispatchClaimedAt?: string;
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
    !Number.isFinite(Date.parse(value.requestedAt))
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
    return record.blockers.every((blocker) => blocker === "historical_source_coverage_incomplete");
  return (
    record.state === "failed" &&
    record.blockers.every(
      (blocker) => blocker === "validation_execution_failed" || blocker === "validation_job_lost",
    )
  );
}
