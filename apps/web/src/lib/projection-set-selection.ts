import type { ProjectionSetSummary } from "@laces-out/contracts";

export function isCurrentManagedProjection(set: ProjectionSetSummary): boolean {
  return set.origin === "laces-out" && set.managed?.scoringCompatibility === "current";
}

/** Prior model versions remain usable when their exact scoring rules still match. */
export function preferredProjectionSet(
  sets: readonly ProjectionSetSummary[],
  horizon: "week" | "rest-of-season",
  currentWeek: number | null,
): ProjectionSetSummary | undefined {
  const candidates = sets.filter((set) => set.horizon === horizon);
  const managed = candidates.filter(isCurrentManagedProjection);
  return (
    (horizon === "week"
      ? managed.find((set) => currentWeek !== null && set.week === currentWeek)
      : undefined) ??
    managed[0] ??
    candidates.find((set) => set.origin === "custom")
  );
}

export function projectionScoringNotice(set: ProjectionSetSummary | undefined): string | null {
  if (!set || set.origin !== "laces-out" || isCurrentManagedProjection(set)) return null;
  return set.managed?.scoringCompatibility === "changed"
    ? "Historical forecast: league scoring has changed. These points use the saved scoring rules, not the current rules."
    : "Historical forecast: its scoring rules cannot be verified against the current league settings. These points are shown for reference.";
}
