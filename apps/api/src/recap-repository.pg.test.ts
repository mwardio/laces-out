/**
 * Real disposable-PostgreSQL tests for the recap repository.
 *
 * Every behavior exercised here is a SQL invariant, so a fake would only prove the fake agrees
 * with itself: upsert semantics on two unique indexes, the atomic generation lease, and the
 * league-season scoping that keeps last season's teams out of this season's League Intel.
 *
 * Safety: the container is created with an explicit, freshly generated, task-specific connection
 * string on a docker-assigned host port. No code here reads `process.env.DATABASE_URL` or any
 * `.env` file, and the container is force-removed in `afterAll` even if setup or a test throws.
 * The suite skips itself cleanly (via `describe.skipIf`) when docker is unavailable.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDatabase,
  fantasyTeams,
  leagueMemberships,
  leagueSeasons,
  leagues,
  providerConnections,
  providerLeagueLinks,
  recapGenerationGuards,
  recapPersonaCards,
  users,
  weeklyRecaps,
  type Database,
} from "@laces-out/db";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  DrizzleRecapRepository,
  RECAP_COOLDOWN_SECONDS,
  RECAP_LEASE_SECONDS,
  RecapLeaseLostError,
} from "./recap-service.js";

function dockerIsAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = dockerIsAvailable();

if (!dockerAvailable) {
  console.warn(
    "[recap-repository.pg.test] Skipping disposable-PostgreSQL recap tests: docker is unavailable.",
  );
}

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

interface DisposablePostgres {
  readonly containerName: string;
  readonly url: string;
}

async function startDisposablePostgres(): Promise<DisposablePostgres> {
  const containerName = `laces-out-recap-pg-${randomUUID().slice(0, 8)}`;
  const user = "laces_test";
  const password = randomBytes(16).toString("hex");
  const databaseName = "laces_test";

  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "--tmpfs",
      "/var/lib/postgresql/data",
      "-e",
      `POSTGRES_USER=${user}`,
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-e",
      `POSTGRES_DB=${databaseName}`,
      "-p",
      "127.0.0.1::5432",
      "postgres:16",
    ],
    { stdio: "ignore" },
  );

  const readyDeadline = Date.now() + 30_000;
  for (;;) {
    try {
      execFileSync(
        "docker",
        ["exec", containerName, "pg_isready", "-U", user, "-d", databaseName],
        { stdio: "ignore" },
      );
      break;
    } catch {
      if (Date.now() > readyDeadline) {
        throw new Error(`Disposable PostgreSQL container ${containerName} did not become ready`);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  const portMapping = execFileSync("docker", ["port", containerName, "5432/tcp"], {
    encoding: "utf8",
  }).trim();
  const port = Number(portMapping.split(":").pop());
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Could not determine the published host port for ${containerName}`);
  }
  const url = `postgres://${user}:${password}@127.0.0.1:${port}/${databaseName}`;

  const connectDeadline = Date.now() + 20_000;
  for (;;) {
    const probe = postgres(url, { max: 1, prepare: false, connect_timeout: 2 });
    try {
      await probe`select 1`;
      await probe.end({ timeout: 1 });
      break;
    } catch (error) {
      await probe.end({ timeout: 1 }).catch(() => {});
      if (Date.now() > connectDeadline) {
        throw new Error(`Could not connect to ${containerName}: ${String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  return { containerName, url };
}

const NOW = new Date("2031-10-07T16:20:00.000Z");

const ownerId = "10000000-0000-4000-8000-0000000000a1";
const managerId = "10000000-0000-4000-8000-0000000000a2";
const leagueId = "20000000-0000-4000-8000-0000000000b1";
const seasonId = "30000000-0000-4000-8000-0000000000c1";
const priorSeasonId = "30000000-0000-4000-8000-0000000000c0";
const teamId = "40000000-0000-4000-8000-0000000000d1";
const otherTeamId = "40000000-0000-4000-8000-0000000000d2";
const priorSeasonTeamId = "40000000-0000-4000-8000-0000000000d0";

describe.skipIf(!dockerAvailable)("recap repository against real PostgreSQL", () => {
  let container: DisposablePostgres;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let repository: DrizzleRecapRepository;

  beforeAll(async () => {
    container = await startDisposablePostgres();
    const migrationHandle = createDatabase(container.url, 1);
    try {
      await migrate(migrationHandle.db, { migrationsFolder });
    } finally {
      await migrationHandle.close();
    }
    handle = createDatabase(container.url, 5);
    db = handle.db;
    repository = new DrizzleRecapRepository(db);

    await db.insert(users).values([
      { id: ownerId, email: "owner@example.test", displayName: "League Guru" },
      { id: managerId, email: "manager@example.test", displayName: "Mack" },
    ]);
    await db.insert(leagues).values({ id: leagueId, ownerUserId: ownerId, name: "Recap League" });
    await db.insert(leagueSeasons).values([
      {
        id: priorSeasonId,
        leagueId,
        provider: "manual",
        externalKey: "recap-league-2030",
        season: 2030,
        teamCount: 2,
        draftType: "snake",
      },
      {
        id: seasonId,
        leagueId,
        provider: "manual",
        externalKey: "recap-league-2031",
        season: 2031,
        teamCount: 2,
        draftType: "snake",
      },
    ]);
    await db.insert(fantasyTeams).values([
      { id: priorSeasonTeamId, leagueSeasonId: priorSeasonId, externalKey: "1", name: "Old Guard" },
      { id: teamId, leagueSeasonId: seasonId, externalKey: "1", name: "Budget Ballers" },
      { id: otherTeamId, leagueSeasonId: seasonId, externalKey: "2", name: "Waiver Theory" },
    ]);
    // Inserting a league already creates its canonical owner membership; only the manager row is
    // seeded here.
    await db
      .insert(leagueMemberships)
      .values({ leagueId, userId: managerId, role: "member", claimedFantasyTeamId: teamId });
  }, 90_000);

  beforeEach(async () => {
    await db.delete(recapPersonaCards);
    await db.delete(weeklyRecaps);
    await db.delete(recapGenerationGuards);
    await db.update(leagues).set({ recapSpiceLevel: "medium" }).where(eq(leagues.id, leagueId));
  });

  afterAll(async () => {
    await handle?.close();
    if (container?.containerName) {
      try {
        execFileSync("docker", ["rm", "-f", "-v", container.containerName], {
          stdio: "ignore",
        });
      } catch {
        // Best-effort; the container was started with --rm.
      }
    }
  });

  async function acquire(week = 5, now = NOW) {
    const lease = await repository.acquireGeneration(seasonId, week, now);
    if (lease.state !== "acquired") throw new Error(`Expected a lease, got ${lease.state}`);
    return lease.leaseToken;
  }

  /** Drizzle wraps driver errors, so the constraint name lives on the cause rather than the top. */
  async function rejectionDetail(statement: () => Promise<unknown>): Promise<string> {
    try {
      await statement();
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      return cause instanceof Error ? cause.message : String(cause);
    }
    throw new Error("Expected the statement to be rejected");
  }

  function recapInput(week: number, body: string, spiceLevel: "mild" | "medium" | "scorched") {
    return {
      leagueSeasonId: seasonId,
      week,
      body,
      provider: "gemini" as const,
      model: "gemini-3.6-flash",
      spiceLevel,
      generatedByUserId: managerId,
    };
  }

  describe("stored recaps", () => {
    it("replaces the row on reroll and keeps generation-time provenance", async () => {
      const first = await acquire();
      await repository.saveRecapAndCompleteGeneration(
        recapInput(5, "The first take", "medium"),
        first,
        NOW,
      );

      const later = new Date(NOW.getTime() + (RECAP_COOLDOWN_SECONDS + 1) * 1_000);
      const second = await acquire(5, later);
      const stored = await repository.saveRecapAndCompleteGeneration(
        recapInput(5, "The reroll", "scorched"),
        second,
        later,
      );

      expect(stored).toMatchObject({
        week: 5,
        body: "The reroll",
        spiceLevel: "scorched",
        generatedByDisplayName: "Mack",
      });
      const rows = await db.select().from(weeklyRecaps);
      expect(rows).toHaveLength(1);
      // Moving the league dial afterwards must not relabel a stored recap.
      await repository.saveSpiceLevel(leagueId, "mild");
      expect((await repository.findRecap(seasonId, 5))?.spiceLevel).toBe("scorched");
    });

    it("keeps each week's recap separate", async () => {
      const week5 = await acquire(5);
      await repository.saveRecapAndCompleteGeneration(
        recapInput(5, "Week five", "medium"),
        week5,
        NOW,
      );
      const week4 = await acquire(4);
      await repository.saveRecapAndCompleteGeneration(
        recapInput(4, "Week four", "mild"),
        week4,
        NOW,
      );

      expect((await repository.findRecap(seasonId, 5))?.body).toBe("Week five");
      expect((await repository.findRecap(seasonId, 4))?.body).toBe("Week four");
      expect(await repository.findRecap(seasonId, 3)).toBeUndefined();
    });

    it("refuses to store under a lease it no longer holds", async () => {
      const stale = await acquire();
      // Another member's completion clears the guard and takes the slot.
      await repository.saveRecapAndCompleteGeneration(
        recapInput(5, "Someone else's take", "medium"),
        stale,
        NOW,
      );

      await expect(
        repository.saveRecapAndCompleteGeneration(
          recapInput(5, "The loser's take", "medium"),
          randomUUID(),
          NOW,
        ),
      ).rejects.toBeInstanceOf(RecapLeaseLostError);
      expect((await repository.findRecap(seasonId, 5))?.body).toBe("Someone else's take");
    });
  });

  describe("League Intel", () => {
    it("upserts one card per team and reads back the updater", async () => {
      const created = await repository.saveCard({
        leagueSeasonId: seasonId,
        fantasyTeamId: teamId,
        body: "Fears kickers.",
        updatedByUserId: managerId,
      });
      expect(created).toMatchObject({
        teamName: "Budget Ballers",
        body: "Fears kickers.",
        updatedByDisplayName: "Mack",
      });

      const moderated = await repository.saveCard({
        leagueSeasonId: seasonId,
        fantasyTeamId: teamId,
        body: "Moderated by the commissioner.",
        updatedByUserId: ownerId,
      });
      expect(moderated).toMatchObject({
        body: "Moderated by the commissioner.",
        updatedByDisplayName: "League Guru",
      });
      expect(await db.select().from(recapPersonaCards)).toHaveLength(1);
    });

    it("clears a card and reports whether anything was removed", async () => {
      await repository.saveCard({
        leagueSeasonId: seasonId,
        fantasyTeamId: teamId,
        body: "Fears kickers.",
        updatedByUserId: managerId,
      });

      await expect(repository.deleteCard(seasonId, teamId)).resolves.toBe(true);
      await expect(repository.deleteCard(seasonId, teamId)).resolves.toBe(false);
      expect(await repository.listCards(seasonId)).toEqual([]);
    });

    it("never lists or clears another season's team through this season", async () => {
      await repository.saveCard({
        leagueSeasonId: priorSeasonId,
        fantasyTeamId: priorSeasonTeamId,
        body: "Last year's bit.",
        updatedByUserId: managerId,
      });
      await repository.saveCard({
        leagueSeasonId: seasonId,
        fantasyTeamId: teamId,
        body: "This year's bit.",
        updatedByUserId: managerId,
      });

      expect((await repository.listCards(seasonId)).map((card) => card.body)).toEqual([
        "This year's bit.",
      ]);
      // The season guard, not just the team id, is what scopes the delete.
      await expect(repository.deleteCard(seasonId, priorSeasonTeamId)).resolves.toBe(false);
      expect(await repository.listCards(priorSeasonId)).toHaveLength(1);
    });

    it("rejects an empty or oversized body at the database", async () => {
      await expect(
        rejectionDetail(() =>
          db.insert(recapPersonaCards).values({
            leagueSeasonId: seasonId,
            fantasyTeamId: otherTeamId,
            body: "   ",
          }),
        ),
      ).resolves.toContain("recap_persona_cards_body_check");
      await expect(
        rejectionDetail(() =>
          db.insert(recapPersonaCards).values({
            leagueSeasonId: seasonId,
            fantasyTeamId: otherTeamId,
            body: "x".repeat(501),
          }),
        ),
      ).resolves.toContain("recap_persona_cards_body_check");
    });

    it("supplies prompt inputs from the latest season only", async () => {
      await repository.saveSpiceLevel(leagueId, "scorched");
      await repository.saveCard({
        leagueSeasonId: priorSeasonId,
        fantasyTeamId: priorSeasonTeamId,
        body: "Last year's bit.",
        updatedByUserId: managerId,
      });
      await repository.saveCard({
        leagueSeasonId: seasonId,
        fantasyTeamId: teamId,
        body: "This year's bit.",
        updatedByUserId: managerId,
      });

      expect(await repository.getPromptInputs(leagueId)).toEqual({
        spiceLevel: "scorched",
        personaCards: [{ teamName: "Budget Ballers", notes: "This year's bit." }],
      });
    });
  });

  describe("generation guard", () => {
    it("grants the lease to exactly one of two concurrent attempts", async () => {
      const [first, second] = await Promise.all([
        repository.acquireGeneration(seasonId, 5, NOW),
        repository.acquireGeneration(seasonId, 5, NOW),
      ]);

      const acquired = [first, second].filter((result) => result.state === "acquired");
      expect(acquired).toHaveLength(1);
      const blocked = [first, second].find((result) => result.state !== "acquired");
      expect(blocked?.state).toBe("in-progress");
    });

    it("refuses a second lease while the first is live and reports the wait", async () => {
      await acquire();

      const blocked = await repository.acquireGeneration(seasonId, 5, NOW);

      expect(blocked).toEqual({
        state: "in-progress",
        retryAfterSeconds: RECAP_LEASE_SECONDS,
      });
      await expect(repository.getGenerationAvailability(seasonId, 5, NOW)).resolves.toEqual({
        state: "in-progress",
        retryAfterSeconds: RECAP_LEASE_SECONDS,
      });
    });

    it("recovers an expired lease without an operator", async () => {
      await acquire();

      const afterExpiry = new Date(NOW.getTime() + (RECAP_LEASE_SECONDS + 1) * 1_000);
      const recovered = await repository.acquireGeneration(seasonId, 5, afterExpiry);

      expect(recovered.state).toBe("acquired");
    });

    it("releases a failed generation immediately and starts no cooldown", async () => {
      const token = await acquire();

      await repository.abandonGeneration(seasonId, 5, token);

      await expect(repository.getGenerationAvailability(seasonId, 5, NOW)).resolves.toEqual({
        state: "available",
      });
      expect((await repository.acquireGeneration(seasonId, 5, NOW)).state).toBe("acquired");
    });

    it("ignores an abandon call carrying someone else's token", async () => {
      await acquire();

      await repository.abandonGeneration(seasonId, 5, randomUUID());

      await expect(repository.getGenerationAvailability(seasonId, 5, NOW)).resolves.toMatchObject({
        state: "in-progress",
      });
    });

    it("starts a cooldown on success and reopens once it elapses", async () => {
      const token = await acquire();
      await repository.saveRecapAndCompleteGeneration(
        recapInput(5, "The recap", "medium"),
        token,
        NOW,
      );

      const duringCooldown = new Date(NOW.getTime() + 5_000);
      await expect(
        repository.getGenerationAvailability(seasonId, 5, duringCooldown),
      ).resolves.toEqual({
        state: "cooldown",
        retryAfterSeconds: RECAP_COOLDOWN_SECONDS - 5,
      });
      expect((await repository.acquireGeneration(seasonId, 5, duringCooldown)).state).toBe(
        "cooldown",
      );

      const afterCooldown = new Date(NOW.getTime() + (RECAP_COOLDOWN_SECONDS + 1) * 1_000);
      await expect(
        repository.getGenerationAvailability(seasonId, 5, afterCooldown),
      ).resolves.toEqual({ state: "available" });
      expect((await repository.acquireGeneration(seasonId, 5, afterCooldown)).state).toBe(
        "acquired",
      );
    });

    it("guards each week independently", async () => {
      await acquire(5);

      expect((await repository.acquireGeneration(seasonId, 6, NOW)).state).toBe("acquired");
      const guards = await db
        .select()
        .from(recapGenerationGuards)
        .where(eq(recapGenerationGuards.leagueSeasonId, seasonId));
      expect(guards).toHaveLength(2);
    });
  });

  describe("league reads", () => {
    it("returns the configured spice level and the claimed team of a member", async () => {
      await repository.saveSpiceLevel(leagueId, "mild");

      await expect(repository.getSpiceLevel(leagueId)).resolves.toBe("mild");
      await expect(repository.findMembership(managerId, leagueId)).resolves.toEqual({
        role: "member",
        explicitCommissioner: false,
        providerCommissioner: false,
        claimedFantasyTeamId: teamId,
      });
      await expect(repository.findLatestSeason(leagueId)).resolves.toEqual({ id: seasonId });
    });

    it("resolves exact provider commissioner evidence independently from canonical ownership", async () => {
      const providerOwnerId = randomUUID();
      const providerLeagueId = randomUUID();
      const providerSeasonId = randomUUID();
      const connectionId = randomUUID();
      const externalLeagueKey = String(Date.now());
      await db.insert(users).values({
        id: providerOwnerId,
        email: `${providerOwnerId}@example.test`,
        displayName: "Provider Owner",
      });
      await db.insert(providerConnections).values({
        id: connectionId,
        userId: providerOwnerId,
        provider: "espn",
        externalAccountId: `espn-${providerOwnerId}`,
      });
      await db.insert(leagues).values({
        id: providerLeagueId,
        ownerUserId: providerOwnerId,
        name: "Provider Authority League",
      });
      await db.insert(leagueSeasons).values({
        id: providerSeasonId,
        leagueId: providerLeagueId,
        provider: "espn",
        externalKey: externalLeagueKey,
        season: 2031,
        teamCount: 2,
        draftType: "snake",
      });
      await db.insert(providerLeagueLinks).values({
        connectionId,
        leagueSeasonId: providerSeasonId,
        currentUserTeamExternalKey: `espn:2031:${externalLeagueKey}:team:1`,
        providerCommissioner: true,
        providerCommissionerObservedAt: NOW,
      });

      await expect(
        repository.findMembership(providerOwnerId, providerLeagueId),
      ).resolves.toMatchObject({
        role: "owner",
        explicitCommissioner: false,
        providerCommissioner: true,
      });

      await db
        .update(providerLeagueLinks)
        .set({ providerCommissioner: false, providerCommissionerObservedAt: NOW })
        .where(
          and(
            eq(providerLeagueLinks.connectionId, connectionId),
            eq(providerLeagueLinks.leagueSeasonId, providerSeasonId),
          ),
        );
      await expect(
        repository.findMembership(providerOwnerId, providerLeagueId),
      ).resolves.toMatchObject({ providerCommissioner: false, explicitCommissioner: false });

      // Even a corrupted cross-provider link cannot become authority for this ESPN season.
      await db
        .update(providerLeagueLinks)
        .set({ providerCommissioner: true, providerCommissionerObservedAt: NOW })
        .where(
          and(
            eq(providerLeagueLinks.connectionId, connectionId),
            eq(providerLeagueLinks.leagueSeasonId, providerSeasonId),
          ),
        );
      await db
        .update(providerConnections)
        .set({ provider: "yahoo" })
        .where(eq(providerConnections.id, connectionId));
      await expect(
        repository.findMembership(providerOwnerId, providerLeagueId),
      ).resolves.toMatchObject({ providerCommissioner: false, explicitCommissioner: false });
    });

    it("keeps canonical ownership transfer invariants without inventing commissioner authority", async () => {
      const ownerId = randomUUID();
      const successorId = randomUUID();
      const transferLeagueId = randomUUID();
      await db.insert(users).values([
        { id: ownerId, email: `${ownerId}@example.test`, displayName: "Original Owner" },
        { id: successorId, email: `${successorId}@example.test`, displayName: "Successor" },
      ]);
      await db.insert(leagues).values({
        id: transferLeagueId,
        ownerUserId: ownerId,
        name: "Ownership Transfer",
      });
      await db.insert(leagueMemberships).values({
        leagueId: transferLeagueId,
        userId: successorId,
        role: "member",
      });

      await db
        .update(leagues)
        .set({ ownerUserId: successorId })
        .where(eq(leagues.id, transferLeagueId));
      await expect(
        db
          .select({ role: leagueMemberships.role })
          .from(leagueMemberships)
          .where(
            and(
              eq(leagueMemberships.leagueId, transferLeagueId),
              eq(leagueMemberships.userId, ownerId),
            ),
          ),
      ).resolves.toEqual([{ role: "member" }]);

      await db
        .update(leagueMemberships)
        .set({ explicitCommissioner: true })
        .where(
          and(
            eq(leagueMemberships.leagueId, transferLeagueId),
            eq(leagueMemberships.userId, successorId),
          ),
        );
      await db
        .update(leagues)
        .set({ ownerUserId: ownerId })
        .where(eq(leagues.id, transferLeagueId));
      await expect(
        db
          .select({
            role: leagueMemberships.role,
            explicit: leagueMemberships.explicitCommissioner,
          })
          .from(leagueMemberships)
          .where(
            and(
              eq(leagueMemberships.leagueId, transferLeagueId),
              eq(leagueMemberships.userId, successorId),
            ),
          ),
      ).resolves.toEqual([{ role: "commissioner", explicit: true }]);
      await expect(
        db
          .select({ role: leagueMemberships.role })
          .from(leagueMemberships)
          .where(
            and(
              eq(leagueMemberships.leagueId, transferLeagueId),
              eq(leagueMemberships.userId, ownerId),
            ),
          ),
      ).resolves.toEqual([{ role: "owner" }]);
    });

    it("rejects a spice level outside the enum at the database", async () => {
      await expect(
        rejectionDetail(() =>
          db
            .update(leagues)
            .set({ recapSpiceLevel: "nuclear" as "mild" })
            .where(eq(leagues.id, leagueId)),
        ),
      ).resolves.toContain("leagues_recap_spice_level_check");
    });

    it("lists only the requested season's teams", async () => {
      const teams = await repository.listTeams(seasonId);

      expect(teams.map((team) => team.name)).toEqual(["Budget Ballers", "Waiver Theory"]);
      expect(
        await db
          .select({ id: fantasyTeams.id })
          .from(fantasyTeams)
          .where(
            and(
              eq(fantasyTeams.leagueSeasonId, priorSeasonId),
              eq(fantasyTeams.id, priorSeasonTeamId),
            ),
          ),
      ).toHaveLength(1);
    });
  });
});
