/** Real snapshot ordering and recurrence regressions; uses only a disposable PostgreSQL. */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
  scoringRules,
  syncRuns,
  users,
} from "@laces-out/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrizzleEspnSyncPersistence } from "./espn-sync-persistence.js";
import {
  DrizzleProjectionRefreshDemandRepository,
  ProjectionRefreshDemandDispatcher,
} from "./projection-refresh-demand.js";
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
        "--memory=384m",
        "--memory-swap=384m",
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

  async function scenario(provider: "espn" | "yahoo", season = SEASON) {
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
      season,
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

  function espnBundle(
    externalKey: string,
    letter: "a" | "b" | "c",
    step: number,
    identity = false,
  ): LeagueSyncBundle {
    const source = yahooBundle(externalKey, letter, step);
    return {
      ...source,
      provider: "espn",
      league: {
        ...source.league,
        externalId: `espn:${SEASON}:${externalKey}`,
        providerLeagueId: externalKey,
        provider: "espn",
      },
      teams: source.teams.map((team) => ({
        ...team,
        externalId: `espn:${SEASON}:${externalKey}:team:${team.providerTeamId}`,
        isCurrentUser: identity && team.providerTeamId === "1",
        roster: team.roster.map((player) => ({
          ...player,
          externalId: `espn:${player.providerPlayerId}`,
        })),
      })),
      provenance: {
        ...source.provenance,
        mode: "server-session",
        endpoint: "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2031",
      },
    };
  }

  function persistCore(
    provider: "espn" | "yahoo",
    s: Awaited<ReturnType<typeof scenario>>,
    letter: "a" | "b" | "c",
    step: number,
    identity = false,
  ) {
    if (provider === "yahoo") {
      return new DrizzleYahooSyncRepository(handle.db, () => capture(10)).persistBundle(
        s.userId,
        s.connectionId,
        yahooBundle(s.externalKey, letter, step),
      );
    }
    return new DrizzleEspnSyncPersistence(handle.db).persist({
      authority: {
        mode: "server-session",
        actorUserId: s.userId,
        connectionId: s.connectionId,
        leagueSeasonId: s.leagueSeasonId,
      },
      bundle: espnBundle(s.externalKey, letter, step, identity),
      checksumSha256: letter.repeat(64),
      effectiveAt: capture(step),
      now: capture(10),
      idempotencyKey: `espn-session:${s.leagueSeasonId}:${letter}`,
      kind: "espn-session",
    });
  }

  async function demandFor(leagueSeasonId: string): Promise<string | null> {
    const [row] = await handle.db
      .select({ demandId: leagueSeasons.projectionRefreshDemandId })
      .from(leagueSeasons)
      .where(eq(leagueSeasons.id, leagueSeasonId));
    if (!row) throw new Error("Test league season disappeared");
    return row.demandId;
  }

  async function setDemand(leagueSeasonId: string, demandId: string | null): Promise<void> {
    await handle.db
      .update(leagueSeasons)
      .set({ projectionRefreshDemandId: demandId })
      .where(eq(leagueSeasons.id, leagueSeasonId));
  }

  it("applies migration 0051 with nullable UUID demand and the bounded pending-season index", async () => {
    const columns = await handle.db.execute<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(sql`
      select data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public' and table_name = 'league_seasons'
        and column_name = 'projection_refresh_demand_id'
    `);
    expect([...columns]).toEqual([{ data_type: "uuid", is_nullable: "YES", column_default: null }]);
    const indexes = await handle.db.execute<{ indexdef: string }>(sql`
      select indexdef from pg_catalog.pg_indexes
      where schemaname = 'public' and tablename = 'league_seasons'
        and indexname = 'league_seasons_projection_demand_idx'
    `);
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toContain("USING btree (season, id)");
    expect(indexes[0]?.indexdef).toContain("WHERE (projection_refresh_demand_id IS NOT NULL)");
    const migrationHash = createHash("sha256")
      .update(
        readFileSync(
          new URL("../../db/migrations/0051_league_projection_demand.sql", import.meta.url),
        ),
      )
      .digest("hex");
    const recorded = await handle.db.execute<{ hash: string }>(sql`
      select hash from drizzle.__drizzle_migrations where hash = ${migrationHash}
    `);
    expect([...recorded]).toEqual([{ hash: migrationHash }]);
  });

  it.each(["espn", "yahoo"] as const)(
    "records %s core demand for accepted snapshots and preserves unchanged delivery state",
    async (provider) => {
      const s = await scenario(provider);
      expect(await demandFor(s.leagueSeasonId)).toBeNull();
      const first = await persistCore(provider, s, "a", 0);
      expect(first.state).toBe("accepted");
      const firstRunId = "receiptId" in first ? first.receiptId : first.syncRunId;
      expect(await demandFor(s.leagueSeasonId)).toBe(firstRunId);
      expect((await persistCore(provider, s, "a", 1)).state).toBe("unchanged");
      expect(await demandFor(s.leagueSeasonId)).toBe(firstRunId);

      await setDemand(s.leagueSeasonId, null);
      expect((await persistCore(provider, s, "a", 2)).state).toBe("unchanged");
      expect(await demandFor(s.leagueSeasonId)).toBeNull();
      const changed = await persistCore(provider, s, "b", 3);
      const changedRunId = "receiptId" in changed ? changed.receiptId : changed.syncRunId;
      expect(changed.state).toBe("accepted");
      expect(changedRunId).not.toBe(firstRunId);
      expect(await demandFor(s.leagueSeasonId)).toBe(changedRunId);
    },
  );

  it("creates projection demand on the first Yahoo import of a new league season", async () => {
    const s = await scenario("yahoo");
    await handle.db.delete(leagues).where(eq(leagues.id, s.leagueId));
    const receipt = await new DrizzleYahooSyncRepository(handle.db, () =>
      capture(10),
    ).persistBundle(s.userId, s.connectionId, yahooBundle(s.externalKey, "a", 0));
    expect(receipt.state).toBe("accepted");
    expect(receipt.leagueSeasonId).not.toBe(s.leagueSeasonId);
    expect(await demandFor(receipt.leagueSeasonId)).toBe(receipt.syncRunId);
  });

  it.each(["espn", "yahoo"] as const)(
    "rolls back %s projection demand with a failed core snapshot transaction",
    async (provider) => {
      const s = await scenario(provider);
      const priorDemandId = randomUUID();
      await setDemand(s.leagueSeasonId, priorDemandId);
      const triggerName = `reject_snapshot_${randomUUID().replaceAll("-", "")}`;
      await handle.db.execute(
        sql.raw(`
        create function ${triggerName}() returns trigger language plpgsql as $$
        begin
          if new.league_season_id = '${s.leagueSeasonId}'::uuid and new.state = 'succeeded' then
            raise exception 'injected late snapshot failure';
          end if;
          return new;
        end;
        $$;
      `),
      );
      await handle.db.execute(
        sql.raw(`
        create trigger ${triggerName} before update on sync_runs
        for each row execute function ${triggerName}();
      `),
      );
      try {
        await expect(persistCore(provider, s, "a", 0)).rejects.toThrow();
        expect(await demandFor(s.leagueSeasonId)).toBe(priorDemandId);
        expect(
          await handle.db
            .select({ id: fantasyTeams.id })
            .from(fantasyTeams)
            .where(eq(fantasyTeams.leagueSeasonId, s.leagueSeasonId)),
        ).toEqual([]);
        expect(
          await handle.db
            .select({ id: syncRuns.id })
            .from(syncRuns)
            .where(eq(syncRuns.leagueSeasonId, s.leagueSeasonId)),
        ).toEqual([]);
        const [season] = await handle.db
          .select({ lastSyncedAt: leagueSeasons.lastSyncedAt })
          .from(leagueSeasons)
          .where(eq(leagueSeasons.id, s.leagueSeasonId));
        expect(season?.lastSyncedAt).toBeNull();
      } finally {
        await handle.db.execute(sql.raw(`drop trigger ${triggerName} on sync_runs`));
        await handle.db.execute(sql.raw(`drop function ${triggerName}()`));
      }
      expect((await persistCore(provider, s, "a", 0)).state).toBe("accepted");
      expect(await demandFor(s.leagueSeasonId)).not.toBe(priorDemandId);
      expect(await demandFor(s.leagueSeasonId)).not.toBeNull();
    },
  );

  it("creates demand when an unchanged ESPN core capture establishes authenticated identity", async () => {
    const s = await scenario("espn");
    await persistCore("espn", s, "a", 0);
    await setDemand(s.leagueSeasonId, null);
    const identityReceipt = await persistCore("espn", s, "a", 1, true);
    expect(identityReceipt).toMatchObject({ state: "unchanged", identityChanged: true });
    const identityDemand = await demandFor(s.leagueSeasonId);
    expect(identityDemand).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await persistCore("espn", s, "a", 2, true)).toMatchObject({
      state: "unchanged",
      identityChanged: false,
    });
    expect(await demandFor(s.leagueSeasonId)).toBe(identityDemand);
    await setDemand(s.leagueSeasonId, null);
    await persistCore("espn", s, "a", 3, true);
    expect(await demandFor(s.leagueSeasonId)).toBeNull();
  });

  it("acknowledges only captured demand IDs after enqueue while preserving concurrent changes", async () => {
    const season = 2041;
    const first = await scenario("espn", season);
    const second = await scenario("yahoo", season);
    const arrivedLater = await scenario("espn", season);
    const firstDemand = randomUUID();
    const secondDemand = randomUUID();
    const newerDemand = randomUUID();
    const laterDemand = randomUUID();
    await setDemand(first.leagueSeasonId, firstDemand);
    await setDemand(second.leagueSeasonId, secondDemand);
    const readFreshness = () =>
      handle.db
        .select({
          id: leagueSeasons.id,
          updatedAt: leagueSeasons.updatedAt,
          lastSyncedAt: leagueSeasons.lastSyncedAt,
        })
        .from(leagueSeasons)
        .where(eq(leagueSeasons.season, season))
        .orderBy(leagueSeasons.id);
    const freshnessBefore = await readFreshness();
    const repository = new DrizzleProjectionRefreshDemandRepository(handle.db);
    let sent = 0;
    const dispatcher = new ProjectionRefreshDemandDispatcher({
      repository,
      enqueue: async (requestedSeason) => {
        expect(requestedSeason).toBe(season);
        sent++;
        if (sent === 1) {
          expect(await demandFor(first.leagueSeasonId)).toBe(firstDemand);
          expect(await demandFor(second.leagueSeasonId)).toBe(secondDemand);
          await setDemand(first.leagueSeasonId, newerDemand);
          await setDemand(arrivedLater.leagueSeasonId, laterDemand);
        }
        return randomUUID();
      },
    });
    expect(await dispatcher.dispatch(season)).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await demandFor(first.leagueSeasonId)).toBe(newerDemand);
    expect(await demandFor(second.leagueSeasonId)).toBeNull();
    expect(await demandFor(arrivedLater.leagueSeasonId)).toBe(laterDemand);
    await dispatcher.dispatch(season);
    expect(await demandFor(first.leagueSeasonId)).toBeNull();
    expect(await demandFor(arrivedLater.leagueSeasonId)).toBeNull();
    expect(await dispatcher.dispatch(season)).toBeNull();
    expect(sent).toBe(2);
    expect(await readFreshness()).toEqual(freshnessBefore);
  });

  it("retries real stored demand after deduplication, enqueue failure, and send-before-ack failure", async () => {
    const season = 2042;
    const s = await scenario("yahoo", season);
    const demandId = randomUUID();
    await setDemand(s.leagueSeasonId, demandId);
    const repository = new DrizzleProjectionRefreshDemandRepository(handle.db);
    const deduplicated = new ProjectionRefreshDemandDispatcher({
      repository,
      enqueue: async () => null,
    });
    expect(await deduplicated.dispatch(season)).toBeNull();
    expect(await demandFor(s.leagueSeasonId)).toBe(demandId);
    const failed = new ProjectionRefreshDemandDispatcher({
      repository,
      enqueue: async () => {
        throw new Error("Queue unavailable");
      },
    });
    await expect(failed.dispatch(season)).rejects.toThrow("Queue unavailable");
    expect(await demandFor(s.leagueSeasonId)).toBe(demandId);

    let failAcknowledgement = true;
    const durableJobs: string[] = [];
    const recovering = new ProjectionRefreshDemandDispatcher({
      repository: {
        capture: (requestedSeason, limit) => repository.capture(requestedSeason, limit),
        acknowledge: async (demands) => {
          if (failAcknowledgement) {
            failAcknowledgement = false;
            throw new Error("Database unavailable after queue commit");
          }
          await repository.acknowledge(demands);
        },
      },
      enqueue: async () => {
        const jobId = randomUUID();
        durableJobs.push(jobId);
        return jobId;
      },
    });
    await expect(recovering.dispatch(season)).rejects.toThrow(
      "Database unavailable after queue commit",
    );
    expect(durableJobs).toHaveLength(1);
    expect(await demandFor(s.leagueSeasonId)).toBe(demandId);
    expect(await recovering.dispatch(season)).toBe(durableJobs[1]);
    expect(durableJobs).toHaveLength(2);
    expect(await demandFor(s.leagueSeasonId)).toBeNull();
  });

  it("keeps unchanged explicit refreshes and excludes archived or other-season demand", async () => {
    const season = 2043;
    const active = await scenario("yahoo", season);
    const archived = await scenario("espn", season);
    const otherSeason = await scenario("espn", season + 1);
    const archivedDemand = randomUUID();
    const otherDemand = randomUUID();
    await setDemand(archived.leagueSeasonId, archivedDemand);
    await setDemand(otherSeason.leagueSeasonId, otherDemand);
    await handle.db
      .update(leagues)
      .set({ archived: true })
      .where(eq(leagues.id, archived.leagueId));
    let sent = 0;
    const dispatcher = new ProjectionRefreshDemandDispatcher({
      repository: new DrizzleProjectionRefreshDemandRepository(handle.db),
      enqueue: async () => {
        sent++;
        return randomUUID();
      },
    });
    expect(await dispatcher.dispatch(season)).toBeNull();
    expect(sent).toBe(0);
    expect(await dispatcher.dispatch(season, { enqueueWithoutDemand: true })).toMatch(
      /^[0-9a-f-]{36}$/u,
    );
    expect(sent).toBe(1);
    expect(await demandFor(active.leagueSeasonId)).toBeNull();
    expect(await demandFor(archived.leagueSeasonId)).toBe(archivedDemand);
    expect(await demandFor(otherSeason.leagueSeasonId)).toBe(otherDemand);
  });

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

  it("preserves fractional provider rates and repairs only verified legacy rounding", async () => {
    const s = await scenario("yahoo");
    const repository = new DrizzleYahooSyncRepository(handle.db, () => capture(10));
    const base = yahooBundle(s.externalKey, "a", 0);
    const rate = 1 / 150;
    const bundle: LeagueSyncBundle = {
      ...base,
      league: {
        ...base.league,
        settings: {
          ...base.league.settings,
          scoringRules: [
            { statId: "14", name: "Return Yards", points: rate },
            { statId: "15", name: "Manual edit", points: 6 },
            { statId: "16", name: "Negative rate", points: -rate },
          ],
        },
      },
    };
    await repository.persistBundle(s.userId, s.connectionId, bundle);
    const saved = async (): Promise<Record<string, number>> =>
      Object.fromEntries<number>(
        (
          await handle.db
            .select({ stat: scoringRules.providerStatId, points: scoringRules.points })
            .from(scoringRules)
            .where(eq(scoringRules.leagueSeasonId, s.leagueSeasonId))
        ).map((row) => [row.stat!, Number(row.points)]),
      );
    expect(await saved()).toEqual({ "14": rate, "15": 6, "16": -rate });
    // Reproduce values written by numeric(10,4), plus an intentional later manual override.
    for (const [stat, points] of [
      ["14", "0.0067"],
      ["15", "9"],
      ["16", "-0.0067"],
    ]) {
      await handle.db
        .update(scoringRules)
        .set({ points })
        .where(
          and(
            eq(scoringRules.leagueSeasonId, s.leagueSeasonId),
            eq(scoringRules.providerStatId, stat!),
          ),
        );
    }
    const migration = readFileSync(
      new URL("../../db/migrations/0050_preserve_scoring_precision.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      await handle.db.execute(sql.raw(statement));
    }
    expect(await saved()).toEqual({ "14": rate, "15": 9, "16": -rate });
    // Reapplying the repair remains safe and does not invent provider changes.
    for (const statement of migration.split("--> statement-breakpoint")) {
      await handle.db.execute(sql.raw(statement));
    }
    expect(await saved()).toEqual({ "14": rate, "15": 9, "16": -rate });
    await handle.db.execute(sql`
      update league_seasons set settings = jsonb_set(settings, '{scoringRules}',
        (settings->'scoringRules') || jsonb_build_array(jsonb_build_object('statId', '14', 'points', ${rate}::numeric)))
      where id = ${s.leagueSeasonId}`);
    await handle.db
      .update(scoringRules)
      .set({ points: "0.0067" })
      .where(
        and(
          eq(scoringRules.leagueSeasonId, s.leagueSeasonId),
          eq(scoringRules.providerStatId, "14"),
        ),
      );
    for (const statement of migration.split("--> statement-breakpoint")) {
      await handle.db.execute(sql.raw(statement));
    }
    expect(await saved()).toEqual({ "14": 0.0067, "15": 9, "16": -rate });
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
