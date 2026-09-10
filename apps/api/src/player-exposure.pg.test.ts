/** Membership and roster selection against a disposable database; never uses application data. */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  createDatabase,
  fantasyTeams,
  leagueMemberships,
  leagues,
  leagueSeasons,
  players,
  rosterEntries,
  rosterSnapshots,
  users,
} from "@laces-out/db";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DrizzlePlayerExposureRepository, PlayerExposureService } from "./player-exposure.js";

function dockerAvailable() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const NOW = new Date("2026-09-10T12:00:00.000Z");

describe.skipIf(!dockerAvailable())("Player exposure against disposable PostgreSQL", () => {
  const containerName = `laces-out-exposure-pg-${randomUUID().slice(0, 8)}`;
  let handle: ReturnType<typeof createDatabase>;
  let service: PlayerExposureService;
  let userId: string;
  let ownerId: string;
  let otherUserId: string;
  let sharedPlayerId: string;
  let otherPlayerId: string;

  beforeAll(async () => {
    const password = randomBytes(16).toString("hex");
    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--name",
        containerName,
        "--cpus=1",
        "--tmpfs",
        "/var/lib/postgresql/data",
        "-e",
        "POSTGRES_USER=exposure_test",
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "-e",
        "POSTGRES_DB=exposure_test",
        "-p",
        "127.0.0.1::5432",
        "postgres:16",
      ],
      { stdio: "ignore" },
    );
    const port = Number(
      execFileSync("docker", ["port", containerName, "5432/tcp"], { encoding: "utf8" })
        .trim()
        .split(":")
        .pop(),
    );
    if (!Number.isInteger(port) || port <= 0) throw new Error("Disposable database port missing");
    handle = createDatabase(
      `postgres://exposure_test:${password}@127.0.0.1:${port}/exposure_test`,
      2,
    );
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        execFileSync(
          "docker",
          [
            "exec",
            containerName,
            "pg_isready",
            "-h",
            "127.0.0.1",
            "-U",
            "exposure_test",
            "-d",
            "exposure_test",
          ],
          { stdio: "ignore" },
        );
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("Disposable database did not start");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    await migrate(handle.db, {
      migrationsFolder: fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url)),
    });
    service = new PlayerExposureService(new DrizzlePlayerExposureRepository(handle.db), () => NOW);
  }, 60_000);

  beforeEach(async () => {
    userId = randomUUID();
    ownerId = randomUUID();
    otherUserId = randomUUID();
    sharedPlayerId = randomUUID();
    otherPlayerId = randomUUID();
    await handle.db.insert(users).values(
      [userId, ownerId, otherUserId].map((id) => ({
        id,
        email: `${id}@exposure.test`,
        displayName: "Manager",
      })),
    );
    await handle.db.insert(players).values(
      [sharedPlayerId, otherPlayerId].map((id) => ({
        id,
        fullName: "Same Name",
        primaryPosition: "WR",
        eligiblePositions: ["WR"],
        nflTeam: "CIN",
      })),
    );
  });

  afterAll(async () => {
    await handle?.close();
    try {
      execFileSync("docker", ["rm", "-f", "-v", containerName], { stdio: "ignore" });
    } catch {
      /* --rm also cleans stopped containers. */
    }
  }, 30_000);

  async function addLeague(
    options: {
      season?: number;
      archived?: boolean;
      claim?: boolean;
      member?: boolean;
      noSeason?: boolean;
      empty?: boolean;
      missing?: boolean;
    } = {},
  ) {
    const leagueId = randomUUID();
    const seasonId = randomUUID();
    const teamId = randomUUID();
    await handle.db.insert(leagues).values({
      id: leagueId,
      ownerUserId: ownerId,
      name: `League ${leagueId}`,
      archived: options.archived ?? false,
    });
    if (!options.noSeason) {
      await handle.db.insert(leagueSeasons).values({
        id: seasonId,
        leagueId,
        provider: "espn",
        externalKey: leagueId,
        season: options.season ?? 2026,
        currentWeek: 1,
        teamCount: 2,
        draftType: "snake",
        updatedAt: NOW,
      });
      await handle.db.insert(fantasyTeams).values({
        id: teamId,
        leagueSeasonId: seasonId,
        externalKey: "1",
        name: "Claimed team",
        isUserTeam: true,
      });
      if (!options.missing)
        await addSnapshot(
          teamId,
          options.season ?? 2026,
          options.empty ? [] : [{ id: sharedPlayerId, starter: true }],
        );
    }
    if (options.member !== false)
      await handle.db.insert(leagueMemberships).values({
        leagueId,
        userId,
        role: "member",
        claimedFantasyTeamId: options.claim === false || options.noSeason ? null : teamId,
      });
    return { leagueId, seasonId, teamId };
  }

  async function addSnapshot(
    teamId: string,
    season: number,
    entries: { id: string; starter: boolean }[],
    options: { id?: string; effectiveAt?: Date; createdAt?: Date } = {},
  ) {
    const snapshotId = options.id ?? randomUUID();
    await handle.db.insert(rosterSnapshots).values({
      id: snapshotId,
      teamId,
      season,
      week: 1,
      effectiveAt: options.effectiveAt ?? NOW,
      createdAt: options.createdAt ?? NOW,
    });
    if (entries.length)
      await handle.db.insert(rosterEntries).values(
        entries.map((entry) => ({
          snapshotId,
          playerId: entry.id,
          isStarter: entry.starter,
          slotCode: entry.starter ? "WR" : "BN",
        })),
      );
    return snapshotId;
  }

  it("aggregates only claimed teams, shares canonical identity across leagues, and keeps empty snapshots in the denominator", async () => {
    const first = await addLeague();
    const second = await addLeague({ missing: true });
    await addSnapshot(second.teamId, 2026, [
      { id: sharedPlayerId, starter: false },
      { id: otherPlayerId, starter: true },
    ]);
    await addLeague({ empty: true });
    const missing = await addLeague({ missing: true });
    const unclaimed = await addLeague({ claim: false });
    const foreign = await addLeague({ member: false });
    const otherTeam = randomUUID();
    await handle.db.insert(fantasyTeams).values({
      id: otherTeam,
      leagueSeasonId: first.seasonId,
      externalKey: "2",
      name: "Another manager",
    });
    await handle.db.insert(leagueMemberships).values({
      leagueId: first.leagueId,
      userId: otherUserId,
      role: "member",
      claimedFantasyTeamId: otherTeam,
    });
    await addSnapshot(otherTeam, 2026, [{ id: otherPlayerId, starter: true }]);

    const result = await service.getExposure(userId);
    expect(result.leagues).toHaveLength(5);
    expect(result.leagues.some((league) => league.id === foreign.leagueId)).toBe(false);
    expect(result.leagues.find((league) => league.id === missing.leagueId)?.status).toBe(
      "roster-missing",
    );
    expect(result.leagues.find((league) => league.id === unclaimed.leagueId)?.status).toBe(
      "team-unclaimed",
    );
    expect(result.players).toHaveLength(2);
    expect(result.players.find((player) => player.id === sharedPlayerId)).toMatchObject({
      leagueIds: [first.leagueId, second.leagueId].sort(),
      starterLeagueIds: [first.leagueId],
      rosterPercentage: 67,
    });
    expect(result.players.find((player) => player.id === otherPlayerId)).toMatchObject({
      leagueIds: [second.leagueId],
      starterLeagueIds: [second.leagueId],
      rosterPercentage: 33,
    });
    const other = await service.getExposure(otherUserId);
    expect(other.players.map((player) => player.id)).toEqual([otherPlayerId]);
    expect(other.leagues).toHaveLength(1);
    expect((await service.getExposure(randomUUID())).leagues).toEqual([]);
  });

  it("excludes historical and archived seasons, missing seasons, and claims outside the latest season", async () => {
    const current = await addLeague();
    const historical = await addLeague({ season: 2025 });
    const archived = await addLeague({ season: 2027, archived: true });
    const noSeason = await addLeague({ noSeason: true });
    const staleClaim = await addLeague({ season: 2025 });
    await handle.db.insert(leagueSeasons).values({
      leagueId: staleClaim.leagueId,
      provider: "espn",
      externalKey: staleClaim.leagueId,
      season: 2026,
      teamCount: 2,
      draftType: "snake",
      updatedAt: NOW,
    });
    const result = await service.getExposure(userId);
    expect(result.season).toBe(2026);
    expect(Object.fromEntries(result.leagues.map((league) => [league.id, league.status]))).toEqual({
      [current.leagueId]: "included",
      [historical.leagueId]: "other-season",
      [archived.leagueId]: "archived",
      [noSeason.leagueId]: "no-season",
      [staleClaim.leagueId]: "team-unclaimed",
    });
    expect(result.leagues.find((league) => league.id === staleClaim.leagueId)?.teamId).toBeNull();
    expect(result.players[0]?.leagueIds).toEqual([current.leagueId]);
    expect(result.players[0]?.rosterPercentage).toBe(100);
  });

  it("selects roster snapshots deterministically, filters their season, and treats a newer empty roster as authoritative", async () => {
    const league = await addLeague({ missing: true });
    const older = new Date("2026-09-09T12:00:00.000Z");
    const later = new Date("2026-09-11T12:00:00.000Z");
    await addSnapshot(league.teamId, 2026, [{ id: otherPlayerId, starter: true }], {
      effectiveAt: older,
      createdAt: later,
    });
    await addSnapshot(league.teamId, 2026, [{ id: otherPlayerId, starter: true }], {
      createdAt: older,
    });
    await addSnapshot(league.teamId, 2026, [{ id: otherPlayerId, starter: true }], {
      id: "30000000-0000-4000-8000-000000000001",
    });
    await addSnapshot(league.teamId, 2026, [{ id: sharedPlayerId, starter: false }], {
      id: "30000000-0000-4000-8000-000000000002",
    });
    await addSnapshot(league.teamId, 2025, [{ id: otherPlayerId, starter: true }], {
      effectiveAt: later,
    });
    expect((await service.getExposure(userId)).players.map((player) => player.id)).toEqual([
      sharedPlayerId,
    ]);
    await addSnapshot(league.teamId, 2026, [], { effectiveAt: later });
    const empty = await service.getExposure(userId);
    expect(empty.players).toEqual([]);
    expect(empty.leagues[0]?.status).toBe("included");
    expect(empty.leagues[0]?.rosterUpdatedAt).toBe(later.toISOString());
  });

  it("immediately reflects claim changes and revoked membership without returning previous-account rosters", async () => {
    const league = await addLeague();
    expect((await service.getExposure(userId)).players[0]?.id).toBe(sharedPlayerId);
    const replacementTeamId = randomUUID();
    await handle.db.insert(fantasyTeams).values({
      id: replacementTeamId,
      leagueSeasonId: league.seasonId,
      externalKey: "replacement",
      name: "New claim",
    });
    await addSnapshot(replacementTeamId, 2026, [{ id: otherPlayerId, starter: false }]);
    const membership = and(
      eq(leagueMemberships.userId, userId),
      eq(leagueMemberships.leagueId, league.leagueId),
    );
    await handle.db
      .update(leagueMemberships)
      .set({ claimedFantasyTeamId: replacementTeamId })
      .where(membership);
    expect((await service.getExposure(userId)).players.map((player) => player.id)).toEqual([
      otherPlayerId,
    ]);
    await handle.db.delete(leagueMemberships).where(membership);
    expect(await service.getExposure(userId)).toEqual({
      generatedAt: NOW.toISOString(),
      season: null,
      leagues: [],
      players: [],
    });
  });

  it("matches dashboard season selection when an older season row was updated more recently", async () => {
    const league = await addLeague();
    await handle.db
      .update(leagueSeasons)
      .set({ createdAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: NOW })
      .where(eq(leagueSeasons.id, league.seasonId));
    await handle.db.insert(leagueSeasons).values({
      leagueId: league.leagueId,
      provider: "yahoo",
      externalKey: randomUUID(),
      season: 2026,
      teamCount: 2,
      draftType: "snake",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: new Date("2026-09-02T00:00:00.000Z"),
    });
    const result = await service.getExposure(userId);
    expect(result.leagues[0]).toMatchObject({
      status: "included",
      teamId: league.teamId,
      provider: "espn",
    });
    expect(result.players.map((player) => player.id)).toEqual([sharedPlayerId]);
  });
});
