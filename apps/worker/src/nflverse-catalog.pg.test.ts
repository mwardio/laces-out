/** Uses an isolated disposable database; never reads or mutates the application database. */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createDatabase, dataSources, playerExternalIds, players } from "@laces-out/db";
import { NflversePlayersSource } from "@laces-out/source-nflverse";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NflverseCatalogRefresher } from "./nflverse-catalog.js";
import { NFLVERSE_ESB_ID_SOURCE, NFLVERSE_SMART_ID_SOURCE } from "./nflverse-roster-identities.js";

function dockerAvailable() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!dockerAvailable())(
  "Catalog roster identity continuity against disposable PostgreSQL",
  () => {
    const containerName = `laces-catalog-identities-pg-${randomUUID().slice(0, 8)}`;
    const now = new Date("2026-09-17T12:00:00.000Z");
    let handle: ReturnType<typeof createDatabase>;
    let nextGsis = 9200000;
    const gsis = () => `00-${nextGsis++}`;

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
          "POSTGRES_USER=catalog_identity_test",
          "-e",
          `POSTGRES_PASSWORD=${password}`,
          "-e",
          "POSTGRES_DB=catalog_identity_test",
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
        `postgres://catalog_identity_test:${password}@127.0.0.1:${port}/catalog_identity_test`,
        4,
      );
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          execFileSync(
            "docker",
            ["exec", containerName, "pg_isready", "-h", "127.0.0.1", "-U", "catalog_identity_test"],
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

    const seed = async (
      input: { gsisId?: string; esb?: string; smart?: string; name?: string } = {},
    ) => {
      const [player] = await handle.db
        .insert(players)
        .values({
          gsisId: input.gsisId ?? null,
          fullName: input.name ?? "Catalog Receiver",
          primaryPosition: "WR",
          eligiblePositions: ["WR"],
          nflTeam: "CHI",
        })
        .returning();
      const aliases = [
        ...(input.esb
          ? [
              {
                playerId: player!.id,
                source: NFLVERSE_ESB_ID_SOURCE,
                externalId: input.esb,
                verified: true,
              },
            ]
          : []),
        ...(input.smart
          ? [
              {
                playerId: player!.id,
                source: NFLVERSE_SMART_ID_SOURCE,
                externalId: input.smart,
                verified: true,
              },
            ]
          : []),
      ];
      if (aliases.length) await handle.db.insert(playerExternalIds).values(aliases);
      return player!;
    };
    const csv = (
      rows: readonly { gsisId: string; esb?: string; smart?: string; name?: string }[],
    ) =>
      "gsis_id,display_name,pfr_id,position,latest_team,status,esb_id,smart_id\n" +
      rows
        .map(
          (row) =>
            `${row.gsisId},${row.name ?? "Catalog Receiver"},,WR,CHI,ACT,${row.esb ?? ""},${row.smart ?? ""}`,
        )
        .join("\n") +
      "\n";
    const refresher = (body: string, requests?: Headers[]) =>
      new NflverseCatalogRefresher({
        database: handle.db,
        now: () => now,
        source: new NflversePlayersSource({
          now: () => now,
          fetch: (_input, init) => {
            requests?.push(new Headers(init?.headers));
            return Promise.resolve(
              new Response(body, { status: 200, headers: { etag: '"catalog-test"' } }),
            );
          },
        }),
      });
    const find = async (id: string) =>
      (await handle.db.select().from(players).where(eq(players.id, id)))[0];

    it.each(["esb", "smart"] as const)(
      "attaches catalog-first GSIS to the exact existing %s player and remains idempotent",
      async (kind) => {
        const id = randomUUID();
        const fallback = await seed({ [kind]: id });
        const incomingGsis = gsis();
        const service = refresher(csv([{ gsisId: incomingGsis, [kind]: id }]));
        expect((await service.refresh(true)).state).toBe("changed");
        expect(await find(fallback.id)).toMatchObject({ gsisId: incomingGsis });
        expect(
          await handle.db.select().from(players).where(eq(players.gsisId, incomingGsis)),
        ).toEqual([expect.objectContaining({ id: fallback.id })]);
        expect((await service.refresh(true)).state).toBe("unchanged");
        expect(
          await handle.db.select().from(players).where(eq(players.gsisId, incomingGsis)),
        ).toHaveLength(1);
      },
    );

    it("publishes exact roster aliases for a new catalog player and replays the previous schema", async () => {
      await handle.db
        .update(dataSources)
        .set({ metadata: { catalogSchemaVersion: 3 }, etag: '"old"' })
        .where(eq(dataSources.key, "nflverse.players"));
      const esb = randomUUID();
      const smart = randomUUID();
      const incomingGsis = gsis();
      const requests: Headers[] = [];
      await refresher(csv([{ gsisId: incomingGsis, esb, smart }]), requests).refresh(true);
      expect(requests[0]!.has("if-none-match")).toBe(false);
      const [player] = await handle.db
        .select()
        .from(players)
        .where(eq(players.gsisId, incomingGsis));
      for (const [source, externalId] of [
        [NFLVERSE_ESB_ID_SOURCE, esb],
        [NFLVERSE_SMART_ID_SOURCE, smart],
      ]) {
        expect(
          await handle.db
            .select()
            .from(playerExternalIds)
            .where(
              and(
                eq(playerExternalIds.source, source!),
                eq(playerExternalIds.externalId, externalId!),
              ),
            ),
        ).toEqual([expect.objectContaining({ playerId: player!.id, verified: true })]);
      }
    });

    it("rejects conflicting existing GSIS and fallback canonical owners without merging or changing either", async () => {
      const esb = randomUUID();
      const fallback = await seed({ esb });
      const canonical = await seed({ gsisId: gsis() });
      await expect(
        refresher(csv([{ gsisId: canonical.gsisId!, esb }])).refresh(true),
      ).rejects.toThrow("conflicting authoritative roster identities");
      expect(await find(fallback.id)).toMatchObject({ gsisId: null });
      expect(await find(canonical.id)).toMatchObject({ gsisId: canonical.gsisId });
    });

    it.each([false, true])(
      "rejects conflicting GSIS rows sharing existing aliases before partial attachment (reverse=%s)",
      async (reverse) => {
        const esb = randomUUID();
        const smart = randomUUID();
        const fallback = await seed({ esb, smart });
        const rows = [
          { gsisId: gsis(), esb },
          { gsisId: gsis(), smart },
        ];
        if (reverse) rows.reverse();
        await expect(refresher(csv(rows)).refresh(true)).rejects.toThrow(
          "conflicting authoritative roster identities",
        );
        expect(await find(fallback.id)).toMatchObject({ gsisId: null });
        for (const row of rows)
          expect(
            await handle.db.select().from(players).where(eq(players.gsisId, row.gsisId)),
          ).toEqual([]);
      },
    );

    it("rejects new aliases claimed by multiple GSIS identities before creating any player", async () => {
      const esb = randomUUID();
      const rows = [
        { gsisId: gsis(), esb },
        { gsisId: gsis(), esb },
      ];
      await expect(refresher(csv(rows)).refresh(true)).rejects.toThrow(
        "conflicting authoritative roster identities",
      );
      for (const row of rows)
        expect(
          await handle.db.select().from(players).where(eq(players.gsisId, row.gsisId)),
        ).toEqual([]);
    });

    it("rejects fallback name conflicts but never attaches an unrelated node based on name alone", async () => {
      const esb = randomUUID();
      const fallback = await seed({ esb });
      await expect(
        refresher(csv([{ gsisId: gsis(), esb, name: "Someone Else" }])).refresh(true),
      ).rejects.toThrow("identity conflicts with an existing roster player");
      expect(await find(fallback.id)).toMatchObject({ gsisId: null });
      const unrelatedGsis = gsis();
      await refresher(csv([{ gsisId: unrelatedGsis }])).refresh(true);
      const [unrelated] = await handle.db
        .select()
        .from(players)
        .where(eq(players.gsisId, unrelatedGsis));
      expect(unrelated!.id).not.toBe(fallback.id);
    });
  },
);
