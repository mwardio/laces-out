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
import { describe, expect, it, vi } from "vitest";

import {
  InSeasonDecisionService,
  RECOMMENDATION_ALGORITHM_VERSION,
  decisionSnapshotInputChecksum,
  evaluateTradePackage,
  recommendationInputChecksum,
  resolveTradeHorizons,
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
  slotRules: readonly DecisionSlotRuleRow[] = slotRules;
  snapshots: readonly DecisionRosterSnapshotRow[] = snapshots;
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
    ]);
    for (const variant of variants) expect(variant).not.toBe(reference);
    expect(new Set(variants).size).toBe(variants.length);
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

  it("is computed from the declared inputs and nothing else", async () => {
    const snapshot = await snapshotFrom(new FakeRepository());
    expect(snapshot.provenance.inputChecksum).toBe(
      decisionSnapshotInputChecksum({
        season,
        claimedFantasyTeamId: TEAM_A_ID,
        slotRules,
        rosterSnapshotIds: [SNAPSHOT_A_ID, SNAPSHOT_B_ID],
        projectionSetId: PROJECTION_SET_ID,
        availabilityAsOf: null,
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

// Frozen by Task 3.1. Any change here means a refactor altered snapshot output.
const SNAPSHOT_FINGERPRINT = "cf65116d0f53bdc556dd5eb9c402cd5f040a66e2a2bda432dfb0f863ffe14386";
/**
 * The same fixture's fingerprint before the snapshot carried ADR 0003 provenance. Stripping the two
 * fields it gained has to reproduce this byte for byte: adding provenance may not move anything else.
 */
const SNAPSHOT_FINGERPRINT_WITHOUT_PROVENANCE =
  "70b8b600588669c3735c5fce346efd11c396d1414af918072431195f3627b9e6";

describe("InSeasonDecisionService snapshot stability", () => {
  it("produces a byte-identical snapshot for the frozen fixture", async () => {
    const snapshot = await new InSeasonDecisionService(new FakeRepository(), () => NOW).getSnapshot(
      USER_ID,
      LEAGUE_ID,
    );
    const serialized = JSON.stringify(snapshot);
    expect(createHash("sha256").update(serialized).digest("hex")).toBe(SNAPSHOT_FINGERPRINT);
  });

  it("changed from the pre-provenance fingerprint by exactly the two added fields", async () => {
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

const ROS_SET_ID = "60000000-0000-4000-8000-000000000002";

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
