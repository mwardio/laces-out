import { describe, expect, it, vi } from "vitest";

import {
  ChangeEventNotificationCollector,
  changeEventDigestKey,
  type ChangeEventNotificationRepository,
  type UndeliveredChangeEvent,
} from "./change-event-notifications.js";

const USER = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";
const EVENT = "50000000-0000-4000-8000-000000000001";
const SECOND_EVENT = "50000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-09-16T12:00:00.000Z");

const actionable: UndeliveredChangeEvent = {
  eventId: EVENT,
  userId: USER,
  eventType: "player.injury.changed",
  severity: "warning",
  headline: "A. Back is OUT",
  detail: null,
  occurredAt: new Date("2026-09-16T11:30:00.000Z"),
};

function repository(
  overrides: Partial<ChangeEventNotificationRepository> = {},
): ChangeEventNotificationRepository {
  return {
    listUndelivered: () => Promise.resolve([actionable]),
    listDeliveredWatermarks: () => Promise.resolve([]),
    markDelivered: () => Promise.resolve(0),
    ...overrides,
  };
}

describe("ChangeEventNotificationCollector", () => {
  it("builds one send-once digest per member, not one push per event", async () => {
    const collector = new ChangeEventNotificationCollector({
      repository: repository({
        listUndelivered: () =>
          Promise.resolve([
            actionable,
            {
              ...actionable,
              eventId: SECOND_EVENT,
              severity: "critical",
              headline: "Your recommendations changed",
              occurredAt: new Date("2026-09-16T11:45:00.000Z"),
            },
          ]),
      }),
      now: () => NOW,
    });

    const pending = await collector.collect();

    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual({
      userId: USER,
      kind: "change-event",
      // The watermark is the newest event, so the next sweep can reconcile the whole batch.
      idempotencyKey: changeEventDigestKey(USER, SECOND_EVENT),
      payload: {
        title: "2 updates need your attention",
        // Critical is ordered ahead of warning inside the digest.
        body: "Your recommendations changed · A. Back is OUT",
        url: "/app",
        tag: `change-event:${USER}`,
      },
    });
    expect(pending[0]!.idempotencyKey.length).toBeLessThanOrEqual(200);
  });

  it("uses the single headline as the title when only one update is pending", async () => {
    const collector = new ChangeEventNotificationCollector({
      repository: repository(),
      now: () => NOW,
    });

    const pending = await collector.collect();
    expect(pending[0]!.payload.title).toBe("A. Back is OUT");
  });

  it("never notifies for an informational change", async () => {
    const collector = new ChangeEventNotificationCollector({
      repository: repository({ listUndelivered: () => Promise.resolve([]) }),
      now: () => NOW,
    });

    expect(await collector.collect()).toEqual([]);
  });

  it("reconciles an already-claimed digest instead of repeating it", async () => {
    const markDelivered = vi.fn(() => Promise.resolve(1));
    const collector = new ChangeEventNotificationCollector({
      repository: repository({
        markDelivered,
        listDeliveredWatermarks: () =>
          Promise.resolve([{ userId: USER, watermark: new Date("2026-09-16T11:30:00.000Z") }]),
      }),
      now: () => NOW,
    });

    expect(await collector.collect()).toEqual([]);
    expect(markDelivered).toHaveBeenCalledWith([{ eventId: EVENT, userId: USER }], NOW);
  });

  it("does not drag a previously sent batch into a digest for a newer event", async () => {
    const markDelivered = vi.fn(() => Promise.resolve(1));
    const collector = new ChangeEventNotificationCollector({
      repository: repository({
        markDelivered,
        listUndelivered: () =>
          Promise.resolve([
            actionable,
            {
              ...actionable,
              eventId: SECOND_EVENT,
              headline: "C. Wide is OUT",
              occurredAt: new Date("2026-09-16T11:50:00.000Z"),
            },
          ]),
        listDeliveredWatermarks: () =>
          Promise.resolve([{ userId: USER, watermark: new Date("2026-09-16T11:30:00.000Z") }]),
      }),
      now: () => NOW,
    });

    const pending = await collector.collect();

    expect(pending).toHaveLength(1);
    expect(pending[0]!.payload.title).toBe("C. Wide is OUT");
    expect(pending[0]!.payload.body).toBe("C. Wide is OUT");
    expect(markDelivered).toHaveBeenCalledWith([{ eventId: EVENT, userId: USER }], NOW);
  });

  it("keeps one member's digest out of another member's", async () => {
    const collector = new ChangeEventNotificationCollector({
      repository: repository({
        listUndelivered: () =>
          Promise.resolve([
            actionable,
            { ...actionable, eventId: SECOND_EVENT, userId: OTHER, headline: "D. End is OUT" },
          ]),
      }),
      now: () => NOW,
    });

    const pending = await collector.collect();

    expect(pending).toHaveLength(2);
    expect(pending.map((entry) => entry.userId)).toEqual([USER, OTHER]);
    expect(pending[0]!.payload.body).toBe("A. Back is OUT");
    expect(pending[1]!.payload.body).toBe("D. End is OUT");
  });
});
