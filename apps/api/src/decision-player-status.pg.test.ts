/** Health presentation and fingerprints against a disposable database; never application data. */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createDatabase,
  dataSources,
  fantasyTeams,
  leagueMemberships,
  leagues,
  leagueSeasons,
  nflScheduleObservations,
  playerExternalIds,
  playerInjuryReportObservations,
  playerProjections,
  playerSourceObservations,
  players,
  projectionSets,
  rosterEntries,
  rosterSlotRules,
  rosterSnapshots,
  syncRuns,
  users,
} from "@laces-out/db";
import { inSeasonDecisionSnapshotSchema } from "@laces-out/contracts";
import { DrizzleInSeasonDecisionRepository, InSeasonDecisionService } from "@laces-out/decisions";
import { loadDecisionPlayerStatuses } from "../../../packages/decisions/src/decision-player-status.js";
import { DrizzleDecisionInboxRepository } from "./decision-inbox.js";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let dockerAvailable = true;
try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
} catch {
  dockerAvailable = false;
}
const NOW = new Date("2026-09-17T23:00:00Z");
const EARLIER = new Date("2026-09-17T22:00:00Z");
const checksum = "a".repeat(64);

describe.skipIf(!dockerAvailable)("decision health on PostgreSQL", () => {
  const container = `laces-health-pg-${randomUUID().slice(0, 8)}`;
  let handle: ReturnType<typeof createDatabase>;
  const owner = randomUUID(),
    league = randomUUID(),
    season = randomUUID(),
    team = randomUUID();
  const harvey = randomUUID(),
    tate = randomUUID(),
    alias = randomUUID();
  const sleeper = randomUUID(),
    injury = randomUUID(),
    schedule = randomUUID(),
    run = randomUUID();
  const snapshot = randomUUID(),
    set = randomUUID();
  let service: InSeasonDecisionService;
  const request = (playerIds = [harvey, tate]) => ({
    playerIds,
    leagueSeasonId: season,
    season: 2026,
    week: 2,
    now: NOW,
  });

  beforeAll(async () => {
    const password = randomBytes(16).toString("hex");
    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--name",
        container,
        "--cpus=1",
        "--tmpfs",
        "/var/lib/postgresql/data",
        "-e",
        "POSTGRES_USER=health",
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "-e",
        "POSTGRES_DB=health",
        "-p",
        "127.0.0.1::5432",
        "postgres:16",
      ],
      { stdio: "ignore" },
    );
    const port = Number(
      execFileSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" })
        .trim()
        .split(":")
        .pop(),
    );
    handle = createDatabase(`postgres://health:${password}@127.0.0.1:${port}/health`, 2);
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        execFileSync(
          "docker",
          ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "health", "-d", "health"],
          {
            stdio: "ignore",
          },
        );
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("Disposable health database unavailable");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    await migrate(handle.db, {
      migrationsFolder: fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url)),
    });
    await handle.db
      .insert(users)
      .values({ id: owner, email: "manager@health.test", displayName: "Manager" });
    await handle.db
      .insert(leagues)
      .values({ id: league, ownerUserId: owner, name: "Health checks" });
    await handle.db.insert(leagueSeasons).values({
      id: season,
      leagueId: league,
      provider: "espn",
      externalKey: "1234",
      season: 2026,
      currentWeek: 2,
      teamCount: 2,
      draftType: "snake",
    });
    await handle.db.insert(fantasyTeams).values([
      { id: team, leagueSeasonId: season, externalKey: "1", name: "Manager" },
      { leagueSeasonId: season, externalKey: "2", name: "Opponent" },
    ]);
    await handle.db
      .update(leagueMemberships)
      .set({ claimedFantasyTeamId: team })
      .where(eq(leagueMemberships.leagueId, league));
    await handle.db.insert(rosterSlotRules).values([
      {
        leagueSeasonId: season,
        slotCode: "FLEX",
        count: 1,
        eligiblePositions: ["RB", "WR", "TE"],
        isStarter: true,
      },
      {
        leagueSeasonId: season,
        slotCode: "BN",
        count: 1,
        eligiblePositions: ["RB", "WR", "TE"],
        isStarter: false,
      },
    ]);
    await handle.db.insert(players).values([
      {
        id: harvey,
        gsisId: "00-0040730",
        fullName: "RJ Harvey",
        primaryPosition: "RB",
        eligiblePositions: ["RB"],
        nflTeam: "DEN",
        status: "ACT",
      },
      {
        id: tate,
        gsisId: "00-0041438",
        fullName: "Carnell Tate",
        primaryPosition: "WR",
        eligiblePositions: ["WR"],
        nflTeam: "TEN",
        status: "ACT",
      },
      {
        id: alias,
        fullName: "R. Harvey",
        primaryPosition: "RB",
        eligiblePositions: ["RB"],
        nflTeam: "Den",
        status: "Q",
      },
    ]);
    await handle.db
      .insert(rosterSnapshots)
      .values({ id: snapshot, teamId: team, season: 2026, week: 2, effectiveAt: NOW });
    await handle.db.insert(rosterEntries).values([
      { snapshotId: snapshot, playerId: harvey, slotCode: "FLEX", isStarter: true },
      { snapshotId: snapshot, playerId: tate, slotCode: "BN", isStarter: false },
    ]);
    await handle.db.insert(projectionSets).values({
      id: set,
      leagueSeasonId: season,
      createdByUserId: owner,
      visibility: "league",
      source: "user-csv",
      version: "health-fixture",
      inputChecksum: checksum,
      season: 2026,
      week: 2,
      horizon: "week",
      windowStartWeek: 2,
      windowEndWeek: 2,
      asOfWeek: 1,
      asOfAt: NOW,
      fetchedAt: NOW,
      createdAt: NOW,
      metadata: {},
    });
    await handle.db.insert(playerProjections).values([
      {
        projectionSetId: set,
        playerId: harvey,
        meanPoints: "9.242",
        floorPoints: "3.148",
        ceilingPoints: "16.215",
        confidence: "0.49",
      },
      {
        projectionSetId: set,
        playerId: tate,
        meanPoints: "6.021",
        floorPoints: "1.171",
        ceilingPoints: "11.139",
        confidence: "0.49",
      },
    ]);
    await handle.db.insert(dataSources).values(
      [
        [sleeper, "sleeper.players"],
        [injury, "nflverse.injuries.2026"],
        [schedule, "nflverse.schedules.2026"],
      ].map(([id, key]) => ({
        id,
        key: key!,
        name: key!,
        kind: "fixture",
        lastChecksum: checksum,
        lastCheckedAt: NOW,
        lastChangedAt: EARLIER,
        lastSuccessfulAt: NOW,
        checkIntervalMinutes: 60,
      })),
    );
    await handle.db.insert(syncRuns).values({ id: run, kind: "fixture", idempotencyKey: run });
    await handle.db.insert(nflScheduleObservations).values(
      [
        { externalGameId: "2026_02_JAX_DEN", homeTeam: "DEN", awayTeam: "JAX" },
        { externalGameId: "2026_02_PHI_TEN", homeTeam: "TEN", awayTeam: "PHI" },
      ].map((game) => ({
        ...game,
        sourceId: schedule,
        sourceSyncRunId: run,
        season: 2026,
        week: 2,
        seasonType: "REG" as const,
        gameDate: "2026-09-20",
        startTimeEastern: "16:05",
        timeTbd: false,
        kickoffAt: new Date("2026-09-20T20:05:00Z"),
        status: "scheduled" as const,
        sourceAsOf: NOW,
        fetchedAt: NOW,
        inputChecksum: checksum,
      })),
    );
    await handle.db.insert(playerSourceObservations).values([
      {
        sourceId: sleeper,
        externalPlayerId: "12489",
        playerId: harvey,
        gsisId: "00-0040730",
        fullName: "RJ Harvey",
        nflTeam: "DEN",
        primaryPosition: "RB",
        eligiblePositions: ["RB"],
        status: "Active",
        injuryStatus: "Questionable",
        observedAt: EARLIER,
      },
      {
        sourceId: sleeper,
        externalPlayerId: "13279",
        playerId: tate,
        gsisId: "00-0041438",
        fullName: "Carnell Tate",
        nflTeam: "TEN",
        primaryPosition: "WR",
        eligiblePositions: ["WR"],
        status: "Active",
        observedAt: EARLIER,
      },
    ]);
    service = new InSeasonDecisionService(
      new DrizzleInSeasonDecisionRepository(handle.db),
      () => NOW,
    );
  }, 60_000);

  beforeEach(async () => {
    await handle.db.update(dataSources).set({
      enabled: true,
      lastChecksum: checksum,
      lastCheckedAt: NOW,
      lastChangedAt: EARLIER,
      lastSuccessfulAt: NOW,
      consecutiveFailures: 0,
      metadata: {},
    });
    await handle.db
      .update(playerSourceObservations)
      .set({ injuryStatus: "Questionable", observedAt: EARLIER })
      .where(eq(playerSourceObservations.playerId, harvey));
    // Isolated fixture reset; production observations remain append-only.
    await handle.db.execute(sql`truncate table player_injury_report_observations`);
    await handle.db.delete(playerExternalIds);
    await handle.db.update(players).set({ status: "ACT" }).where(eq(players.id, harvey));
    await handle.db
      .update(players)
      .set({
        fullName: "R. Harvey",
        nflTeam: "Den",
        primaryPosition: "RB",
        eligiblePositions: ["RB"],
      })
      .where(eq(players.id, alias));
  });
  afterAll(async () => {
    await handle?.close();
    try {
      execFileSync("docker", ["rm", "-f", "-v", container], { stdio: "ignore" });
    } catch {
      /* Already removed. */
    }
  }, 30_000);

  it("serializes canonical ACT plus fresh Sleeper Q and fingerprints a later healthy recovery without changing points", async () => {
    const before = inSeasonDecisionSnapshotSchema.parse(await service.getSnapshot(owner, league));
    if (before.lineup.state !== "available") throw new Error(JSON.stringify(before.lineup));
    expect(before.lineup.assignments[0]?.player).toMatchObject({
      id: harvey,
      status: "QUESTIONABLE",
      projectedPoints: 9.242,
    });
    expect(before.lineup.notes.join(" ")).toContain("RJ Harvey is questionable");
    const inboxRepository = new DrizzleDecisionInboxRepository(handle.db);
    const access = await inboxRepository.findAccess(owner, league);
    await handle.db
      .update(playerSourceObservations)
      .set({ injuryStatus: null, observedAt: NOW })
      .where(eq(playerSourceObservations.playerId, harvey));
    await handle.db
      .update(dataSources)
      .set({ lastChecksum: "b".repeat(64), lastChangedAt: NOW })
      .where(eq(dataSources.id, sleeper));
    const after = inSeasonDecisionSnapshotSchema.parse(await service.getSnapshot(owner, league));
    if (after.lineup.state !== "available") throw new Error("Expected available lineup");
    expect(after.lineup.assignments[0]?.player.status).toBe("ACTIVE");
    expect(after.lineup.optimalProjectedPoints).toBe(before.lineup.optimalProjectedPoints);
    expect(after.provenance.inputChecksum).not.toBe(before.provenance.inputChecksum);
    expect((await inboxRepository.findAccess(owner, league))?.revision).not.toBe(access?.revision);
  });

  it("does not resurrect stale or retired injury rows and distinguishes a current out designation", async () => {
    await handle.db
      .update(dataSources)
      .set({
        lastCheckedAt: new Date("2026-09-16T12:00:00Z"),
        lastChangedAt: new Date("2026-09-16T12:00:00Z"),
        lastSuccessfulAt: new Date("2026-09-16T12:00:00Z"),
      })
      .where(eq(dataSources.id, sleeper));
    expect((await loadDecisionPlayerStatuses(handle.db, request())).get(harvey)).toBe("UNKNOWN");
    await handle.db
      .update(dataSources)
      .set({ lastCheckedAt: NOW, lastChangedAt: EARLIER, lastSuccessfulAt: NOW })
      .where(eq(dataSources.id, sleeper));
    const injuryRow = {
      sourceId: injury,
      sourceSyncRunId: run,
      externalPlayerId: "00-0040730",
      playerId: harvey,
      season: 2026,
      week: 2,
      seasonType: "REG" as const,
      gameType: "REG" as const,
      team: "DEN",
      position: "RB",
      reportStatus: "out",
      stateKey: "e".repeat(64),
      fetchedAt: NOW,
      inputChecksum: "f".repeat(64),
    };
    await handle.db.insert(playerInjuryReportObservations).values(injuryRow);
    expect((await loadDecisionPlayerStatuses(handle.db, request())).get(harvey)).toBe(
      "QUESTIONABLE",
    );
    await handle.db
      .insert(playerInjuryReportObservations)
      .values({ ...injuryRow, inputChecksum: checksum });
    expect((await loadDecisionPlayerStatuses(handle.db, request())).get(harvey)).toBe("OUT");
    await handle.db
      .insert(playerInjuryReportObservations)
      .values({ ...injuryRow, week: 1, inputChecksum: "c".repeat(64) });
    await handle.db
      .update(dataSources)
      .set({ lastChecksum: "c".repeat(64) })
      .where(eq(dataSources.id, injury));
    expect((await loadDecisionPlayerStatuses(handle.db, request())).get(harvey)).toBe(
      "QUESTIONABLE",
    );
  });

  it("uses only a unique current-league provider alias and never borrows another league's identity", async () => {
    await handle.db.insert(playerExternalIds).values([
      { playerId: harvey, source: "sleeper-espn", externalId: "4841630" },
      { playerId: alias, source: "espn-self-asserted", externalId: `${randomUUID()}:4841630` },
    ]);
    expect((await loadDecisionPlayerStatuses(handle.db, request([alias]))).get(alias)).toBe(
      "UNKNOWN",
    );
    await handle.db
      .update(playerExternalIds)
      .set({ externalId: `${season}:4841630` })
      .where(eq(playerExternalIds.playerId, alias));
    expect((await loadDecisionPlayerStatuses(handle.db, request([alias]))).get(alias)).toBe(
      "QUESTIONABLE",
    );
    await handle.db
      .update(players)
      .set({ primaryPosition: "WR", eligiblePositions: ["WR"] })
      .where(eq(players.id, alias));
    expect((await loadDecisionPlayerStatuses(handle.db, request([alias]))).get(alias)).toBe(
      "UNKNOWN",
    );
  });
  it("ignores an omitted old catalog row after a new source epoch, even when the source is healthy", async () => {
    await handle.db
      .update(dataSources)
      .set({ lastChangedAt: NOW })
      .where(eq(dataSources.id, sleeper));
    expect((await loadDecisionPlayerStatuses(handle.db, request())).get(harvey)).toBe("UNKNOWN");
  });

  it.each(["cancelled", "postponed"] as const)(
    "does not let a prior %s game block current-week health",
    async (status) => {
      const [game] = await handle.db.select().from(nflScheduleObservations).limit(1);
      await handle.db.insert(nflScheduleObservations).values({
        ...game!,
        id: randomUUID(),
        externalGameId: `2026_01_${status}`,
        week: 1,
        status,
      });
      expect((await loadDecisionPlayerStatuses(handle.db, request())).get(harvey)).toBe(
        "QUESTIONABLE",
      );
    },
  );

  it.each(["OUT", "IR"])(
    "surfaces unresolved prior %s during a source outage instead of reporting healthy",
    async (status) => {
      await handle.db.update(players).set({ status }).where(eq(players.id, harvey));
      await handle.db
        .update(dataSources)
        .set({ consecutiveFailures: 1 })
        .where(eq(dataSources.id, sleeper));
      const result = inSeasonDecisionSnapshotSchema.parse(await service.getSnapshot(owner, league));
      if (result.lineup.state !== "available") throw new Error(JSON.stringify(result.lineup));
      expect(result.lineup.assignments[0]?.player.status).toBe("UNKNOWN");
      expect(result.lineup.notes.join(" ")).toContain(
        `last stored designation was ${status.toLowerCase()}`,
      );
      expect(result.lineup.notes.join(" ")).toContain("could not be verified");
      expect(result.lineup.assignments[0]?.player.projectedPoints).toBe(9.242);
    },
  );

  it("does not turn limited practice alone into an official Questionable designation", async () => {
    await handle.db
      .update(playerSourceObservations)
      .set({ injuryStatus: null, practiceParticipation: "Limited" })
      .where(eq(playerSourceObservations.playerId, harvey));
    expect((await loadDecisionPlayerStatuses(handle.db, request())).get(harvey)).toBe("ACTIVE");
  });
  it("uses current canonical NFL Out evidence when Sleeper alone is unavailable", async () => {
    await handle.db
      .update(dataSources)
      .set({ consecutiveFailures: 1 })
      .where(eq(dataSources.id, sleeper));
    await handle.db.insert(playerInjuryReportObservations).values({
      sourceId: injury,
      sourceSyncRunId: run,
      externalPlayerId: "00-0040730",
      playerId: harvey,
      season: 2026,
      week: 2,
      seasonType: "REG",
      gameType: "REG",
      team: "DEN",
      position: "RB",
      reportStatus: "out",
      stateKey: "e".repeat(64),
      fetchedAt: NOW,
      inputChecksum: checksum,
    });
    await handle.db
      .update(playerSourceObservations)
      .set({ injuryStatus: null, observedAt: NOW })
      .where(eq(playerSourceObservations.playerId, harvey));
    expect((await loadDecisionPlayerStatuses(handle.db, request())).get(harvey)).toBe("OUT");
  });

  it("isolates duplicate catalog health evidence to that player without hiding another player's injury", async () => {
    const [existing] = await handle.db
      .select()
      .from(playerSourceObservations)
      .where(eq(playerSourceObservations.playerId, tate));
    await handle.db
      .insert(playerSourceObservations)
      .values({ ...existing!, externalPlayerId: "duplicate-tate", injuryStatus: "Out" });
    await handle.db
      .update(players)
      .set({
        fullName: "C. Tate",
        nflTeam: "TEN",
        primaryPosition: "WR",
        eligiblePositions: ["WR"],
      })
      .where(eq(players.id, alias));
    await handle.db.insert(playerExternalIds).values([
      { playerId: tate, source: "sleeper-espn", externalId: "tate-provider" },
      { playerId: alias, source: "espn-self-asserted", externalId: `${season}:tate-provider` },
    ]);
    const result = await loadDecisionPlayerStatuses(handle.db, request([harvey, tate, alias]));
    expect(result.get(tate)).toBe("UNKNOWN");
    expect(result.get(alias)).toBe("UNKNOWN");
    expect(result.get(harvey)).toBe("QUESTIONABLE");
  });
});
