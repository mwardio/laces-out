import { createHash } from "node:crypto";

import {
  inSeasonDecisionSnapshotSchema,
  tradeEvaluationResponseSchema,
} from "@laces-out/contracts";
import {
  playerId,
  rosterSlotId,
  type Player,
  type ProjectionValue,
  type RosterSlot,
} from "@laces-out/domain";
import { projectionScoringProfileKey } from "@laces-out/projections";
import { describe, expect, it, vi } from "vitest";

import {
  InSeasonDecisionService,
  RECOMMENDATION_ALGORITHM_VERSION,
  decisionSnapshotInputChecksum,
  evaluateTradePackage,
  recommendationInputChecksum,
  resolveTradeHorizons,
  type DecisionAvailabilitySnapshotRow,
  type DecisionEspnPlayerIdentityRow,
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
  type ManagedProjectionProfile,
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
const ROS_SET_ID = "60000000-0000-4000-8000-000000000002";
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
  role: "member",
  claimedFantasyTeamId: TEAM_A_ID,
};

const season: DecisionSeasonRow = {
  id: SEASON_ID,
  provider: "espn",
  externalKey: "24681012",
  season: 2026,
  currentWeek: 2,
  waiverType: "FAAB",
  settings: { scoringFormat: "ppr", receptionPoints: 1 },
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
  windowStartWeek: 2,
  windowEndWeek: 2,
  asOfWeek: 1,
  asOfAt: new Date("2026-09-15T09:00:00.000Z"),
  fetchedAt: new Date("2026-09-15T10:00:00.000Z"),
  createdAt: new Date("2026-09-15T11:00:00.000Z"),
  metadata: { model: "weekly-v1" },
};

const rosScoringProfileKey = projectionScoringProfileKey({
  id: "fixture-scoring",
  rules: [
    { statId: "passing_yards", points: 0.04 },
    { statId: "rushing_yards", points: 0.1 },
  ],
});

const rosProjectionSet: DecisionProjectionSetRow = {
  id: ROS_SET_ID,
  source: "laces-out-first-party-ros",
  version: "2026-w02-ros-v1",
  season: 2026,
  week: null,
  horizon: "rest-of-season",
  windowStartWeek: 2,
  windowEndWeek: 18,
  asOfWeek: 1,
  asOfAt: new Date("2026-09-15T09:30:00.000Z"),
  fetchedAt: new Date("2026-09-15T10:30:00.000Z"),
  createdAt: new Date("2026-09-15T10:31:00.000Z"),
  metadata: {
    scoringProfileKey: rosScoringProfileKey,
    releaseCompleteness: "full",
    preservePriorGoodSet: false,
  },
};

const managedRosProfile: ManagedProjectionProfile = {
  key: rosScoringProfileKey,
  positions: (["QB", "RB", "WR", "TE", "K", "DST"] as const).map((position) => ({
    position,
    supported: true,
    reasons: [],
  })),
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

const availabilityFreeRb: DecisionProjectionPlayerRow = {
  playerId: "72000000-0000-4000-8000-000000000001",
  name: "Available Back",
  primaryPosition: "RB",
  eligiblePositions: ["RB"],
  nflTeam: "CHI",
  status: "ACTIVE",
  meanPoints: "35",
  floorPoints: "29",
  ceilingPoints: "41",
};

const unlistedFreeQb: DecisionProjectionPlayerRow = {
  playerId: "72000000-0000-4000-8000-000000000002",
  name: "Unlisted Arm",
  primaryPosition: "QB",
  eligiblePositions: ["QB"],
  nflTeam: "CHI",
  status: "ACTIVE",
  meanPoints: "40",
  floorPoints: "34",
  ceilingPoints: "46",
};

const dstSlotRule: DecisionSlotRuleRow = {
  id: "80000000-0000-4000-8000-000000000004",
  slotCode: "D/ST",
  count: 1,
  eligiblePositions: ["D/ST"],
  isStarter: true,
};

function defenseProjection(
  playerId: string,
  name: string,
  nflTeam: string,
  meanPoints: number,
): DecisionProjectionPlayerRow {
  return {
    playerId,
    name,
    primaryPosition: "DST",
    eligiblePositions: ["DST"],
    nflTeam,
    status: "ACTIVE",
    meanPoints: String(meanPoints),
    floorPoints: String(meanPoints - 3),
    ceilingPoints: String(meanPoints + 4),
  };
}

function defenseRosterEntry(
  playerId: string,
  name: string,
  nflTeam: string,
): DecisionRosterEntryRow {
  return {
    snapshotId: SNAPSHOT_A_ID,
    playerId,
    name,
    primaryPosition: "D/ST",
    eligiblePositions: ["D/ST"],
    nflTeam,
    status: "ACTIVE",
    slotCode: "D/ST",
    isStarter: true,
    locked: false,
  };
}

function availabilityFeed(
  availability: "free-agent" | "waivers",
  providerPlayerIds: readonly string[],
  options: {
    readonly effectiveAt?: Date;
    readonly truncated?: boolean;
    readonly playerDetails?: Readonly<
      Record<string, { readonly primaryPosition: string; readonly proTeamAbbreviation: string }>
    >;
  } = {},
): DecisionAvailabilitySnapshotRow {
  return {
    availability,
    asOfWeek: 2,
    effectiveAt: options.effectiveAt ?? new Date("2026-09-15T11:00:00.000Z"),
    artifact: {
      kind: "available-players",
      availability,
      truncated: options.truncated ?? false,
      players: providerPlayerIds.map((providerPlayerId) => ({
        providerPlayerId,
        ...options.playerDetails?.[providerPlayerId],
      })),
    },
  };
}

class FakeRepository implements InSeasonDecisionRepository {
  membership: DecisionMembershipRow | undefined = membership;
  season: DecisionSeasonRow | undefined = season;
  teamRows: readonly DecisionTeamRow[] = teams;
  slotRules: readonly DecisionSlotRuleRow[] = slotRules;
  snapshots: readonly DecisionRosterSnapshotRow[] = snapshots;
  projectionSets: readonly DecisionProjectionSetRow[] = [projectionSet];
  projectionRows: readonly DecisionProjectionPlayerRow[] = projectionRows;
  projectionRowsBySet = new Map<string, readonly DecisionProjectionPlayerRow[]>();
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
  availabilityRows: readonly DecisionAvailabilitySnapshotRow[] = [];
  espnIdentities: readonly DecisionEspnPlayerIdentityRow[] = [];
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
    return Promise.resolve(this.teamRows.slice(0, limit));
  }
  listSlotRules(_seasonId: string, limit: number) {
    return Promise.resolve(this.slotRules.slice(0, limit));
  }
  listLatestRosterSnapshots(_seasonId: string, limit: number) {
    return Promise.resolve(this.snapshots.slice(0, limit));
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
  projectionRowsFor(setId: string) {
    return this.projectionRowsBySet.get(setId) ?? this.projectionRows;
  }
  countProjectionPlayers(setId: string) {
    return Promise.resolve(this.projectionRowsFor(setId).length);
  }
  listTopProjectionPlayers(setId: string, limit: number) {
    return Promise.resolve(
      [...this.projectionRowsFor(setId)]
        .sort((left, right) => Number(right.meanPoints) - Number(left.meanPoints))
        .slice(0, limit),
    );
  }
  listTopProjectionPlayersByPosition(setId: string, limitPerPosition: number) {
    const positions = ["QB", "RB", "WR", "TE", "K", "DST"] as const;
    return Promise.resolve(
      positions.flatMap((position) =>
        [...this.projectionRowsFor(setId)]
          .filter((row) => row.primaryPosition === position)
          .sort((left, right) => Number(right.meanPoints) - Number(left.meanPoints))
          .slice(0, limitPerPosition),
      ),
    );
  }
  listProjectionPlayersByIds(setId: string, ids: readonly string[]) {
    return Promise.resolve(
      this.projectionRowsFor(setId).filter((row) => ids.includes(row.playerId)),
    );
  }
  listLatestMarketSignals(ids: readonly string[], limit: number) {
    return Promise.resolve(
      this.marketRows.filter((row) => row.playerId && ids.includes(row.playerId)).slice(0, limit),
    );
  }
  findLatestEspnAvailability() {
    return Promise.resolve(this.availabilityRows);
  }
  listEspnPlayerIdentities(seasonId: string, ids: readonly string[]) {
    void seasonId;
    return Promise.resolve(this.espnIdentities.filter((row) => ids.includes(row.playerId)));
  }
  findManagedProjectionProfile?: (leagueSeasonId: string) => Promise<ManagedProjectionProfile>;
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
      expect(snapshot.waivers.dropCandidates.map((player) => player.name)).toEqual([
        "Low Arm",
        "Lead Back",
        "Spare Back",
      ]);
      expect(snapshot.waivers.recommendations[0]?.dropComparisons).toEqual([
        expect.objectContaining({
          dropPlayerId: playerIds.aQbLow,
          weightedGain: 20,
          lineupGain: 20,
        }),
        expect.objectContaining({
          dropPlayerId: playerIds.aRbOne,
          weightedGain: 19,
          lineupGain: 20,
        }),
        expect.objectContaining({
          dropPlayerId: playerIds.aRbTwo,
          weightedGain: 14,
          lineupGain: 15,
        }),
      ]);
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

  it("publishes an independent rest-of-season waiver ranking with normalized FAAB", async () => {
    const repository = new FakeRepository();
    const freeRosBackId = "70000000-0000-4000-8000-000000000009";
    const rosMeans: Readonly<Record<string, number>> = {
      [playerIds.aQbLow]: 200,
      [playerIds.aRbOne]: 140,
      [playerIds.aRbTwo]: 220,
      [playerIds.bQbOne]: 240,
      [playerIds.bQbTwo]: 180,
      [playerIds.bRbLow]: 130,
      [playerIds.freeQb]: 100,
    };
    const rosRows: readonly DecisionProjectionPlayerRow[] = [
      ...projectionRows.map((row) => {
        const mean = rosMeans[row.playerId] ?? 0;
        return {
          ...row,
          meanPoints: String(mean),
          floorPoints: String(Math.max(0, mean - 20)),
          ceilingPoints: String(mean + 25),
        };
      }),
      {
        playerId: freeRosBackId,
        name: "Season Back",
        primaryPosition: "RB",
        eligiblePositions: ["RB"],
        nflTeam: "CHI",
        status: "ACTIVE",
        meanPoints: "260",
        floorPoints: "220",
        ceilingPoints: "300",
      },
    ];
    repository.projectionSets = [projectionSet, rosProjectionSet];
    repository.projectionRowsBySet.set(PROJECTION_SET_ID, projectionRows);
    repository.projectionRowsBySet.set(ROS_SET_ID, rosRows);
    repository.findManagedProjectionProfile = () => Promise.resolve(managedRosProfile);

    const snapshot = await new InSeasonDecisionService(repository, () => NOW).getSnapshot(
      USER_ID,
      LEAGUE_ID,
    );

    if (snapshot?.waivers.state !== "available") throw new Error("expected available waivers");
    expect(snapshot.waivers.recommendations[0]?.add.name).toBe("Free Arm");
    const ros = snapshot.waivers.restOfSeason;
    if (ros.state !== "available") throw new Error("expected available ROS waivers");
    expect(ros).toMatchObject({
      label: "Rest of season · Weeks 2–18",
      windowStartWeek: 2,
      windowEndWeek: 18,
      projectionSet: {
        id: ROS_SET_ID,
        horizon: "rest-of-season",
        sourceObservedAt: "2026-09-15T09:30:00.000Z",
      },
      projectionFreshness: { observedAt: "2026-09-15T09:30:00.000Z" },
    });
    expect(ros.recommendations[0]).toMatchObject({
      add: { id: freeRosBackId, name: "Season Back", projectedPoints: 260 },
      drop: { id: playerIds.aRbOne, name: "Lead Back" },
      weightedGain: 48,
      lineupGain: 40,
    });
    expect(ros.recommendations[0]?.rationale).toContain("Rest of season · Weeks 2–18");
    expect(ros.recommendations[0]?.faab?.recommended).toBeGreaterThan(0);
    expect(ros.recommendations[0]?.faab?.recommended).toBeLessThan(
      snapshot.waivers.recommendations[0]?.faab?.recommended ?? 0,
    );
    expect(ros.notes.join(" ")).toContain("not a week-by-week lineup simulation");
    expect(() => inSeasonDecisionSnapshotSchema.parse(snapshot)).not.toThrow();
  });

  it("selects the exact scoring-compatible ROS set over a newer incompatible release", async () => {
    const repository = new FakeRepository();
    const incompatibleScoringProfileKey = projectionScoringProfileKey({
      id: "incompatible-fixture-scoring",
      rules: [
        { statId: "passing_yards", points: 0.04 },
        { statId: "rushing_yards", points: 0.2 },
      ],
    });
    const incompatibleRosSet: DecisionProjectionSetRow = {
      ...rosProjectionSet,
      id: "60000000-0000-4000-8000-000000000003",
      version: "2026-w02-ros-newer-incompatible",
      asOfWeek: 2,
      asOfAt: new Date("2026-09-15T11:30:00.000Z"),
      fetchedAt: new Date("2026-09-15T11:31:00.000Z"),
      createdAt: new Date("2026-09-15T11:32:00.000Z"),
      metadata: {
        ...rosProjectionSet.metadata,
        scoringProfileKey: incompatibleScoringProfileKey,
      },
    };
    repository.projectionSets = [projectionSet, incompatibleRosSet, rosProjectionSet];
    repository.projectionRowsBySet.set(PROJECTION_SET_ID, projectionRows);
    repository.projectionRowsBySet.set(incompatibleRosSet.id, projectionRows);
    repository.projectionRowsBySet.set(ROS_SET_ID, projectionRows);
    repository.findManagedProjectionProfile = () => Promise.resolve(managedRosProfile);

    const snapshot = await snapshotFrom(repository);

    if (snapshot.waivers.state !== "available") throw new Error("expected weekly waivers");
    const ros = snapshot.waivers.restOfSeason;
    if (ros.state !== "available") throw new Error("expected available ROS waivers");
    expect(ros.projectionSet).toMatchObject({
      id: ROS_SET_ID,
      version: rosProjectionSet.version,
      horizon: "rest-of-season",
    });
    expect(ros.projectionSet.id).not.toBe(incompatibleRosSet.id);
  });

  it("does not let a newer partial-position scoring match displace an older compatible ROS set", async () => {
    const repository = new FakeRepository();
    const currentScoringProfile = {
      id: "current-partial-match-fixture",
      rules: [
        { statId: "passing_yards", points: 0.04 },
        { statId: "rushing_yards", points: 0.1 },
      ],
    } as const;
    const olderCompatibleProfileKey = projectionScoringProfileKey({
      id: "older-compatible-fixture",
      rules: [...currentScoringProfile.rules, { statId: "field_goals_made", points: 3 }],
    });
    const newerPartialProfileKey = projectionScoringProfileKey({
      id: "newer-partial-fixture",
      rules: [...currentScoringProfile.rules, { statId: "receiving_yards", points: 0.2 }],
    });
    const olderCompatibleSet: DecisionProjectionSetRow = {
      ...rosProjectionSet,
      id: "60000000-0000-4000-8000-000000000004",
      version: "2026-w02-ros-older-position-compatible",
      metadata: {
        ...rosProjectionSet.metadata,
        scoringProfileKey: olderCompatibleProfileKey,
      },
    };
    const newerPartialSet: DecisionProjectionSetRow = {
      ...rosProjectionSet,
      id: "60000000-0000-4000-8000-000000000005",
      version: "2026-w02-ros-newer-partial-match",
      asOfWeek: 2,
      asOfAt: new Date("2026-09-15T11:30:00.000Z"),
      fetchedAt: new Date("2026-09-15T11:31:00.000Z"),
      createdAt: new Date("2026-09-15T11:32:00.000Z"),
      metadata: {
        ...rosProjectionSet.metadata,
        scoringProfileKey: newerPartialProfileKey,
      },
    };
    repository.projectionSets = [projectionSet, newerPartialSet, olderCompatibleSet];
    repository.projectionRowsBySet.set(PROJECTION_SET_ID, projectionRows);
    repository.projectionRowsBySet.set(newerPartialSet.id, projectionRows);
    repository.projectionRowsBySet.set(olderCompatibleSet.id, projectionRows);
    repository.findManagedProjectionProfile = () =>
      Promise.resolve({
        key: projectionScoringProfileKey(currentScoringProfile),
        positions: (["QB", "RB"] as const).map((position) => ({
          position,
          supported: true,
          reasons: [],
        })),
      });

    const snapshot = await snapshotFrom(repository);

    if (snapshot.waivers.state !== "available") throw new Error("expected weekly waivers");
    const ros = snapshot.waivers.restOfSeason;
    if (ros.state !== "available") throw new Error("expected available ROS waivers");
    expect(ros.projectionSet).toMatchObject({
      id: olderCompatibleSet.id,
      version: olderCompatibleSet.version,
      horizon: "rest-of-season",
    });
    expect(ros.projectionSet.id).not.toBe(newerPartialSet.id);
  });

  it("keeps lower-total positions in the bounded ROS candidate pool", async () => {
    const repository = new FakeRepository();
    const seasonBackId = "71000000-0000-4000-8000-000000000001";
    const rosterMeans: Readonly<Record<string, number>> = {
      [playerIds.aQbLow]: 1_000,
      [playerIds.aRbOne]: 100,
      [playerIds.aRbTwo]: 90,
      [playerIds.bQbOne]: 300,
      [playerIds.bQbTwo]: 250,
      [playerIds.bRbLow]: 80,
      [playerIds.freeQb]: 600,
    };
    const extraQuarterbacks: DecisionProjectionPlayerRow[] = Array.from(
      { length: 520 },
      (_, index) => ({
        playerId: `71000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`,
        name: `Free Quarterback ${index + 1}`,
        primaryPosition: "QB",
        eligiblePositions: ["QB"],
        nflTeam: "MIA",
        status: "ACTIVE",
        meanPoints: String(599 - index),
        floorPoints: String(550 - index),
        ceilingPoints: String(630 - index),
      }),
    );
    const rosRows: DecisionProjectionPlayerRow[] = [
      ...projectionRows.map((row) => {
        const mean = rosterMeans[row.playerId] ?? 100;
        return {
          ...row,
          meanPoints: String(mean),
          floorPoints: String(Math.max(0, mean - 20)),
          ceilingPoints: String(mean + 20),
        };
      }),
      ...extraQuarterbacks,
      {
        playerId: seasonBackId,
        name: "Position Balanced Back",
        primaryPosition: "RB",
        eligiblePositions: ["RB"],
        nflTeam: "CHI",
        status: "ACTIVE",
        meanPoints: "300",
        floorPoints: "260",
        ceilingPoints: "340",
      },
    ];
    repository.projectionSets = [projectionSet, rosProjectionSet];
    repository.projectionRowsBySet.set(PROJECTION_SET_ID, projectionRows);
    repository.projectionRowsBySet.set(ROS_SET_ID, rosRows);
    repository.findManagedProjectionProfile = () => Promise.resolve(managedRosProfile);

    const snapshot = await new InSeasonDecisionService(repository, () => NOW).getSnapshot(
      USER_ID,
      LEAGUE_ID,
    );

    if (snapshot?.waivers.state !== "available") throw new Error("expected available waivers");
    const ros = snapshot.waivers.restOfSeason;
    if (ros.state !== "available") throw new Error("expected available ROS waivers");
    expect(ros.candidateCount).toBe(24);
    expect(ros.recommendations[0]?.add).toMatchObject({
      id: seasonBackId,
      name: "Position Balanced Back",
    });
  });

  it("seeds ROS beyond 24 higher-ranked players who are already rostered", async () => {
    const repository = new FakeRepository();
    const deepTargetId = "74000000-0000-4000-8000-000000000001";
    const higherRosteredQuarterbacks = Array.from({ length: 25 }, (_, index) => {
      const id = `74000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`;
      return {
        roster: rosterEntry(
          SNAPSHOT_B_ID,
          id,
          `Rostered Quarterback ${index + 1}`,
          "QB",
          "BN",
          false,
        ),
        projection: {
          playerId: id,
          name: `Rostered Quarterback ${index + 1}`,
          primaryPosition: "QB",
          eligiblePositions: ["QB"],
          nflTeam: "CHI",
          status: "ACTIVE",
          meanPoints: String(200 - index),
          floorPoints: String(180 - index),
          ceilingPoints: String(220 - index),
        } satisfies DecisionProjectionPlayerRow,
      };
    });
    const deepTarget: DecisionProjectionPlayerRow = {
      playerId: deepTargetId,
      name: "Deep Available Quarterback",
      primaryPosition: "QB",
      eligiblePositions: ["QB"],
      nflTeam: "CHI",
      status: "ACTIVE",
      meanPoints: "100",
      floorPoints: "90",
      ceilingPoints: "110",
    };
    repository.rosterRows = [
      ...rosterRows,
      ...higherRosteredQuarterbacks.map(({ roster }) => roster),
    ];
    repository.projectionSets = [projectionSet, rosProjectionSet];
    repository.projectionRowsBySet.set(PROJECTION_SET_ID, projectionRows);
    repository.projectionRowsBySet.set(ROS_SET_ID, [
      ...projectionRows,
      ...higherRosteredQuarterbacks.map(({ projection }) => projection),
      deepTarget,
    ]);
    repository.findManagedProjectionProfile = () => Promise.resolve(managedRosProfile);

    const snapshot = await snapshotFrom(repository);

    if (snapshot.waivers.state !== "available") throw new Error("expected weekly waivers");
    const ros = snapshot.waivers.restOfSeason;
    if (ros.state !== "available") throw new Error("expected available ROS waivers");
    expect(ros.recommendations.some(({ add }) => add.id === deepTargetId)).toBe(true);
  });

  it("withholds ROS waivers when the active roster is not fully projected", async () => {
    const repository = new FakeRepository();
    repository.projectionSets = [projectionSet, rosProjectionSet];
    repository.projectionRowsBySet.set(PROJECTION_SET_ID, projectionRows);
    repository.projectionRowsBySet.set(
      ROS_SET_ID,
      projectionRows.filter((row) => row.playerId !== playerIds.aRbTwo),
    );
    repository.findManagedProjectionProfile = () => Promise.resolve(managedRosProfile);

    const snapshot = await new InSeasonDecisionService(repository, () => NOW).getSnapshot(
      USER_ID,
      LEAGUE_ID,
    );

    if (snapshot?.waivers.state !== "available") throw new Error("expected weekly waivers");
    expect(snapshot.waivers.restOfSeason).toMatchObject({
      state: "unavailable",
      reasons: [{ code: "PROJECTION_COVERAGE_INCOMPLETE" }],
    });
  });

  it("withholds ROS waivers after a relevant scoring-profile change", async () => {
    const repository = new FakeRepository();
    const changedKey = projectionScoringProfileKey({
      id: "changed-fixture-scoring",
      rules: [
        { statId: "passing_yards", points: 0.04 },
        { statId: "rushing_yards", points: 0.2 },
      ],
    });
    repository.projectionSets = [projectionSet, rosProjectionSet];
    repository.projectionRowsBySet.set(PROJECTION_SET_ID, projectionRows);
    repository.projectionRowsBySet.set(ROS_SET_ID, projectionRows);
    repository.findManagedProjectionProfile = () =>
      Promise.resolve({ ...managedRosProfile, key: changedKey });

    const snapshot = await new InSeasonDecisionService(repository, () => NOW).getSnapshot(
      USER_ID,
      LEAGUE_ID,
    );

    if (snapshot?.waivers.state !== "available") throw new Error("expected weekly waivers");
    expect(snapshot.waivers.restOfSeason).toMatchObject({
      state: "unavailable",
      reasons: [{ code: "PROJECTIONS_MISSING" }],
    });
  });

  it.each([
    { provider: "espn" as const, defenseCode: "D/ST", reserveCode: "IR" },
    { provider: "yahoo" as const, defenseCode: "DEF", reserveCode: "IR+" },
    { provider: "yahoo" as const, defenseCode: "DEF", reserveCode: "IL" },
    { provider: "yahoo" as const, defenseCode: "DEF", reserveCode: "NA" },
  ])(
    "maps $provider $reserveCode reserve and defense slot labels without inventing waiver capacity",
    async ({ provider, defenseCode, reserveCode }) => {
      const repository = new FakeRepository();
      const defensePlayerId = "70000000-0000-4000-8000-000000000008";
      repository.season = {
        ...season,
        provider,
        externalKey: provider === "yahoo" ? "470.l.123" : season.externalKey,
      };
      repository.slotRules = [
        ...slotRules.map((rule) =>
          rule.slotCode === "BN" ? { ...rule, eligiblePositions: ["BN"] } : rule,
        ),
        {
          id: "80000000-0000-4000-8000-000000000004",
          slotCode: defenseCode,
          count: 1,
          eligiblePositions: [defenseCode],
          isStarter: true,
        },
        {
          id: "80000000-0000-4000-8000-000000000005",
          slotCode: reserveCode,
          count: 1,
          eligiblePositions: [reserveCode],
          isStarter: false,
        },
      ];
      repository.rosterRows = [
        ...rosterRows,
        {
          snapshotId: SNAPSHOT_A_ID,
          playerId: defensePlayerId,
          name: "Miami D/ST",
          primaryPosition: defenseCode,
          eligiblePositions: [defenseCode, "BN", "IR"],
          nflTeam: "MIA",
          status: "ACTIVE",
          slotCode: defenseCode,
          isStarter: true,
          locked: false,
        },
      ];
      repository.projectionRows = [
        ...projectionRows,
        {
          playerId: defensePlayerId,
          name: "Miami D/ST",
          primaryPosition: defenseCode,
          eligiblePositions: [defenseCode],
          nflTeam: "MIA",
          status: "ACTIVE",
          meanPoints: "8",
          floorPoints: "3",
          ceilingPoints: "14",
        },
      ];

      const snapshot = await new InSeasonDecisionService(repository, () => NOW).getSnapshot(
        USER_ID,
        LEAGUE_ID,
      );

      expect(snapshot?.lineup.state).toBe("available");
      expect(snapshot?.waivers.state).toBe("available");
      expect(snapshot?.trades.state).toBe("available");
      expect(snapshot?.coverage).toMatchObject({
        claimedRosterPlayers: 4,
        claimedRosterProjected: 4,
      });
      if (snapshot?.waivers.state !== "available") throw new Error("expected available waivers");
      expect(snapshot.waivers.recommendations.length).toBeGreaterThan(0);
      expect(snapshot.waivers.recommendations.every((move) => move.drop !== null)).toBe(true);
      expect(snapshot.waivers.recommendations[0]).toMatchObject({
        add: { name: "Free Arm" },
        drop: { name: "Low Arm" },
        weightedGain: 20,
        lineupGain: 20,
      });
      expect(snapshot.waivers.recommendations[0]?.rationale).toBe(
        "Adding Free Arm and dropping Low Arm improves weighted roster value by 20.00 points (Week 2).",
      );
      expect(snapshot.waivers.recommendations[0]?.rationale).not.toContain("open roster spot");
      expect(snapshot.waivers.evaluatedMoveCount).toBeGreaterThan(snapshot.waivers.candidateCount);
    },
  );

  it("keeps injured-reserve occupants outside active-roster waiver legality", async () => {
    const repository = new FakeRepository();
    const injuredPlayerId = "70000000-0000-4000-8000-000000000008";
    const freeReceiverId = "70000000-0000-4000-8000-000000000009";
    repository.slotRules = [
      ...slotRules.filter((rule) => rule.slotCode !== "BN"),
      {
        id: "80000000-0000-4000-8000-000000000004",
        slotCode: "IR",
        count: 1,
        eligiblePositions: ["IR"],
        isStarter: false,
      },
    ];
    repository.rosterRows = [
      ...rosterRows.filter((row) => row.playerId !== playerIds.aRbTwo),
      {
        ...rosterEntry(SNAPSHOT_A_ID, injuredPlayerId, "Injured Stash", "RB", "IR", false),
        status: "IR",
      },
    ];
    repository.projectionRows = [
      ...projectionRows,
      {
        playerId: injuredPlayerId,
        name: "Injured Stash",
        primaryPosition: "RB",
        eligiblePositions: ["RB"],
        nflTeam: "MIA",
        status: "IR",
        meanPoints: "0",
        floorPoints: "0",
        ceilingPoints: "0",
      },
      {
        playerId: freeReceiverId,
        name: "Free Receiver",
        primaryPosition: "WR",
        eligiblePositions: ["WR"],
        nflTeam: "CHI",
        status: "ACTIVE",
        meanPoints: "100",
        floorPoints: "90",
        ceilingPoints: "110",
      },
    ];

    const snapshot = await new InSeasonDecisionService(repository, () => NOW).getSnapshot(
      USER_ID,
      LEAGUE_ID,
    );

    if (snapshot?.waivers.state !== "available") throw new Error("expected available waivers");
    expect(snapshot.waivers.recommendations.length).toBeGreaterThan(0);
    expect(snapshot.waivers.recommendations.every((move) => move.add.id !== freeReceiverId)).toBe(
      true,
    );
    expect(snapshot.waivers.recommendations.every((move) => move.drop.id !== injuredPlayerId)).toBe(
      true,
    );
    expect(snapshot.waivers.recommendations[0]).toMatchObject({
      add: { name: "Free Arm" },
      drop: { name: "Low Arm" },
      weightedGain: 20,
      lineupGain: 20,
    });
  });

  it("still models the suggested drop when an ordinary roster slot is open", async () => {
    const repository = new FakeRepository();
    repository.slotRules = [
      ...slotRules,
      {
        id: "80000000-0000-4000-8000-000000000004",
        slotCode: "BN",
        count: 1,
        eligiblePositions: ["QB", "RB", "WR", "TE", "K", "DST"],
        isStarter: false,
      },
    ];

    const snapshot = await new InSeasonDecisionService(repository, () => NOW).getSnapshot(
      USER_ID,
      LEAGUE_ID,
    );

    if (snapshot?.waivers.state !== "available") throw new Error("expected available waivers");
    expect(snapshot.waivers.recommendations[0]).toMatchObject({
      add: { name: "Free Arm" },
      drop: { name: "Low Arm" },
      weightedGain: 20,
      lineupGain: 20,
    });
    expect(snapshot.waivers.recommendations[0]?.rationale).not.toContain("open roster spot");
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

  it("explains a missing projection set caused by unsupported managed scoring, not just that one is missing", async () => {
    const repository = new FakeRepository();
    repository.projectionSets = [];
    repository.findManagedProjectionProfile = () => Promise.resolve({ key: null, positions: [] });
    const service = new InSeasonDecisionService(repository, () => NOW);
    const snapshot = await service.getSnapshot(USER_ID, LEAGUE_ID);
    expect(snapshot?.lineup.state).toBe("unavailable");
    if (snapshot?.lineup.state !== "unavailable") throw new Error("expected unavailable");
    const [projectionsMissing] = snapshot.lineup.reasons.filter(
      (item) => item.code === "PROJECTIONS_MISSING",
    );
    expect(projectionsMissing?.message).toContain("scoring rules do not normalize");
  });

  it("explains a missing projection set caused by the bounded scoring-rule read sentinel", async () => {
    const repository = new FakeRepository();
    repository.projectionSets = [];
    repository.findManagedProjectionProfile = () => Promise.resolve({ key: null, positions: null });
    const service = new InSeasonDecisionService(repository, () => NOW);
    const snapshot = await service.getSnapshot(USER_ID, LEAGUE_ID);
    if (snapshot?.lineup.state !== "unavailable") throw new Error("expected unavailable");
    const [projectionsMissing] = snapshot.lineup.reasons.filter(
      (item) => item.code === "PROJECTIONS_MISSING",
    );
    expect(projectionsMissing?.message).toContain("exceeded the bounded read");
  });

  it("explains a missing projection set as not-yet-published when the managed profile itself is supported", async () => {
    const repository = new FakeRepository();
    repository.projectionSets = [];
    repository.findManagedProjectionProfile = () =>
      Promise.resolve({ key: "some-normalized-key", positions: [] });
    const service = new InSeasonDecisionService(repository, () => NOW);
    const snapshot = await service.getSnapshot(USER_ID, LEAGUE_ID);
    if (snapshot?.lineup.state !== "unavailable") throw new Error("expected unavailable");
    const [projectionsMissing] = snapshot.lineup.reasons.filter(
      (item) => item.code === "PROJECTIONS_MISSING",
    );
    expect(projectionsMissing?.message).toContain(
      "no managed weekly projection set has been published",
    );
  });

  it("notes when a non-managed projection set stands in because managed scoring is unsupported", async () => {
    const repository = new FakeRepository();
    repository.findManagedProjectionProfile = () => Promise.resolve({ key: null, positions: [] });
    const service = new InSeasonDecisionService(repository, () => NOW);
    const snapshot = await service.getSnapshot(USER_ID, LEAGUE_ID);
    expect(snapshot?.lineup.state).toBe("available");
    expect(snapshot?.waivers.state).toBe("available");
    expect(snapshot?.trades.state).toBe("available");
    if (snapshot?.lineup.state === "available") {
      expect(snapshot.lineup.notes.join(" ")).toContain("managed weekly projections are withheld");
    }
    if (snapshot?.waivers.state === "available") {
      expect(snapshot.waivers.notes.join(" ")).toContain("managed weekly projections are withheld");
    }
    if (snapshot?.trades.state === "available") {
      expect(snapshot.trades.notes.join(" ")).toContain("managed weekly projections are withheld");
    }
  });

  it("adds no managed-projections note when the projection set used is itself the managed set", async () => {
    const repository = new FakeRepository();
    repository.projectionSets = [{ ...projectionSet, source: "laces-out-first-party" }];
    repository.findManagedProjectionProfile = () => Promise.resolve({ key: null, positions: [] });
    const service = new InSeasonDecisionService(repository, () => NOW);
    const snapshot = await service.getSnapshot(USER_ID, LEAGUE_ID);
    if (snapshot?.lineup.state === "available") {
      expect(snapshot.lineup.notes.join(" ")).not.toContain(
        "managed weekly projections are withheld",
      );
    }
  });

  it("reports a newly generated first-party set as fresh while retaining its older input time", async () => {
    const repository = new FakeRepository();
    const sourceObservedAt = new Date("2026-08-17T15:53:54.229Z");
    repository.projectionSets = [
      {
        ...projectionSet,
        source: "laces-out-first-party",
        fetchedAt: sourceObservedAt,
        createdAt: new Date("2026-09-15T11:00:00.000Z"),
        metadata: { sourceAsOf: sourceObservedAt.toISOString() },
      },
    ];

    const snapshot = await new InSeasonDecisionService(repository, () => NOW).getSnapshot(
      USER_ID,
      LEAGUE_ID,
    );

    expect(snapshot?.provenance.projectionSet).toMatchObject({
      sourceObservedAt: sourceObservedAt.toISOString(),
      sourceObservedAtStatus: "verified",
      importedAt: "2026-09-15T11:00:00.000Z",
    });
    expect(snapshot?.provenance.projectionFreshness).toEqual({
      state: "fresh",
      observedAt: "2026-09-15T11:00:00.000Z",
      label: "Updated 1h ago",
    });
  });

  // Regression for review Finding 1: a compatible managed set that genuinely exists but loses
  // `#findProjectionSets`' real ORDER BY tiebreak to a user-created row must NOT be reported as
  // withheld — the note is only true when no managed candidate is present at all.
  it("does not fire a false withheld note when a compatible managed set exists but is outranked by a user-created one", async () => {
    const repository = new FakeRepository();
    const findManagedProjectionProfile = vi.fn(() =>
      Promise.resolve({ key: "some-normalized-key", positions: [] }),
    );
    repository.findManagedProjectionProfile = findManagedProjectionProfile;
    // Mirrors the real repository's ORDER BY: a user-created row (`createdByUserId` set, the
    // default `projectionSet` fixture) ranks above a managed row (`createdByUserId: null`) for the
    // same league/season/week, so both are admitted as candidates but the user's row is selected.
    repository.projectionSets = [
      projectionSet,
      {
        ...projectionSet,
        id: "60000000-0000-4000-8000-000000000002",
        source: "laces-out-first-party",
      },
    ];
    const service = new InSeasonDecisionService(repository, () => NOW);
    const snapshot = await service.getSnapshot(USER_ID, LEAGUE_ID);

    expect(snapshot?.lineup.state).toBe("available");
    expect(snapshot?.waivers.state).toBe("available");
    expect(snapshot?.trades.state).toBe("available");
    if (snapshot?.lineup.state === "available") {
      expect(snapshot.lineup.notes.join(" ")).not.toContain(
        "managed weekly projections are withheld",
      );
    }
    if (snapshot?.waivers.state === "available") {
      expect(snapshot.waivers.notes.join(" ")).not.toContain(
        "managed weekly projections are withheld",
      );
    }
    if (snapshot?.trades.state === "available") {
      expect(snapshot.trades.notes.join(" ")).not.toContain(
        "managed weekly projections are withheld",
      );
    }
    // A managed candidate was present, so there was nothing to explain — the bounded profile read
    // must not even fire.
    expect(findManagedProjectionProfile).not.toHaveBeenCalled();
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

  it("uses only complete fresh ESPN availability feeds as an allowlist", async () => {
    const identities: readonly DecisionEspnPlayerIdentityRow[] = [
      { playerId: playerIds.freeQb, source: "espn", externalId: "101" },
      { playerId: availabilityFreeRb.playerId, source: "espn", externalId: "102" },
    ];
    const repositoryWith = (availabilityRows: readonly DecisionAvailabilitySnapshotRow[]) => {
      const repository = new FakeRepository();
      repository.projectionRows = [...projectionRows, availabilityFreeRb, unlistedFreeQb];
      repository.availabilityRows = availabilityRows;
      repository.espnIdentities = identities;
      return repository;
    };

    const completeSnapshot = await snapshotFrom(
      repositoryWith([
        availabilityFeed("free-agent", ["101"]),
        availabilityFeed("waivers", ["102"]),
      ]),
    );
    const missingComponentSnapshot = await snapshotFrom(
      repositoryWith([availabilityFeed("free-agent", ["101"])]),
    );
    const truncatedComponentSnapshot = await snapshotFrom(
      repositoryWith([
        availabilityFeed("free-agent", ["101"]),
        availabilityFeed("waivers", ["102"], { truncated: true }),
      ]),
    );

    if (completeSnapshot.waivers.state !== "available") {
      throw new Error("expected complete-feed waivers");
    }
    expect(completeSnapshot.waivers.candidateCount).toBe(2);
    expect(
      completeSnapshot.waivers.recommendations.every(
        (recommendation) => recommendation.add.id !== unlistedFreeQb.playerId,
      ),
    ).toBe(true);
    expect(completeSnapshot.waivers.notes.join(" ")).toContain(
      "confirmed in ESPN's latest available-player feeds",
    );

    for (const fallbackSnapshot of [missingComponentSnapshot, truncatedComponentSnapshot]) {
      if (fallbackSnapshot.waivers.state !== "available") {
        throw new Error("expected fallback waivers");
      }
      expect(fallbackSnapshot.waivers.candidateCount).toBe(3);
      expect(fallbackSnapshot.waivers.recommendations[0]?.add.id).toBe(unlistedFreeQb.playerId);
      expect(fallbackSnapshot.waivers.notes.join(" ")).toContain(
        "not rostered in any latest team snapshot",
      );
    }
  });

  it("team-matches canonical D/ST projections from strict ESPN availability with exact provenance", async () => {
    const rosterDefenseId = "73000000-0000-4000-8000-000000000001";
    const ramsDefenseId = "73000000-0000-4000-8000-000000000002";
    const commandersDefenseId = "73000000-0000-4000-8000-000000000003";
    const providerDefenseId = "-16028";
    const repositoryWithDefense = (providerTeam: "LA" | "WSH") => {
      const repository = new FakeRepository();
      repository.slotRules = [...slotRules, dstSlotRule];
      repository.rosterRows = [
        ...rosterRows,
        defenseRosterEntry(rosterDefenseId, "Buffalo D/ST provider alias", "BUF"),
      ];
      repository.projectionRows = [
        ...projectionRows,
        defenseProjection(rosterDefenseId, "Buffalo D/ST provider alias", "BUF", 5),
        defenseProjection(ramsDefenseId, "Los Angeles Rams D/ST", "LAR", 35),
        defenseProjection(commandersDefenseId, "Washington Commanders D/ST", "WAS", 34),
      ];
      repository.marketRows = [];
      repository.availabilityRows = [
        availabilityFeed("free-agent", [providerDefenseId], {
          playerDetails: {
            [providerDefenseId]: {
              primaryPosition: "D/ST",
              proTeamAbbreviation: providerTeam,
            },
          },
        }),
        availabilityFeed("waivers", []),
      ];
      repository.espnIdentities = [];
      return repository;
    };

    const ramsSnapshot = await snapshotFrom(repositoryWithDefense("LA"));
    const commandersSnapshot = await snapshotFrom(repositoryWithDefense("WSH"));

    if (
      ramsSnapshot.waivers.state !== "available" ||
      commandersSnapshot.waivers.state !== "available"
    ) {
      throw new Error("expected team-matched D/ST waivers");
    }
    expect(ramsSnapshot.waivers.candidateCount).toBe(1);
    expect(commandersSnapshot.waivers.candidateCount).toBe(1);
    expect(ramsSnapshot.waivers.recommendations[0]?.add.id).toBe(ramsDefenseId);
    expect(commandersSnapshot.waivers.recommendations[0]?.add.id).toBe(commandersDefenseId);
    expect(ramsSnapshot.provenance.inputChecksum).not.toBe(
      commandersSnapshot.provenance.inputChecksum,
    );
  });

  it("keeps ROS available for a rostered D/ST alias without offering its canonical same-team defense", async () => {
    const rosterDefenseId = "73000000-0000-4000-8000-000000000011";
    const canonicalRosterDefenseId = "73000000-0000-4000-8000-000000000012";
    const availableDefenseId = "73000000-0000-4000-8000-000000000013";
    const rosterDefense = defenseProjection(
      rosterDefenseId,
      "Buffalo D/ST provider alias",
      "BUF",
      5,
    );
    const canonicalRosterDefense = defenseProjection(
      canonicalRosterDefenseId,
      "Buffalo Bills D/ST",
      "BUF",
      500,
    );
    const availableDefense = defenseProjection(
      availableDefenseId,
      "Chicago Bears D/ST",
      "CHI",
      250,
    );
    const dstScoringProfileKey = projectionScoringProfileKey({
      id: "dst-fixture-scoring",
      rules: [
        { statId: "passing_yards", points: 0.04 },
        { statId: "rushing_yards", points: 0.1 },
        { statId: "defensive_sacks", points: 1 },
      ],
    });
    const repository = new FakeRepository();
    repository.slotRules = [...slotRules, dstSlotRule];
    repository.rosterRows = [
      ...rosterRows,
      defenseRosterEntry(rosterDefenseId, "Buffalo D/ST provider alias", "BUF"),
    ];
    repository.projectionSets = [
      projectionSet,
      {
        ...rosProjectionSet,
        metadata: { ...rosProjectionSet.metadata, scoringProfileKey: dstScoringProfileKey },
      },
    ];
    repository.projectionRowsBySet.set(PROJECTION_SET_ID, [
      ...projectionRows,
      rosterDefense,
      canonicalRosterDefense,
      availableDefense,
    ]);
    repository.projectionRowsBySet.set(ROS_SET_ID, [
      ...projectionRows,
      rosterDefense,
      canonicalRosterDefense,
      availableDefense,
    ]);
    repository.findManagedProjectionProfile = () =>
      Promise.resolve({ ...managedRosProfile, key: dstScoringProfileKey });
    repository.marketRows = [];
    repository.availabilityRows = [
      availabilityFeed("free-agent", ["-16002", "-16005"], {
        playerDetails: {
          "-16002": { primaryPosition: "D/ST", proTeamAbbreviation: "BUF" },
          "-16005": { primaryPosition: "D/ST", proTeamAbbreviation: "CHI" },
        },
      }),
      availabilityFeed("waivers", []),
    ];

    const snapshot = await snapshotFrom(repository);

    if (snapshot.waivers.state !== "available") throw new Error("expected weekly waivers");
    const ros = snapshot.waivers.restOfSeason;
    if (ros.state !== "available") throw new Error("expected available ROS waivers");
    expect(ros.candidateCount).toBe(1);
    expect(ros.dropCandidates).toContainEqual(
      expect.objectContaining({ id: rosterDefenseId, name: "Buffalo D/ST provider alias" }),
    );
    expect(ros.recommendations[0]?.add.id).toBe(availableDefenseId);
    expect(
      ros.recommendations.some(
        (recommendation) => recommendation.add.id === canonicalRosterDefenseId,
      ),
    ).toBe(false);
  });

  it("changes provenance when ESPN availability crosses the 24-hour freshness boundary", async () => {
    const effectiveAt = new Date("2026-09-14T12:00:00.000Z");
    const repository = new FakeRepository();
    repository.availabilityRows = [
      availabilityFeed("free-agent", ["101"], { effectiveAt }),
      availabilityFeed("waivers", [], { effectiveAt }),
    ];
    repository.espnIdentities = [{ playerId: playerIds.freeQb, source: "espn", externalId: "101" }];

    const atBoundary = await new InSeasonDecisionService(repository, () => NOW).getSnapshot(
      USER_ID,
      LEAGUE_ID,
    );
    const afterBoundary = await new InSeasonDecisionService(
      repository,
      () => new Date(NOW.getTime() + 1),
    ).getSnapshot(USER_ID, LEAGUE_ID);

    if (!atBoundary || !afterBoundary) throw new Error("expected decision snapshots");
    expect(atBoundary.provenance.inputChecksum).not.toBe(afterBoundary.provenance.inputChecksum);
  });

  it("changes provenance when ESPN identity mapping changes the admitted candidate", async () => {
    const repositoryWithIdentity = (playerIdToAdmit: string) => {
      const repository = new FakeRepository();
      repository.projectionRows = [...projectionRows, availabilityFreeRb];
      repository.marketRows = [];
      repository.availabilityRows = [
        availabilityFeed("free-agent", ["501"]),
        availabilityFeed("waivers", []),
      ];
      repository.espnIdentities = [
        { playerId: playerIdToAdmit, source: "espn", externalId: "501" },
      ];
      return repository;
    };

    const quarterbackSnapshot = await snapshotFrom(repositoryWithIdentity(playerIds.freeQb));
    const runningBackSnapshot = await snapshotFrom(
      repositoryWithIdentity(availabilityFreeRb.playerId),
    );

    if (
      quarterbackSnapshot.waivers.state !== "available" ||
      runningBackSnapshot.waivers.state !== "available"
    ) {
      throw new Error("expected identity-filtered waivers");
    }
    expect(quarterbackSnapshot.waivers.candidateCount).toBe(1);
    expect(runningBackSnapshot.waivers.candidateCount).toBe(1);
    expect(quarterbackSnapshot.waivers.recommendations[0]?.add.id).toBe(playerIds.freeQb);
    expect(runningBackSnapshot.waivers.recommendations[0]?.add.id).toBe(
      availabilityFreeRb.playerId,
    );
    expect(quarterbackSnapshot.provenance.inputChecksum).not.toBe(
      runningBackSnapshot.provenance.inputChecksum,
    );
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
    if (snapshot?.waivers.state !== "available") throw new Error("expected available waivers");
    expect(snapshot.waivers.recommendations[0]).toMatchObject({
      add: { name: "Free Arm" },
      drop: { name: "Lead Back" },
      weightedGain: 1,
      lineupGain: 0,
    });
  });

  it("withholds waiver views for unmappable players or a malformed claimed lineup", async () => {
    const unmappableRoster = new FakeRepository();
    unmappableRoster.rosterRows = rosterRows.map((row) =>
      row.playerId === playerIds.aRbTwo
        ? { ...row, primaryPosition: "P", eligiblePositions: ["P"] }
        : row,
    );

    const malformedLineup = new FakeRepository();
    malformedLineup.rosterRows = rosterRows.map((row) =>
      row.playerId === playerIds.aRbTwo ? { ...row, slotCode: "RB", isStarter: true } : row,
    );

    const [unmappableSnapshot, malformedSnapshot] = await Promise.all([
      snapshotFrom(unmappableRoster),
      snapshotFrom(malformedLineup),
    ]);

    expect(unmappableSnapshot.waivers).toMatchObject({
      state: "unavailable",
      reasons: [{ code: "ROSTER_MISSING" }],
    });
    expect(malformedSnapshot.waivers).toMatchObject({
      state: "unavailable",
      reasons: [{ code: "SLOT_RULES_UNSUPPORTED" }],
    });
    expect("recommendations" in unmappableSnapshot.waivers).toBe(false);
    expect("recommendations" in malformedSnapshot.waivers).toBe(false);
  });

  it("withholds waiver views when any latest team roster snapshot has no entries", async () => {
    const repository = new FakeRepository();
    repository.rosterRows = rosterRows.filter((row) => row.snapshotId !== SNAPSHOT_B_ID);

    const snapshot = await snapshotFrom(repository);

    expect(snapshot.lineup.state).toBe("available");
    expect(snapshot.waivers).toMatchObject({
      state: "unavailable",
      reasons: [{ code: "ROSTER_INCOMPLETE" }],
    });
    if (snapshot.waivers.state !== "unavailable") {
      throw new Error("expected unavailable waivers");
    }
    expect(snapshot.waivers.reasons[0]?.message).toContain(
      "1 latest team roster snapshot has no entries",
    );
    expect("restOfSeason" in snapshot.waivers).toBe(false);
  });

  it("emits no weekly or ROS FAAB guidance for a non-FAAB league", async () => {
    const repository = new FakeRepository();
    repository.season = { ...season, waiverType: "rolling-priority" };
    repository.projectionSets = [projectionSet, rosProjectionSet];
    repository.projectionRowsBySet.set(PROJECTION_SET_ID, projectionRows);
    repository.projectionRowsBySet.set(ROS_SET_ID, projectionRows);
    repository.findManagedProjectionProfile = () => Promise.resolve(managedRosProfile);

    const snapshot = await snapshotFrom(repository);

    if (snapshot.waivers.state !== "available") throw new Error("expected weekly waivers");
    expect(snapshot.waivers.recommendations.length).toBeGreaterThan(0);
    for (const recommendation of snapshot.waivers.recommendations) {
      expect(recommendation.faab).toBeNull();
      expect(recommendation.dropComparisons.every((comparison) => comparison.faab === null)).toBe(
        true,
      );
    }
    const ros = snapshot.waivers.restOfSeason;
    if (ros.state !== "available") throw new Error("expected available ROS waivers");
    expect(ros.recommendations.length).toBeGreaterThan(0);
    for (const recommendation of ros.recommendations) {
      expect(recommendation.faab).toBeNull();
      expect(recommendation.dropComparisons.every((comparison) => comparison.faab === null)).toBe(
        true,
      );
    }
  });

  it("returns unavailable instead of available-empty when every roster player is locked", async () => {
    const repository = new FakeRepository();
    repository.rosterRows = rosterRows.map((row) =>
      row.snapshotId === SNAPSHOT_A_ID ? { ...row, locked: true } : row,
    );

    const snapshot = await snapshotFrom(repository);

    expect(snapshot.waivers).toMatchObject({
      state: "unavailable",
      reasons: [{ code: "ENGINE_INFEASIBLE" }],
    });
    if (snapshot.waivers.state !== "unavailable") throw new Error("expected unavailable waivers");
    expect(snapshot.waivers.reasons[0]?.message).toContain("No legal add/drop pairing");
    expect("recommendations" in snapshot.waivers).toBe(false);
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

async function snapshotFrom(repository: FakeRepository) {
  const snapshot = await new InSeasonDecisionService(repository, () => NOW).getSnapshot(
    USER_ID,
    LEAGUE_ID,
  );
  if (!snapshot) throw new Error("Expected a snapshot");
  return snapshot;
}

const checksumOf = async (mutate: (repository: FakeRepository) => void = () => {}) => {
  const repository = new FakeRepository();
  mutate(repository);
  return (await snapshotFrom(repository)).provenance.inputChecksum;
};

describe("InSeasonDecisionSnapshot ADR 0003 provenance", () => {
  it("retains the engine's algorithm version and a 64-hex input checksum", async () => {
    const snapshot = await snapshotFrom(new FakeRepository());
    expect(snapshot.provenance.algorithmVersion).toBe(RECOMMENDATION_ALGORITHM_VERSION);
    expect(snapshot.provenance.inputChecksum).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("is deterministic: identical inputs produce an identical digest", async () => {
    expect(await checksumOf()).toBe(await checksumOf());
  });

  it("ignores the order of equivalent input rows", async () => {
    const reference = await checksumOf();
    expect(
      await checksumOf((repository) => {
        repository.snapshots = [...snapshots].reverse();
      }),
    ).toBe(reference);
    expect(
      await checksumOf((repository) => {
        repository.slotRules = [...slotRules].reverse();
      }),
    ).toBe(reference);
    expect(
      await checksumOf((repository) => {
        repository.slotRules = slotRules.map((rule) => ({
          ...rule,
          eligiblePositions: [...rule.eligiblePositions].reverse(),
        }));
      }),
    ).toBe(reference);
    // Key order inside the stored settings blob is not a scoring change.
    expect(
      await checksumOf((repository) => {
        repository.season = { ...season, settings: { receptionPoints: 1, scoringFormat: "ppr" } };
      }),
    ).toBe(reference);
  });

  it("changes when any input that determines the recommendation changes", async () => {
    const reference = await checksumOf();
    const variants = await Promise.all([
      // Week.
      checksumOf((repository) => {
        repository.season = { ...season, currentWeek: 3 };
      }),
      // Scoring rules.
      checksumOf((repository) => {
        repository.season = { ...season, settings: { scoringFormat: "standard" } };
      }),
      // Roster slot rules.
      checksumOf((repository) => {
        repository.slotRules = slotRules.map((rule) =>
          rule.slotCode === "RB" ? { ...rule, count: 2 } : rule,
        );
      }),
      // Roster snapshot identity.
      checksumOf((repository) => {
        repository.snapshots = snapshots.map((snapshot, index) =>
          index === 0 ? { ...snapshot, id: "50000000-0000-4000-8000-00000000000f" } : snapshot,
        );
      }),
      // Projection set identity.
      checksumOf((repository) => {
        repository.projectionSets = [
          { ...projectionSet, id: "60000000-0000-4000-8000-00000000000f" },
        ];
      }),
      // Independently admitted rest-of-season projection set identity.
      checksumOf((repository) => {
        repository.projectionSets = [projectionSet, rosProjectionSet];
      }),
    ]);
    for (const variant of variants) expect(variant).not.toBe(reference);
    expect(new Set(variants).size).toBe(variants.length);
  });

  it("changes for corrected market content at the same time or a changed managed scoring profile", async () => {
    const marketReference = await checksumOf();
    const marketContentChanged = await checksumOf((repository) => {
      repository.marketRows = repository.marketRows.map((row) => ({
        ...row,
        count: row.count + 1,
      }));
    });
    expect(marketContentChanged).not.toBe(marketReference);

    const profileReference = await checksumOf((repository) => {
      repository.findManagedProjectionProfile = () => Promise.resolve(managedRosProfile);
    });
    const changedScoringProfileKey = projectionScoringProfileKey({
      id: "changed-checksum-fixture-scoring",
      rules: [
        { statId: "passing_yards", points: 0.04 },
        { statId: "rushing_yards", points: 0.2 },
      ],
    });
    const profileChanged = await checksumOf((repository) => {
      repository.findManagedProjectionProfile = () =>
        Promise.resolve({ ...managedRosProfile, key: changedScoringProfileKey });
    });
    expect(profileChanged).not.toBe(profileReference);
  });

  it("changes when FAAB budget or player eligibility facts change", async () => {
    const reference = await checksumOf();
    const faabChanged = await checksumOf((repository) => {
      repository.teamRows = teams.map((team) =>
        team.id === TEAM_A_ID ? { ...team, faabRemaining: 41 } : team,
      );
    });
    const eligibilityChanged = await checksumOf((repository) => {
      repository.rosterRows = rosterRows.map((row) =>
        row.playerId === playerIds.aRbTwo ? { ...row, eligiblePositions: ["RB", "WR"] } : row,
      );
    });

    expect(faabChanged).not.toBe(reference);
    expect(eligibilityChanged).not.toBe(reference);
    expect(eligibilityChanged).not.toBe(faabChanged);
  });

  it("records provenance on an unavailable snapshot too", async () => {
    const repository = new FakeRepository();
    repository.membership = { ...membership, claimedFantasyTeamId: null };
    const snapshot = await snapshotFrom(repository);
    expect(snapshot.lineup.state).toBe("unavailable");
    expect(snapshot.provenance.algorithmVersion).toBe(RECOMMENDATION_ALGORITHM_VERSION);
    expect(snapshot.provenance.inputChecksum).toMatch(/^[0-9a-f]{64}$/u);
    // A snapshot computed from no league facts must not share a digest with one computed from them.
    expect(snapshot.provenance.inputChecksum).not.toBe(await checksumOf());
  });

  it("is computed from the declared early-unavailable inputs and nothing else", async () => {
    const repository = new FakeRepository();
    repository.membership = { ...membership, claimedFantasyTeamId: null };
    const snapshot = await snapshotFrom(repository);
    expect(snapshot.provenance.inputChecksum).toBe(
      decisionSnapshotInputChecksum({
        season,
        claimedFantasyTeamId: null,
        slotRules: [],
        rosterSnapshotIds: [],
        projectionSetIds: [],
        scoringProfileChecksum: null,
        marketSignalsChecksum: null,
        marketSignalAsOf: null,
        availabilityChecksum: null,
        availabilityAsOf: null,
        modeledFactsChecksum: null,
      }),
    );
  });

  it("cannot be mistaken for a persisted run's input hash over the same inputs", async () => {
    const snapshot = await snapshotFrom(new FakeRepository());
    const runInput = {
      algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
      leagueSeasonId: SEASON_ID,
      fantasyTeamId: TEAM_A_ID,
      week: 2,
      scoringRulesChecksum: null,
      slotRulesChecksum: null,
      rosterSnapshotIds: [SNAPSHOT_A_ID, SNAPSHOT_B_ID],
      projectionSetIds: [PROJECTION_SET_ID],
      marketSignalAsOf: null,
      availabilityAsOf: null,
    } as const;
    // Same function, different scope: the snapshot digest is namespaced away from every run kind.
    for (const kind of ["lineup", "waiver", "trade"] as const) {
      expect(snapshot.provenance.inputChecksum).not.toBe(
        recommendationInputChecksum({ ...runInput, kind }),
      );
    }
  });
});

// Any intentional response-contract change must renew this only after semantic assertions pass.
const SNAPSHOT_FINGERPRINT = "9d8481b12f47dcc3d6c73818abd37202c038898b403c51d0f09c60f9bff1b09c";
/**
 * A second guard strips the generated provenance fields so changes elsewhere in the response remain
 * independently visible.
 */
const SNAPSHOT_FINGERPRINT_WITHOUT_PROVENANCE =
  "238358ac0a4d6edd63b43d7f1504ec287683c3fbb614153bafdf0b0be2f985d7";

describe("InSeasonDecisionService snapshot stability", () => {
  it("produces a byte-identical snapshot for the frozen fixture", async () => {
    const snapshot = await new InSeasonDecisionService(new FakeRepository(), () => NOW).getSnapshot(
      USER_ID,
      LEAGUE_ID,
    );
    const serialized = JSON.stringify(snapshot);
    expect(createHash("sha256").update(serialized).digest("hex")).toBe(SNAPSHOT_FINGERPRINT);
  });

  it("keeps the response outside generated provenance byte-identical", async () => {
    const snapshot = await snapshotFrom(new FakeRepository());
    const { algorithmVersion, inputChecksum, ...rest } = snapshot.provenance;
    expect(algorithmVersion).toBe(RECOMMENDATION_ALGORITHM_VERSION);
    expect(inputChecksum).toMatch(/^[0-9a-f]{64}$/u);
    const stripped = JSON.stringify({ ...snapshot, provenance: rest });
    expect(createHash("sha256").update(stripped).digest("hex")).toBe(
      SNAPSHOT_FINGERPRINT_WITHOUT_PROVENANCE,
    );
  });

  it("emits only the three modeled generated package shapes", async () => {
    const snapshot = await new InSeasonDecisionService(new FakeRepository(), () => NOW).getSnapshot(
      USER_ID,
      LEAGUE_ID,
    );
    if (snapshot?.trades.state !== "available") throw new Error("Trades should be available");
    const shapes = [...snapshot.trades.bestForMe, ...snapshot.trades.fairest].map(
      (item) => item.shape,
    );
    expect(shapes.length).toBeGreaterThan(0);
    for (const shape of shapes) {
      expect(["1-for-1", "2-for-1", "1-for-2"]).toContain(shape);
    }
  });
});

const builderSlots: readonly RosterSlot[] = [
  {
    id: rosterSlotId("qb-1"),
    type: "QB",
    label: "QB",
    kind: "STARTER",
    eligiblePositions: ["QB"],
  },
  {
    id: rosterSlotId("rb-1"),
    type: "RB",
    label: "RB",
    kind: "STARTER",
    eligiblePositions: ["RB"],
  },
  {
    id: rosterSlotId("bn-1"),
    type: "BENCH",
    label: "BN",
    kind: "BENCH",
    eligiblePositions: ["QB", "RB"],
  },
];

function fixturePlayer(id: string, position: "QB" | "RB"): Player {
  return {
    id: playerId(id),
    name: projectionNames[id]![0],
    positions: [position],
    nflTeam: "MIA",
    status: "ACTIVE",
  };
}

const fixtureProjections = new Map<string, ProjectionValue>(
  Object.entries(projectionNames).map(([id, [, , mean]]) => [
    id,
    { mean, floor: mean - 3, ceiling: mean + 4 },
  ]),
);

function builderContext(locked: readonly string[] = []) {
  const rows = (snapshotId: string) =>
    rosterRows
      .filter((row) => row.snapshotId === snapshotId)
      .map((row) => ({
        ...row,
        locked: locked.includes(row.playerId),
      }));
  return {
    user: {
      team: teams[0]!,
      roster: [playerIds.aQbLow, playerIds.aRbOne, playerIds.aRbTwo].map((id) =>
        fixturePlayer(id, id === playerIds.aQbLow ? "QB" : "RB"),
      ),
      rosterRows: rows(SNAPSHOT_A_ID),
    },
    opponent: {
      team: teams[1]!,
      roster: [playerIds.bQbOne, playerIds.bQbTwo, playerIds.bRbLow].map((id) =>
        fixturePlayer(id, id === playerIds.bRbLow ? "RB" : "QB"),
      ),
      rosterRows: rows(SNAPSHOT_B_ID),
    },
    slots: builderSlots,
    starterSlots: builderSlots.filter((slot) => slot.kind === "STARTER"),
    horizons: [{ id: PROJECTION_SET_ID, label: "Week 2", weight: 1 }],
    projectionsByHorizon: { [PROJECTION_SET_ID]: fixtureProjections },
  };
}

describe("evaluateTradePackage", () => {
  it("scores both sides of a one-for-one package", () => {
    const evaluation = evaluateTradePackage(builderContext(), {
      sendsFromA: [playerId(playerIds.aRbTwo)],
      sendsFromB: [playerId(playerIds.bQbOne)],
    });

    expect(evaluation.legal).toBe(true);
    expect(evaluation.teamA?.teamId).toBe(TEAM_A_ID);
    expect(evaluation.teamB?.teamId).toBe(TEAM_B_ID);
    expect(evaluation.teamA?.forcedDropPlayerIds).toEqual([]);
    expect(evaluation.fairnessGap).toBeGreaterThanOrEqual(0);
  });

  it("reports NO_LEGAL_FORCED_DROP instead of throwing when every drop is protected", () => {
    const evaluation = evaluateTradePackage(builderContext([playerIds.aQbLow, playerIds.aRbOne]), {
      sendsFromA: [playerId(playerIds.aRbTwo)],
      sendsFromB: [playerId(playerIds.bQbOne), playerId(playerIds.bQbTwo)],
    });

    expect(evaluation.legal).toBe(false);
    expect(evaluation.teamA).toBeNull();
    expect(evaluation.diagnostics.map((item) => item.code)).toContain("NO_LEGAL_FORCED_DROP");
  });
});

describe("resolveTradeHorizons", () => {
  it("blends the weekly and rest-of-season horizons when a compatible release is supplied", () => {
    const rosProjections = new Map<string, ProjectionValue>([
      [playerIds.aRbOne, { mean: 180, floor: 150, ceiling: 210 }],
    ]);
    const resolved = resolveTradeHorizons(projectionSet, fixtureProjections, {
      id: ROS_SET_ID,
      label: "Rest of season",
      weight: 0.5,
      projections: rosProjections,
      unavailable: null,
    });

    expect(resolved.horizons).toEqual([
      { id: PROJECTION_SET_ID, label: "Week 2", weight: 1 },
      { id: ROS_SET_ID, label: "Rest of season", weight: 0.5 },
    ]);
    expect(resolved.projectionsByHorizon[ROS_SET_ID]).toBe(rosProjections);
    expect(resolved.rosUnavailable).toBeNull();
  });

  it("falls back to the weekly horizon with a stated reason when no release is available", () => {
    const resolved = resolveTradeHorizons(projectionSet, fixtureProjections, undefined);

    expect(resolved.horizons).toEqual([{ id: PROJECTION_SET_ID, label: "Week 2", weight: 1 }]);
    expect(resolved.rosUnavailable?.code).toBe("ROS_RELEASE_STATUS_UNAVAILABLE");
    expect(resolved.rosUnavailable?.message).toContain("Rest-of-season value is not included.");
  });

  it("never substitutes a set the release marked unusable", () => {
    const incompatible = {
      code: "ROS_SET_INCOMPATIBLE" as const,
      message: "The published rest-of-season set uses a different scoring profile.",
    };
    const resolved = resolveTradeHorizons(projectionSet, fixtureProjections, {
      id: ROS_SET_ID,
      label: "Rest of season",
      weight: 0.5,
      projections: new Map([[playerIds.aRbOne, { mean: 180, floor: 150, ceiling: 210 }]]),
      unavailable: incompatible,
    });

    expect(resolved.horizons).toHaveLength(1);
    expect(resolved.rosUnavailable).toEqual(incompatible);
  });

  it("refuses a release that would make the engine throw", () => {
    const duplicateId = resolveTradeHorizons(projectionSet, fixtureProjections, {
      id: PROJECTION_SET_ID,
      label: "Rest of season",
      weight: 0.5,
      projections: new Map([[playerIds.aRbOne, { mean: 180, floor: 150, ceiling: 210 }]]),
      unavailable: null,
    });
    expect(duplicateId.horizons).toHaveLength(1);
    expect(duplicateId.rosUnavailable?.code).toBe("ROS_SET_UNAVAILABLE");

    const emptyProjections = resolveTradeHorizons(projectionSet, fixtureProjections, {
      id: ROS_SET_ID,
      label: "Rest of season",
      weight: 0.5,
      projections: new Map(),
      unavailable: null,
    });
    expect(emptyProjections.horizons).toHaveLength(1);
    expect(emptyProjections.rosUnavailable?.code).toBe("ROS_SET_UNAVAILABLE");
  });
});

const builderRequest = {
  opponentTeamId: TEAM_B_ID,
  sendsPlayerIds: [playerIds.aRbTwo],
  receivesPlayerIds: [playerIds.bQbOne],
};

describe("InSeasonDecisionService.evaluateBuiltTrade", () => {
  it("returns not-found for a league the user is not a member of", async () => {
    const service = new InSeasonDecisionService(new FakeRepository(), () => NOW);
    await expect(
      service.evaluateBuiltTrade(OTHER_USER_ID, LEAGUE_ID, builderRequest),
    ).resolves.toEqual({ outcome: "not-found" });
  });

  it("evaluates a user-constructed package into the generated package shape", async () => {
    const service = new InSeasonDecisionService(new FakeRepository(), () => NOW);
    const result = await service.evaluateBuiltTrade(USER_ID, LEAGUE_ID, builderRequest);

    if (result.outcome !== "evaluated") throw new Error("Expected an evaluated package");
    expect(() => tradeEvaluationResponseSchema.parse(result.response)).not.toThrow();
    if (result.response.state !== "available") throw new Error("Expected an available response");
    expect(result.response.legal).toBe(true);
    expect(result.response.algorithmVersion).toBe("trade-builder-v1");
    expect(result.response.inputChecksum).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.response.package).toMatchObject({
      partner: { id: TEAM_B_ID, name: "The Isotoners" },
      shape: "1-for-1",
      send: [{ name: "Spare Back" }],
      receive: [{ name: "Lead Arm" }],
    });
    expect(result.response.rosUnavailable).not.toBeNull();
  });

  it("is deterministic for identical inputs", async () => {
    const service = new InSeasonDecisionService(new FakeRepository(), () => NOW);
    const first = await service.evaluateBuiltTrade(USER_ID, LEAGUE_ID, builderRequest);
    const second = await service.evaluateBuiltTrade(USER_ID, LEAGUE_ID, builderRequest);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("rejects a player that is on neither the claimed nor the opponent roster", async () => {
    const service = new InSeasonDecisionService(new FakeRepository(), () => NOW);

    await expect(
      service.evaluateBuiltTrade(USER_ID, LEAGUE_ID, {
        ...builderRequest,
        sendsPlayerIds: [playerIds.freeQb],
      }),
    ).resolves.toEqual({ outcome: "rejected", code: "PLAYER_NOT_ON_ROSTER" });

    await expect(
      service.evaluateBuiltTrade(USER_ID, LEAGUE_ID, {
        ...builderRequest,
        receivesPlayerIds: [playerIds.freeQb],
      }),
    ).resolves.toEqual({ outcome: "rejected", code: "PLAYER_NOT_ON_ROSTER" });
  });

  it("rejects a send that belongs to the opponent and a receive that belongs to the caller", async () => {
    const service = new InSeasonDecisionService(new FakeRepository(), () => NOW);

    await expect(
      service.evaluateBuiltTrade(USER_ID, LEAGUE_ID, {
        ...builderRequest,
        sendsPlayerIds: [playerIds.bQbTwo],
      }),
    ).resolves.toEqual({ outcome: "rejected", code: "PLAYER_NOT_ON_ROSTER" });

    await expect(
      service.evaluateBuiltTrade(USER_ID, LEAGUE_ID, {
        ...builderRequest,
        receivesPlayerIds: [playerIds.aRbOne],
      }),
    ).resolves.toEqual({ outcome: "rejected", code: "PLAYER_NOT_ON_ROSTER" });
  });

  it("rejects an opponent team that is not in the league season, including the caller's own team", async () => {
    const service = new InSeasonDecisionService(new FakeRepository(), () => NOW);

    await expect(
      service.evaluateBuiltTrade(USER_ID, LEAGUE_ID, {
        ...builderRequest,
        opponentTeamId: "40000000-0000-4000-8000-000000000009",
      }),
    ).resolves.toEqual({ outcome: "rejected", code: "OPPONENT_NOT_IN_LEAGUE" });

    await expect(
      service.evaluateBuiltTrade(USER_ID, LEAGUE_ID, {
        ...builderRequest,
        opponentTeamId: TEAM_A_ID,
      }),
    ).resolves.toEqual({ outcome: "rejected", code: "OPPONENT_NOT_IN_LEAGUE" });
  });

  it("returns NO_LEGAL_FORCED_DROP as a diagnostic, not an error", async () => {
    const repository = new FakeRepository();
    repository.rosterRows = rosterRows.map((row) =>
      row.playerId === playerIds.aQbLow || row.playerId === playerIds.aRbOne
        ? { ...row, locked: true }
        : row,
    );
    const result = await new InSeasonDecisionService(repository, () => NOW).evaluateBuiltTrade(
      USER_ID,
      LEAGUE_ID,
      {
        opponentTeamId: TEAM_B_ID,
        sendsPlayerIds: [playerIds.aRbTwo],
        receivesPlayerIds: [playerIds.bQbOne, playerIds.bQbTwo],
      },
    );

    if (result.outcome !== "evaluated") throw new Error("Expected an evaluated package");
    if (result.response.state !== "available") throw new Error("Expected an available response");
    expect(result.response.legal).toBe(false);
    expect(result.response.package).toBeNull();
    expect(result.response.diagnostics.map((item) => item.code)).toContain("NO_LEGAL_FORCED_DROP");
  });

  it("returns the shared unavailable reasons when league facts are missing", async () => {
    const repository = new FakeRepository();
    repository.projectionSets = [];
    const result = await new InSeasonDecisionService(repository, () => NOW).evaluateBuiltTrade(
      USER_ID,
      LEAGUE_ID,
      builderRequest,
    );

    if (result.outcome !== "evaluated") throw new Error("Expected an evaluated response");
    expect(result.response).toMatchObject({
      state: "unavailable",
      reasons: [{ code: "PROJECTIONS_MISSING" }],
    });
  });
});
