import { DEFENSE_POINTS_ALLOWED_EVENT_POINTS } from "@laces-out/projections";

/** Synthetic complete scoreboard ledger; callers specify every nonzero scoring event. */
export function completeDefenseScoringEvents(
  events: Partial<Record<keyof typeof DEFENSE_POINTS_ALLOWED_EVENT_POINTS, number>>,
): Record<string, number> {
  const counts = Object.fromEntries(
    Object.keys(DEFENSE_POINTS_ALLOWED_EVENT_POINTS).map((key) => [key, 0]),
  );
  Object.assign(counts, events);
  return {
    ...counts,
    scoring_event_totals_complete: 1,
    scoring_points_total: Object.entries(DEFENSE_POINTS_ALLOWED_EVENT_POINTS).reduce(
      (sum, [key, points]) => sum + counts[key]! * points,
      0,
    ),
  };
}
