/** Real claims and immutable selection in disposable PostgreSQL; fixture HTTP only. */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createDatabase,
  dataSources,
  playerWeeklyStatObservations,
  players,
  teamWeeklyStatObservations,
  syncRuns,
} from "@laces-out/db";
import {
  NFLVERSE_WEEKLY_STATS_COMPONENT_SCHEMA,
  NFLVERSE_TEAM_WEEKLY_STATS_COMPONENT_SCHEMA,
  NflverseDatasetSourceError,
  NflverseTeamWeeklyStatsSource,
  NflverseWeeklyStatsSource,
  buildNflverseTeamWeeklyStatsUrl,
  fourthDownStopsFromPlayByPlay,
  type NflversePlayByPlayResult,
} from "@laces-out/source-nflverse";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { weeklyStatsPlayByPlayFixture } from "../../../packages/source-nflverse/src/weekly-stats-source.test-fixtures.js";
import { NflverseWeeklyDataRefresher, datasetMetadata } from "./nflverse-weekly-data.js";

function dockerAvailable() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function csvFixture(name: "player" | "team", season: number): string {
  const rows = readFileSync(
    new URL(
      `../../../packages/source-nflverse/src/fixtures/${name}-weekly-stats.csv`,
      import.meta.url,
    ),
    "utf8",
  )
    .trimEnd()
    .split("\n")
    .map((line) => line.split(","));
  const header = rows[0]!;
  return [
    header,
    ...rows.slice(1, 3).map((row) =>
      row.map((value, index) => {
        if (header[index] === "season") return String(season);
        if (header[index] === "game_id") return `${season}_01_CHI_GB`;
        if (["team", "opponent_team"].includes(header[index]!) && value === "TEN") return "GB";
        return value;
      }),
    ),
  ]
    .map((row) => row.join(","))
    .join("\n");
}

function playByPlayFixture(
  season: number,
  capture: string,
  corrected = false,
): NflversePlayByPlayResult {
  const original = weeklyStatsPlayByPlayFixture();
  const context = { season, gameId: `${season}_01_CHI_GB` };
  return {
    ...original,
    season,
    checksumSha256: capture.repeat(64),
    sourceUrl: `https://fixture.invalid/play_by_play_${season}.csv.gz`,
    observations: original.observations.map((row) => ({
      ...row,
      ...context,
      fourthDownStops: corrected ? 1 : 0,
    })),
    playerTouchdowns: original.playerTouchdowns.map((row) => ({
      ...row,
      ...context,
      ...(corrected && row.gsisId === "00-0039999" ? { receiving_touchdowns_40_plus: 0 } : {}),
    })),
  };
}

describe.skipIf(!dockerAvailable())(
  "Coherent weekly source pairs against disposable PostgreSQL",
  () => {
    const containerName = `laces-weekly-pair-pg-${randomUUID().slice(0, 8)}`;
    let handle: ReturnType<typeof createDatabase>;

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
          "POSTGRES_USER=weekly_pair_test",
          "-e",
          `POSTGRES_PASSWORD=${password}`,
          "-e",
          "POSTGRES_DB=weekly_pair_test",
          "-p",
          "127.0.0.1::5432",
          "postgres:17-alpine",
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
        `postgres://weekly_pair_test:${password}@127.0.0.1:${port}/weekly_pair_test`,
        4,
      );
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          execFileSync(
            "docker",
            ["exec", containerName, "pg_isready", "-h", "127.0.0.1", "-U", "weekly_pair_test"],
            { stdio: "ignore" },
          );
          break;
        } catch {
          if (Date.now() > deadline) throw new Error("Disposable database did not start");
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      await migrate(handle.db, {
        migrationsFolder: fileURLToPath(
          new URL("../../../packages/db/migrations", import.meta.url),
        ),
      });
      await handle.db.insert(players).values([
        {
          gsisId: "00-0039999",
          fullName: "Fixture receiver",
          primaryPosition: "WR",
          eligiblePositions: ["WR"],
        },
        {
          gsisId: "00-0038888",
          fullName: "Fixture quarterback",
          primaryPosition: "QB",
          eligiblePositions: ["QB"],
        },
      ]);
    }, 60_000);

    afterAll(async () => {
      try {
        await handle?.close();
      } finally {
        execFileSync("docker", ["rm", "-f", "-v", containerName], { stdio: "ignore" });
      }
    }, 30_000);

    async function fixture(season: number, activeSeason = 2026) {
      let now = new Date(`${activeSeason}-09-16T12:00:00Z`);
      let capture = playByPlayFixture(season, "a");
      let rejectTeam = false;
      let beforePlayerFetch: (() => Promise<void>) | undefined;
      const load = vi.fn(async () => capture);
      const loader = { load };
      const playerFetch = vi.fn(async () => {
        await beforePlayerFetch?.();
        return new Response(csvFixture("player", season), {
          headers: { etag: '"stable-player-csv"' },
        });
      });
      const teamFetch = vi.fn(async () => {
        if (rejectTeam)
          throw new NflverseDatasetSourceError("UPSTREAM", "Fixture team repair failed", true);
        return new Response(csvFixture("team", season), { headers: { etag: '"stable-team-csv"' } });
      });
      const service = new NflverseWeeklyDataRefresher({
        database: handle.db,
        weeklyStatsSource: new NflverseWeeklyStatsSource({ fetch: playerFetch, now: () => now }),
        teamWeeklyStatsSource: new NflverseTeamWeeklyStatsSource({
          fetch: teamFetch,
          now: () => now,
        }),
        playByPlaySource: loader,
        now: () => now,
      });
      const readSource = async (kind: "player" | "team") => {
        const [row] = await handle.db
          .select()
          .from(dataSources)
          .where(eq(dataSources.key, `nflverse.stats-${kind}-week.${season}`));
        if (!row) throw new Error("Fixture source not seeded");
        return row;
      };
      const playerRows = () =>
        handle.db
          .select()
          .from(playerWeeklyStatObservations)
          .where(eq(playerWeeklyStatObservations.season, season));
      const teamRows = () =>
        handle.db
          .select()
          .from(teamWeeklyStatObservations)
          .where(eq(teamWeeklyStatObservations.season, season));
      const clearCalls = () => {
        load.mockClear();
        playerFetch.mockClear();
        teamFetch.mockClear();
      };
      const seed = async (playerCapture = "a", teamCapture = "a") => {
        capture = playByPlayFixture(season, playerCapture);
        expect((await service.refreshWeeklyStats(season, true, loader)).state).toBe("changed");
        capture = playByPlayFixture(season, teamCapture);
        expect((await service.refreshTeamWeeklyStats(season, true, loader)).state).toBe("changed");
        now = new Date(`${activeSeason}-09-17T12:00:00Z`);
        clearCalls();
      };
      const selectCapture = (value: string, corrected = false) => {
        capture = playByPlayFixture(season, value, corrected);
      };
      return {
        service,
        loader,
        load,
        playerFetch,
        teamFetch,
        readSource,
        playerRows,
        teamRows,
        seed,
        clearCalls,
        selectCapture,
        now: () => now,
        advance: (minutes: number) => {
          now = new Date(now.getTime() + minutes * 60_000);
        },
        failTeam: (value: boolean) => {
          rejectTeam = value;
        },
        holdPlayer: (callback?: () => Promise<void>) => {
          beforePlayerFetch = callback;
        },
      };
    }

    it("repairs an active-season counterpart skipped by its independent due clock using one capture", async () => {
      const prepared = await fixture(2026);
      await prepared.seed();
      const oldPlayerRows = await prepared.playerRows();
      const oldTeamRows = await prepared.teamRows();
      const team = await prepared.readSource("team");
      await handle.db
        .update(dataSources)
        .set({ nextCheckAt: new Date(prepared.now().getTime() + 60 * 60_000) })
        .where(eq(dataSources.id, team.id));
      prepared.selectCapture("b", true);
      expect(await prepared.service.refreshWeeklyStatsPair(2026)).toMatchObject({
        weeklyStats: { state: "changed" },
        teamWeeklyStats: { state: "changed" },
      });
      expect(prepared.load).toHaveBeenCalledTimes(1);
      expect(prepared.playerFetch).toHaveBeenCalledTimes(1);
      expect(prepared.teamFetch).toHaveBeenCalledTimes(1);
      expect((await prepared.readSource("player")).metadata.playByPlayChecksumSha256).toBe(
        "b".repeat(64),
      );
      expect((await prepared.readSource("team")).metadata.playByPlayChecksumSha256).toBe(
        "b".repeat(64),
      );
      const nextPlayers = await prepared.playerRows();
      const nextTeams = await prepared.teamRows();
      expect(nextPlayers).toHaveLength(4);
      expect(nextTeams).toHaveLength(4);
      for (const row of oldPlayerRows)
        expect(nextPlayers.find((next) => next.id === row.id)).toEqual(row);
      for (const row of oldTeamRows)
        expect(nextTeams.find((next) => next.id === row.id)).toEqual(row);
    });

    it("repairs an archived reusable mismatch and PBP-only correction without an operator force", async () => {
      const prepared = await fixture(2025);
      await prepared.seed("a", "b");
      const playerBefore = await prepared.readSource("player");
      const teamBefore = await prepared.readSource("team");
      prepared.selectCapture("c", true);
      expect(await prepared.service.refreshWeeklyStatsPair(2025)).toMatchObject({
        weeklyStats: { state: "changed" },
        teamWeeklyStats: { state: "changed" },
      });
      const playerAfter = await prepared.readSource("player");
      const teamAfter = await prepared.readSource("team");
      expect(prepared.load).toHaveBeenCalledTimes(1);
      expect(prepared.playerFetch).toHaveBeenCalledTimes(1);
      expect(prepared.teamFetch).toHaveBeenCalledTimes(1);
      expect(playerAfter.metadata.playerWeeklyChecksumSha256).toBe(
        playerBefore.metadata.playerWeeklyChecksumSha256,
      );
      expect(playerAfter.lastChecksum).not.toBe(playerBefore.lastChecksum);
      expect(teamAfter.lastChecksum).not.toBe(teamBefore.lastChecksum);
      expect(playerAfter.metadata.playByPlayChecksumSha256).toBe("c".repeat(64));
      expect(teamAfter.metadata.playByPlayChecksumSha256).toBe("c".repeat(64));
      expect(
        (await prepared.playerRows()).find(
          (row) =>
            row.inputChecksum === playerAfter.lastChecksum && row.externalPlayerId === "00-0039999",
        )?.components.receiving_touchdowns_40_plus,
      ).toBe(0);
      expect(
        (await prepared.teamRows())
          .filter((row) => row.inputChecksum === teamAfter.lastChecksum)
          .map((row) => row.components.fourth_down_stops),
      ).toEqual([1, 1]);
      prepared.clearCalls();
      expect(await prepared.service.refreshWeeklyStatsPair(2025)).toMatchObject({
        weeklyStats: { state: "not-due" },
        teamWeeklyStats: { state: "not-due" },
      });
      expect(prepared.load).not.toHaveBeenCalled();
      expect(prepared.playerFetch).not.toHaveBeenCalled();
      expect(prepared.teamFetch).not.toHaveBeenCalled();
    });

    it("upgrades an archived legacy player component schema despite a future due clock", async () => {
      const prepared = await fixture(2024);
      await prepared.seed();
      const before = await prepared.readSource("player");
      const rows = await prepared.playerRows();
      await handle.db
        .update(dataSources)
        .set({
          nextCheckAt: new Date(prepared.now().getTime() + 24 * 60 * 60_000),
          metadata: {
            ...before.metadata,
            playerWeeklyComponentSchema: "nflverse-player-week-components-v2",
          },
        })
        .where(eq(dataSources.id, before.id));
      expect(await prepared.service.refreshWeeklyStatsPair(2024)).toMatchObject({
        weeklyStats: { state: "changed" },
        teamWeeklyStats: { state: "not-due" },
      });
      const after = await prepared.readSource("player");
      expect(after.metadata.playerWeeklyComponentSchema).toBe(
        NFLVERSE_WEEKLY_STATS_COMPONENT_SCHEMA,
      );
      expect(after.lastChecksum).toBe(before.lastChecksum);
      expect(await prepared.playerRows()).toEqual(rows);
      expect(prepared.playerFetch).toHaveBeenCalledTimes(1);
      expect(prepared.teamFetch).not.toHaveBeenCalled();
      expect(prepared.load).toHaveBeenCalledTimes(1);
    });

    it("replays unchanged archived team bytes into new immutable component facts without refreshing a current player contract", async () => {
      const season = 2021;
      const prepared = await fixture(season);
      const lines = csvFixture("team", season)
        .split("\n")
        .map((line) => line.split(","));
      const header = lines[0]!;
      const chicago = lines.find(
        (row, index) => index > 0 && row[header.indexOf("team")] === "CHI",
      )!;
      chicago[header.indexOf("def_2pt_made")] = "1";
      const csv = lines.map((row) => row.join(",")).join("\n");
      prepared.teamFetch.mockImplementation(
        async () => new Response(csv, { headers: { etag: '"stable-team-csv"' } }),
      );
      await prepared.service.refreshWeeklyStats(season, true, prepared.loader);
      const rawChecksum = createHash("sha256").update(csv).digest("hex");
      const legacyChecksum = createHash("sha256")
        .update(`team-week-with-fourth-downs-v1:${rawChecksum}:${"a".repeat(64)}`)
        .digest("hex");
      const sourceKey = `nflverse.stats-team-week.${season}`;
      const metadata: ReturnType<typeof datasetMetadata> = {
        ...datasetMetadata({
          sourceKey,
          previous: {},
          season,
          rowsRead: 2,
          rowsRejected: 0,
          rowsUnmatched: 0,
          coveredWeeks: [1],
          coveredSeasonTypes: ["REG"],
        }),
        playByPlayChecksumSha256: "a".repeat(64),
      };
      delete metadata.teamWeeklyComponentSchema;
      const oldTime = new Date(prepared.now().getTime() - 60_000);
      const [source] = await handle.db
        .insert(dataSources)
        .values({
          key: sourceKey,
          name: "Legacy team fixture",
          kind: "weekly_team_stats",
          sourceUrl: buildNflverseTeamWeeklyStatsUrl(season),
          checkIntervalMinutes: 1440,
          nextCheckAt: new Date(prepared.now().getTime() + 24 * 60 * 60_000),
          lastCheckedAt: oldTime,
          lastSuccessfulAt: oldTime,
          lastChangedAt: oldTime,
          lastChecksum: legacyChecksum,
          etag: '"stable-team-csv"',
          metadata,
        })
        .returning();
      const [legacyRun] = await handle.db
        .insert(syncRuns)
        .values({
          kind: "weekly-team-stats",
          state: "succeeded",
          idempotencyKey: `${sourceKey}:${legacyChecksum}:v4`,
          startedAt: oldTime,
          finishedAt: oldTime,
          artifactChecksum: legacyChecksum,
          recordsRead: 2,
          recordsWritten: 2,
        })
        .returning();
      const parsed = await new NflverseTeamWeeklyStatsSource({
        fetch: () => Promise.resolve(new Response(csv)),
        fourthDowns: fourthDownStopsFromPlayByPlay(prepared.loader),
      }).check(season, { etag: null, lastModified: null, checksumSha256: null });
      if (parsed.state !== "changed") throw new Error("Expected team fixture observations");
      for (const observation of parsed.observations) {
        const components: Record<string, number> = { ...observation.components };
        delete components.defensive_two_point_returns;
        await handle.db.insert(teamWeeklyStatObservations).values({
          sourceId: source!.id,
          sourceSyncRunId: legacyRun!.id,
          externalTeamId: observation.team,
          season,
          week: observation.week,
          seasonType: observation.seasonType,
          gameId: observation.gameId,
          team: observation.team,
          opponentTeam: observation.opponentTeam,
          components,
          fetchedAt: oldTime,
          inputChecksum: legacyChecksum,
        });
      }
      const oldRows = await prepared.teamRows();
      const playerBefore = await prepared.readSource("player");
      prepared.clearCalls();
      expect(await prepared.service.refreshWeeklyStatsPair(season)).toMatchObject({
        weeklyStats: { state: "not-due" },
        teamWeeklyStats: { state: "changed", rowsWritten: 2 },
      });
      expect(prepared.playerFetch).not.toHaveBeenCalled();
      expect(prepared.teamFetch).toHaveBeenCalledTimes(1);
      const after = await prepared.readSource("team");
      expect(after.metadata).toMatchObject({
        sourceSchemaVersion: 4,
        teamWeeklyComponentSchema: NFLVERSE_TEAM_WEEKLY_STATS_COMPONENT_SCHEMA,
        teamWeeklyChecksumSha256: rawChecksum,
        playByPlayChecksumSha256: "a".repeat(64),
      });
      expect(after.lastChecksum).toBe(parsed.checksumSha256);
      expect(after.lastChecksum).not.toBe(legacyChecksum);
      expect((await prepared.readSource("player")).lastChecksum).toBe(playerBefore.lastChecksum);
      const nextRows = await prepared.teamRows();
      expect(nextRows).toHaveLength(4);
      for (const row of oldRows) expect(nextRows.find((next) => next.id === row.id)).toEqual(row);
      expect(
        nextRows
          .filter((row) => row.inputChecksum === after.lastChecksum)
          .every((row) => row.sourceSyncRunId !== legacyRun!.id),
      ).toBe(true);
      expect(
        nextRows.find((row) => row.inputChecksum === after.lastChecksum && row.team === "CHI")
          ?.components.defensive_two_point_returns,
      ).toBe(1);
      prepared.clearCalls();
      expect(await prepared.service.refreshWeeklyStatsPair(season)).toMatchObject({
        weeklyStats: { state: "not-due" },
        teamWeeklyStats: { state: "not-due" },
      });
      expect(prepared.load).not.toHaveBeenCalled();
      expect(prepared.teamFetch).not.toHaveBeenCalled();
      expect(
        await prepared.service.refreshTeamWeeklyStats(season, true, prepared.loader),
      ).toMatchObject({ state: "unchanged", rowsWritten: 0 });
      expect(await prepared.teamRows()).toEqual(nextRows);
      expect((await prepared.readSource("team")).metadata.teamWeeklyComponentSchema).toBe(
        NFLVERSE_TEAM_WEEKLY_STATS_COMPONENT_SCHEMA,
      );
    });

    it("refuses to steal active leases even with force and exposes an unresolved mismatch without fetching", async () => {
      const prepared = await fixture(2027, 2027);
      await prepared.seed("a", "b");
      for (const kind of ["player", "team"] as const) {
        const source = await prepared.readSource(kind);
        await handle.db
          .update(dataSources)
          .set({
            nextCheckAt: new Date(prepared.now().getTime() - 60_000),
            metadata: {
              ...source.metadata,
              refreshClaimedAt: new Date(prepared.now().getTime() - 5 * 60_000).toISOString(),
            },
          })
          .where(eq(dataSources.id, source.id));
      }
      const before = await Promise.all([
        prepared.readSource("player"),
        prepared.readSource("team"),
      ]);
      const failure: unknown = await prepared.service
        .refreshWeeklyStatsPair(2027, true)
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "UPSTREAM",
        retryable: true,
      });
      expect(failure instanceof Error ? failure.message : null).toContain(
        "PBP captures remain inconsistent",
      );
      expect(prepared.load).not.toHaveBeenCalled();
      expect(prepared.playerFetch).not.toHaveBeenCalled();
      expect(prepared.teamFetch).not.toHaveBeenCalled();
      const after = await Promise.all([prepared.readSource("player"), prepared.readSource("team")]);
      expect(
        after.map((source) => ({ checksum: source.lastChecksum, metadata: source.metadata })),
      ).toEqual(
        before.map((source) => ({ checksum: source.lastChecksum, metadata: source.metadata })),
      );
    });

    it("preserves failed repair selection and immutable facts, then recovers on a later retry", async () => {
      const prepared = await fixture(2023);
      await prepared.seed("a", "b");
      const originalTeam = await prepared.readSource("team");
      const originalTeamRows = await prepared.teamRows();
      const originalPlayerRows = await prepared.playerRows();
      prepared.selectCapture("d", true);
      prepared.failTeam(true);
      await expect(prepared.service.refreshWeeklyStatsPair(2023)).rejects.toMatchObject({
        retryable: true,
      });
      const failedTeam = await prepared.readSource("team");
      expect(failedTeam.lastChecksum).toBe(originalTeam.lastChecksum);
      expect(failedTeam.lastSuccessfulAt).toEqual(originalTeam.lastSuccessfulAt);
      expect(failedTeam.metadata).toEqual(originalTeam.metadata);
      expect(failedTeam.consecutiveFailures).toBe(1);
      expect(failedTeam.metadata.refreshClaimedAt).toBeUndefined();
      expect(await prepared.teamRows()).toEqual(originalTeamRows);
      const interimPlayers = await prepared.playerRows();
      for (const row of originalPlayerRows)
        expect(interimPlayers.find((next) => next.id === row.id)).toEqual(row);
      prepared.failTeam(false);
      prepared.advance(16);
      prepared.clearCalls();
      await prepared.service.refreshWeeklyStatsPair(2023);
      expect((await prepared.readSource("team")).metadata.playByPlayChecksumSha256).toBe(
        "d".repeat(64),
      );
      expect((await prepared.readSource("player")).metadata.playByPlayChecksumSha256).toBe(
        "d".repeat(64),
      );
      expect((await prepared.readSource("team")).consecutiveFailures).toBe(0);
      const recoveredTeams = await prepared.teamRows();
      for (const row of originalTeamRows)
        expect(recoveredTeams.find((next) => next.id === row.id)).toEqual(row);
      expect(prepared.load).toHaveBeenCalledTimes(1);
    });

    it("prevents a second forced worker from taking a live database claim", async () => {
      const prepared = await fixture(2028, 2028);
      await prepared.seed();
      prepared.selectCapture("e");
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      prepared.holdPlayer(async () => {
        entered();
        await held;
      });
      const first = prepared.service.refreshWeeklyStats(2028, true, prepared.loader);
      await started;
      try {
        expect(
          await prepared.service.refreshWeeklyStats(2028, true, prepared.loader),
        ).toMatchObject({ state: "not-due" });
        expect(prepared.playerFetch).toHaveBeenCalledTimes(1);
      } finally {
        release();
      }
      expect((await first).state).toBe("changed");
      expect((await prepared.readSource("player")).metadata.playByPlayChecksumSha256).toBe(
        "e".repeat(64),
      );
      expect((await prepared.readSource("player")).metadata.refreshClaimedAt).toBeUndefined();
    });
  },
  30_000,
);
