import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { loadEnvironment } from "@laces-out/config";
import type { EspnBridgeSnapshot } from "@laces-out/contracts";
import {
  bridgeDeviceLeagues,
  createDatabase,
  type Database,
  fantasyTeams,
  leagueMemberships,
  leagues,
  leagueSeasons,
  matchupSnapshots,
  rosterSnapshots,
  standingsEntries,
  standingsSnapshots,
  syncRuns,
  users,
  weeklyMatchups,
} from "@laces-out/db";
import { and, count, eq } from "drizzle-orm";

import { EspnBridgeService } from "../src/espn-bridge.js";

interface SmokeResult {
  readonly state: "accepted" | "unchanged";
  readonly replayState: "accepted" | "unchanged";
  readonly teams: number;
  readonly rosterSnapshots: number;
  readonly standingsEntries: number;
  readonly weeklyMatchups: number;
  readonly recordsRead: number;
  readonly memberships: number;
  readonly memberState: "accepted" | "unchanged";
  readonly initialOwnerEstablished: true;
  readonly configuredScopeGrantedNothing: true;
  readonly providerConnectionAutoEnrolled: true;
  readonly staleSnapshotRejected: true;
  readonly deviceListed: true;
  readonly revokedReplayRejected: true;
  readonly rolledBack: true;
}

class SmokeRollback extends Error {
  readonly result: SmokeResult;

  constructor(result: SmokeResult) {
    super("Roll back the ESPN bridge smoke transaction");
    this.name = "SmokeRollback";
    this.result = result;
  }
}

async function ensureSmokeUser(
  database: Database,
  email: string,
  displayName: string,
  role: "admin" | "member",
): Promise<string> {
  const inserted = await database
    .insert(users)
    .values({ email, displayName, passwordHash: null, role })
    .onConflictDoNothing()
    .returning({ id: users.id });
  const existing = inserted[0]
    ? undefined
    : (
        await database.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
      )[0];
  const userId = inserted[0]?.id ?? existing?.id;
  assert.ok(userId, "smoke user must exist");
  return userId;
}

const environment = loadEnvironment();
const database = createDatabase(environment.DATABASE_URL, 1);
let smokeResult: SmokeResult | undefined;

try {
  const fixtureUrl = new URL(
    "../../../packages/connector-espn/test/fixtures/web-client-v1.json",
    import.meta.url,
  );
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as EspnBridgeSnapshot;
  const payloadJson = JSON.stringify(fixture.payload);
  const snapshot: EspnBridgeSnapshot = {
    ...fixture,
    capturedAt: new Date().toISOString(),
    checksumSha256: createHash("sha256").update(payloadJson, "utf8").digest("hex"),
  };

  await database.db.transaction(async (transaction) => {
    // The bridge service accepts the transaction handle for this smoke run so all nested
    // work is confined to a savepoint and deliberately rolled back at the end.
    const smokeDatabase = transaction as unknown as Database;
    const userId = await ensureSmokeUser(
      smokeDatabase,
      "bridge-smoke@lacesout.local",
      "ESPN Bridge Smoke",
      "admin",
    );
    const outsiderUserId = await ensureSmokeUser(
      smokeDatabase,
      "bridge-friend-smoke@lacesout.local",
      "ESPN Bridge Friend Smoke",
      "member",
    );

    const bridge = new EspnBridgeService(smokeDatabase);
    const credential = await bridge.registerDevice(userId, {
      name: "Database smoke device",
      clientKind: "chrome-extension",
      agentCapabilities: [],
      season: snapshot.season,
      allowedLeagueIds: [snapshot.leagueId],
    });
    assert.match(
      credential.deviceToken,
      /^lo_espn_[A-Za-z0-9_-]{43}$/u,
      "new bridge credentials must use the Laces Out token namespace",
    );
    const firstReceipt = await bridge.acceptSnapshot(credential.deviceToken, snapshot);
    const replayReceipt = await bridge.acceptSnapshot(credential.deviceToken, snapshot);
    const staleSnapshot: EspnBridgeSnapshot = {
      ...snapshot,
      capturedAt: new Date(new Date(snapshot.capturedAt).getTime() - 60_000).toISOString(),
    };
    await assert.rejects(
      bridge.acceptSnapshot(credential.deviceToken, staleSnapshot),
      (error: unknown) =>
        error instanceof Error &&
        "statusCode" in error &&
        (error as { statusCode: unknown }).statusCode === 409,
      "an older snapshot must not roll canonical league state backward",
    );
    const driftPayload = JSON.parse(JSON.stringify(snapshot.payload)) as {
      teams: Array<{ playoffSeed?: number; record?: unknown }>;
    };
    delete driftPayload.teams[0]?.record;
    delete driftPayload.teams[0]?.playoffSeed;
    const driftSnapshot: EspnBridgeSnapshot = {
      ...snapshot,
      payload: driftPayload,
      checksumSha256: createHash("sha256")
        .update(JSON.stringify(driftPayload), "utf8")
        .digest("hex"),
    };
    await assert.rejects(
      bridge.acceptSnapshot(credential.deviceToken, driftSnapshot),
      /standings|payload|contract/iu,
      "schema drift must fail without replacing the last good state",
    );
    const [season] = await smokeDatabase
      .select({
        id: leagueSeasons.id,
        leagueId: leagueSeasons.leagueId,
        teamCount: leagueSeasons.teamCount,
        ownerUserId: leagues.ownerUserId,
      })
      .from(leagueSeasons)
      .innerJoin(leagues, eq(leagueSeasons.leagueId, leagues.id))
      .where(
        and(
          eq(leagueSeasons.provider, "espn"),
          eq(leagueSeasons.externalKey, snapshot.leagueId),
          eq(leagueSeasons.season, snapshot.season),
        ),
      )
      .limit(1);
    assert.ok(season, "ESPN season must be persisted");
    assert.equal(season.ownerUserId, userId, "the first bridge importer must own a new league");
    const [ownerMembership] = await smokeDatabase
      .select({ role: leagueMemberships.role })
      .from(leagueMemberships)
      .where(
        and(eq(leagueMemberships.leagueId, season.leagueId), eq(leagueMemberships.userId, userId)),
      )
      .limit(1);
    assert.equal(ownerMembership?.role, "owner", "new bridge ownership must be explicit");

    const outsiderCredential = await bridge.registerDevice(outsiderUserId, {
      name: "League mate database smoke device",
      clientKind: "chrome-extension",
      agentCapabilities: [],
      season: snapshot.season,
      allowedLeagueIds: [snapshot.leagueId],
    });
    const [scopeBeforeAuthority] = await smokeDatabase
      .select({ leagueId: bridgeDeviceLeagues.leagueId })
      .from(bridgeDeviceLeagues)
      .where(eq(bridgeDeviceLeagues.bridgeDeviceId, outsiderCredential.deviceId))
      .limit(1);
    const [membershipBeforeAuthority] = await smokeDatabase
      .select({ role: leagueMemberships.role })
      .from(leagueMemberships)
      .where(
        and(
          eq(leagueMemberships.leagueId, season.leagueId),
          eq(leagueMemberships.userId, outsiderUserId),
        ),
      )
      .limit(1);
    assert.equal(
      scopeBeforeAuthority?.leagueId,
      null,
      "a configured league ID must remain unlinked",
    );
    assert.equal(
      membershipBeforeAuthority,
      undefined,
      "configuring a league ID without a successful provider sync must grant nothing",
    );

    const memberReceipt = await bridge.acceptSnapshot(outsiderCredential.deviceToken, snapshot);
    const [connectedMembership] = await smokeDatabase
      .select({ role: leagueMemberships.role })
      .from(leagueMemberships)
      .where(
        and(
          eq(leagueMemberships.leagueId, season.leagueId),
          eq(leagueMemberships.userId, outsiderUserId),
        ),
      )
      .limit(1);

    assert.equal(replayReceipt.state, "unchanged", "replayed snapshot must be idempotent");
    assert.equal(replayReceipt.receiptId, firstReceipt.receiptId);
    assert.equal(
      memberReceipt.state,
      "unchanged",
      "the same canonical provider artifact must not create duplicate league data",
    );
    assert.equal(memberReceipt.receiptId, firstReceipt.receiptId);
    assert.equal(
      connectedMembership?.role,
      "member",
      "a successful provider connection must join the existing shared league",
    );

    const [teamTotal] = await smokeDatabase
      .select({ value: count() })
      .from(fantasyTeams)
      .where(eq(fantasyTeams.leagueSeasonId, season.id));
    const [snapshotTotal] = await smokeDatabase
      .select({ value: count() })
      .from(rosterSnapshots)
      .innerJoin(fantasyTeams, eq(rosterSnapshots.teamId, fantasyTeams.id))
      .where(eq(rosterSnapshots.sourceSyncRunId, firstReceipt.receiptId));
    const [standingTotal] = await smokeDatabase
      .select({ value: count() })
      .from(standingsEntries)
      .innerJoin(standingsSnapshots, eq(standingsEntries.snapshotId, standingsSnapshots.id))
      .where(eq(standingsSnapshots.sourceSyncRunId, firstReceipt.receiptId));
    const [matchupTotal] = await smokeDatabase
      .select({ value: count() })
      .from(weeklyMatchups)
      .innerJoin(matchupSnapshots, eq(weeklyMatchups.snapshotId, matchupSnapshots.id))
      .where(eq(matchupSnapshots.sourceSyncRunId, firstReceipt.receiptId));
    const [run] = await smokeDatabase
      .select({ state: syncRuns.state, recordsRead: syncRuns.recordsRead })
      .from(syncRuns)
      .where(eq(syncRuns.id, firstReceipt.receiptId))
      .limit(1);
    const [membershipTotal] = await smokeDatabase
      .select({ value: count() })
      .from(leagueMemberships)
      .where(eq(leagueMemberships.leagueId, season.leagueId));
    const [memberScope] = await smokeDatabase
      .select({ leagueId: bridgeDeviceLeagues.leagueId })
      .from(bridgeDeviceLeagues)
      .where(
        and(
          eq(bridgeDeviceLeagues.bridgeDeviceId, outsiderCredential.deviceId),
          eq(bridgeDeviceLeagues.externalLeagueId, snapshot.leagueId),
        ),
      )
      .limit(1);

    assert.equal(Number(teamTotal?.value ?? 0), season.teamCount);
    assert.equal(Number(snapshotTotal?.value ?? 0), season.teamCount);
    assert.equal(Number(standingTotal?.value ?? 0), season.teamCount);
    assert.equal(Number(matchupTotal?.value ?? 0), 3);
    assert.equal(run?.state, "succeeded");
    assert.ok((run?.recordsRead ?? 0) > 0, "sync receipt must record roster entries");
    assert.equal(
      Number(membershipTotal?.value ?? 0),
      2,
      "both successful provider connections must establish membership",
    );
    assert.equal(
      memberScope?.leagueId,
      season.leagueId,
      "a provider-connected member scope must link after a successful sync",
    );

    const devices = await bridge.listDevices(userId);
    assert.equal(devices.devices.length, 1, "the owner must see only their own bridge device");
    assert.equal(devices.devices[0]?.state, "active");
    assert.deepEqual(devices.devices[0]?.allowedLeagues, [
      {
        externalLeagueId: snapshot.leagueId,
        season: snapshot.season,
        leagueId: season.leagueId,
        leagueName: "Moonshot Friends League",
      },
    ]);
    const revocation = await bridge.revokeDevice(userId, credential.deviceId);
    assert.equal(revocation?.deviceId, credential.deviceId);
    assert.equal((await bridge.listDevices(userId)).devices[0]?.state, "revoked");
    await assert.rejects(
      bridge.acceptSnapshot(credential.deviceToken, snapshot),
      /not active/iu,
      "a revoked device token must stop working immediately",
    );

    throw new SmokeRollback({
      state: firstReceipt.state,
      replayState: replayReceipt.state,
      teams: Number(teamTotal?.value ?? 0),
      rosterSnapshots: Number(snapshotTotal?.value ?? 0),
      standingsEntries: Number(standingTotal?.value ?? 0),
      weeklyMatchups: Number(matchupTotal?.value ?? 0),
      recordsRead: run?.recordsRead ?? 0,
      memberships: Number(membershipTotal?.value ?? 0),
      memberState: memberReceipt.state,
      initialOwnerEstablished: true,
      configuredScopeGrantedNothing: true,
      providerConnectionAutoEnrolled: true,
      staleSnapshotRejected: true,
      deviceListed: true,
      revokedReplayRejected: true,
      rolledBack: true,
    });
  });
} catch (error) {
  if (error instanceof SmokeRollback) smokeResult = error.result;
  else throw error;
} finally {
  await database.close();
}

assert.ok(smokeResult, "smoke transaction must finish through the expected rollback");
process.stdout.write(`${JSON.stringify(smokeResult)}\n`);
