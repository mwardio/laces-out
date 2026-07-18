import { inSeasonDecisionSnapshotSchema } from "@fantasy/contracts";
import { describe, expect, it } from "vitest";

import {
  InSeasonDecisionService,
  type DecisionMembershipRow,
  type DecisionMarketSignalRow,
  type DecisionProjectionPlayerRow,
  type DecisionProjectionSetRow,
  type DecisionRosterEntryRow,
  type DecisionRosterSnapshotRow,
  type DecisionSeasonRow,
  type DecisionSlotRuleRow,
  type DecisionTeamRow,
  type InSeasonDecisionRepository,
} from "./in-season-decisions.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "10000000-0000-4000-8000-000000000002";
const LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const SEASON_ID = "30000000-0000-4000-8000-000000000001";
const TEAM_A_ID = "40000000-0000-4000-8000-000000000001";
const TEAM_B_ID = "40000000-0000-4000-8000-000000000002";
const SNAPSHOT_A_ID = "50000000-0000-4000-8000-000000000001";
const SNAPSHOT_B_ID = "50000000-0000-4000-8000-000000000002";
const PROJECTION_SET_ID = "60000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-15T12:00:00.000Z");

const playerIds = {
  aQbLow: "70000000-0000-4000-8000-000000000001",
  aRbOne: "70000000-0000-4000-8000-000000000002",
  aRbTwo: "70000000-0000-4000-8000-000000000003",
  bQbOne: "70000000-0000-4000-8000-000000000004",
  bQbTwo: "70000000-0000-4000-8000-000000000005",
  bRbLow: "70000000-0000-4000-8000-000000000006",
  freeQb: "70000000-0000-4000-8000-000000000007",
} as const;

const membership: DecisionMembershipRow = {
  leagueId: LEAGUE_ID,
  leagueName: "Fourth and Long",
  role: "manager",
  claimedFantasyTeamId: TEAM_A_ID,
};

const season: DecisionSeasonRow = {
  id: SEASON_ID,
  provider: "espn",
  externalKey: "24681012",
  season: 2026,
  currentWeek: 2,
  waiverType: "FAAB",
  lastSyncedAt: new Date("2026-09-15T11:30:00.000Z"),
};

const teams: readonly DecisionTeamRow[] = [
  { id: TEAM_A_ID, name: "The Snowflakes", faabRemaining: 82 },
  { id: TEAM_B_ID, name: "The Isotoners", faabRemaining: 64 },
];

const slotRules: readonly DecisionSlotRuleRow[] = [
  {
    id: "80000000-0000-4000-8000-000000000001",
    slotCode: "QB",
    count: 1,
    eligiblePositions: ["QB"],
    isStarter: true,
  },
  {
    id: "80000000-0000-4000-8000-000000000002",
    slotCode: "RB",
    count: 1,
    eligiblePositions: ["RB"],
    isStarter: true,
  },
  {
    id: "80000000-0000-4000-8000-000000000003",
    slotCode: "BN",
    count: 1,
    eligiblePositions: ["QB", "RB", "WR", "TE", "K", "DST"],
    isStarter: false,
  },
];

const snapshots: readonly DecisionRosterSnapshotRow[] = [
  { id: SNAPSHOT_A_ID, teamId: TEAM_A_ID, effectiveAt: NOW },
  { id: SNAPSHOT_B_ID, teamId: TEAM_B_ID, effectiveAt: NOW },
];

function rosterEntry(
  snapshotId: string,
  playerId: string,
  name: string,
  position: "QB" | "RB",
  slotCode: string,
  isStarter: boolean,
): DecisionRosterEntryRow {
  return {
    snapshotId,
    playerId,
    name,
    primaryPosition: position,
    eligiblePositions: [position],
    nflTeam: "MIA",
    status: "ACTIVE",
    slotCode,
    isStarter,
    locked: false,
  };
}

const rosterRows: readonly DecisionRosterEntryRow[] = [
  rosterEntry(SNAPSHOT_A_ID, playerIds.aQbLow, "Low Arm", "QB", "QB", true),
  rosterEntry(SNAPSHOT_A_ID, playerIds.aRbOne, "Lead Back", "RB", "RB", true),
  rosterEntry(SNAPSHOT_A_ID, playerIds.aRbTwo, "Spare Back", "RB", "BN", false),
  rosterEntry(SNAPSHOT_B_ID, playerIds.bQbOne, "Lead Arm", "QB", "QB", true),
  rosterEntry(SNAPSHOT_B_ID, playerIds.bQbTwo, "Spare Arm", "QB", "BN", false),
  rosterEntry(SNAPSHOT_B_ID, playerIds.bRbLow, "Low Back", "RB", "RB", true),
];

const projectionSet: DecisionProjectionSetRow = {
  id: PROJECTION_SET_ID,
  source: "trusted-weekly-model",
  version: "2026-w02-v1",
  season: 2026,
  week: 2,
  horizon: "Week 2",
  fetchedAt: new Date("2026-09-15T10:00:00.000Z"),
  createdAt: new Date("2026-09-15T11:00:00.000Z"),
  metadata: { model: "weekly-v1" },
};

const projectionNames: Readonly<Record<string, readonly [string, "QB" | "RB", number]>> = {
  [playerIds.aQbLow]: ["Low Arm", "QB", 10],
  [playerIds.aRbOne]: ["Lead Back", "RB", 20],
  [playerIds.aRbTwo]: ["Spare Back", "RB", 25],
  [playerIds.bQbOne]: ["Lead Arm", "QB", 25],
  [playerIds.bQbTwo]: ["Spare Arm", "QB", 20],
  [playerIds.bRbLow]: ["Low Back", "RB", 10],
  [playerIds.freeQb]: ["Free Arm", "QB", 30],
};

const projectionRows: readonly DecisionProjectionPlayerRow[] = Object.entries(projectionNames).map(
  ([id, [name, position, mean]]) => ({
    playerId: id,
    name,
    primaryPosition: position,
    eligiblePositions: [position],
    nflTeam: "MIA",
    status: "ACTIVE",
    meanPoints: String(mean),
    floorPoints: String(mean - 3),
    ceilingPoints: String(mean + 4),
  }),
);

class FakeRepository implements InSeasonDecisionRepository {
  membership: DecisionMembershipRow | undefined = membership;
  season: DecisionSeasonRow | undefined = season;
  projectionSets: readonly DecisionProjectionSetRow[] = [projectionSet];
  projectionRows: readonly DecisionProjectionPlayerRow[] = projectionRows;
  marketRows: readonly DecisionMarketSignalRow[] = [
    {
      playerId: playerIds.freeQb,
      signal: "add",
      count: 45,
      rank: 1,
      lookbackHours: 24,
      observedAt: new Date("2026-09-15T11:00:00.000Z"),
    },
  ];
  rosterRows: readonly DecisionRosterEntryRow[] = rosterRows;
  projectionSetQuery:
    | readonly [
        actorUserId: string,
        leagueSeasonId: string,
        season: number,
        week: number | null,
        limit: number,
      ]
    | undefined;

  findMembership(userId: string, leagueId: string) {
    return Promise.resolve(
      userId === USER_ID && leagueId === LEAGUE_ID ? this.membership : undefined,
    );
  }
  findLatestSeason() {
    return Promise.resolve(this.season);
  }
  listTeams(_seasonId: string, limit: number) {
    return Promise.resolve(teams.slice(0, limit));
  }
  listSlotRules(_seasonId: string, limit: number) {
    return Promise.resolve(slotRules.slice(0, limit));
  }
  listLatestRosterSnapshots(_seasonId: string, limit: number) {
    return Promise.resolve(snapshots.slice(0, limit));
  }
  listRosterEntries(snapshotIds: readonly string[], limit: number) {
    return Promise.resolve(
      this.rosterRows.filter((row) => snapshotIds.includes(row.snapshotId)).slice(0, limit),
    );
  }
  findProjectionSets(
    actorUserId: string,
    leagueSeasonId: string,
    seasonToFind: number,
    week: number | null,
    limit: number,
  ) {
    this.projectionSetQuery = [actorUserId, leagueSeasonId, seasonToFind, week, limit];
    return Promise.resolve(this.projectionSets);
  }
  countProjectionPlayers() {
    return Promise.resolve(this.projectionRows.length);
  }
  listTopProjectionPlayers(_setId: string, limit: number) {
    return Promise.resolve(
      [...this.projectionRows]
        .sort((left, right) => Number(right.meanPoints) - Number(left.meanPoints))
        .slice(0, limit),
    );
  }
  listProjectionPlayersByIds(_setId: string, ids: readonly string[]) {
    return Promise.resolve(this.projectionRows.filter((row) => ids.includes(row.playerId)));
  }
  listLatestMarketSignals(ids: readonly string[], limit: number) {
    return Promise.resolve(
      this.marketRows.filter((row) => row.playerId && ids.includes(row.playerId)).slice(0, limit),
    );
  }
}

describe("InSeasonDecisionService", () => {
  it("isolates league reads to an authenticated membership", async () => {
    const service = new InSeasonDecisionService(new FakeRepository(), () => NOW);
    await expect(service.getSnapshot(OTHER_USER_ID, LEAGUE_ID)).resolves.toBeUndefined();
  });

  it("runs deterministic lineup, waiver, and trade engines on persisted facts", async () => {
    const repository = new FakeRepository();
    const service = new InSeasonDecisionService(repository, () => NOW);
    const snapshot = await service.getSnapshot(USER_ID, LEAGUE_ID);
    expect(snapshot).toBeDefined();
    expect(() => inSeasonDecisionSnapshotSchema.parse(snapshot)).not.toThrow();
    expect(snapshot?.provenance.projectionSet).toMatchObject({
      source: "trusted-weekly-model",
      version: "2026-w02-v1",
      sourceObservedAt: "2026-09-15T10:00:00.000Z",
      sourceObservedAtStatus: "verified",
      importedAt: "2026-09-15T11:00:00.000Z",
    });
    expect(repository.projectionSetQuery).toEqual([USER_ID, SEASON_ID, 2026, 2, 12]);
    expect(snapshot?.coverage).toMatchObject({
      leagueTeams: 2,
      teamsWithRosters: 2,
      claimedRosterPlayers: 3,
      claimedRosterProjected: 3,
    });
    expect(snapshot?.providerVerification).toMatchObject({
      lockCoverage: "unavailable",
      storedTrueLocksHonored: true,
      storedFalseMeansUnlocked: false,
      storedLockedPlayerCount: 0,
    });
    expect(snapshot?.providerVerification.actionWarning).toContain("cannot execute");

    expect(snapshot?.lineup.state).toBe("available");
    if (snapshot?.lineup.state === "available") {
      expect(snapshot.lineup.currentProjectedPoints).toBe(30);
      expect(snapshot.lineup.optimalProjectedPoints).toBe(35);
      expect(snapshot.lineup.changes.some((change) => change.add?.name === "Spare Back")).toBe(
        true,
      );
      expect(snapshot.lineup.execution).toEqual({
        mode: "provider-required",
        provider: "espn",
        label: "Open ESPN to verify and apply manually",
        url: "https://fantasy.espn.com/football/league?leagueId=24681012",
      });
      expect(snapshot.lineup.notes.join(" ")).toContain("does not verify");
    }

    expect(snapshot?.waivers.state).toBe("available");
    if (snapshot?.waivers.state === "available") {
      expect(snapshot.waivers.recommendations[0]).toMatchObject({
        add: { name: "Free Arm" },
        drop: { name: "Low Arm" },
      });
      expect(snapshot.waivers.recommendations[0]?.faab?.recommended).toBeGreaterThan(0);
      expect(snapshot.waivers.recommendations[0]?.market).toMatchObject({
        addCount: 45,
        dropCount: 0,
        lookbackHours: 24,
      });
      expect(snapshot.waivers.notes.join(" ")).toContain("Sleeper add/drop momentum");
      expect(snapshot.waivers.evaluatedMoveCount).toBeLessThanOrEqual(24 * 3);
    }

    expect(snapshot?.trades.state).toBe("available");
    if (snapshot?.trades.state === "available") {
      expect(snapshot.trades.evaluatedPackageCount).toBeLessThanOrEqual(320);
      expect(
        snapshot.trades.fairest.some(
          (trade) => trade.userGain > 0 && trade.partnerGain > 0 && trade.mutuallyBeneficial,
        ),
      ).toBe(true);
      expect(snapshot.trades.notes.join(" ")).toContain("member account data is never included");
    }
  });

  it("returns structured unavailability instead of using roster facts as projections", async () => {
    const repository = new FakeRepository();
    repository.projectionSets = [];
    const service = new InSeasonDecisionService(repository, () => NOW);
    const snapshot = await service.getSnapshot(USER_ID, LEAGUE_ID);
    expect(snapshot?.provenance.projectionSet).toBeNull();
    expect(snapshot?.lineup).toMatchObject({
      state: "unavailable",
      reasons: [{ code: "PROJECTIONS_MISSING" }],
    });
    expect(snapshot?.waivers.state).toBe("unavailable");
    expect(snapshot?.trades.state).toBe("unavailable");
  });

  it("does not use stale global waiver momentum for bid competition", async () => {
    const repository = new FakeRepository();
    repository.marketRows = repository.marketRows.map((row) => ({
      ...row,
      observedAt: new Date("2026-09-14T00:00:00.000Z"),
    }));
    const snapshot = await new InSeasonDecisionService(repository, () => NOW).getSnapshot(
      USER_ID,
      LEAGUE_ID,
    );

    if (snapshot?.waivers.state !== "available") throw new Error("Waivers should be available");
    expect(snapshot.waivers.recommendations[0]?.market).toBeNull();
    expect(snapshot.waivers.notes.join(" ")).toContain("No current cross-platform waiver momentum");
  });

  it("never reports legacy user CSV import time as projection freshness", async () => {
    const repository = new FakeRepository();
    repository.projectionSets = [{ ...projectionSet, source: "user-csv", metadata: {} }];
    const snapshot = await new InSeasonDecisionService(repository, () => NOW).getSnapshot(
      USER_ID,
      LEAGUE_ID,
    );

    expect(snapshot?.provenance.projectionSet).toMatchObject({
      sourceObservedAt: null,
      sourceObservedAtStatus: "unverified",
      importedAt: "2026-09-15T11:00:00.000Z",
    });
    expect(snapshot?.provenance.projectionFreshness).toEqual({
      state: "missing",
      observedAt: null,
      label: "Projection source time missing / unverified",
    });
  });

  it("blocks all engines when claimed-roster projection coverage is partial", async () => {
    const repository = new FakeRepository();
    repository.projectionRows = projectionRows.filter((row) => row.playerId !== playerIds.aQbLow);
    const service = new InSeasonDecisionService(repository, () => NOW);
    const snapshot = await service.getSnapshot(USER_ID, LEAGUE_ID);
    expect(snapshot?.coverage).toMatchObject({
      claimedRosterPlayers: 3,
      claimedRosterProjected: 2,
      claimedRosterProjectionRatio: 0.667,
    });
    expect(snapshot?.lineup).toMatchObject({
      state: "unavailable",
      reasons: [{ code: "PROJECTION_COVERAGE_INCOMPLETE" }],
    });
  });

  it("requires a team claim before loading shared roster and projection inputs", async () => {
    const repository = new FakeRepository();
    repository.membership = { ...membership, claimedFantasyTeamId: null };
    const service = new InSeasonDecisionService(repository, () => NOW);
    const snapshot = await service.getSnapshot(USER_ID, LEAGUE_ID);
    expect(snapshot?.team).toBeNull();
    expect(snapshot?.lineup).toMatchObject({
      state: "unavailable",
      reasons: [{ code: "TEAM_UNCLAIMED" }],
    });
  });

  it("honors stored true locks while declaring complete provider lock coverage unavailable", async () => {
    const repository = new FakeRepository();
    repository.rosterRows = rosterRows.map((row) =>
      row.playerId === playerIds.aQbLow ? { ...row, locked: true } : row,
    );
    const snapshot = await new InSeasonDecisionService(repository, () => NOW).getSnapshot(
      USER_ID,
      LEAGUE_ID,
    );

    expect(snapshot?.providerVerification).toMatchObject({
      lockCoverage: "unavailable",
      storedLockedPlayerCount: 1,
      storedTrueLocksHonored: true,
      storedFalseMeansUnlocked: false,
    });
    if (snapshot?.lineup.state === "available") {
      expect(
        snapshot.lineup.assignments.find((assignment) => assignment.player.id === playerIds.aQbLow),
      ).toMatchObject({ locked: true });
      expect(snapshot.lineup.notes.join(" ")).toContain("complete provider lock coverage");
    }
  });

  it("builds Yahoo deep links from numeric and alphabetic game prefixes", async () => {
    const repository = new FakeRepository();
    repository.season = { ...season, provider: "yahoo", externalKey: "449.l.123" };
    const numeric = await new InSeasonDecisionService(repository, () => NOW).getSnapshot(
      USER_ID,
      LEAGUE_ID,
    );
    expect(numeric?.lineup).toMatchObject({
      state: "available",
      execution: { url: "https://football.fantasysports.yahoo.com/f1/123" },
    });

    repository.season = { ...season, provider: "yahoo", externalKey: "nfl.l.456" };
    const alphabetic = await new InSeasonDecisionService(repository, () => NOW).getSnapshot(
      USER_ID,
      LEAGUE_ID,
    );
    expect(alphabetic?.lineup).toMatchObject({
      state: "available",
      execution: { url: "https://football.fantasysports.yahoo.com/f1/456" },
    });
  });
});
