/** Replays the same upstream bytes through the real parser and immutable PostgreSQL writes. */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createDatabase, dataSources, nflScheduleObservations } from "@laces-out/db";
import { NflverseSchedulesSource } from "@laces-out/source-nflverse";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { projectionTargetWeeks } from "./first-party-projections.js";
import { NflverseScheduleRefresher } from "./nflverse-schedules.js";

function dockerAvailable() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!dockerAvailable())("Schedule finality against disposable PostgreSQL", () => {
  const containerName = `laces-schedule-pg-${randomUUID().slice(0, 8)}`;
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
        "POSTGRES_USER=schedule_test",
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "-e",
        "POSTGRES_DB=schedule_test",
        "-p",
        "127.0.0.1::5432",
        "postgres:16",
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
      `postgres://schedule_test:${password}@127.0.0.1:${port}/schedule_test`,
      2,
    );
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        execFileSync(
          "docker",
          ["exec", containerName, "pg_isready", "-h", "127.0.0.1", "-U", "schedule_test"],
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
  }, 60_000);

  afterAll(async () => {
    try {
      await handle?.close();
    } finally {
      execFileSync("docker", ["rm", "-f", "-v", containerName], { stdio: "ignore" });
    }
  }, 30_000);

  it.each(["http-304", "identical-body", "legacy-schema"] as const)(
    "advances past the last game despite %s, preserving the earlier snapshot",
    async (cacheMode) => {
      // Pre-2021 seasons permit a small ledger; modern completeness is covered separately.
      const season = { "http-304": 2020, "identical-body": 2019, "legacy-schema": 2018 }[cacheMode];
      let now = new Date(`${season}-09-15T03:40:00.000Z`);
      const csv = [
        "game_id,season,game_type,week,gameday,gametime,away_team,home_team,away_score,home_score,away_rest,home_rest,location",
        `${season}_01_DEN_KC,${season},REG,1,${season}-09-14,20:15,DEN,KC,10,31,7,7,Home`,
        `${season}_02_PHI_TEN,${season},REG,2,${season}-09-20,13:00,PHI,TEN,,,7,7,Home`,
      ].join("\n");
      const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        const conditional = new Headers(init?.headers).has("if-none-match");
        return Promise.resolve(
          cacheMode !== "identical-body" && conditional
            ? new Response(null, { status: 304, headers: { etag: '"same-scores"' } })
            : new Response(csv, {
                headers: {
                  "content-type": "text/csv",
                  ...(cacheMode === "identical-body" ? {} : { etag: '"same-scores"' }),
                },
              }),
        );
      });
      const service = new NflverseScheduleRefresher({
        database: handle.db,
        source: new NflverseSchedulesSource({ fetch, now: () => now }),
        now: () => now,
      });
      const readSource = async () =>
        (
          await handle.db
            .select()
            .from(dataSources)
            .where(eq(dataSources.key, `nflverse.schedules.${season}`))
        )[0]!;
      const readSnapshot = async (checksum: string) =>
        handle.db
          .select()
          .from(nflScheduleObservations)
          .where(
            and(
              eq(nflScheduleObservations.season, season),
              eq(nflScheduleObservations.inputChecksum, checksum),
            ),
          );

      expect(await service.refresh(season)).toMatchObject({ state: "changed", rowsWritten: 2 });
      const initial = await readSource();
      const initialRows = await readSnapshot(initial.lastChecksum!);
      expect(initialRows.find((row) => row.week === 1)?.status).toBe("in-progress");
      expect(initial.metadata.statusRecheckAt).toBe(`${season}-09-15T04:15:00.000Z`);
      expect(projectionTargetWeeks(initialRows, season, undefined, now)).toEqual([1, 2]);

      now = new Date(`${season}-09-15T04:00:00.000Z`);
      expect(await service.refresh(season, true)).toMatchObject({
        state: "unchanged",
        rowsWritten: 0,
      });
      expect((await readSource()).lastChecksum).toBe(initial.lastChecksum);
      if (cacheMode === "legacy-schema") {
        // Existing v2 deployments have a frozen in-progress row without a recheck deadline.
        const metadata: typeof initial.metadata = { ...initial.metadata, sourceSchemaVersion: 2 };
        delete metadata.statusRecheckAt;
        await handle.db.update(dataSources).set({ metadata }).where(eq(dataSources.id, initial.id));
      }

      now = new Date(`${season}-09-16T12:00:00.000Z`);
      expect(await service.refresh(season)).toMatchObject({ state: "changed", rowsWritten: 2 });
      const advanced = await readSource();
      expect(advanced.lastChecksum).not.toBe(initial.lastChecksum);
      expect(advanced.metadata.artifactChecksumSha256).toBe(
        initial.metadata.artifactChecksumSha256,
      );
      expect(advanced.metadata.statusRecheckAt).toBeNull();
      expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).has("if-none-match")).toBe(false);
      const advancedRows = await readSnapshot(advanced.lastChecksum!);
      expect(advancedRows.find((row) => row.week === 1)?.status).toBe("final");
      expect(projectionTargetWeeks(advancedRows, season, undefined, now)).toEqual([2]);
      expect(await readSnapshot(initial.lastChecksum!)).toEqual(initialRows);

      now = new Date(`${season}-09-16T13:00:00.000Z`);
      expect(await service.refresh(season)).toMatchObject({ state: "unchanged", rowsWritten: 0 });
      expect((await readSource()).lastChecksum).toBe(advanced.lastChecksum);
    },
  );
});
