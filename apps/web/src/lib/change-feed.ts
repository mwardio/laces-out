import {
  changeEventFeedResponseSchema,
  type ChangeEvent,
  type ChangeEventFeedResponse,
  type ChangeEventSeverity,
} from "@fantasy/contracts";

/**
 * Client-side helpers for the change feed.
 *
 * The panel is a `.tsx` component and this repository collects `.test.ts` only, so everything with
 * a decision in it lives here and the component stays a renderer.
 */

export function parseChangeFeed(value: unknown): ChangeEventFeedResponse | null {
  const result = changeEventFeedResponseSchema.safeParse(value);
  return result.success ? result.data : null;
}

const SEVERITY_RANK: Readonly<Record<ChangeEventSeverity, number>> = {
  critical: 0,
  warning: 1,
  action: 2,
  info: 3,
};

/**
 * Unread before read, then severity, then newest first, then id.
 *
 * The trailing id comparison is what makes the order *total*: without it two events sharing a
 * severity and a timestamp could render in either order, and the same page would disagree with
 * itself between renders.
 */
export function prioritizeChangeEvents(events: readonly ChangeEvent[]): readonly ChangeEvent[] {
  return [...events].sort((left, right) => {
    const byState = (left.state === "unread" ? 0 : 1) - (right.state === "unread" ? 0 : 1);
    if (byState !== 0) return byState;
    const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
    if (bySeverity !== 0) return bySeverity;
    const byTime = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
    if (byTime !== 0) return byTime;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}
