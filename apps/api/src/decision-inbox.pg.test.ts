/** Real SQL authorization and receipt persistence; only a freshly created disposable DB is used. */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  createDatabase,
  decisionInboxReceipts,
  fantasyTeams,
  leagueMemberships,
  leagues,
  leagueSeasons,
  users,
} from "@laces-out/db";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DecisionInboxService, DrizzleDecisionInboxRepository } from "./decision-inbox.js";
import {
  decisionInboxSnapshot,
  INBOX_LEAGUE_ID as LEAGUE,
  INBOX_NOW as NOW,
  INBOX_OTHER_TEAM_ID as OTHER_TEAM,
  INBOX_OTHER_USER_ID as OTHER_USER,
  INBOX_TEAM_ID as TEAM,
  INBOX_USER_ID as USER,
} from "./decision-inbox-test-fixtures.js";

function dockerAvailable() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const OWNER = "10000000-0000-4000-8000-000000000003";
const FOREIGN_LEAGUE = "20000000-0000-4000-8000-000000000002";
const SEASON = "50000000-0000-4000-8000-000000000001";
const NEW_SEASON = "50000000-0000-4000-8000-000000000002";

describe.skipIf(!dockerAvailable())("Decision inbox receipts against disposable PostgreSQL", () => {
  const containerName = `laces-out-inbox-pg-${randomUUID().slice(0, 8)}`;
  let handle: ReturnType<typeof createDatabase>;
  let repository: DrizzleDecisionInboxRepository;
  let service: DecisionInboxService;
  const decisions = {
    getSnapshot: async (userId: string) => {
      const access = await repository.findAccess(userId, LEAGUE);
      if (!access) return undefined;
      return decisionInboxSnapshot({
        team: access.teamId ? { id: access.teamId, name: "Claimed team", faabRemaining: 82 } : null,
      });
    },
  };

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
        "POSTGRES_USER=inbox_test",
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "-e",
        "POSTGRES_DB=inbox_test",
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
    handle = createDatabase(`postgres://inbox_test:${password}@127.0.0.1:${port}/inbox_test`, 2);
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
            "inbox_test",
            "-d",
            "inbox_test",
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
    repository = new DrizzleDecisionInboxRepository(handle.db);
    await handle.db.insert(users).values([
      { id: USER, email: "manager@inbox.test", displayName: "Manager" },
      { id: OTHER_USER, email: "other@inbox.test", displayName: "Other manager" },
      { id: OWNER, email: "owner@inbox.test", displayName: "Owner" },
    ]);
    // League insertion creates the owner's membership through the existing integrity trigger.
    await handle.db.insert(leagues).values([
      { id: LEAGUE, ownerUserId: OWNER, name: "Inbox league" },
      { id: FOREIGN_LEAGUE, ownerUserId: OWNER, name: "Unrelated league" },
    ]);
    await handle.db.insert(leagueSeasons).values({
      id: SEASON,
      leagueId: LEAGUE,
      provider: "espn",
      externalKey: "inbox-test",
      season: 2026,
      currentWeek: 2,
      teamCount: 2,
      draftType: "snake",
      lastSyncedAt: new Date(NOW),
    });
    await handle.db.insert(fantasyTeams).values([
      { id: TEAM, leagueSeasonId: SEASON, externalKey: "1", name: "Team A" },
      { id: OTHER_TEAM, leagueSeasonId: SEASON, externalKey: "2", name: "Team B" },
    ]);
  }, 60_000);

  beforeEach(async () => {
    await handle.db.delete(leagueMemberships).where(eq(leagueMemberships.userId, USER));
    await handle.db.delete(leagueMemberships).where(eq(leagueMemberships.userId, OTHER_USER));
    await handle.db.delete(leagueSeasons).where(eq(leagueSeasons.id, NEW_SEASON));
    await handle.db.insert(leagueMemberships).values([
      { leagueId: LEAGUE, userId: USER, role: "member", claimedFantasyTeamId: TEAM },
      { leagueId: LEAGUE, userId: OTHER_USER, role: "member", claimedFantasyTeamId: OTHER_TEAM },
    ]);
    service = new DecisionInboxService(repository, decisions, () => new Date(NOW));
  });

  afterAll(async () => {
    await handle?.close();
    try {
      execFileSync("docker", ["rm", "-f", "-v", containerName], { stdio: "ignore" });
    } catch {
      /* --rm also cleans a stopped container. */
    }
  }, 30_000);

  it("persists review/dismissal across service restarts and isolates the same fingerprint by account", async () => {
    const own = await service.getInbox(USER, LEAGUE);
    const other = await service.getInbox(OTHER_USER, LEAGUE);
    expect(own?.team?.id).toBe(TEAM);
    expect(other?.team?.id).toBe(OTHER_TEAM);
    const itemId = own!.items[0]!.id;
    expect(await service.setState(USER, LEAGUE, itemId, "reviewed")).toEqual({
      itemId,
      state: "reviewed",
      updatedAt: NOW,
    });
    const restarted = new DecisionInboxService(
      new DrizzleDecisionInboxRepository(handle.db),
      decisions,
    );
    expect((await restarted.getInbox(USER, LEAGUE))?.items[0]?.state).toBe("reviewed");
    expect((await restarted.getInbox(OTHER_USER, LEAGUE))?.items[0]?.state).toBe("open");
    expect(await service.setState(OTHER_USER, LEAGUE, itemId, "dismissed")).toBeUndefined();
    const otherAccess = (await repository.findAccess(OTHER_USER, LEAGUE))!;
    await repository.saveReceipt(
      {
        userId: OTHER_USER,
        leagueId: LEAGUE,
        teamId: OTHER_TEAM,
        membershipId: otherAccess.membershipId,
      },
      itemId,
      "dismissed",
      new Date(NOW),
    );
    expect((await restarted.getInbox(USER, LEAGUE))?.items[0]?.state).toBe("reviewed");
    await restarted.setState(USER, LEAGUE, itemId, "dismissed");
    expect((await service.getInbox(USER, LEAGUE))?.items[0]?.state).toBe("dismissed");
    await restarted.setState(USER, LEAGUE, itemId, "open");
    expect((await service.getInbox(USER, LEAGUE))?.items[0]?.state).toBe("open");
  });

  it("rejects cross-league and stale-claim writes and revokes a cached inbox immediately", async () => {
    const itemId = (await service.getInbox(USER, LEAGUE))!.items[0]!.id;
    const access = (await repository.findAccess(USER, LEAGUE))!;
    const scope = {
      userId: USER,
      leagueId: LEAGUE,
      teamId: TEAM,
      membershipId: access.membershipId,
    };
    await service.setState(USER, LEAGUE, itemId, "dismissed");
    expect(await repository.findAccess(USER, FOREIGN_LEAGUE)).toBeUndefined();
    expect(
      await repository.saveReceipt(
        { ...scope, leagueId: FOREIGN_LEAGUE },
        itemId,
        "reviewed",
        new Date(NOW),
      ),
    ).toBeUndefined();
    expect(
      await repository.saveReceipt(
        { ...scope, teamId: OTHER_TEAM },
        itemId,
        "reviewed",
        new Date(NOW),
      ),
    ).toBeUndefined();
    await handle.db.delete(leagueMemberships).where(eq(leagueMemberships.id, access.membershipId));
    expect(await service.getInbox(USER, LEAGUE)).toBeUndefined();
    expect(await service.setState(USER, LEAGUE, itemId, "reviewed")).toBeUndefined();
    expect(await repository.saveReceipt(scope, itemId, "reviewed", new Date(NOW))).toBeUndefined();
    expect(await repository.listReceipts(scope, [itemId])).toEqual([]);
    expect(
      await handle.db
        .select()
        .from(decisionInboxReceipts)
        .where(eq(decisionInboxReceipts.userId, USER)),
    ).toEqual([]);
    await handle.db
      .insert(leagueMemberships)
      .values({ userId: USER, leagueId: LEAGUE, role: "member", claimedFantasyTeamId: TEAM });
    expect((await service.getInbox(USER, LEAGUE))?.items[0]?.state).toBe("open");
  });

  it("invalidates on league sync and only admits claims in the latest season", async () => {
    const first = (await repository.findAccess(USER, LEAGUE))!;
    const itemId = (await service.getInbox(USER, LEAGUE))!.items[0]!.id;
    await handle.db
      .update(leagueSeasons)
      .set({ currentWeek: 3, lastSyncedAt: new Date("2026-09-15T13:00:00.000Z") })
      .where(eq(leagueSeasons.id, SEASON));
    expect((await repository.findAccess(USER, LEAGUE))?.revision).not.toBe(first.revision);
    await handle.db.insert(leagueSeasons).values({
      id: NEW_SEASON,
      leagueId: LEAGUE,
      provider: "espn",
      externalKey: "inbox-test",
      season: 2027,
      currentWeek: 1,
      teamCount: 2,
      draftType: "snake",
    });
    expect((await repository.findAccess(USER, LEAGUE))?.teamId).toBeNull();
    expect(
      await repository.saveReceipt(
        { userId: USER, leagueId: LEAGUE, teamId: TEAM, membershipId: first.membershipId },
        itemId,
        "reviewed",
        new Date(NOW),
      ),
    ).toBeUndefined();
  });
});
