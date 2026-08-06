/**
 * Real disposable-PostgreSQL tests for the rest-of-season status surface.
 *
 * `RosProjectionStatusService.getStatus` joins seven tables and re-derives each caller league's
 * scoring identity through `normalizeLeagueScoringProfile`. Both halves are only meaningful against
 * real PostgreSQL: an in-memory fake would prove the fake agrees with itself. This suite admits a
 * champion artifact the way `apps/worker/scripts/admit-first-party-ros.ts` does, seeds two leagues,
 * and asserts what the surface reports back.
 *
 * It deliberately does NOT read `reports/ros-validation-*.json`: `reports/` is gitignored, so a
 * suite that depended on a validation report would pass locally and fail on a fresh clone. The
 * artifact row is built from the same catalog identity the admission script writes.
 *
 * Safety: the container is created with an explicit, freshly generated, task-specific connection
 * string on a docker-assigned host port. No code here reads `process.env.DATABASE_URL` or any
 * `.env` file, and the container is force-removed in `afterAll` even if setup or a test throws.
 * The suite skips itself cleanly (via `describe.skipIf`) when docker is unavailable.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDatabase,
  dataSources,
  fantasyTeams,
  firstPartyRosChampionArtifacts,
  leagueMemberships,
  leagueSeasons,
  leagues,
  nflScheduleObservations,
  playerWeeklyRosterObservations,
  players,
  rosterEntries,
  rosterSnapshots,
  scoringRules,
  syncRuns,
  users,
  type Database,
} from "@laces-out/db";
import {
  FIRST_PARTY_ROS_MODEL_VERSION,
  LEAGUE_SCORING_NORMALIZATION_VERSION,
  normalizeLeagueScoringProfile,
  projectionScoringProfileKey,
  rosAvailableProjectionStatIds,
  rosScoringProfile,
} from "@laces-out/projections";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  RosProjectionStatusService,
  type RosProjectionStatusResponse,
} from "./ros-projection-status.js";

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
    "[ros-projection-status.pg.test] Skipping disposable-PostgreSQL tests: docker is unavailable.",
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
  const containerName = `laces-out-ros-status-pg-${randomUUID().slice(0, 8)}`;
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

const SEASON = 2026;
/** Inside `STALE_SOURCE_HOURS` of `FRESH`, so staleness never masks the assertions below. */
const NOW = new Date("2026-09-10T12:00:00.000Z");
const FRESH = new Date("2026-09-10T06:00:00.000Z");

// The policy and calibration identities the admission rail pins for the v7 model. They are echoed
// verbatim by the status surface, which does not re-derive them.
const POLICY_VERSION = "season-walk-forward-block-wis-cqr-v4";
const CALIBRATION_VERSION = "season-blocked-split-conformal-cqr-v1";

/**
 * A league configured as genuine full PPR: every stat the `full-ppr` catalog profile scores, at the
 * catalog's own points. `field_goals_made_0_39` has no display-name alias, so it is supplied by its
 * ESPN provider stat ID (80) the way a real ESPN league sync stores it.
 */
const FULL_PPR_LEAGUE_ROWS: readonly {
  readonly statKey: string;
  readonly providerStatId: string | null;
  readonly points: string;
}[] = [
  { statKey: "passing yards", providerStatId: null, points: "0.04" },
  { statKey: "passing touchdowns", providerStatId: null, points: "4" },
  { statKey: "interceptions thrown", providerStatId: null, points: "-2" },
  { statKey: "rushing yards", providerStatId: null, points: "0.1" },
  { statKey: "rushing touchdowns", providerStatId: null, points: "6" },
  { statKey: "receiving yards", providerStatId: null, points: "0.1" },
  { statKey: "receiving touchdowns", providerStatId: null, points: "6" },
  { statKey: "fumble lost", providerStatId: null, points: "-2" },
  { statKey: "field_goals_made_0_39", providerStatId: "80", points: "3" },
  { statKey: "field goal 40 49 yards", providerStatId: null, points: "4" },
  { statKey: "field goal 50 yards", providerStatId: null, points: "5" },
  { statKey: "field goal missed", providerStatId: null, points: "-1" },
  { statKey: "point after attempt made", providerStatId: null, points: "1" },
  { statKey: "sacks recorded", providerStatId: null, points: "1" },
  { statKey: "interceptions made", providerStatId: null, points: "2" },
  { statKey: "fumbles recovered", providerStatId: null, points: "2" },
  { statKey: "safeties", providerStatId: null, points: "2" },
  { statKey: "defensive touchdowns", providerStatId: null, points: "6" },
  { statKey: "blocked kicks", providerStatId: null, points: "2" },
  { statKey: "kickoff and punt return touchdowns", providerStatId: null, points: "6" },
  { statKey: "0 points allowed", providerStatId: null, points: "10" },
  { statKey: "1 6 points allowed", providerStatId: null, points: "7" },
  { statKey: "7 13 points allowed", providerStatId: null, points: "4" },
  { statKey: "14 20 points allowed", providerStatId: null, points: "1" },
  { statKey: "21 27 points allowed", providerStatId: null, points: "0" },
  { statKey: "28 34 points allowed", providerStatId: null, points: "-1" },
  { statKey: "35 points allowed", providerStatId: null, points: "-4" },
  { statKey: "receptions", providerStatId: null, points: "1" },
];

/** The same league minus reception points: a different, definitely-not-admitted scoring identity. */
const NON_PPR_LEAGUE_ROWS = FULL_PPR_LEAGUE_ROWS.filter((row) => row.statKey !== "receptions");

/**
 * A sanitized transcription of one of the two real synced ESPN leagues (`league B`, "Garagely" /
 * "The Android's Dungeon") and the fixture of the same shape in
 * `packages/projections/src/league-scoring.test.ts` (`ESPN_LEAGUE_B_ROWS`) — normalizes to
 * `state: "available"` with **all six positions supported**
 * since the de minimis zero criterion mapped ESPN 206/209 on 2026-07-29
 * (`docs/dst-stat-id-evidence-2026-07-29.md` §4); the yards-allowed bracket overrides are accepted,
 * mapped tier rules. It was D/ST-withheld on those two IDs before the flip.
 */
const GARAGELY_LEAGUE_ROWS: readonly {
  readonly statKey: string;
  readonly providerStatId: string | null;
  readonly points: string;
}[] = [
  { statKey: "101", providerStatId: "101", points: "6" },
  { statKey: "ESPN stat 101 override for D/ST", providerStatId: "101:slot:16", points: "6" },
  { statKey: "102", providerStatId: "102", points: "6" },
  { statKey: "ESPN stat 102 override for D/ST", providerStatId: "102:slot:16", points: "6" },
  { statKey: "103", providerStatId: "103", points: "6" },
  { statKey: "ESPN stat 103 override for D/ST", providerStatId: "103:slot:16", points: "6" },
  { statKey: "104", providerStatId: "104", points: "6" },
  { statKey: "ESPN stat 104 override for D/ST", providerStatId: "104:slot:16", points: "6" },
  { statKey: "123", providerStatId: "123", points: "0" },
  { statKey: "ESPN stat 123 override for D/ST", providerStatId: "123:slot:16", points: "-1" },
  { statKey: "124", providerStatId: "124", points: "0" },
  { statKey: "ESPN stat 124 override for D/ST", providerStatId: "124:slot:16", points: "-3" },
  { statKey: "125", providerStatId: "125", points: "0" },
  { statKey: "ESPN stat 125 override for D/ST", providerStatId: "125:slot:16", points: "-5" },
  { statKey: "128", providerStatId: "128", points: "0" },
  { statKey: "ESPN stat 128 override for D/ST", providerStatId: "128:slot:16", points: "5" },
  { statKey: "129", providerStatId: "129", points: "0" },
  { statKey: "ESPN stat 129 override for D/ST", providerStatId: "129:slot:16", points: "3" },
  { statKey: "130", providerStatId: "130", points: "0" },
  { statKey: "ESPN stat 130 override for D/ST", providerStatId: "130:slot:16", points: "2" },
  { statKey: "132", providerStatId: "132", points: "0" },
  { statKey: "ESPN stat 132 override for D/ST", providerStatId: "132:slot:16", points: "-1" },
  { statKey: "133", providerStatId: "133", points: "0" },
  { statKey: "ESPN stat 133 override for D/ST", providerStatId: "133:slot:16", points: "-3" },
  { statKey: "134", providerStatId: "134", points: "0" },
  { statKey: "ESPN stat 134 override for D/ST", providerStatId: "134:slot:16", points: "-5" },
  { statKey: "135", providerStatId: "135", points: "0" },
  { statKey: "ESPN stat 135 override for D/ST", providerStatId: "135:slot:16", points: "-6" },
  { statKey: "136", providerStatId: "136", points: "0" },
  { statKey: "ESPN stat 136 override for D/ST", providerStatId: "136:slot:16", points: "-7" },
  { statKey: "19", providerStatId: "19", points: "2" },
  { statKey: "198", providerStatId: "198", points: "5" },
  { statKey: "20", providerStatId: "20", points: "-2" },
  { statKey: "201", providerStatId: "201", points: "5" },
  { statKey: "206", providerStatId: "206", points: "2" },
  { statKey: "ESPN stat 206 override for D/ST", providerStatId: "206:slot:16", points: "2" },
  { statKey: "209", providerStatId: "209", points: "1" },
  { statKey: "ESPN stat 209 override for D/ST", providerStatId: "209:slot:16", points: "1" },
  { statKey: "24", providerStatId: "24", points: "0.1" },
  { statKey: "25", providerStatId: "25", points: "6" },
  { statKey: "26", providerStatId: "26", points: "2" },
  { statKey: "3", providerStatId: "3", points: "0.04" },
  { statKey: "4", providerStatId: "4", points: "4" },
  { statKey: "42", providerStatId: "42", points: "0.1" },
  { statKey: "43", providerStatId: "43", points: "6" },
  { statKey: "44", providerStatId: "44", points: "2" },
  { statKey: "63", providerStatId: "63", points: "6" },
  { statKey: "72", providerStatId: "72", points: "-2" },
  { statKey: "77", providerStatId: "77", points: "4" },
  { statKey: "80", providerStatId: "80", points: "3" },
  { statKey: "85", providerStatId: "85", points: "-1" },
  { statKey: "86", providerStatId: "86", points: "1" },
  { statKey: "88", providerStatId: "88", points: "-1" },
  { statKey: "89", providerStatId: "89", points: "0" },
  { statKey: "ESPN stat 89 override for D/ST", providerStatId: "89:slot:16", points: "5" },
  { statKey: "90", providerStatId: "90", points: "0" },
  { statKey: "ESPN stat 90 override for D/ST", providerStatId: "90:slot:16", points: "4" },
  { statKey: "91", providerStatId: "91", points: "0" },
  { statKey: "ESPN stat 91 override for D/ST", providerStatId: "91:slot:16", points: "3" },
  { statKey: "92", providerStatId: "92", points: "0" },
  { statKey: "ESPN stat 92 override for D/ST", providerStatId: "92:slot:16", points: "1" },
  { statKey: "93", providerStatId: "93", points: "6" },
  { statKey: "ESPN stat 93 override for D/ST", providerStatId: "93:slot:16", points: "6" },
  { statKey: "95", providerStatId: "95", points: "0" },
  { statKey: "ESPN stat 95 override for D/ST", providerStatId: "95:slot:16", points: "2" },
  { statKey: "96", providerStatId: "96", points: "0" },
  { statKey: "ESPN stat 96 override for D/ST", providerStatId: "96:slot:16", points: "2" },
  { statKey: "97", providerStatId: "97", points: "0" },
  { statKey: "ESPN stat 97 override for D/ST", providerStatId: "97:slot:16", points: "2" },
  { statKey: "98", providerStatId: "98", points: "0" },
  { statKey: "ESPN stat 98 override for D/ST", providerStatId: "98:slot:16", points: "2" },
  { statKey: "99", providerStatId: "99", points: "0" },
  { statKey: "ESPN stat 99 override for D/ST", providerStatId: "99:slot:16", points: "1" },
];

/**
 * A single scoring rule with no exact mapping to any provider ID or display name: fails
 * `UNKNOWN_NONZERO_RULE` for every position (`LEAGUE_SCORING_POSITIONS`), producing a
 * structurally-failing, zero-positions-supported profile without mixed-provider plumbing
 * (`scoringRules` rows share one provider per league season on this real read path, so a
 * genuinely mixed-provider row set cannot be seeded through `seedLeague`).
 */
const ZERO_POSITION_LEAGUE_ROWS: readonly {
  readonly statKey: string;
  readonly providerStatId: string | null;
  readonly points: string;
}[] = [
  { statKey: "Completely Unrecognized Custom Scoring Category", providerStatId: null, points: "3" },
];

function normalizedLeagueKey(
  rows: readonly (typeof FULL_PPR_LEAGUE_ROWS)[number][],
): string | null {
  const normalization = normalizeLeagueScoringProfile({
    id: "league:pg-test",
    label: "League scoring",
    version: LEAGUE_SCORING_NORMALIZATION_VERSION,
    rows: rows.map((row) => ({
      provider: "espn" as const,
      statKey: row.statKey,
      providerStatId: row.providerStatId,
      operation: "multiply",
      points: row.points,
      thresholdLow: null,
      thresholdHigh: null,
    })),
    availableStatIds: rosAvailableProjectionStatIds(),
  });
  return normalization.state === "available"
    ? projectionScoringProfileKey(normalization.profile)
    : null;
}

interface SeededLeague {
  readonly leagueSeasonId: string;
  readonly snapshotId: string;
}

async function seedLeague(
  db: Database,
  userId: string,
  name: string,
  rows: readonly (typeof FULL_PPR_LEAGUE_ROWS)[number][],
): Promise<SeededLeague> {
  const [league] = await db
    .insert(leagues)
    .values({ ownerUserId: userId, name })
    .returning({ id: leagues.id });
  if (!league) throw new Error("Failed to seed the pg-test league");
  // Creating a league already records its owner membership; this keeps the intent explicit without
  // depending on whether that happened here or in a trigger.
  await db
    .insert(leagueMemberships)
    .values({ leagueId: league.id, userId, role: "owner" })
    .onConflictDoNothing();

  const [leagueSeason] = await db
    .insert(leagueSeasons)
    .values({
      leagueId: league.id,
      provider: "espn",
      externalKey: `ros-status-pg-test-${randomUUID()}`,
      season: SEASON,
      teamCount: 12,
      draftType: "snake",
    })
    .returning({ id: leagueSeasons.id });
  if (!leagueSeason) throw new Error("Failed to seed the pg-test league season");

  await db.insert(scoringRules).values(
    rows.map((row) => ({
      leagueSeasonId: leagueSeason.id,
      statKey: row.statKey,
      providerStatId: row.providerStatId,
      operation: "multiply",
      points: row.points,
      thresholdLow: null,
      thresholdHigh: null,
    })),
  );

  const [team] = await db
    .insert(fantasyTeams)
    .values({
      leagueSeasonId: leagueSeason.id,
      externalKey: `ros-status-pg-test-team-${randomUUID()}`,
      name: `${name} team`,
    })
    .returning({ id: fantasyTeams.id });
  if (!team) throw new Error("Failed to seed the pg-test fantasy team");

  const [snapshot] = await db
    .insert(rosterSnapshots)
    .values({ teamId: team.id, season: SEASON, week: 1, effectiveAt: FRESH })
    .returning({ id: rosterSnapshots.id });
  if (!snapshot) throw new Error("Failed to seed the pg-test roster snapshot");

  return { leagueSeasonId: leagueSeason.id, snapshotId: snapshot.id };
}

/**
 * Writes the champion artifact exactly as `admit-first-party-ros.ts` does for `full-ppr`: the
 * catalog's own `scoringProfileKey`, the running model version, and a checksum in the shape the
 * table's check constraint enforces.
 */
async function admitFullPprArtifact(db: Database): Promise<string> {
  const profile = rosScoringProfile("full-ppr");
  const artifactChecksum = createHash("sha256")
    .update(`ros-status-pg-test:${profile.scoringProfileKey}`)
    .digest("hex");
  await db.insert(firstPartyRosChampionArtifacts).values({
    season: SEASON,
    scoringProfileKey: profile.scoringProfileKey,
    modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
    policyVersion: POLICY_VERSION,
    calibrationVersion: CALIBRATION_VERSION,
    evidenceThroughSeason: SEASON - 1,
    sourceChecksums: [{ key: "nflverse.weekly_stats.2025", checksum: "a".repeat(64) }],
    policy: { evidenceIdentity: { scoringProfileKey: profile.scoringProfileKey } },
    releaseGate: { state: "released", blockers: [] },
    artifactChecksum,
    admittedAt: FRESH,
  });
  return artifactChecksum;
}

describe.skipIf(!dockerAvailable)(
  "the ROS status surface against a disposable PostgreSQL 16 database",
  () => {
    let container: DisposablePostgres;
    let handle: ReturnType<typeof createDatabase>;
    let db: Database;
    let status: RosProjectionStatusResponse;
    let artifactChecksum: string;
    let fullPprLeague: SeededLeague;
    let nonPprLeague: SeededLeague;
    let garagelyLeague: SeededLeague;
    let zeroPositionLeague: SeededLeague;

    beforeAll(async () => {
      container = await startDisposablePostgres();
      const migrationHandle = createDatabase(container.url, 1);
      try {
        await migrate(migrationHandle.db, { migrationsFolder });
      } finally {
        await migrationHandle.close();
      }
      handle = createDatabase(container.url, 4);
      db = handle.db;

      artifactChecksum = await admitFullPprArtifact(db);

      const [user] = await db
        .insert(users)
        .values({
          email: `ros-status-pg-test-${randomUUID()}@example.test`,
          displayName: "ROS status pg test",
        })
        .returning({ id: users.id });
      if (!user) throw new Error("Failed to seed the pg-test user");

      fullPprLeague = await seedLeague(db, user.id, "Full PPR league", FULL_PPR_LEAGUE_ROWS);
      nonPprLeague = await seedLeague(db, user.id, "Non-PPR league", NON_PPR_LEAGUE_ROWS);
      garagelyLeague = await seedLeague(
        db,
        user.id,
        "Garagely-shaped league",
        GARAGELY_LEAGUE_ROWS,
      );
      zeroPositionLeague = await seedLeague(
        db,
        user.id,
        "Zero-position league",
        ZERO_POSITION_LEAGUE_ROWS,
      );

      const [player] = await db
        .insert(players)
        .values({
          gsisId: `00-${randomUUID().slice(0, 8)}`,
          fullName: "ROS Status Receiver",
          nflTeam: "SF",
          primaryPosition: "WR",
          eligiblePositions: ["WR"],
          status: "ACT",
        })
        .returning({ id: players.id });
      if (!player) throw new Error("Failed to seed the pg-test player");
      for (const league of [fullPprLeague, nonPprLeague, garagelyLeague, zeroPositionLeague]) {
        await db.insert(rosterEntries).values({
          snapshotId: league.snapshotId,
          playerId: player.id,
          slotCode: "WR",
          isStarter: true,
        });
      }

      // A complete, fresh regular-season schedule, so `incomplete-schedule` and `stale-source`
      // cannot fire and the scoring-identity reason is isolated.
      const scheduleChecksum = "b".repeat(64);
      const rosterChecksum = "c".repeat(64);
      const sources = await db
        .insert(dataSources)
        .values([
          {
            key: `nflverse.schedules.${SEASON}`,
            name: "ROS status pg-test schedule source",
            kind: "pg-test-source",
            checkIntervalMinutes: 60,
            lastChecksum: scheduleChecksum,
            lastSuccessfulAt: FRESH,
            lastCheckedAt: FRESH,
          },
          {
            key: `nflverse.weekly-rosters.${SEASON}`,
            name: "ROS status pg-test candidate source",
            kind: "pg-test-source",
            checkIntervalMinutes: 60,
            lastChecksum: rosterChecksum,
            lastSuccessfulAt: FRESH,
            lastCheckedAt: FRESH,
          },
        ])
        .returning({ id: dataSources.id, key: dataSources.key });
      const sourceByKey = new Map(sources.map((source) => [source.key, source.id]));
      const scheduleSourceId = sourceByKey.get(`nflverse.schedules.${SEASON}`);
      const rosterSourceId = sourceByKey.get(`nflverse.weekly-rosters.${SEASON}`);
      if (!scheduleSourceId || !rosterSourceId) {
        throw new Error("Failed to seed the pg-test ROS sources");
      }
      const [run] = await db
        .insert(syncRuns)
        .values({
          kind: "pg-test-ros-status",
          state: "complete",
          idempotencyKey: `pg-test-ros-status:${randomUUID()}`,
          startedAt: FRESH,
          finishedAt: FRESH,
        })
        .returning({ id: syncRuns.id });
      if (!run) throw new Error("Failed to seed the pg-test sync run");
      await db.insert(nflScheduleObservations).values({
        sourceId: scheduleSourceId,
        sourceSyncRunId: run.id,
        externalGameId: `${SEASON}_01_SF_SEA`,
        season: SEASON,
        week: 1,
        seasonType: "REG",
        gameDate: `${SEASON}-09-14`,
        startTimeEastern: "13:00",
        timeTbd: false,
        kickoffAt: new Date(`${SEASON}-09-14T17:00:00.000Z`),
        awayTeam: "SF",
        homeTeam: "SEA",
        status: "scheduled",
        neutralSite: false,
        awayRestDays: 7,
        homeRestDays: 7,
        awayScore: null,
        homeScore: null,
        sourceAsOf: FRESH,
        fetchedAt: FRESH,
        inputChecksum: scheduleChecksum,
      });
      await db.insert(playerWeeklyRosterObservations).values({
        sourceId: rosterSourceId,
        sourceSyncRunId: run.id,
        externalPlayerId: "ros-status-receiver",
        playerId: player.id,
        season: SEASON,
        week: 1,
        team: "SF",
        position: "WR",
        rosterStatus: "ACT",
        statusDescription: null,
        fetchedAt: FRESH,
        inputChecksum: rosterChecksum,
      });

      status = await new RosProjectionStatusService(db, () => NOW).getStatus({
        season: SEASON,
        userId: user.id,
      });
    }, 180_000);

    afterAll(async () => {
      await handle?.close().catch(() => {});
      if (container) {
        execFileSync("docker", ["rm", "-f", container.containerName], { stdio: "ignore" });
      }
    });

    it("reports the admitted full-PPR artifact with its pinned identity", () => {
      expect(status.admittedArtifacts.state).toBe("admitted");
      expect(status.admittedArtifacts.artifacts).toHaveLength(1);
      const artifact = status.admittedArtifacts.artifacts[0]!;
      expect(artifact.scoringProfile.profileId).toBe("laces-out-historical-ros-full-ppr");
      expect(artifact.scoringProfile.label).toBe("Full PPR");
      expect(artifact.scoringProfile.digest).toBe(rosScoringProfile("full-ppr").digest);
      expect(artifact.season).toBe(SEASON);
      expect(artifact.modelVersion).toBe(FIRST_PARTY_ROS_MODEL_VERSION);
      expect(artifact.policyVersion).toBe(POLICY_VERSION);
      expect(artifact.calibrationVersion).toBe(CALIBRATION_VERSION);
      expect(artifact.evidenceThroughSeason).toBe(SEASON - 1);
      expect(artifact.artifactChecksum).toBe(artifactChecksum);
      expect(artifact.sourceChecksumCount).toBe(1);
    });

    it("moves only full PPR into the supported scoring profiles", () => {
      expect(status.scoringProfiles.supported.map((profile) => profile.profileId)).toEqual([
        "laces-out-historical-ros-full-ppr",
      ]);
      expect(status.scoringProfiles.unsupported.map((entry) => entry.profile.profileId)).toEqual([
        "laces-out-historical-ros-half-ppr",
        "laces-out-historical-ros-standard",
        "laces-out-historical-ros-espn-standard-2pt",
        "laces-out-historical-ros-espn-standard-2pt-nxm",
      ]);
      for (const entry of status.scoringProfiles.unsupported) {
        expect(entry.blockers).toEqual(["no_admitted_artifact"]);
      }
      expect(
        Object.fromEntries(
          status.scoringProfiles.unsupported.map((entry) => [
            entry.profile.profileId,
            entry.evidenceReport,
          ]),
        ),
      ).toEqual({
        "laces-out-historical-ros-half-ppr": "ros-validation-v8-half-ppr-n8-2026-07-28",
        "laces-out-historical-ros-standard": "ros-validation-v8-standard-n8-2026-07-28",
        "laces-out-historical-ros-espn-standard-2pt":
          "ros-validation-v9-espn-standard-2pt-n8-2026-08-03",
        "laces-out-historical-ros-espn-standard-2pt-nxm":
          "ros-validation-v9-espn-standard-2pt-nxm-n8-2026-08-03",
      });
    });

    it("keeps the positions that match even when the league differs elsewhere", () => {
      const readiness = status.leagueReadiness.find(
        (entry) => entry.leagueSeasonId === nonPprLeague.leagueSeasonId,
      );
      expect(readiness).toBeDefined();
      expect(readiness!.state).toBe("ready");
      expect(readiness!.reasons).toEqual([]);
      expect(
        readiness!.positions
          .filter((position) => position.decision === "ready")
          .map((position) => position.position),
      ).toEqual(["QB", "K", "DST"]);
      expect(status.publishedSets).toEqual([]);
    });

    /**
     * DEFECT UNDER OBSERVATION — the admitted scoring-profile key is unreachable from league rules.
     *
     * Every catalog ROS profile key contains at least one zero-point rule
     * (`points_allowed_21_27_probability` in all three; `standard` also carries `receptions: 0`),
     * because the key is `projectionScoringProfileKey` of the catalog profile verbatim. But
     * `normalizeLeagueScoringProfile` drops every zero-point rule as ignored provenance
     * (`packages/projections/src/league-scoring.ts`), so a league's normalized key can never contain
     * one. The two keys therefore can never be equal, for any league, under exact-equality matching
     * (`enumerateFirstPartyRosScoringMatchedLeagues` in
     * `apps/worker/src/first-party-ros-candidate-provider.ts`).
     *
     * Position-scoped identity deliberately makes this whole-key difference non-blocking: every
     * scoreable position can still match the admitted artifact exactly.
     */
    it("does not let a harmless whole-key normalization difference block a matching league", () => {
      const catalogKey = rosScoringProfile("full-ppr").scoringProfileKey;
      const leagueKey = normalizedLeagueKey(FULL_PPR_LEAGUE_ROWS);

      expect(catalogKey).toContain('"statId":"points_allowed_21_27_probability","points":0');
      expect(leagueKey).not.toBeNull();
      expect(leagueKey).not.toContain("points_allowed_21_27_probability");
      expect(leagueKey).not.toBe(catalogKey);

      const readiness = status.leagueReadiness.find(
        (entry) => entry.leagueSeasonId === fullPprLeague.leagueSeasonId,
      );
      expect(readiness).toBeDefined();
      expect(readiness!.state).toBe("ready");
      expect(readiness!.reasons).toEqual([]);
      expect(readiness!.scoringProfile).toBeNull();
    });

    /**
     * Position-level counterpart to the DEFECT UNDER OBSERVATION test above. That test pins that the
     * whole-profile key can never be reached for a genuinely full-PPR league, because the catalog key
     * carries an explicit zero-point rule the league's own normalization always drops. This test pins
     * the fix at the position axis: `projectionScoringProfileKeyForPosition` drops zero-point rules on
     * BOTH sides of the comparison (the admitted key's recovered rules and the league's own recovered
     * rules), so the same rule that makes the whole key unreachable never enters either position-scoped
     * key in the first place. A genuinely matching league is therefore reachable position by position
     * even while its harmless whole-key difference remains.
     */
    it("reports every position ready for a genuinely full-PPR league even though its whole-profile key is unreachable", () => {
      const readiness = status.leagueReadiness.find(
        (entry) => entry.leagueSeasonId === fullPprLeague.leagueSeasonId,
      );
      expect(readiness).toBeDefined();
      expect(readiness!.state).toBe("ready");
      expect(readiness!.reasons).toEqual([]);

      expect(readiness!.positions).toHaveLength(6);
      for (const entry of readiness!.positions) {
        expect(entry.decision, `${entry.position} should be reachable`).toBe("ready");
        expect(entry.reasons).toEqual([]);
      }
    });

    /**
     * A garagely-shaped fixture (`GARAGELY_LEAGUE_ROWS`, a sanitized transcription of the real
     * "Garagely" / "Android's Dungeon" ESPN league) rather than a synthetic one, so this asserts
     * against the shape the real synced leagues actually have.
     *
     * The de minimis zero criterion mapped ESPN 206/209
     * (`docs/dst-stat-id-evidence-2026-07-29.md` §4), which were this league's last two D/ST
     * blockers, so it normalizes with all six positions supported and resolves to the exact ESPN
     * catalog identity. It is still withheld here because this fixture admits only Full PPR.
     */
    it("reports honest per-position truth for an available-but-unmatched league with every position supported", () => {
      const readiness = status.leagueReadiness.find(
        (entry) => entry.leagueSeasonId === garagelyLeague.leagueSeasonId,
      );
      expect(readiness).toBeDefined();
      // It normalizes (state: "available" upstream), so this is the "normalizes but unmatched" reason,
      // not "scoring-rules-unsupported".
      expect(readiness!.state).toBe("withheld");
      expect(readiness!.reasons).toEqual(["no-admitted-scoring-profile"]);
      expect(readiness!.scoringProfile?.profileId).toBe(
        "laces-out-historical-ros-espn-standard-2pt",
      );
      expect(
        rosScoringProfile("espn-standard-2pt").profile.rules.some((item) =>
          item.statId.startsWith("points_allowed"),
        ),
      ).toBe(true);

      const byPosition = new Map(readiness!.positions.map((entry) => [entry.position, entry]));
      // All six now report a MATCHING fact rather than a support fact: `admittedScoringProfileKeys`
      // in this fixture holds only the full-PPR artifact's key, so nothing matches — but every
      // position is priceable, which is what changed.
      for (const position of ["QB", "RB", "WR", "TE", "K", "DST"] as const) {
        const entry = byPosition.get(position);
        expect(entry, position).toBeDefined();
        expect(entry!.decision, position).toBe("withheld");
        expect(entry!.reasons, position).toEqual(["scoring-profile-position-mismatch"]);
      }
    });

    /**
     * A league whose rules cannot be attributed to any provider category at all (no exact provider-ID
     * or display-name mapping) fails every position — `state: "unavailable"` upstream, zero positions
     * supported. This is the `scoring-rules-unsupported` reason, distinct from a league that normalizes
     * fine but simply isn't admitted. (`scoringRules` rows share one provider per league season on this
     * real read path, so a genuinely mixed-provider row set cannot be exercised through `seedLeague`;
     * `ZERO_POSITION_LEAGUE_ROWS`'s single unattributable rule reaches the same zero-positions state.)
     */
    it("reports scoring-rules-unsupported and withholds every position when normalization fails entirely", () => {
      const readiness = status.leagueReadiness.find(
        (entry) => entry.leagueSeasonId === zeroPositionLeague.leagueSeasonId,
      );
      expect(readiness).toBeDefined();
      expect(readiness!.state).toBe("withheld");
      expect(readiness!.reasons).toEqual(["scoring-rules-unsupported"]);
      expect(readiness!.scoringProfile).toBeNull();

      expect(readiness!.positions).toHaveLength(6);
      for (const entry of readiness!.positions) {
        expect(entry.decision, entry.position).toBe("withheld");
        expect(entry.reasons[0], entry.position).toBe("position-unsupported");
        expect(entry.reasons.length, entry.position).toBeGreaterThan(1);
      }
    });
  },
);
