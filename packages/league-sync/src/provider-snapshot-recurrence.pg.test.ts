/** Real snapshot ordering and recurrence regressions; uses only a disposable PostgreSQL. */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { LeagueSupplementalBundle, LeagueSyncBundle } from "@laces-out/connectors";
import {
  createDatabase,
  fantasyTeams,
  leagueMemberships,
  leagues,
  leagueSeasons,
  leagueSupplementalSnapshots,
  providerConnections,
  providerLeagueLinks,
  rosterEntries,
  rosterSnapshots,
  syncRuns,
  users,
} from "@laces-out/db";
import { and, desc, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrizzleEspnSyncPersistence } from "./espn-sync-persistence.js";
import { DrizzleYahooSyncRepository } from "./yahoo-sync.js";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const SEASON = 2031;
const START = new Date("2031-09-16T12:00:00.000Z");
const capture = (step: number) => new Date(START.getTime() + step * 60_000);

describe.skipIf(!dockerAvailable())("Provider snapshot recurrence against PostgreSQL", () => {
  const containerName = `laces-out-snapshot-pg-${randomUUID().slice(0, 8)}`;
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
        "POSTGRES_USER=snapshot_test",
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "-e",
        "POSTGRES_DB=snapshot_test",
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
    if (!Number.isSafeInteger(port) || port <= 0) throw new Error("Disposable PG port missing");
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
            "snapshot_test",
            "-d",
            "snapshot_test",
          ],
          { stdio: "ignore" },
        );
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("Disposable PG did not start");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    handle = createDatabase(
      `postgres://snapshot_test:${password}@127.0.0.1:${port}/snapshot_test`,
      3,
    );
    await migrate(handle.db, {
      migrationsFolder: fileURLToPath(new URL("../../db/migrations", import.meta.url)),
    });
  }, 60_000);

  afterAll(async () => {
    await handle?.close();
    try {
      execFileSync("docker", ["rm", "-f", "-v", containerName], { stdio: "ignore" });
    } catch {
      /* --rm also removes stopped containers. */
    }
  }, 30_000);

  async function scenario(provider: "espn" | "yahoo") {
    const userId = randomUUID();
    const connectionId = randomUUID();
    const leagueId = randomUUID();
    const leagueSeasonId = randomUUID();
    const externalKey =
      provider === "yahoo"
        ? `449.l.${Date.now()}${Math.floor(Math.random() * 10000)}`
        : String(Date.now());
    await handle.db
      .insert(users)
      .values({ id: userId, email: `${userId}@snapshot.test`, displayName: "Manager" });
    await handle.db.insert(providerConnections).values({
      id: connectionId,
      userId,
      provider,
      externalAccountId: userId,
      encryptedCredential: { version: 1, ciphertext: "sanitized-test-envelope" },
      capabilities: {
        authentication: [
          provider === "espn" ? "server-session-cookie" : "oauth2-authorization-code-pkce",
        ],
      },
      health: "healthy",
    });
    await handle.db.insert(leagues).values({ id: leagueId, ownerUserId: userId, name: "Initial" });
    await handle.db.insert(leagueSeasons).values({
      id: leagueSeasonId,
      leagueId,
      connectionId,
      provider,
      externalKey,
      season: SEASON,
      status: "active",
      teamCount: 2,
      draftType: "snake",
      currentWeek: 1,
    });
    await handle.db.insert(providerLeagueLinks).values({ connectionId, leagueSeasonId });
    return { userId, connectionId, leagueId, leagueSeasonId, externalKey };
  }

  function yahooBundle(
    externalKey: string,
    letter: "a" | "b" | "c",
    step: number,
  ): LeagueSyncBundle {
    return {
      schemaVersion: 1,
      provider: "yahoo",
      league: {
        externalId: externalKey,
        providerLeagueId: externalKey.split(".").at(-1)!,
        provider: "yahoo",
        season: SEASON,
        name: `League ${letter}`,
        url: null,
        currentWeek: 1,
        settings: {
          teamCount: 2,
          draftType: "snake",
          auctionBudget: null,
          waiverType: "rolling",
          faabBudget: null,
          playoffTeamCount: 2,
          rosterSlots: [],
          scoringRules: [],
        },
      },
      teams: ["1", "2"].map((id) => ({
        externalId: `${externalKey}.t.${id}`,
        providerTeamId: id,
        name: `Team ${id}`,
        abbreviation: null,
        url: null,
        logoUrl: null,
        isCurrentUser: id === "1",
        managers: [],
        roster:
          id === "1"
            ? [
                {
                  externalId: `${externalKey}.p.1`,
                  providerPlayerId: "1",
                  fullName: "Roster Player",
                  primaryPosition: "RB",
                  eligiblePositions: ["RB"],
                  lineupSlot: letter === "a" ? "RB" : "BN",
                  proTeamAbbreviation: "KC",
                  status: "ACTIVE",
                },
              ]
            : [],
      })),
      provenance: {
        mode: "official-api",
        endpoint: "https://fantasysports.yahooapis.com/fantasy/v2/league/test",
        fetchedAt: capture(step).toISOString(),
        artifactChecksumSha256: letter.repeat(64),
      },
      warnings: [],
    };
  }

  it("persists Yahoo A-B-A transitions and deduplicates only the current snapshot", async () => {
    const s = await scenario("yahoo");
    const repository = new DrizzleYahooSyncRepository(handle.db, () => capture(10));
    const persist = (letter: "a" | "b", step: number) =>
      repository.persistBundle(s.userId, s.connectionId, yahooBundle(s.externalKey, letter, step));
    const first = await persist("a", 0);
    const second = await persist("b", 1);
    const third = await persist("a", 2);
    expect([first.state, second.state, third.state]).toEqual(["accepted", "accepted", "accepted"]);
    expect(new Set([first.syncRunId, second.syncRunId, third.syncRunId]).size).toBe(3);
    expect(await persist("a", 3)).toMatchObject({ state: "unchanged", syncRunId: third.syncRunId });
    const [latest] = await handle.db
      .select({ id: rosterSnapshots.id })
      .from(rosterSnapshots)
      .innerJoin(fantasyTeams, eq(fantasyTeams.id, rosterSnapshots.teamId))
      .where(
        and(
          eq(fantasyTeams.leagueSeasonId, s.leagueSeasonId),
          eq(fantasyTeams.externalKey, `${s.externalKey}.t.1`),
        ),
      )
      .orderBy(desc(rosterSnapshots.effectiveAt))
      .limit(1);
    expect(
      await handle.db
        .select({ slot: rosterEntries.slotCode })
        .from(rosterEntries)
        .where(eq(rosterEntries.snapshotId, latest!.id)),
    ).toEqual([{ slot: "RB" }]);
    const [league] = await handle.db.select().from(leagues).where(eq(leagues.id, s.leagueId));
    expect(league?.name).toBe("League a");
    expect((await persist("b", 4)).state).toBe("accepted");
  });

  it("rejects Yahoo captures older than an unchanged freshness check and equal-time conflicts", async () => {
    const s = await scenario("yahoo");
    const repository = new DrizzleYahooSyncRepository(handle.db, () => capture(10));
    const persist = (letter: "a" | "b" | "c", step: number) =>
      repository.persistBundle(s.userId, s.connectionId, yahooBundle(s.externalKey, letter, step));
    await persist("a", 0);
    const current = await persist("b", 2);
    expect(await persist("b", 4)).toMatchObject({
      state: "unchanged",
      syncRunId: current.syncRunId,
    });
    for (const [letter, step] of [
      ["a", 1],
      ["b", 3],
      ["c", 3],
      ["c", 4],
    ] as const) {
      await expect(persist(letter, step)).rejects.toThrow("older than or conflicts");
    }
    const [season] = await handle.db
      .select()
      .from(leagueSeasons)
      .where(eq(leagueSeasons.id, s.leagueSeasonId));
    const [league] = await handle.db.select().from(leagues).where(eq(leagues.id, s.leagueId));
    expect(season?.lastSyncedAt).toEqual(capture(4));
    expect(league?.name).toBe("League b");
    expect(
      await handle.db
        .select({ id: syncRuns.id })
        .from(syncRuns)
        .where(eq(syncRuns.leagueSeasonId, s.leagueSeasonId)),
    ).toHaveLength(2);
  });

  it("preserves a new Yahoo member's access while deduplicating their subsequent capture", async () => {
    const s = await scenario("yahoo");
    const repository = new DrizzleYahooSyncRepository(handle.db, () => capture(10));
    const first = await repository.persistBundle(
      s.userId,
      s.connectionId,
      yahooBundle(s.externalKey, "a", 0),
    );
    const secondUserId = randomUUID();
    const secondConnectionId = randomUUID();
    await handle.db.insert(users).values({
      id: secondUserId,
      email: `${secondUserId}@snapshot.test`,
      displayName: "Second manager",
    });
    await handle.db.insert(providerConnections).values({
      id: secondConnectionId,
      userId: secondUserId,
      provider: "yahoo",
      externalAccountId: secondUserId,
      encryptedCredential: { version: 1, ciphertext: "sanitized-test-envelope" },
      health: "healthy",
    });
    const joined = await repository.persistBundle(
      secondUserId,
      secondConnectionId,
      yahooBundle(s.externalKey, "a", 1),
    );
    expect(joined).toMatchObject({ state: "accepted", leagueSeasonId: first.leagueSeasonId });
    expect(joined.syncRunId).not.toBe(first.syncRunId);
    expect(
      await handle.db
        .select({ role: leagueMemberships.role })
        .from(leagueMemberships)
        .where(
          and(
            eq(leagueMemberships.leagueId, s.leagueId),
            eq(leagueMemberships.userId, secondUserId),
          ),
        ),
    ).toEqual([{ role: "member" }]);
    expect(
      await repository.persistBundle(
        secondUserId,
        secondConnectionId,
        yahooBundle(s.externalKey, "a", 2),
      ),
    ).toMatchObject({ state: "unchanged", syncRunId: joined.syncRunId });
  });

  it("persists ESPN supplemental A-B-A transitions and preserves immediate retry receipts", async () => {
    const s = await scenario("espn");
    const repository = new DrizzleEspnSyncPersistence(handle.db);
    const persist = (letter: "a" | "b", step: number) => {
      const bundle: LeagueSupplementalBundle = {
        provider: "espn",
        leagueExternalId: `espn:${SEASON}:${s.externalKey}`,
        providerLeagueId: s.externalKey,
        season: SEASON,
        kind: "weekly-box-scores",
        week: 1,
        matchups: [],
        playerScores: [],
        warnings: [],
        provenance: {
          mode: "server-session",
          endpoint: "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2031",
          fetchedAt: capture(step).toISOString(),
          artifactChecksumSha256: letter.repeat(64),
        },
      };
      return repository.persistSupplemental({
        authority: {
          mode: "server-session",
          actorUserId: s.userId,
          connectionId: s.connectionId,
          leagueSeasonId: s.leagueSeasonId,
        },
        bundle,
        checksumSha256: letter.repeat(64),
        effectiveAt: capture(step),
        now: capture(10),
        idempotencyKey: `espn-supplemental:${s.leagueSeasonId}:${letter}`,
      });
    };
    const first = await persist("a", 0);
    const second = await persist("b", 1);
    const third = await persist("a", 2);
    expect([first.state, second.state, third.state]).toEqual(["accepted", "accepted", "accepted"]);
    expect(new Set([first.receiptId, second.receiptId, third.receiptId]).size).toBe(3);
    expect(await persist("a", 3)).toMatchObject({ state: "unchanged", receiptId: third.receiptId });
    const saved = await handle.db
      .select()
      .from(leagueSupplementalSnapshots)
      .where(eq(leagueSupplementalSnapshots.leagueSeasonId, s.leagueSeasonId));
    expect(saved).toHaveLength(3);
    expect(saved.filter((row) => row.artifactChecksum === "a".repeat(64))).toHaveLength(2);
    await expect(persist("b", 2)).rejects.toThrow();
    expect((await persist("b", 4)).state).toBe("accepted");
  });
});
