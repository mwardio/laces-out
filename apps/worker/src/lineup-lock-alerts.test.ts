import { describe, expect, it } from "vitest";

import {
  buildLineupLockPayload,
  describeLeadTime,
  describeRosterStaleness,
  DrizzleLineupLockRepository,
  earliestRelevantKickoff,
  evaluateLineupLockIssues,
  LineupLockAlertService,
  lineupLockWindow,
  normalizedPlayerStatus,
  type LineupLockCandidateRow,
  type LineupLockRepository,
  type LineupLockRosterEntryRow,
  type LineupLockScheduleGameRow,
  type LineupLockScheduleSourceRow,
  type LineupLockSlotRuleRow,
  type LineupLockSnapshotRow,
  type LineupLockStarter,
} from "./lineup-lock-alerts.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const LEAGUE_SEASON_ID = "30000000-0000-4000-8000-000000000001";
const TEAM_ID = "40000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "50000000-0000-4000-8000-000000000001";
const KICKOFF = new Date("2026-10-25T17:00:00.000Z");

function starter(overrides: Partial<LineupLockStarter> = {}): LineupLockStarter {
  return {
    playerName: "Ja'Marr Chase",
    primaryPosition: "WR",
    nflTeam: "CIN",
    status: "ACTIVE",
    slotCode: "WR",
    ...overrides,
  };
}

function game(overrides: Partial<LineupLockScheduleGameRow> = {}): LineupLockScheduleGameRow {
  return {
    externalGameId: "2026_08_CIN_BAL",
    season: 2026,
    week: 8,
    gameDate: "2026-10-25",
    startTimeEastern: "13:00",
    timeTbd: false,
    kickoffAt: KICKOFF,
    awayTeam: "CIN",
    homeTeam: "BAL",
    status: "scheduled",
    neutralSite: false,
    awayRestDays: 7,
    homeRestDays: 7,
    awayScore: null,
    homeScore: null,
    ...overrides,
  };
}

const STARTER_SLOTS: readonly LineupLockSlotRuleRow[] = [
  { slotCode: "QB", count: 1 },
  { slotCode: "WR", count: 2 },
  { slotCode: "TE", count: 1 },
];

function fullLineup(): readonly LineupLockStarter[] {
  return [
    starter({ playerName: "Joe Burrow", primaryPosition: "QB", slotCode: "QB" }),
    starter({ playerName: "Ja'Marr Chase", slotCode: "WR" }),
    starter({ playerName: "Tee Higgins", slotCode: "WR" }),
    starter({
      playerName: "Trey McBride",
      primaryPosition: "TE",
      nflTeam: "ARI",
      slotCode: "TE",
    }),
  ];
}

describe("stored-status normalization", () => {
  it("accepts only the shared vocabulary the rest of the app renders", () => {
    expect(normalizedPlayerStatus("out")).toBe("OUT");
    expect(normalizedPlayerStatus(" Doubtful ")).toBe("DOUBTFUL");
    expect(normalizedPlayerStatus("IR")).toBe("IR");
    // Provider spellings the app does not recognize are deliberately not translated here.
    expect(normalizedPlayerStatus("INJURY_RESERVE")).toBeNull();
    expect(normalizedPlayerStatus("O")).toBeNull();
    expect(normalizedPlayerStatus(null)).toBeNull();
  });
});

describe("alert condition detection", () => {
  it("produces no alert for a clean, complete lineup", () => {
    expect(
      evaluateLineupLockIssues({
        starters: fullLineup(),
        requiredStarterSlots: STARTER_SLOTS,
        byeTeams: new Set(["DAL"]),
      }),
    ).toEqual([]);
  });

  it("flags a starter ruled out, on IR, or doubtful", () => {
    const issues = evaluateLineupLockIssues({
      starters: [
        ...fullLineup().slice(0, 1),
        starter({ playerName: "Ja'Marr Chase", status: "OUT", slotCode: "WR" }),
        starter({ playerName: "Tee Higgins", status: "Doubtful", slotCode: "WR" }),
        starter({
          playerName: "Trey McBride",
          primaryPosition: "TE",
          nflTeam: "ARI",
          status: "ir",
          slotCode: "TE",
        }),
      ],
      requiredStarterSlots: STARTER_SLOTS,
      byeTeams: new Set(),
    });

    expect(issues).toEqual([
      { kind: "player-unavailable", playerName: "Ja'Marr Chase", status: "OUT" },
      { kind: "player-unavailable", playerName: "Tee Higgins", status: "DOUBTFUL" },
      { kind: "player-unavailable", playerName: "Trey McBride", status: "IR" },
    ]);
  });

  it("flags a starter on a proven bye and folds the nflverse Rams alias", () => {
    const issues = evaluateLineupLockIssues({
      starters: [
        ...fullLineup().slice(0, 3),
        starter({
          playerName: "Puka Nacua",
          primaryPosition: "WR",
          nflTeam: "LA",
          slotCode: "TE",
        }),
      ],
      requiredStarterSlots: STARTER_SLOTS,
      byeTeams: new Set(["LAR"]),
    });

    expect(issues).toEqual([{ kind: "player-bye", playerName: "Puka Nacua", position: "WR" }]);
  });

  it("never asserts a bye for a team the schedule does not affirm", () => {
    expect(
      evaluateLineupLockIssues({
        starters: fullLineup(),
        requiredStarterSlots: STARTER_SLOTS,
        // An empty affirmed-bye set is what unproven coverage produces.
        byeTeams: new Set(),
      }),
    ).toEqual([]);
  });

  it("names the empty starting slot when the per-slot arithmetic accounts for the shortfall", () => {
    expect(
      evaluateLineupLockIssues({
        starters: fullLineup().filter((entry) => entry.slotCode !== "TE"),
        requiredStarterSlots: STARTER_SLOTS,
        byeTeams: new Set(),
      }),
    ).toEqual([{ kind: "empty-slot", slotCode: "TE", count: 1 }]);
  });

  it("falls back to a bare count when stored slot codes do not match the rules", () => {
    expect(
      evaluateLineupLockIssues({
        starters: [
          starter({ playerName: "Joe Burrow", slotCode: "QB" }),
          starter({ playerName: "Ja'Marr Chase", slotCode: "FLEX" }),
        ],
        requiredStarterSlots: STARTER_SLOTS,
        byeTeams: new Set(),
      }),
    ).toEqual([{ kind: "empty-slot", slotCode: null, count: 2 }]);
  });

  it("claims no empty slot when the starter count meets the requirement", () => {
    expect(
      evaluateLineupLockIssues({
        starters: fullLineup(),
        requiredStarterSlots: STARTER_SLOTS,
        byeTeams: new Set(),
      }),
    ).toEqual([]);
  });
});

describe("send windows", () => {
  it("uses disjoint bands so a digest can never masquerade as the final warning", () => {
    const kickoff = new Date("2026-10-25T17:00:00.000Z");
    expect(lineupLockWindow(new Date("2026-10-23T17:00:00.000Z"), kickoff)).toBeNull();
    expect(lineupLockWindow(new Date("2026-10-24T17:00:00.000Z"), kickoff)).toBe("t-24h");
    expect(lineupLockWindow(new Date("2026-10-25T10:00:00.000Z"), kickoff)).toBe("t-24h");
    expect(lineupLockWindow(new Date("2026-10-25T15:00:00.000Z"), kickoff)).toBe("t-2h");
    expect(lineupLockWindow(new Date("2026-10-25T16:59:00.000Z"), kickoff)).toBe("t-2h");
    expect(lineupLockWindow(new Date("2026-10-25T17:00:00.000Z"), kickoff)).toBeNull();
    expect(lineupLockWindow(new Date("2026-10-25T18:00:00.000Z"), kickoff)).toBeNull();
  });
});

describe("kickoff anchor", () => {
  it("anchors on the earliest stored kickoff involving a team in the lineup", () => {
    const thursday = game({
      externalGameId: "2026_08_DAL_NYG",
      awayTeam: "DAL",
      homeTeam: "NYG",
      kickoffAt: new Date("2026-10-23T00:15:00.000Z"),
    });
    expect(earliestRelevantKickoff([thursday, game()], 8, fullLineup())).toEqual(KICKOFF);
  });

  it("falls back to the week's earliest kickoff when no starter team can be matched", () => {
    const early = game({
      externalGameId: "2026_08_DAL_NYG",
      awayTeam: "DAL",
      homeTeam: "NYG",
      kickoffAt: new Date("2026-10-23T00:15:00.000Z"),
    });
    expect(earliestRelevantKickoff([early, game()], 8, [])).toEqual(
      new Date("2026-10-23T00:15:00.000Z"),
    );
  });

  it("never anchors on a game with an unknown or TBD kickoff", () => {
    expect(earliestRelevantKickoff([game({ kickoffAt: null })], 8, fullLineup())).toBeUndefined();
    expect(earliestRelevantKickoff([game({ timeTbd: true })], 8, fullLineup())).toBeUndefined();
    expect(earliestRelevantKickoff([game()], 9, fullLineup())).toBeUndefined();
  });
});

describe("notification copy", () => {
  it("states the facts, the lead time, and the staleness of the roster it used", () => {
    const payload = buildLineupLockPayload(
      {
        leagueName: "Sunday Scaries",
        week: 8,
        issues: [
          { kind: "player-unavailable", playerName: "Ja'Marr Chase", status: "OUT" },
          { kind: "empty-slot", slotCode: "TE", count: 1 },
        ],
        millisecondsToKickoff: 2 * 60 * 60 * 1000,
        stalenessNote: "Roster synced 2d ago.",
      },
      LEAGUE_ID,
    );

    expect(payload.title).toBe("2 starters need attention");
    expect(payload.body).toBe(
      "Ja'Marr Chase is OUT, and your TE slot is empty. First kickoff in about 2 hours. " +
        "Roster synced 2d ago. (Sunday Scaries, Week 8)",
    );
    expect(payload.url).toBe("/decisions");
    expect(payload.tag).toBe(`lineup-lock:${LEAGUE_ID}:8`);
  });

  it("uses the singular headline for a single issue", () => {
    const payload = buildLineupLockPayload(
      {
        leagueName: "Sunday Scaries",
        week: 8,
        issues: [{ kind: "player-bye", playerName: "Puka Nacua", position: "WR" }],
        millisecondsToKickoff: 24 * 60 * 60 * 1000,
        stalenessNote: null,
      },
      LEAGUE_ID,
    );

    expect(payload.title).toBe("1 starter needs attention");
    expect(payload.body).toBe(
      "Puka Nacua is on bye. First kickoff in about 24 hours. (Sunday Scaries, Week 8)",
    );
  });

  it("describes lead times and roster staleness the way the rest of the app does", () => {
    expect(describeLeadTime(90 * 60 * 1000)).toBe("about 2 hours");
    expect(describeLeadTime(20 * 60 * 1000)).toBe("about 20 minutes");
    expect(describeLeadTime(24 * 60 * 60 * 1000)).toBe("about 24 hours");
    const now = new Date("2026-10-25T12:00:00.000Z");
    expect(describeRosterStaleness(new Date("2026-10-25T00:00:00.000Z"), now)).toBeNull();
    expect(describeRosterStaleness(new Date("2026-10-24T00:00:00.000Z"), now)).toBe(
      "Roster synced 36h ago.",
    );
    expect(describeRosterStaleness(new Date("2026-10-22T00:00:00.000Z"), now)).toBe(
      "Roster synced 3d ago.",
    );
  });
});

interface RepositoryOverrides {
  readonly candidates?: readonly LineupLockCandidateRow[];
  readonly entries?: readonly LineupLockRosterEntryRow[];
  readonly snapshot?: LineupLockSnapshotRow | undefined;
  readonly source?: LineupLockScheduleSourceRow | undefined;
  readonly games?: readonly LineupLockScheduleGameRow[];
}

function entry(overrides: Partial<LineupLockRosterEntryRow> = {}): LineupLockRosterEntryRow {
  return {
    playerId: "60000000-0000-4000-8000-000000000001",
    playerName: "Ja'Marr Chase",
    primaryPosition: "WR",
    nflTeam: "CIN",
    status: "ACTIVE",
    slotCode: "WR",
    isStarter: true,
    ...overrides,
  };
}

function repositoryWith(overrides: RepositoryOverrides = {}): LineupLockRepository {
  return {
    listCandidates: () =>
      Promise.resolve(
        overrides.candidates ?? [
          {
            userId: USER_ID,
            leagueId: LEAGUE_ID,
            leagueName: "Sunday Scaries",
            leagueSeasonId: LEAGUE_SEASON_ID,
            season: 2026,
            week: 8,
            lastSyncedAt: new Date("2026-10-25T12:00:00.000Z"),
            teamId: TEAM_ID,
          },
        ],
      ),
    findLatestRosterSnapshot: () =>
      Promise.resolve(
        "snapshot" in overrides
          ? overrides.snapshot
          : { id: SNAPSHOT_ID, effectiveAt: new Date("2026-10-25T12:00:00.000Z") },
      ),
    listRosterEntries: () =>
      Promise.resolve(
        overrides.entries ?? [
          entry({ playerName: "Joe Burrow", primaryPosition: "QB", slotCode: "QB" }),
          entry({ playerName: "Ja'Marr Chase", status: "OUT" }),
          entry({ playerName: "Tee Higgins" }),
          entry({
            playerName: "Trey McBride",
            primaryPosition: "TE",
            nflTeam: "ARI",
            slotCode: "TE",
          }),
        ],
      ),
    listStarterSlotRules: () => Promise.resolve(STARTER_SLOTS),
    findScheduleSource: () =>
      Promise.resolve(
        "source" in overrides
          ? overrides.source
          : {
              id: "70000000-0000-4000-8000-000000000001",
              lastChecksum: "c".repeat(64),
              lastSuccessfulAt: new Date("2026-10-20T00:00:00.000Z"),
              metadata: {
                publishable: true,
                coveredWeeks: "8",
                coveredTeams: "ARI,BAL,CIN,LA",
                rowsRejected: 0,
              },
            },
      ),
    listScheduleGames: () =>
      Promise.resolve(
        overrides.games ?? [
          game(),
          game({
            externalGameId: "2026_08_ARI_SEA",
            awayTeam: "ARI",
            homeTeam: "SEA",
            kickoffAt: new Date("2026-10-25T20:05:00.000Z"),
          }),
        ],
      ),
  };
}

describe("LineupLockAlertService", () => {
  it("builds one pending notification per live window with a stable idempotency key", async () => {
    const service = new LineupLockAlertService({
      repository: repositoryWith(),
      now: () => new Date("2026-10-25T15:30:00.000Z"),
    });

    const pending = await service.collect();

    expect(pending).toHaveLength(1);
    expect(pending[0]?.userId).toBe(USER_ID);
    expect(pending[0]?.kind).toBe("lineup-lock");
    expect(pending[0]?.idempotencyKey).toBe(`lineup-lock:${USER_ID}:${LEAGUE_ID}:2026:8:t-2h`);
    expect(pending[0]?.payload.title).toBe("1 starter needs attention");
    expect(pending[0]?.payload.body).toContain("Ja'Marr Chase is OUT");
  });

  it("uses the digest key a day out and the final-warning key two hours out", async () => {
    const digest = await new LineupLockAlertService({
      repository: repositoryWith(),
      now: () => new Date("2026-10-25T00:00:00.000Z"),
    }).collect();
    const final = await new LineupLockAlertService({
      repository: repositoryWith(),
      now: () => new Date("2026-10-25T16:00:00.000Z"),
    }).collect();

    expect(digest[0]?.idempotencyKey).toMatch(/:t-24h$/u);
    expect(final[0]?.idempotencyKey).toMatch(/:t-2h$/u);
  });

  it("stays silent outside both windows, after kickoff, and for a clean roster", async () => {
    const early = await new LineupLockAlertService({
      repository: repositoryWith(),
      now: () => new Date("2026-10-22T00:00:00.000Z"),
    }).collect();
    const late = await new LineupLockAlertService({
      repository: repositoryWith(),
      now: () => new Date("2026-10-25T17:30:00.000Z"),
    }).collect();
    const clean = await new LineupLockAlertService({
      repository: repositoryWith({
        entries: [
          entry({ playerName: "Joe Burrow", primaryPosition: "QB", slotCode: "QB" }),
          entry({ playerName: "Ja'Marr Chase" }),
          entry({ playerName: "Tee Higgins" }),
          entry({
            playerName: "Trey McBride",
            primaryPosition: "TE",
            nflTeam: "ARI",
            slotCode: "TE",
          }),
        ],
      }),
      now: () => new Date("2026-10-25T15:30:00.000Z"),
    }).collect();

    expect(early).toEqual([]);
    expect(late).toEqual([]);
    expect(clean).toEqual([]);
  });

  it("asserts a bye only inside affirmed coverage", async () => {
    const byeLineup: readonly LineupLockRosterEntryRow[] = [
      entry({ playerName: "Joe Burrow", primaryPosition: "QB", slotCode: "QB" }),
      entry({ playerName: "Ja'Marr Chase" }),
      entry({ playerName: "Tee Higgins" }),
      // Covered by the admitted schedule, and it has no week 8 game: a proven bye.
      entry({ playerName: "Puka Nacua", nflTeam: "LA", slotCode: "TE" }),
    ];
    const affirmed = await new LineupLockAlertService({
      repository: repositoryWith({ entries: byeLineup }),
      now: () => new Date("2026-10-25T15:30:00.000Z"),
    }).collect();
    const withheld = await new LineupLockAlertService({
      repository: repositoryWith({
        entries: byeLineup,
        source: {
          id: "70000000-0000-4000-8000-000000000001",
          lastChecksum: "c".repeat(64),
          lastSuccessfulAt: new Date("2026-10-20T00:00:00.000Z"),
          // The read rejected a row, so a missing game is no longer evidence of a bye.
          metadata: {
            publishable: true,
            coveredWeeks: "8",
            coveredTeams: "ARI,BAL,CIN,LA",
            rowsRejected: 3,
          },
        },
      }),
      now: () => new Date("2026-10-25T15:30:00.000Z"),
    }).collect();

    expect(affirmed[0]?.payload.body).toContain("Puka Nacua is on bye");
    expect(withheld).toEqual([]);
  });

  it("says nothing when the schedule source has not cleared admission", async () => {
    const pending = await new LineupLockAlertService({
      repository: repositoryWith({ source: undefined }),
      now: () => new Date("2026-10-25T15:30:00.000Z"),
    }).collect();

    // No admitted schedule means no trustworthy kickoff, so there is no honest lead time to state.
    expect(pending).toEqual([]);
  });

  it("says nothing when the claimed team has no stored roster snapshot", async () => {
    const pending = await new LineupLockAlertService({
      repository: repositoryWith({ snapshot: undefined }),
      now: () => new Date("2026-10-25T15:30:00.000Z"),
    }).collect();

    expect(pending).toEqual([]);
  });

  it("skips a league season with no current week", async () => {
    const pending = await new LineupLockAlertService({
      repository: repositoryWith({
        candidates: [
          {
            userId: USER_ID,
            leagueId: LEAGUE_ID,
            leagueName: "Sunday Scaries",
            leagueSeasonId: LEAGUE_SEASON_ID,
            season: 2026,
            week: null,
            lastSyncedAt: null,
            teamId: TEAM_ID,
          },
        ],
      }),
      now: () => new Date("2026-10-25T15:30:00.000Z"),
    }).collect();

    expect(pending).toEqual([]);
  });
});

describe("DrizzleLineupLockRepository", () => {
  it("is constructible against the shared database handle", () => {
    expect(new DrizzleLineupLockRepository({} as never)).toBeInstanceOf(
      DrizzleLineupLockRepository,
    );
  });
});
