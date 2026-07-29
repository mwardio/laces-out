import { describe, expect, it } from "vitest";

import {
  CHANGE_EVENT_KINDS,
  CHANGE_EVENT_PAYLOAD_VERSION,
  CHANGE_EVENT_SEVERITIES,
  CHANGE_EVENT_SOURCES,
  CHANGE_EVENT_VISIBILITIES,
  changeEventFeedResponseSchema,
  changeEventReceiptResponseSchema,
  decodeChangeEventCursor,
  encodeChangeEventCursor,
  parseChangeEventPayload,
} from "./change-events.js";

const EVENT_ID = "50000000-0000-4000-8000-000000000001";
const TEAM_ID = "30000000-0000-4000-8000-000000000001";
const PLAYER_ID = "40000000-0000-4000-8000-000000000001";

const sampleEvent = {
  id: EVENT_ID,
  eventType: "roster.changed" as const,
  severity: "info" as const,
  visibility: "league" as const,
  leagueId: "20000000-0000-4000-8000-000000000001",
  occurredAt: "2026-09-16T12:00:00.000Z",
  headline: "Gridiron Ghosts changed 1 roster spot",
  detail: "Added A. Back.",
  url: "/app",
  state: "unread" as const,
  payload: {
    v: CHANGE_EVENT_PAYLOAD_VERSION,
    teamId: TEAM_ID,
    teamName: "Gridiron Ghosts",
    season: 2026,
    week: 4,
    added: [{ playerId: PLAYER_ID, name: "A. Back" }],
    removed: [],
    promoted: [],
    benched: [],
    moreCount: 0,
  },
};

describe("change event registry", () => {
  it("parses a registered payload at the current version", () => {
    const parsed = parseChangeEventPayload("roster.changed", sampleEvent.payload);

    expect(parsed.state).toBe("parsed");
    if (parsed.state !== "parsed") throw new Error("Expected a parsed payload");
    if (parsed.eventType !== "roster.changed") throw new Error("Expected a roster payload");
    expect(parsed.payload.added).toHaveLength(1);
  });

  it("degrades an unknown kind and an unsupported version instead of throwing", () => {
    expect(parseChangeEventPayload("roster.changed", { v: 99 })).toEqual({
      state: "unsupported-version",
      version: 99,
    });
    expect(parseChangeEventPayload("not.a.kind", { v: 1 })).toEqual({ state: "unknown-kind" });
    expect(parseChangeEventPayload("roster.changed", { v: 1 })).toMatchObject({
      state: "malformed",
    });
    expect(parseChangeEventPayload("roster.changed", null)).toMatchObject({ state: "malformed" });
  });

  it("registers every kind, source, visibility, and severity this package emits", () => {
    expect([...CHANGE_EVENT_KINDS]).toEqual([
      "league.sync.completed",
      "roster.changed",
      "player.injury.changed",
      "recommendation.changed",
    ]);
    expect([...CHANGE_EVENT_SOURCES]).toEqual([
      "league-sync",
      "roster-diff",
      "injury-report",
      "decision-delta",
    ]);
    // Copied verbatim from `change_events_visibility_check` and `change_events_severity_check`.
    expect([...CHANGE_EVENT_VISIBILITIES]).toEqual(["private", "league", "global"]);
    expect([...CHANGE_EVENT_SEVERITIES]).toEqual(["info", "action", "warning", "critical"]);
  });

  it("bounds the feed response", () => {
    const page = {
      generatedAt: "2026-09-16T12:00:00.000Z",
      unreadCount: 1,
      nextCursor: null,
      events: [sampleEvent],
    };
    expect(changeEventFeedResponseSchema.safeParse(page).success).toBe(true);

    const oversized = { ...page, events: Array.from({ length: 51 }, () => sampleEvent) };
    expect(changeEventFeedResponseSchema.safeParse(oversized).success).toBe(false);
  });

  it("bounds the receipt response", () => {
    expect(
      changeEventReceiptResponseSchema.safeParse({
        eventId: EVENT_ID,
        state: "read",
        at: "2026-09-16T12:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      changeEventReceiptResponseSchema.safeParse({ eventId: EVENT_ID, state: "nope", at: null })
        .success,
    ).toBe(false);
  });

  it("round-trips an opaque cursor and rejects a forged one", () => {
    const cursor = encodeChangeEventCursor("2026-09-16T12:00:00.000Z", EVENT_ID);
    expect(decodeChangeEventCursor(cursor)).toEqual({
      occurredAt: "2026-09-16T12:00:00.000Z",
      id: EVENT_ID,
    });
    expect(decodeChangeEventCursor("not-a-cursor")).toBeNull();
    expect(decodeChangeEventCursor(encodeChangeEventCursor("nope", EVENT_ID))).toBeNull();
    // A forged cursor must never reach SQL, whatever it is smuggling.
    expect(decodeChangeEventCursor("../../etc/passwd")).toBeNull();
    expect(
      decodeChangeEventCursor(encodeChangeEventCursor("2026-09-16T12:00:00.000Z", "'; drop --")),
    ).toBeNull();
  });

  it("parses every registered payload kind", () => {
    expect(
      parseChangeEventPayload("league.sync.completed", {
        v: 1,
        provider: "espn",
        season: 2026,
        week: 4,
        teamCount: 12,
      }).state,
    ).toBe("parsed");
    expect(
      parseChangeEventPayload("player.injury.changed", {
        v: 1,
        playerId: PLAYER_ID,
        playerName: "A. Back",
        teamName: "Gridiron Ghosts",
        season: 2026,
        week: 4,
        reportStatus: "out",
        practiceStatus: null,
      }).state,
    ).toBe("parsed");
    expect(
      parseChangeEventPayload("recommendation.changed", {
        v: 1,
        leagueSeasonId: "60000000-0000-4000-8000-000000000001",
        fantasyTeamId: TEAM_ID,
        teamName: "Gridiron Ghosts",
        week: 4,
        kinds: ["lineup"],
        fingerprint: "a".repeat(64),
        algorithmVersion: "in-season-decisions-v1",
        inputChecksum: "b".repeat(64),
      }).state,
    ).toBe("parsed");
  });
});
