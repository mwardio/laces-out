/** Uses a disposable database and fixture HTTP only; never touches production. */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createDatabase,
  dataSources,
  playerWeeklyStatObservations,
  players,
  syncRuns,
} from "@laces-out/db";
import {
  NFLVERSE_WEEKLY_STATS_COMPONENT_SCHEMA,
  NflverseWeeklyStatsSource,
  buildNflverseWeeklyStatsUrl,
} from "@laces-out/source-nflverse";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NflverseWeeklyDataRefresher, datasetMetadata } from "./nflverse-weekly-data.js";
import {
  weeklyStatsPlayByPlayFixture,
  weeklyStatsPlayByPlayLoader,
} from "../../../packages/source-nflverse/src/weekly-stats-source.test-fixtures.js";

function dockerAvailable() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!dockerAvailable())(
  "Player-week component replay against disposable PostgreSQL",
  () => {
    const containerName = `laces-stat-replay-pg-${randomUUID().slice(0, 8)}`;
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
          "POSTGRES_USER=stat_replay_test",
          "-e",
          `POSTGRES_PASSWORD=${password}`,
          "-e",
          "POSTGRES_DB=stat_replay_test",
          "-p",
          "127.0.0.1::5432",
          "postgres:17-alpine",
        ],
        { stdio: "ignore" },
      );
      const port = Number(
        execFileSync("docker", ["port", containerName, "5432/tcp"], {
          encoding: "utf8",
        })
          .trim()
          .split(":")
          .pop(),
      );
      if (!Number.isInteger(port) || port <= 0) throw new Error("Disposable database port missing");
      handle = createDatabase(
        `postgres://stat_replay_test:${password}@127.0.0.1:${port}/stat_replay_test`,
        2,
      );
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          execFileSync(
            "docker",
            ["exec", containerName, "pg_isready", "-h", "127.0.0.1", "-U", "stat_replay_test"],
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
    }, 60_000);

    afterAll(async () => {
      try {
        await handle?.close();
      } finally {
        execFileSync("docker", ["rm", "-f", "-v", containerName], { stdio: "ignore" });
      }
    }, 30_000);

    it("reparses archived unchanged bytes once, retains legacy facts, and preserves complete composite selection through unchanged replay and PBP-only correction", async () => {
      const season = 2025;
      let now = new Date("2026-09-17T12:00:00Z");
      const oldTime = new Date("2026-09-16T12:00:00Z");
      const sourceKey = `nflverse.stats-player-week.${season}`;
      const lines = readFileSync(
        new URL(
          "../../../packages/source-nflverse/src/fixtures/player-weekly-stats.csv",
          import.meta.url,
        ),
        "utf8",
      )
        .trimEnd()
        .split("\n")
        .map((line) => line.split(","));
      const header = lines[0]!;
      const first = lines[1]!;
      first[header.indexOf("fg_att")] = "2";
      first[header.indexOf("fg_blocked")] = "2";
      first[header.indexOf("fg_blocked_list")] = "36;44";
      const csv = lines.map((line) => line.join(",")).join("\n");
      const rawChecksum = createHash("sha256").update(csv).digest("hex");
      const legacyChecksum = createHash("sha256")
        .update(`nflverse-player-week-components-v2:${rawChecksum}`)
        .digest("hex");
      const metadata = datasetMetadata({
        sourceKey,
        previous: {},
        season,
        rowsRead: 2,
        rowsRejected: 0,
        rowsUnmatched: 0,
        coveredWeeks: [1],
        coveredSeasonTypes: ["REG"],
      });
      delete metadata.playerWeeklyComponentSchema;
      const [legacySource] = await handle.db
        .insert(dataSources)
        .values({
          key: sourceKey,
          name: "Archived player facts",
          kind: "weekly_stats",
          sourceUrl: buildNflverseWeeklyStatsUrl(season),
          checkIntervalMinutes: 1440,
          nextCheckAt: oldTime,
          lastCheckedAt: oldTime,
          lastSuccessfulAt: oldTime,
          lastChangedAt: oldTime,
          lastChecksum: legacyChecksum,
          etag: '"unchanged"',
          lastModified: "Wed, 16 Sep 2026 12:00:00 GMT",
          metadata,
        })
        .returning();
      const [legacyRun] = await handle.db
        .insert(syncRuns)
        .values({
          kind: "weekly-stats",
          state: "succeeded",
          idempotencyKey: `${sourceKey}:${legacyChecksum}:v4`,
          startedAt: oldTime,
          finishedAt: oldTime,
          artifactChecksum: legacyChecksum,
          recordsRead: 2,
          recordsWritten: 2,
        })
        .returning();
      const parsed = await new NflverseWeeklyStatsSource({
        playByPlay: weeklyStatsPlayByPlayLoader,
        fetch: () => Promise.resolve(new Response(csv)),
      }).check(season, { etag: null, lastModified: null, checksumSha256: null });
      if (parsed.state !== "changed") throw new Error("Expected fixture observations");
      for (const observation of parsed.observations) {
        const [player] = await handle.db
          .insert(players)
          .values({
            gsisId: observation.gsisId,
            fullName: observation.displayName,
            primaryPosition: observation.position,
            eligiblePositions: [observation.position],
          })
          .returning();
        const components: Record<string, number> = { ...observation.components };
        components.field_goals_missed = components.field_goals_missed_unblocked!;
        for (const suffix of ["0_19", "20_29", "30_39", "40_49", "50_59", "60_plus"])
          components[`field_goals_missed_${suffix}`] =
            components[`field_goals_missed_${suffix}`]! -
            components[`field_goals_blocked_${suffix}`]!;
        for (const key of Object.keys(components))
          if (
            key.startsWith("field_goals_blocked") ||
            key === "field_goals_missed_unblocked" ||
            /touchdowns_(40|50)_plus$/u.test(key)
          )
            delete components[key];
        await handle.db.insert(playerWeeklyStatObservations).values({
          sourceId: legacySource!.id,
          sourceSyncRunId: legacyRun!.id,
          playerId: player!.id,
          externalPlayerId: observation.gsisId,
          season,
          week: observation.week,
          seasonType: observation.seasonType,
          gameId: observation.gameId,
          team: observation.team,
          opponentTeam: observation.opponentTeam,
          components,
          advanced: { ...observation.advanced },
          sourceFantasyPoints: observation.sourceFantasyPoints,
          fetchedAt: oldTime,
          inputChecksum: legacyChecksum,
        });
      }
      const readObservations = () =>
        handle.db
          .select()
          .from(playerWeeklyStatObservations)
          .where(eq(playerWeeklyStatObservations.sourceId, legacySource!.id));
      const readSource = async () =>
        (
          await handle.db.select().from(dataSources).where(eq(dataSources.id, legacySource!.id))
        )[0]!;
      const oldRows = await readObservations();
      let conditionalResponse = true;
      const fetch = vi.fn((_url: string | URL, init?: RequestInit) =>
        Promise.resolve(
          conditionalResponse && new Headers(init?.headers).has("if-none-match")
            ? new Response(null, { status: 304, headers: { etag: '"unchanged"' } })
            : new Response(csv, { headers: { etag: '"unchanged"', "content-type": "text/csv" } }),
        ),
      );
      let pbp = weeklyStatsPlayByPlayFixture();
      const service = new NflverseWeeklyDataRefresher({
        database: handle.db,
        weeklyStatsSource: new NflverseWeeklyStatsSource({
          fetch,
          now: () => now,
          playByPlay: { load: () => Promise.resolve(pbp) },
        }),
        now: () => now,
      });
      expect(await service.refreshWeeklyStats(season)).toMatchObject({
        state: "changed",
        rowsWritten: 2,
        rowsUnmatched: 0,
      });
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has("if-none-match")).toBe(false);
      const selected = await readSource();
      expect(selected.lastChecksum).toBe(parsed.checksumSha256);
      expect(selected.lastChecksum).not.toBe(legacyChecksum);
      expect(selected.metadata).toMatchObject({
        sourceSchemaVersion: 4,
        playerWeeklyComponentSchema: NFLVERSE_WEEKLY_STATS_COMPONENT_SCHEMA,
      });
      const rows = await readObservations();
      expect(rows).toHaveLength(4);
      for (const old of oldRows) expect(rows.find((row) => row.id === old.id)).toEqual(old);
      expect(
        rows.find(
          (row) =>
            row.inputChecksum === parsed.checksumSha256 && row.externalPlayerId === "00-0039999",
        )?.components,
      ).toMatchObject({
        field_goals_missed: 2,
        field_goals_missed_30_39: 1,
        field_goals_missed_40_49: 1,
      });
      now = new Date("2026-09-19T12:00:00Z");
      expect(await service.refreshWeeklyStats(season)).toMatchObject({ state: "not-due" });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await service.refreshWeeklyStats(season, true)).toMatchObject({
        state: "unchanged",
        rowsWritten: 0,
      });
      expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).has("if-none-match")).toBe(false);
      expect((await readSource()).lastChecksum).toBe(parsed.checksumSha256);
      conditionalResponse = false;
      expect(await service.refreshWeeklyStats(season, true)).toMatchObject({
        state: "unchanged",
        rowsWritten: 0,
      });
      expect(await readObservations()).toEqual(rows);
      expect((await readSource()).lastChecksum).toBe(parsed.checksumSha256);

      pbp = {
        ...pbp,
        checksumSha256: "c".repeat(64),
        playerTouchdowns: pbp.playerTouchdowns.map((row) =>
          row.gsisId === "00-0039999" ? { ...row, receiving_touchdowns_40_plus: 0 } : row,
        ),
      };
      expect(await service.refreshWeeklyStats(season, true)).toMatchObject({
        state: "changed",
        rowsWritten: 2,
      });
      const corrected = await readSource();
      expect(corrected.lastChecksum).not.toBe(parsed.checksumSha256);
      expect(corrected.metadata).toMatchObject({
        playByPlayChecksumSha256: "c".repeat(64),
        playerWeeklyChecksumSha256: rawChecksum,
      });
      const correctedRows = await readObservations();
      expect(correctedRows).toHaveLength(6);
      for (const row of rows)
        expect(correctedRows.find((current) => current.id === row.id)).toEqual(row);
      pbp = { ...pbp, observations: [] };
      await expect(service.refreshWeeklyStats(season, true)).rejects.toMatchObject({
        code: "QUALITY_THRESHOLD",
      });
      expect((await readSource()).lastChecksum).toBe(corrected.lastChecksum);
      expect(await readObservations()).toEqual(correctedRows);
    });
  },
);
