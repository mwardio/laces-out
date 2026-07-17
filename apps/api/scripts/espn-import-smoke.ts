import assert from "node:assert/strict";

import { loadEnvironment } from "@fantasy/config";
import {
  createDatabase,
  fantasyTeams,
  leagueMemberships,
  leagues,
  leagueSeasons,
  playerExternalIds,
  players,
  rosterEntries,
  rosterSlotRules,
  rosterSnapshots,
  scoringRules,
  syncRuns,
  users,
  type Database,
} from "@fantasy/db";
import { and, count, eq, inArray, or } from "drizzle-orm";

import { EspnManualImportService } from "../src/espn-import.js";
import { DrizzleProjectionImportRepository } from "../src/projection-import.js";
import { DrizzleRankingRepository } from "../src/ranking-repository.js";
import {
  ESPN_SELF_ASSERTED_PLAYER_SOURCE,
  DrizzleEspnSyncPersistence,
  espnSelfAssertedPlayerKey,
} from "../src/espn-sync-persistence.js";

interface SmokeResult {
  readonly firstState: "accepted";
  readonly replayState: "unchanged";
  readonly commissionerState: "accepted";
  readonly teams: number;
  readonly rosterSnapshots: number;
  readonly rosterEntries: number;
  readonly ownerMemberships: number;
  readonly normalizedPlayerIds: number;
  readonly nonmemberDenied: true;
  readonly managerDenied: true;
  readonly canonicalPlayerPreserved: true;
  readonly selfAssertedMappingUnverified: true;
  readonly selfAssertedIdentityQuarantined: true;
  readonly selfAssertedExcludedFromGlobalCatalog: true;
  readonly selfAssertedAvailableInLeagueScope: true;
  readonly invalidReplacementRolledBack: true;
  readonly rolledBack: true;
}

class SmokeRollback extends Error {
  readonly result: SmokeResult;

  constructor(result: SmokeResult) {
    super("Roll back the ESPN manual import smoke transaction");
    this.name = "SmokeRollback";
    this.result = result;
  }
}

async function createSmokeUser(
  database: Database,
  email: string,
  displayName: string,
): Promise<string> {
  const [user] = await database
    .insert(users)
    .values({ email, displayName, passwordHash: null, role: "member" })
    .returning({ id: users.id });
  assert.ok(user, "smoke user must be created");
  return user.id;
}

function artifact(input: {
  readonly leagueId: string;
  readonly importedAt: string;
  readonly name: string;
  readonly playerIdBase: string;
  readonly teamCount?: 1 | 2;
}) {
  const teamCount = input.teamCount ?? 2;
  const teams = [
    {
      id: "1",
      name: "Laces High",
      abbreviation: "LH",
      logoUrl: null,
      isCurrentUser: true,
      managers: [
        {
          id: "manager-1",
          displayName: "League Owner",
          isCommissioner: true,
        },
      ],
      roster: [
        {
          id: `${input.playerIdBase}1`,
          fullName: "Smoke Quarterback",
          primaryPosition: "QB",
          eligiblePositions: ["QB"],
          lineupSlot: "QB",
          proTeamAbbreviation: "CHI",
          status: null,
        },
      ],
    },
    {
      id: "2",
      name: "Wide Right",
      abbreviation: "WR",
      logoUrl: null,
      isCurrentUser: false,
      managers: [],
      roster: [
        {
          id: `${input.playerIdBase}2`,
          fullName: "Smoke Receiver",
          primaryPosition: "WR",
          eligiblePositions: ["WR"],
          lineupSlot: "BN",
          proTeamAbbreviation: "MIA",
          status: "ACTIVE",
        },
      ],
    },
  ];
  return {
    schemaVersion: 1,
    provider: "espn",
    importedAt: input.importedAt,
    league: {
      id: input.leagueId,
      season: 2026,
      name: input.name,
      currentWeek: 2,
      settings: {
        teamCount,
        draftType: "auction",
        auctionBudget: 200,
        waiverType: "faab",
        faabBudget: 100,
        playoffTeamCount: teamCount,
        rosterSlots: [
          { position: "QB", count: 1, starting: true },
          { position: "BN", count: 4, starting: false },
        ],
        scoringRules: [{ statId: "PASS_TD", name: "Passing touchdown", points: 4 }],
      },
    },
    teams: teams.slice(0, teamCount),
  };
}

const environment = loadEnvironment();
const database = createDatabase(environment.DATABASE_URL, 1);
let smokeResult: SmokeResult | undefined;

try {
  await database.db.transaction(async (transaction) => {
    const smokeDatabase = transaction as unknown as Database;
    const uniqueness = String(Date.now());
    const leagueProviderId = uniqueness;
    const playerIdBase = uniqueness.slice(0, 18);
    const ownerId = await createSmokeUser(
      smokeDatabase,
      `espn-import-owner-${uniqueness}@lacesout.local`,
      "ESPN Import Owner",
    );
    const commissionerId = await createSmokeUser(
      smokeDatabase,
      `espn-import-commissioner-${uniqueness}@lacesout.local`,
      "ESPN Import Commissioner",
    );
    const managerId = await createSmokeUser(
      smokeDatabase,
      `espn-import-manager-${uniqueness}@lacesout.local`,
      "ESPN Import Manager",
    );
    const nonmemberId = await createSmokeUser(
      smokeDatabase,
      `espn-import-outsider-${uniqueness}@lacesout.local`,
      "ESPN Import Outsider",
    );
    const now = new Date();
    const firstImportedAt = new Date(now.getTime() - 60_000).toISOString();
    const replacementImportedAt = new Date(now.getTime() - 30_000).toISOString();
    const service = new EspnManualImportService(
      new DrizzleEspnSyncPersistence(smokeDatabase),
      () => now,
    );
    const [canonicalPlayer] = await smokeDatabase
      .insert(players)
      .values({
        gsisId: `espn-smoke-${uniqueness}`,
        fullName: "Trusted Catalog Quarterback",
        nflTeam: "GB",
        primaryPosition: "QB",
        eligiblePositions: ["QB"],
        status: "ACTIVE",
      })
      .returning({ id: players.id });
    assert.ok(canonicalPlayer, "trusted catalog player must be seeded");
    await smokeDatabase.insert(playerExternalIds).values({
      playerId: canonicalPlayer.id,
      source: "espn",
      externalId: `${playerIdBase}1`,
      season: 2026,
      confidence: "1",
      verified: true,
    });
    const firstArtifact = artifact({
      leagueId: leagueProviderId,
      importedAt: firstImportedAt,
      name: "Manual Smoke League",
      playerIdBase,
    });
    const firstChecksum = service.preview(firstArtifact).provenance.artifactChecksumSha256;
    const first = await service.commit(ownerId, {
      snapshot: firstArtifact,
      expectedChecksumSha256: firstChecksum,
    });
    const replay = await service.commit(ownerId, {
      snapshot: firstArtifact,
      expectedChecksumSha256: firstChecksum,
    });

    assert.equal(first.state, "accepted");
    assert.equal(replay.state, "unchanged");
    assert.equal(replay.receiptId, first.receiptId);
    const [createdLeague] = await smokeDatabase
      .select({ ownerUserId: leagues.ownerUserId, name: leagues.name })
      .from(leagues)
      .where(eq(leagues.id, first.league.id))
      .limit(1);
    assert.equal(createdLeague?.ownerUserId, ownerId, "first importer must own the new league");
    const [ownerMembership] = await smokeDatabase
      .select({ role: leagueMemberships.role })
      .from(leagueMemberships)
      .where(
        and(eq(leagueMemberships.leagueId, first.league.id), eq(leagueMemberships.userId, ownerId)),
      )
      .limit(1);
    assert.equal(ownerMembership?.role, "owner");

    await assert.rejects(
      service.commit(nonmemberId, {
        snapshot: firstArtifact,
        expectedChecksumSha256: firstChecksum,
      }),
      (error: unknown) =>
        error instanceof Error &&
        "statusCode" in error &&
        (error as { statusCode: unknown }).statusCode === 404,
      "nonmembers must not learn about or replay another user's import",
    );

    await smokeDatabase.insert(leagueMemberships).values([
      { leagueId: first.league.id, userId: commissionerId, role: "commissioner" },
      { leagueId: first.league.id, userId: managerId, role: "manager" },
    ]);
    const replacementArtifact = artifact({
      leagueId: leagueProviderId,
      importedAt: replacementImportedAt,
      name: "Commissioner Recovery League",
      playerIdBase,
    });
    const forgedCanonicalObservation = replacementArtifact.teams[0]?.roster[0];
    assert.ok(forgedCanonicalObservation);
    forgedCanonicalObservation.fullName = "Forged Canonical Name";
    forgedCanonicalObservation.primaryPosition = "WR";
    forgedCanonicalObservation.eligiblePositions = ["WR"];
    forgedCanonicalObservation.proTeamAbbreviation = "MIA";
    forgedCanonicalObservation.status = "OUT";
    const forgedFallbackObservation = replacementArtifact.teams[1]?.roster[0];
    assert.ok(forgedFallbackObservation);
    forgedFallbackObservation.fullName = "Forged Fallback Name";
    forgedFallbackObservation.primaryPosition = "QB";
    forgedFallbackObservation.eligiblePositions = ["QB"];
    forgedFallbackObservation.proTeamAbbreviation = "NE";
    forgedFallbackObservation.status = "IR";
    const replacementChecksum =
      service.preview(replacementArtifact).provenance.artifactChecksumSha256;
    await assert.rejects(
      service.commit(managerId, {
        snapshot: replacementArtifact,
        expectedChecksumSha256: replacementChecksum,
      }),
      (error: unknown) =>
        error instanceof Error &&
        "statusCode" in error &&
        (error as { statusCode: unknown }).statusCode === 404,
      "ordinary managers must not replace shared canonical league data",
    );
    const commissioner = await service.commit(commissionerId, {
      snapshot: replacementArtifact,
      expectedChecksumSha256: replacementChecksum,
    });
    assert.equal(commissioner.state, "accepted");

    const [beforeFailureSeason] = await smokeDatabase
      .select({
        teamCount: leagueSeasons.teamCount,
        lastSyncedAt: leagueSeasons.lastSyncedAt,
      })
      .from(leagueSeasons)
      .where(eq(leagueSeasons.id, first.league.leagueSeasonId))
      .limit(1);
    const [beforeFailureRosterTotal] = await smokeDatabase
      .select({ value: count() })
      .from(rosterSnapshots)
      .innerJoin(fantasyTeams, eq(rosterSnapshots.teamId, fantasyTeams.id))
      .where(eq(fantasyTeams.leagueSeasonId, first.league.leagueSeasonId));
    const [beforeFailureRunTotal] = await smokeDatabase
      .select({ value: count() })
      .from(syncRuns)
      .where(
        and(
          eq(syncRuns.kind, "espn-manual-import"),
          inArray(syncRuns.id, [first.receiptId, commissioner.receiptId]),
        ),
      );

    // This artifact is valid canonical schema v1, but teamCount=1 violates the database's
    // production league invariant after the league name update has already been attempted.
    const invalidReplacement = artifact({
      leagueId: leagueProviderId,
      importedAt: new Date(now.getTime() - 10_000).toISOString(),
      name: "Must Roll Back",
      playerIdBase,
      teamCount: 1,
    });
    const invalidChecksum = service.preview(invalidReplacement).provenance.artifactChecksumSha256;
    await assert.rejects(
      service.commit(commissionerId, {
        snapshot: invalidReplacement,
        expectedChecksumSha256: invalidChecksum,
      }),
      /team_count|team count|constraint/iu,
      "an invalid replacement must fail its transaction",
    );

    const [afterFailureLeague] = await smokeDatabase
      .select({ name: leagues.name })
      .from(leagues)
      .where(eq(leagues.id, first.league.id))
      .limit(1);
    const [afterFailureSeason] = await smokeDatabase
      .select({
        teamCount: leagueSeasons.teamCount,
        lastSyncedAt: leagueSeasons.lastSyncedAt,
      })
      .from(leagueSeasons)
      .where(eq(leagueSeasons.id, first.league.leagueSeasonId))
      .limit(1);
    const [teamTotal] = await smokeDatabase
      .select({ value: count() })
      .from(fantasyTeams)
      .where(eq(fantasyTeams.leagueSeasonId, first.league.leagueSeasonId));
    const [rosterTotal] = await smokeDatabase
      .select({ value: count() })
      .from(rosterSnapshots)
      .innerJoin(fantasyTeams, eq(rosterSnapshots.teamId, fantasyTeams.id))
      .where(eq(fantasyTeams.leagueSeasonId, first.league.leagueSeasonId));
    const [rosterEntryTotal] = await smokeDatabase
      .select({ value: count() })
      .from(rosterEntries)
      .innerJoin(rosterSnapshots, eq(rosterEntries.snapshotId, rosterSnapshots.id))
      .innerJoin(fantasyTeams, eq(rosterSnapshots.teamId, fantasyTeams.id))
      .where(eq(fantasyTeams.leagueSeasonId, first.league.leagueSeasonId));
    const [slotRuleTotal] = await smokeDatabase
      .select({ value: count() })
      .from(rosterSlotRules)
      .where(eq(rosterSlotRules.leagueSeasonId, first.league.leagueSeasonId));
    const [scoringRuleTotal] = await smokeDatabase
      .select({ value: count() })
      .from(scoringRules)
      .where(eq(scoringRules.leagueSeasonId, first.league.leagueSeasonId));
    const selfAssertedKey = espnSelfAssertedPlayerKey(
      first.league.leagueSeasonId,
      `${playerIdBase}2`,
    );
    const [selfAssertedMapping] = await smokeDatabase
      .select({
        playerId: playerExternalIds.playerId,
        confidence: playerExternalIds.confidence,
        verified: playerExternalIds.verified,
      })
      .from(playerExternalIds)
      .where(
        and(
          eq(playerExternalIds.source, ESPN_SELF_ASSERTED_PLAYER_SOURCE),
          eq(playerExternalIds.externalId, selfAssertedKey),
        ),
      )
      .limit(1);
    assert.ok(selfAssertedMapping, "unmapped ESPN roster entry must receive a scoped placeholder");
    const [selfAssertedPlayer] = await smokeDatabase
      .select({
        fullName: players.fullName,
        nflTeam: players.nflTeam,
        primaryPosition: players.primaryPosition,
        eligiblePositions: players.eligiblePositions,
        status: players.status,
      })
      .from(players)
      .where(eq(players.id, selfAssertedMapping.playerId))
      .limit(1);
    const [storedCanonicalPlayer] = await smokeDatabase
      .select({
        fullName: players.fullName,
        nflTeam: players.nflTeam,
        primaryPosition: players.primaryPosition,
        eligiblePositions: players.eligiblePositions,
        status: players.status,
      })
      .from(players)
      .where(eq(players.id, canonicalPlayer.id))
      .limit(1);
    const [unexpectedGlobalMapping] = await smokeDatabase
      .select({ playerId: playerExternalIds.playerId })
      .from(playerExternalIds)
      .where(
        and(
          eq(playerExternalIds.source, "espn"),
          eq(playerExternalIds.externalId, `${playerIdBase}2`),
        ),
      )
      .limit(1);
    const [playerIdTotal] = await smokeDatabase
      .select({ value: count() })
      .from(playerExternalIds)
      .where(
        or(
          and(
            eq(playerExternalIds.source, "espn"),
            eq(playerExternalIds.externalId, `${playerIdBase}1`),
          ),
          and(
            eq(playerExternalIds.source, ESPN_SELF_ASSERTED_PLAYER_SOURCE),
            eq(playerExternalIds.externalId, selfAssertedKey),
          ),
        ),
      );
    const [manualRunTotal] = await smokeDatabase
      .select({ value: count() })
      .from(syncRuns)
      .where(
        and(
          eq(syncRuns.kind, "espn-manual-import"),
          eq(syncRuns.leagueSeasonId, first.league.leagueSeasonId),
        ),
      );

    assert.equal(afterFailureLeague?.name, "Commissioner Recovery League");
    assert.equal(afterFailureSeason?.teamCount, beforeFailureSeason?.teamCount);
    assert.equal(
      afterFailureSeason?.lastSyncedAt?.toISOString(),
      beforeFailureSeason?.lastSyncedAt?.toISOString(),
    );
    assert.equal(Number(rosterTotal?.value ?? 0), Number(beforeFailureRosterTotal?.value ?? 0));
    assert.equal(Number(manualRunTotal?.value ?? 0), Number(beforeFailureRunTotal?.value ?? 0));
    assert.equal(Number(teamTotal?.value ?? 0), 2);
    assert.equal(Number(rosterTotal?.value ?? 0), 4);
    assert.equal(Number(rosterEntryTotal?.value ?? 0), 4);
    assert.equal(Number(slotRuleTotal?.value ?? 0), 2);
    assert.equal(Number(scoringRuleTotal?.value ?? 0), 1);
    assert.equal(Number(playerIdTotal?.value ?? 0), 2);
    assert.deepEqual(storedCanonicalPlayer, {
      fullName: "Trusted Catalog Quarterback",
      nflTeam: "GB",
      primaryPosition: "QB",
      eligiblePositions: ["QB"],
      status: "ACTIVE",
    });
    assert.equal(selfAssertedMapping.verified, false);
    assert.equal(Number(selfAssertedMapping.confidence), 0);
    assert.equal(unexpectedGlobalMapping, undefined, "self-asserted IDs must not become global");
    assert.deepEqual(selfAssertedPlayer, {
      fullName: "Forged Fallback Name",
      nflTeam: "NE",
      primaryPosition: "QB",
      eligiblePositions: ["QB"],
      status: "IR",
    });
    const globalRankingPlayers = await new DrizzleRankingRepository(
      smokeDatabase,
    ).listPlayerIdentities();
    assert.ok(
      globalRankingPlayers.some((player) => player.id === canonicalPlayer.id),
      "verified canonical players must remain available globally",
    );
    assert.equal(
      globalRankingPlayers.some((player) => player.id === selfAssertedMapping.playerId),
      false,
      "league-scoped observations must not enter global ranking search",
    );
    const projectionRepository = new DrizzleProjectionImportRepository(smokeDatabase);
    const leagueScopedPlayers = await projectionRepository.listResolverPlayers(
      first.league.leagueSeasonId,
      2026,
      [selfAssertedMapping.playerId],
    );
    const otherLeaguePlayers = await projectionRepository.listResolverPlayers(ownerId, 2026, [
      selfAssertedMapping.playerId,
    ]);
    assert.ok(
      leagueScopedPlayers.some((player) => player.id === selfAssertedMapping.playerId),
      "the owning league may resolve projections for its observed roster player",
    );
    assert.equal(
      otherLeaguePlayers.some((player) => player.id === selfAssertedMapping.playerId),
      false,
      "another league scope must not resolve the observation player",
    );

    throw new SmokeRollback({
      firstState: "accepted",
      replayState: "unchanged",
      commissionerState: "accepted",
      teams: Number(teamTotal?.value ?? 0),
      rosterSnapshots: Number(rosterTotal?.value ?? 0),
      rosterEntries: Number(rosterEntryTotal?.value ?? 0),
      ownerMemberships: ownerMembership?.role === "owner" ? 1 : 0,
      normalizedPlayerIds: Number(playerIdTotal?.value ?? 0),
      nonmemberDenied: true,
      managerDenied: true,
      canonicalPlayerPreserved: true,
      selfAssertedMappingUnverified: true,
      selfAssertedIdentityQuarantined: true,
      selfAssertedExcludedFromGlobalCatalog: true,
      selfAssertedAvailableInLeagueScope: true,
      invalidReplacementRolledBack: true,
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
