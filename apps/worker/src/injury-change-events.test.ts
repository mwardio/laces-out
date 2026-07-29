import { describe, expect, it } from "vitest";

import { buildInjuryChangeDrafts } from "./injury-change-events.js";

const PLAYER = "40000000-0000-4000-8000-00000000000a";
const OWNER = "10000000-0000-4000-8000-000000000001";
const LEAGUE = "20000000-0000-4000-8000-000000000001";
const HEALTHY = "a".repeat(64);
const QUESTIONABLE = "b".repeat(64);

const rostering = [{ userId: OWNER, leagueId: LEAGUE, teamName: "Gridiron Ghosts" }];

describe("buildInjuryChangeDrafts", () => {
  it("emits a private warning when a rostered player turns OUT", () => {
    const drafts = buildInjuryChangeDrafts({
      observations: [
        {
          playerId: PLAYER,
          playerName: "A. Back",
          season: 2026,
          week: 4,
          stateKey: QUESTIONABLE,
          reportStatus: "out",
          practiceStatus: "did-not-participate",
          fetchedAt: new Date("2026-09-16T12:00:00.000Z"),
        },
      ],
      priorStateKeyByPlayerWeek: new Map([[`${PLAYER}:2026:4`, HEALTHY]]),
      rosteringByPlayer: new Map([[PLAYER, rostering]]),
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      source: "injury-report",
      eventType: "player.injury.changed",
      aggregateType: "player",
      aggregateId: PLAYER,
      leagueId: LEAGUE,
      actorUserId: null,
      visibility: "private",
      severity: "warning",
      recipientUserIds: [OWNER],
    });
    expect(drafts[0]!.occurredAt).toEqual(new Date("2026-09-16T12:00:00.000Z"));
  });

  it("uses the action severity for a softer designation", () => {
    const drafts = buildInjuryChangeDrafts({
      observations: [
        {
          playerId: PLAYER,
          playerName: "A. Back",
          season: 2026,
          week: 4,
          stateKey: QUESTIONABLE,
          reportStatus: "questionable",
          practiceStatus: "limited",
          fetchedAt: new Date("2026-09-16T12:00:00.000Z"),
        },
      ],
      priorStateKeyByPlayerWeek: new Map([[`${PLAYER}:2026:4`, HEALTHY]]),
      rosteringByPlayer: new Map([[PLAYER, rostering]]),
    });

    expect(drafts[0]).toMatchObject({ severity: "action" });
  });

  it("emits nothing when the observed state key is unchanged", () => {
    expect(
      buildInjuryChangeDrafts({
        observations: [
          {
            playerId: PLAYER,
            playerName: "A. Back",
            season: 2026,
            week: 4,
            stateKey: HEALTHY,
            reportStatus: "questionable",
            practiceStatus: "limited",
            fetchedAt: new Date("2026-09-16T12:00:00.000Z"),
          },
        ],
        priorStateKeyByPlayerWeek: new Map([[`${PLAYER}:2026:4`, HEALTHY]]),
        rosteringByPlayer: new Map([[PLAYER, rostering]]),
      }),
    ).toEqual([]);
  });

  it("emits nothing for an unrostered player or an unresolved identity", () => {
    const base = {
      playerName: "A. Back",
      season: 2026,
      week: 4,
      stateKey: QUESTIONABLE,
      reportStatus: "out" as const,
      practiceStatus: null,
      fetchedAt: new Date("2026-09-16T12:00:00.000Z"),
    };

    expect(
      buildInjuryChangeDrafts({
        observations: [{ ...base, playerId: PLAYER }],
        priorStateKeyByPlayerWeek: new Map(),
        rosteringByPlayer: new Map(),
      }),
    ).toEqual([]);
    // An unresolved identity must never be guessed here.
    expect(
      buildInjuryChangeDrafts({
        observations: [{ ...base, playerId: null }],
        priorStateKeyByPlayerWeek: new Map(),
        rosteringByPlayer: new Map([[PLAYER, rostering]]),
      }),
    ).toEqual([]);
  });

  it("emits one draft per rostering member, never a shared league event", () => {
    const drafts = buildInjuryChangeDrafts({
      observations: [
        {
          playerId: PLAYER,
          playerName: "A. Back",
          season: 2026,
          week: 4,
          stateKey: QUESTIONABLE,
          reportStatus: "out",
          practiceStatus: null,
          fetchedAt: new Date("2026-09-16T12:00:00.000Z"),
        },
      ],
      priorStateKeyByPlayerWeek: new Map(),
      rosteringByPlayer: new Map([
        [
          PLAYER,
          [
            { userId: OWNER, leagueId: LEAGUE, teamName: "Gridiron Ghosts" },
            {
              userId: "10000000-0000-4000-8000-000000000002",
              leagueId: "20000000-0000-4000-8000-000000000002",
              teamName: "Other Team",
            },
          ],
        ],
      ]),
    });

    expect(drafts).toHaveLength(2);
    expect(new Set(drafts.map((draft) => draft.deduplicationKey)).size).toBe(2);
    expect(drafts.every((draft) => draft.visibility === "private")).toBe(true);
    expect(drafts.map((draft) => draft.recipientUserIds)).toEqual([
      [OWNER],
      ["10000000-0000-4000-8000-000000000002"],
    ]);
  });
});
