import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parseYahooLeagueSyncArtifacts } from "@fantasy/connector-yahoo";
import type { LeagueSyncBundle } from "@fantasy/connectors";
import { loadEnvironment } from "@fantasy/config";
import {
  createDatabase,
  fantasyTeams,
  leagueMemberships,
  providerConnections,
  providerLeagueLinks,
  syncRuns,
  type Database,
  users,
} from "@fantasy/db";
import { count, eq } from "drizzle-orm";

import { DrizzleLeagueDashboardRepository } from "../src/league-dashboard.js";
import { DrizzleYahooSyncRepository } from "../src/yahoo-sync.js";

interface SmokeResult {
  readonly firstState: "accepted" | "unchanged";
  readonly replayState: "accepted" | "unchanged";
  readonly friendState: "accepted" | "unchanged";
  readonly memberships: number;
  readonly connectionLinks: number;
  readonly isolatedStatus: true;
  readonly ownerAutoClaimed: true;
  readonly wrongYahooTeamDenied: true;
  readonly crossUserMappedClaimDenied: true;
  readonly historicalClaimConflictDidNotFailSync: true;
  readonly failedSyncRolledBack: true;
  readonly rolledBack: true;
}

class SmokeRollback extends Error {
  readonly result: SmokeResult;

  constructor(result: SmokeResult) {
    super("Roll back the Yahoo sync smoke transaction");
    this.name = "SmokeRollback";
    this.result = result;
  }
}

async function fixture(name: string): Promise<string> {
  return readFile(
    new URL(`../../../packages/connector-yahoo/test/fixtures/${name}`, import.meta.url),
    "utf8",
  );
}

const environment = loadEnvironment();
const database = createDatabase(environment.DATABASE_URL, 1);
let result: SmokeResult | undefined;

try {
  const fetchedAt = new Date("2026-07-16T12:00:00.000Z");
  const bundle = parseYahooLeagueSyncArtifacts({
    settingsXml: await fixture("sanitized-settings.xml"),
    teamsXml: await fixture("sanitized-teams.xml"),
    rostersXml: await fixture("sanitized-rosters.xml"),
    standingsXml: await fixture("sanitized-standings.xml"),
    matchupsXml: await fixture("sanitized-scoreboard.xml"),
    fetchedAt,
    endpoint: "https://fantasysports.yahooapis.com/fantasy/v2/league/449.l.12345",
  });

  await database.db.transaction(async (transaction) => {
    const smokeDatabase = transaction as unknown as Database;
    const [owner, friend] = await smokeDatabase
      .insert(users)
      .values([
        {
          email: "yahoo-owner-smoke@lacesout.local",
          displayName: "Yahoo Owner Smoke",
          role: "admin",
        },
        {
          email: "yahoo-friend-smoke@lacesout.local",
          displayName: "Yahoo Friend Smoke",
          role: "member",
        },
      ])
      .returning({ id: users.id });
    assert.ok(owner && friend, "Yahoo smoke users must be created");
    const [ownerConnection, friendConnection] = await smokeDatabase
      .insert(providerConnections)
      .values([
        {
          userId: owner.id,
          provider: "yahoo",
          externalAccountId: "sanitized-owner-guid",
          displayName: "Yahoo Fantasy",
          health: "healthy",
        },
        {
          userId: friend.id,
          provider: "yahoo",
          externalAccountId: "sanitized-friend-guid",
          displayName: "Yahoo Fantasy",
          health: "healthy",
        },
      ])
      .returning({ id: providerConnections.id });
    assert.ok(ownerConnection && friendConnection, "Yahoo smoke connections must be created");

    const repository = new DrizzleYahooSyncRepository(smokeDatabase, () => fetchedAt);
    const first = await repository.persistBundle(owner.id, ownerConnection.id, bundle);
    const replay = await repository.persistBundle(owner.id, ownerConnection.id, bundle);
    const friendFirst = await repository.persistBundle(friend.id, friendConnection.id, bundle);

    assert.equal(first.state, "accepted");
    assert.equal(replay.state, "unchanged");
    assert.equal(replay.syncRunId, first.syncRunId);
    assert.equal(friendFirst.state, "accepted");
    assert.equal(friendFirst.leagueId, first.leagueId);
    assert.notEqual(friendFirst.syncRunId, first.syncRunId);

    const [membershipTotal] = await smokeDatabase
      .select({ value: count() })
      .from(leagueMemberships)
      .where(eq(leagueMemberships.leagueId, first.leagueId));
    const [linkTotal] = await smokeDatabase
      .select({ value: count() })
      .from(providerLeagueLinks)
      .where(eq(providerLeagueLinks.leagueSeasonId, first.leagueSeasonId));
    assert.equal(Number(membershipTotal?.value ?? 0), 2);
    assert.equal(Number(linkTotal?.value ?? 0), 2);

    const mappedExternalKey = bundle.teams.find((team) => team.isCurrentUser)?.externalId;
    assert.ok(mappedExternalKey, "Yahoo fixture must identify one current-user team");
    const storedTeams = await smokeDatabase
      .select({ id: fantasyTeams.id, externalKey: fantasyTeams.externalKey })
      .from(fantasyTeams)
      .where(eq(fantasyTeams.leagueSeasonId, first.leagueSeasonId));
    const mappedTeam = storedTeams.find((team) => team.externalKey === mappedExternalKey);
    const wrongTeam = storedTeams.find((team) => team.externalKey !== mappedExternalKey);
    assert.ok(mappedTeam && wrongTeam, "Yahoo smoke must persist mapped and non-mapped teams");
    const membershipRows = await smokeDatabase
      .select({
        userId: leagueMemberships.userId,
        claimedTeamId: leagueMemberships.claimedFantasyTeamId,
      })
      .from(leagueMemberships)
      .where(eq(leagueMemberships.leagueId, first.leagueId));
    assert.equal(
      membershipRows.find((membership) => membership.userId === owner.id)?.claimedTeamId,
      mappedTeam.id,
      "an unambiguous Yahoo team mapping should auto-claim for the first account",
    );
    assert.equal(
      membershipRows.find((membership) => membership.userId === friend.id)?.claimedTeamId,
      null,
      "a historical cross-user claim conflict must not fail sync or steal the team",
    );

    const dashboardRepository = new DrizzleLeagueDashboardRepository(smokeDatabase);
    assert.deepEqual(
      await dashboardRepository.claimTeam(friend.id, first.leagueId, wrongTeam.id, fetchedAt),
      { state: "provider-mismatch" },
      "a Yahoo member cannot claim a team other than their provider mapping",
    );
    assert.deepEqual(
      await dashboardRepository.claimTeam(friend.id, first.leagueId, mappedTeam.id, fetchedAt),
      { state: "taken" },
      "the mapped team cannot be claimed across users when an older claim owns it",
    );

    const ownerStatus = await repository.listConnectionStatus(owner.id);
    const friendStatus = await repository.listConnectionStatus(friend.id);
    assert.deepEqual(
      ownerStatus.map((status) => status.connectionId),
      [ownerConnection.id],
    );
    assert.deepEqual(
      friendStatus.map((status) => status.connectionId),
      [friendConnection.id],
    );
    assert.equal(await repository.findOwnedConnection(owner.id, friendConnection.id), undefined);

    const [beforeFailedRun] = await smokeDatabase.select({ value: count() }).from(syncRuns);
    const invalidBundle = JSON.parse(JSON.stringify(bundle)) as LeagueSyncBundle & {
      teams: Array<{ isCurrentUser: boolean }>;
      provenance: { artifactChecksumSha256: string };
    };
    invalidBundle.teams[1]!.isCurrentUser = true;
    invalidBundle.provenance.artifactChecksumSha256 = "f".repeat(64);
    await assert.rejects(
      repository.persistBundle(owner.id, ownerConnection.id, invalidBundle),
      /more than one team/iu,
    );
    const [afterFailedRun] = await smokeDatabase.select({ value: count() }).from(syncRuns);
    assert.equal(
      afterFailedRun?.value,
      beforeFailedRun?.value,
      "failed sync must roll back its run",
    );

    throw new SmokeRollback({
      firstState: first.state,
      replayState: replay.state,
      friendState: friendFirst.state,
      memberships: Number(membershipTotal?.value ?? 0),
      connectionLinks: Number(linkTotal?.value ?? 0),
      isolatedStatus: true,
      ownerAutoClaimed: true,
      wrongYahooTeamDenied: true,
      crossUserMappedClaimDenied: true,
      historicalClaimConflictDidNotFailSync: true,
      failedSyncRolledBack: true,
      rolledBack: true,
    });
  });
} catch (error) {
  if (error instanceof SmokeRollback) result = error.result;
  else throw error;
} finally {
  await database.close();
}

assert.ok(result, "Yahoo smoke transaction must finish through the expected rollback");
process.stdout.write(`${JSON.stringify(result)}\n`);
