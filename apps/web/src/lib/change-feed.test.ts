import { describe, expect, it } from "vitest";

import { parseChangeFeed, prioritizeChangeEvents } from "./change-feed";

const event = (over: Record<string, unknown> = {}) => ({
  id: "50000000-0000-4000-8000-000000000001",
  eventType: "roster.changed",
  severity: "info",
  visibility: "league",
  leagueId: "20000000-0000-4000-8000-000000000001",
  occurredAt: "2026-09-16T11:00:00.000Z",
  headline: "Gridiron Ghosts changed 1 roster spot",
  detail: "Added A. Back.",
  url: "/app",
  state: "unread",
  payload: {
    v: 1,
    teamId: "30000000-0000-4000-8000-000000000001",
    teamName: "Gridiron Ghosts",
    season: 2026,
    week: 4,
    added: [],
    removed: [],
    promoted: [],
    benched: [],
    moreCount: 0,
  },
  ...over,
});

describe("parseChangeFeed", () => {
  it("returns null rather than throwing on a contract violation", () => {
    expect(parseChangeFeed({ nope: true })).toBeNull();
    expect(parseChangeFeed(null)).toBeNull();
    expect(
      parseChangeFeed({
        generatedAt: "2026-09-16T12:00:00.000Z",
        unreadCount: 1,
        nextCursor: null,
        events: [event()],
      }),
    ).not.toBeNull();
  });
});

describe("prioritizeChangeEvents", () => {
  it("orders critical before warning before action before info, then newest first", () => {
    const ordered = prioritizeChangeEvents([
      event({ id: "a", severity: "info", occurredAt: "2026-09-16T11:00:00.000Z" }),
      event({ id: "b", severity: "warning", occurredAt: "2026-09-16T09:00:00.000Z" }),
      event({ id: "c", severity: "critical", occurredAt: "2026-09-16T08:00:00.000Z" }),
      event({ id: "d", severity: "action", occurredAt: "2026-09-16T10:00:00.000Z" }),
      event({ id: "e", severity: "warning", occurredAt: "2026-09-16T10:30:00.000Z" }),
    ] as never);

    expect(ordered.map((entry) => entry.id)).toEqual(["c", "e", "b", "d", "a"]);
  });

  it("sinks read items below unread items of the same severity", () => {
    const ordered = prioritizeChangeEvents([
      event({
        id: "read",
        severity: "warning",
        state: "read",
        occurredAt: "2026-09-16T11:00:00.000Z",
      }),
      event({ id: "unread", severity: "warning", occurredAt: "2026-09-16T09:00:00.000Z" }),
    ] as never);

    expect(ordered.map((entry) => entry.id)).toEqual(["unread", "read"]);
  });

  it("is a total order, so two renders of one page never disagree", () => {
    const page = [event({ id: "x" }), event({ id: "y" }), event({ id: "z" })] as never;

    expect(prioritizeChangeEvents(page)).toEqual(prioritizeChangeEvents([...page].reverse()));
  });

  it("does not mutate the page it was given", () => {
    const page = [event({ id: "b", severity: "info" }), event({ id: "a", severity: "critical" })];
    prioritizeChangeEvents(page as never);
    expect(page.map((entry) => entry.id)).toEqual(["b", "a"]);
  });
});
