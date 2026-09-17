/** Projection history and player access against a disposable DB; never uses application data. */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  projectionPlayerListResponseSchema,
  projectionSetListResponseSchema,
} from "@laces-out/contracts";
import {
  createDatabase,
  leagues,
  leagueSeasons,
  playerExternalIds,
  playerProjections,
  players,
  projectionSets,
  scoringRules,
  users,
} from "@laces-out/db";
import { DrizzleInSeasonDecisionRepository } from "@laces-out/decisions";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DrizzleProjectionImportRepository, ProjectionImportService } from "./projection-import.js";

function dockerAvailable() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const NOW = new Date("2026-09-11T12:00:00.000Z");

describe.skipIf(!dockerAvailable())("Projection history against disposable PostgreSQL", () => {
  const containerName = `laces-out-projections-pg-${randomUUID().slice(0, 8)}`;
  let handle: ReturnType<typeof createDatabase>;
  let repository: DrizzleProjectionImportRepository;
  let service: ProjectionImportService;
  let userId: string;
  let otherUserId: string;
  let seasonId: string;
  let playerId: string;

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
        "POSTGRES_USER=projections_test",
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "-e",
        "POSTGRES_DB=projections_test",
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
      `postgres://projections_test:${password}@127.0.0.1:${port}/projections_test`,
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
            "projections_test",
            "-d",
            "projections_test",
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
    repository = new DrizzleProjectionImportRepository(handle.db);
    service = new ProjectionImportService(repository, () => NOW);
  }, 60_000);

  beforeEach(async () => {
    userId = randomUUID();
    otherUserId = randomUUID();
    seasonId = randomUUID();
    playerId = randomUUID();
    const leagueId = randomUUID();
    await handle.db.insert(users).values(
      [userId, otherUserId].map((id) => ({
        id,
        email: `${id}@projections.test`,
        displayName: "Manager",
      })),
    );
    await handle.db.insert(leagues).values({ id: leagueId, ownerUserId: userId, name: "History" });
    await handle.db.insert(leagueSeasons).values({
      id: seasonId,
      leagueId,
      provider: "espn",
      externalKey: leagueId,
      season: 2026,
      currentWeek: 2,
      teamCount: 2,
      draftType: "snake",
    });
    // The owner membership is created by the database trigger.
    await handle.db.insert(players).values({
      id: playerId,
      fullName: "Saved Receiver",
      primaryPosition: "WR",
      eligiblePositions: ["WR"],
    });
  });

  afterAll(async () => {
    await handle?.close();
    try {
      execFileSync("docker", ["rm", "-f", "-v", containerName], { stdio: "ignore" });
    } catch {
      /* --rm also cleans stopped containers. */
    }
  }, 30_000);

  function setRow(horizon: "week" | "rest-of-season" | "full-season", createdAt: Date) {
    return {
      id: randomUUID(),
      leagueSeasonId: seasonId,
      visibility: "league" as const,
      source: horizon === "week" ? "laces-out-first-party" : "laces-out-first-party-ros",
      version: randomUUID(),
      season: 2026,
      week: horizon === "week" ? 2 : null,
      horizon,
      windowStartWeek: 2,
      windowEndWeek: horizon === "week" ? 2 : 18,
      asOfWeek: 1,
      asOfAt: createdAt,
      fetchedAt: createdAt,
      createdAt,
      inputChecksum: randomBytes(32).toString("hex"),
      metadata: {
        releaseCompleteness: "full",
        preservePriorGoodSet: false,
        modelVersion: "laces-ros-distribution-v8",
      },
    };
  }

  it("marks saved weekly and ROS sets as history immediately after an exact scoring change and keeps authorized player access", async () => {
    const [rule] = await handle.db
      .insert(scoringRules)
      .values({
        leagueSeasonId: seasonId,
        statKey: "42",
        providerStatId: "42",
        operation: "multiply",
        points: "0.1",
      })
      .returning();
    const key = await repository.currentScoringProfileKey(seasonId);
    expect(key).not.toBeNull();
    const saved = (["week", "rest-of-season"] as const).map((horizon) => {
      const row = setRow(horizon, NOW);
      return {
        ...row,
        metadata: { ...row.metadata, scoringProfileKey: key, qualityState: "publishable" },
      };
    });
    await handle.db.insert(projectionSets).values(saved);
    await handle.db
      .insert(playerProjections)
      .values(saved.map((row) => ({ projectionSetId: row.id, playerId, meanPoints: "20" })));
    expect(
      (await service.list(userId, seasonId)).projectionSets.map(
        (row) => row.managed?.scoringCompatibility,
      ),
    ).toEqual(["current", "current"]);
    // Exact decimal semantics matter; this is not a change to a coarse PPR label.
    await handle.db
      .update(scoringRules)
      .set({ points: "0.1000001" })
      .where(eq(scoringRules.id, rule!.id));
    const changed = projectionSetListResponseSchema.parse(await service.list(userId, seasonId));
    expect(changed.managedForecastStatus).toMatchObject({ state: "withheld", qualityState: null });
    expect(changed.managedForecastStatus.reasons.join(" ")).toContain("League scoring changed");
    expect(changed.projectionSets.map((row) => row.managed?.scoringCompatibility)).toEqual([
      "changed",
      "changed",
    ]);
    for (const row of saved) {
      const detail = await service.getPlayers(userId, seasonId, row.id);
      expect(detail.projectionSet.managed?.scoringCompatibility).toBe("changed");
      expect(detail.players[0]?.meanPoints).toBe(20);
      await expect(service.getPlayers(otherUserId, seasonId, row.id)).rejects.toMatchObject({
        statusCode: 404,
      });
    }
    // An older model's exact-scoring release remains compatible even with no new model admission.
    await handle.db
      .update(scoringRules)
      .set({ points: "0.1" })
      .where(eq(scoringRules.id, rule!.id));
    expect((await service.list(userId, seasonId)).managedForecastStatus.state).toBe("published");
    expect(
      (await service.getPlayers(userId, seasonId, saved[1]!.id)).projectionSet.managed,
    ).toMatchObject({ scoringCompatibility: "current", modelVersion: "laces-ros-distribution-v8" });
  });

  it.each(["week", "rest-of-season"] as const)(
    "retains the other horizon and loads its players after 150 newer %s sets",
    async (busyHorizon) => {
      const retainedHorizon = busyHorizon === "week" ? "rest-of-season" : "week";
      const retained = setRow(retainedHorizon, new Date("2026-09-08T06:30:00.000Z"));
      // Equal timestamps also exercise the deterministic ID tie breaker.
      const busy = Array.from({ length: 150 }, () => setRow(busyHorizon, NOW));
      const privateSet = {
        ...setRow(retainedHorizon, NOW),
        visibility: "private" as const,
        createdByUserId: otherUserId,
      };
      const unsupported = setRow("full-season", NOW);
      await handle.db.insert(projectionSets).values([retained, ...busy, privateSet, unsupported]);
      await handle.db.insert(playerProjections).values(
        [retained, ...busy].map((set) => ({
          projectionSetId: set.id,
          playerId,
          meanPoints: "180.5",
        })),
      );

      const list = projectionSetListResponseSchema.parse(await service.list(userId, seasonId));
      const expectedBusy = busy
        .map((row) => row.id)
        .sort()
        .reverse()
        .slice(0, 99);
      expect(list.projectionSets.map((row) => row.id)).toEqual([...expectedBusy, retained.id]);
      expect(list.projectionSets.at(-1)).toMatchObject({
        horizon: retainedHorizon,
        importedAt: retained.createdAt.toISOString(),
        playerCount: 1,
      });
      const details = projectionPlayerListResponseSchema.parse(
        await service.getPlayers(userId, seasonId, retained.id),
      );
      expect(details.players).toMatchObject([{ playerId, meanPoints: 180.5 }]);
      await expect(service.getPlayers(userId, seasonId, privateSet.id)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(await repository.listAccessibleSets(otherUserId, seasonId)).toEqual([]);
    },
  );

  it("keeps the latest 100 sets when only one horizon exists", async () => {
    const rows = Array.from({ length: 120 }, () => setRow("week", NOW));
    await handle.db.insert(projectionSets).values(rows);
    const list = projectionSetListResponseSchema.parse(await service.list(userId, seasonId));
    expect(list.projectionSets.map((row) => row.id)).toEqual(
      rows
        .map((row) => row.id)
        .sort()
        .reverse()
        .slice(0, 100),
    );
  });

  it("keeps a compatible older ROS model inside bounded history after many newer differently-scored publications", async () => {
    await handle.db
      .insert(scoringRules)
      .values({
        leagueSeasonId: seasonId,
        statKey: "42",
        providerStatId: "42",
        operation: "multiply",
        points: "0.1",
      });
    const key = await repository.currentScoringProfileKey(seasonId);
    const earlier = setRow("rest-of-season", new Date("2026-09-01T12:00:00.000Z"));
    const compatible = { ...earlier, metadata: { ...earlier.metadata, scoringProfileKey: key } };
    const newer = Array.from({ length: 150 }, () => setRow("rest-of-season", NOW));
    await handle.db.insert(projectionSets).values([compatible, ...newer]);
    await handle.db
      .insert(playerProjections)
      .values(
        [compatible, ...newer].map((row) => ({
          projectionSetId: row.id,
          playerId,
          meanPoints: "20",
        })),
      );
    const response = await service.list(userId, seasonId);
    expect(response.projectionSets).toHaveLength(100);
    expect(
      response.projectionSets.find((row) => row.id === compatible.id)?.managed
        ?.scoringCompatibility,
    ).toBe("current");
    expect(
      (await service.getPlayers(userId, seasonId, compatible.id)).projectionSet.managed
        ?.scoringCompatibility,
    ).toBe("current");
  });

  it("defaults to the last approved ROS numbers when newer candidates are partial or empty", async () => {
    const approved = setRow("rest-of-season", new Date("2026-09-08T06:30:00.000Z"));
    const partial = {
      ...setRow("rest-of-season", NOW),
      metadata: {
        releaseCompleteness: "partial",
        preservePriorGoodSet: true,
        modelVersion: "laces-ros-distribution-v9",
      },
    };
    const empty = setRow("rest-of-season", NOW);
    await handle.db.insert(projectionSets).values([approved, partial, empty]);
    await handle.db.insert(playerProjections).values(
      [approved, partial].map((set) => ({
        projectionSetId: set.id,
        playerId,
        meanPoints: "180.5",
      })),
    );
    const list = projectionSetListResponseSchema.parse(await service.list(userId, seasonId));
    expect(list.projectionSets.map((row) => row.id)).toEqual([approved.id]);
    expect(list.projectionSets[0]).toMatchObject({ importedAt: approved.createdAt.toISOString() });
    const details = await service.getPlayers(userId, seasonId, approved.id);
    expect(details.players).toMatchObject([{ playerId, meanPoints: 180.5 }]);
  });

  it("reconciles new roster IDs against the full approved release without changing publication facts", async () => {
    const approved = setRow("rest-of-season", new Date("2026-09-08T06:30:00.000Z"));
    const identities = [
      {
        name: "Mike Washington Jr.",
        canonicalName: "Mike Washington Jr.",
        position: "RB",
        team: "LV",
      },
      { name: "Browns D/ST", canonicalName: "CLE D/ST", position: "D/ST", team: "CLE" },
      { name: "Ravens D/ST", canonicalName: "BAL D/ST", position: "D/ST", team: "BAL" },
      { name: "Steelers D/ST", canonicalName: "PIT D/ST", position: "D/ST", team: "PIT" },
    ].map((row) => ({ ...row, canonicalId: randomUUID(), aliasId: randomUUID() }));
    const fillers = Array.from({ length: 513 }, () => randomUUID());
    await handle.db.insert(players).values([
      ...identities.flatMap((row) => [
        {
          id: row.canonicalId,
          fullName: row.canonicalName,
          primaryPosition: row.position,
          eligiblePositions: [row.position],
          nflTeam: row.team,
          gsisId: row.position === "RB" ? `gsis-${row.canonicalId}` : null,
        },
        {
          id: row.aliasId,
          fullName: row.name,
          primaryPosition: row.position,
          eligiblePositions: [row.position],
          nflTeam: row.team,
        },
      ]),
      ...fillers.map((id) => ({
        id,
        fullName: `Filler ${id}`,
        primaryPosition: "QB",
        eligiblePositions: ["QB"],
      })),
    ]);
    await handle.db.insert(playerExternalIds).values(
      identities.map((row, index) => ({
        playerId: row.aliasId,
        source: "espn-self-asserted",
        externalId: `${seasonId}:${index}`,
        verified: false,
        confidence: "0",
      })),
    );
    await handle.db.insert(projectionSets).values(approved);
    await handle.db.insert(playerProjections).values([
      ...identities.map((row) => ({
        projectionSetId: approved.id,
        playerId: row.canonicalId,
        meanPoints: "84.247",
        floorPoints: "40.123",
        ceilingPoints: "120.456",
      })),
      ...fillers.map((id) => ({ projectionSetId: approved.id, playerId: id, meanPoints: "500" })),
    ]);
    const decisions = new DrizzleInSeasonDecisionRepository(handle.db);
    expect(
      (await decisions.listTopProjectionPlayers(approved.id, 512)).some((row) =>
        identities.some((identity) => identity.canonicalId === row.playerId),
      ),
    ).toBe(false);
    const matched = await decisions.listProjectionPlayersByIds(
      approved.id,
      identities.map((row) => row.aliasId),
    );
    expect(matched).toHaveLength(4);
    for (const identity of identities) {
      expect(matched).toContainEqual(
        expect.objectContaining({
          playerId: identity.aliasId,
          projectionPlayerId: identity.canonicalId,
          name: identity.name,
          meanPoints: "84.247",
          floorPoints: "40.123",
          ceilingPoints: "120.456",
        }),
      );
    }
    // A later provider sync can introduce yet another ID after the same release was published.
    const nextAliasId = randomUUID();
    await handle.db.insert(players).values({
      id: nextAliasId,
      fullName: "Mike Washington Jr.",
      primaryPosition: "RB",
      eligiblePositions: ["RB"],
      nflTeam: "LV",
    });
    expect(await decisions.listProjectionPlayersByIds(approved.id, [nextAliasId])).toMatchObject([
      {
        playerId: nextAliasId,
        projectionPlayerId: identities[0]!.canonicalId,
        meanPoints: "84.247",
      },
    ]);
    expect(await decisions.countProjectionPlayers(approved.id)).toBe(517);
    const [saved] = await handle.db
      .select()
      .from(projectionSets)
      .where(eq(projectionSets.id, approved.id));
    expect(saved).toMatchObject({
      fetchedAt: approved.fetchedAt,
      createdAt: approved.createdAt,
      metadata: approved.metadata,
    });
  });

  it("does not take an alias forecast from another set or reinterpret a private import", async () => {
    const canonicalId = randomUUID();
    const aliasId = randomUUID();
    await handle.db.insert(players).values([
      {
        id: canonicalId,
        fullName: "Same Player",
        gsisId: `gsis-${canonicalId}`,
        primaryPosition: "RB",
        eligiblePositions: ["RB"],
        nflTeam: "LV",
      },
      {
        id: aliasId,
        fullName: "Same Player",
        primaryPosition: "RB",
        eligiblePositions: ["RB"],
        nflTeam: "LV",
      },
    ]);
    const approved = setRow("rest-of-season", NOW);
    const privateSet = {
      ...setRow("rest-of-season", NOW),
      source: "manual-import",
      visibility: "private" as const,
      createdByUserId: otherUserId,
    };
    await handle.db.insert(projectionSets).values([approved, privateSet]);
    await handle.db
      .insert(playerProjections)
      .values({ projectionSetId: privateSet.id, playerId: canonicalId, meanPoints: "999" });
    const decisions = new DrizzleInSeasonDecisionRepository(handle.db);
    expect(await decisions.listProjectionPlayersByIds(approved.id, [aliasId])).toEqual([]);
    expect(await decisions.listProjectionPlayersByIds(privateSet.id, [aliasId])).toEqual([]);
  });
});
