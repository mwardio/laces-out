import type { ScheduleEdgeResponse } from "@laces-out/contracts";

type ScheduleEdgeValidationStatus = ScheduleEdgeResponse["algorithm"]["validationStatus"];

/** Product-facing summary; the exact validation state remains in advanced methodology details. */
export function scheduleEdgeEvidenceUseLabel(status: ScheduleEdgeValidationStatus): string {
  if (status === "descriptive-only") return "Historical context";
  return status === "validated" ? "Validated" : "Withheld";
}
