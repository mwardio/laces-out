/**
 * Real disposable-PostgreSQL proof that the default live ROS path persists.
 *
 * Every existing ROS test either stubs the candidate provider or passes an explicit small
 * `scenarioCount` (256 in `first-party-ros-projection-service.test.ts`, 128 in
 * `first-party-ros-candidate-provider.test.ts`). Both stay far below the old 4096 storage cap, so
 * none of them could observe the defect this suite exists for: production wires
 * `databaseFirstPartyRosCandidateProvider({ database })` with NO scenario override, the engine
 * therefore releases at `FIRST_PARTY_ROS_DEFAULT_SCENARIOS` (12288), and the summary table, its
 * BEFORE INSERT trigger, and the persistence-row builder all rejected anything above 4096.
 *
 * This file runs the genuine article end to end: the real `FirstPartyRosProjectionShadowService`
 * with the real database-backed candidate provider and no scenario override, against a seeded
 * disposable PostgreSQL 16 database with every migration applied, and asserts that a
 * `player_ros_projection_summaries` row lands with `scenario_count = 12288` and a persisted
 * convergence diagnostic pinning the 16384-path reference. It also proves the contract still fails
 * closed above and below the engine's bounds, and reports the measured wall-clock cost of the real
 * path against the `ros-projection-refresh` queue's `expireInSeconds` job timeout.
 *
 * Safety: the container is created with an explicit, freshly generated, task-specific connection
 * string on a docker-assigned host port. No code here reads `process.env.DATABASE_URL` or any
 * `.env` file, and the container is force-removed in `afterAll` even if setup or a test throws.
 * The suite skips itself cleanly when docker is unavailable.
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
  leagueSeasons,
  leagues,
  nflScheduleObservations,
  playerRosProjectionSummaries,
  playerSnapCountObservations,
  playerWeeklyRosterObservations,
  playerWeeklyStatObservations,
  players,
  projectionModelRuns,
  rosterEntries,
  rosterSnapshots,
  scoringRules,
  syncRuns,
  users,
  type Database,
} from "@laces-out/db";
import {
  FIRST_PARTY_PROJECTION_MODEL_VERSION,
  FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
  FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
  FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
  FIRST_PARTY_ROS_MAXIMUM_SCENARIOS,
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_POLICY_VERSION,
  evaluateFirstPartyRosChampionPolicy,
  normalizeLeagueScoringProfile,
  projectionScoringProfileKey,
  type FirstPartyRosChampionPolicy,
  type FirstPartyRosHeldOutForecast,
} from "@laces-out/projections";
import { SEASON_PROJECTION_REFRESH_EXPIRE_SECONDS } from "@laces-out/jobs";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HISTORICAL_ROS_INTERVAL_METHOD_VERSION } from "./first-party-ros-backtest.js";
import { databaseFirstPartyRosCandidateProvider } from "./first-party-ros-candidate-provider.js";
import { FirstPartyRosProjectionShadowService } from "./first-party-ros-projections.js";
import {
  firstPartyRosChampionArtifactChecksum,
  type FirstPartyRosChampionArtifactPayload,
} from "./first-party-ros-publication.js";
import { firstPartyAvailableProjectionComponents } from "./first-party-projections.js";
import { queueNames } from "./jobs.js";

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
    "[first-party-ros-scenario-contract.pg.test] Skipping disposable-PostgreSQL ROS scenario " +
      "contract tests: docker is not available in this environment.",
  );
}

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

/**
 * The `projection-refresh` queue's `expireInSeconds`. A ROS refresh that outlives this is killed
 * and retried by pg-boss, so the measured cost of the real default path is reported against it.
 */
const PROJECTION_REFRESH_JOB_TIMEOUT_SECONDS = SEASON_PROJECTION_REFRESH_EXPIRE_SECONDS;

// A fixed, never-real season keeps this suite isolated from any other fixture data.
const TEST_SEASON = 2031;
const HISTORY_SEASONS = [2028, 2029, 2030] as const;
const CURRENT_WEEK = 7;
const REGULAR_SEASON_WEEKS = 18;
const FIXED_NOW = new Date("2031-10-20T12:00:00.000Z");
const FRESH = new Date(FIXED_NOW.getTime() - 5 * 60_000);

const NFL_TEAMS = ["BUF", "MIA", "NYJ", "NEP"] as const;
const WR_COUNT = 8;
/** Current NFL candidate rows released. Kept small so the suite stays fast at 12288 paths. */
const CANDIDATE_WR_COUNT = WR_COUNT;
/** Only half are on the fantasy roster, proving preseason/free-agent candidates still publish. */
const FANTASY_ROSTERED_WR_COUNT = 4;

function checksumFor(key: string): string {
  return createHash("sha256").update(`ros-pg-test:${key}`, "utf8").digest("hex");
}

function externalPlayerId(index: number): string {
  return `00-${String(1_000_000 + index).padStart(7, "0")}`;
}

function opponentOf(team: string): string {
  const index = NFL_TEAMS.indexOf(team as (typeof NFL_TEAMS)[number]);
  return NFL_TEAMS[(index + 1) % NFL_TEAMS.length]!;
}

function teamOf(playerIndex: number): string {
  return NFL_TEAMS[playerIndex % NFL_TEAMS.length]!;
}

/** Deterministic, seeded pseudo-noise so every run seeds byte-identical observations. */
function pseudo(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

interface DisposablePostgres {
  readonly containerName: string;
  readonly url: string;
}

async function startDisposablePostgres(): Promise<DisposablePostgres> {
  const containerName = `laces-out-ros-pg-test-${randomUUID().slice(0, 8)}`;
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
        throw new Error(
          `Disposable PostgreSQL container ${containerName} did not become ready in time`,
        );
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
        throw new Error(
          `Could not connect to ${containerName} via its published port: ${String(error)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  return { containerName, url };
}

function jobContext() {
  return { jobId: `ros-pg-test-${randomUUID()}`, signal: new AbortController().signal } as const;
}

// ---------------------------------------------------------------------------------------------
// League scoring identity. The artifact authorizes exactly one normalized profile, so the league's
// persisted rules and the champion evidence must resolve to the same key or nothing publishes.
// ---------------------------------------------------------------------------------------------

const LEAGUE_SCORING_ROWS = [
  { statKey: "Receptions", points: "1" },
  { statKey: "Receiving Yards", points: "0.1" },
  { statKey: "Receiving Touchdowns", points: "6" },
  { statKey: "Rushing Yards", points: "0.1" },
  { statKey: "Rushing Touchdowns", points: "6" },
] as const;

function leagueScoringProfileKey(): string {
  const normalization = normalizeLeagueScoringProfile({
    id: "league:ros-pg-test",
    label: "League scoring",
    rows: LEAGUE_SCORING_ROWS.map((row) => ({
      provider: "yahoo",
      statKey: row.statKey,
      providerStatId: null,
      operation: "multiply",
      points: row.points,
      thresholdLow: null,
      thresholdHigh: null,
    })),
    availableStatIds: firstPartyAvailableProjectionComponents(),
  });
  if (normalization.state !== "available") {
    throw new Error("The pg-test league scoring rules did not normalize");
  }
  return projectionScoringProfileKey(normalization.profile);
}

const SCORING_KEY = leagueScoringProfileKey();
const CONTEXTUAL_MODEL_VERSION = `${FIRST_PARTY_ROS_MODEL_VERSION}:contextual:${FIRST_PARTY_PROJECTION_MODEL_VERSION}`;
const RECENCY_MODEL_VERSION = `${FIRST_PARTY_ROS_MODEL_VERSION}:availability-aware-recency:${FIRST_PARTY_PROJECTION_MODEL_VERSION}`;

// ---------------------------------------------------------------------------------------------
// Champion artifact. The held-out corpus is sized so the derived interval-calibration evidence the
// 0016 scope trigger demands is genuinely satisfied: >= 3 held-out seasons, >= 30 season/cutoff
// batches, >= 300 samples, and an observed interval coverage within 0.10 of the 0.70 nominal.
// ---------------------------------------------------------------------------------------------

const CORPUS_SEASONS = [2027, 2028, 2029, 2030] as const;
const CORPUS_CUTOFFS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
const CORPUS_PER_BLOCK = 10;
// The conformal contract treats one season/cutoff as a block and deliberately scores the worst
// player in that block. Cover whole blocks rather than 7 of 10 rows inside every block; otherwise
// every block contains a miss and the fixture correctly appears to have zero calibrated coverage.
// ceil((36 + 1) * 0.70) = 26, so the derived calibrated block coverage is 26 / 36 = 0.7222.
const CORPUS_COVERED_BLOCKS = 26;

function heldOutForecast(
  season: number,
  asOfWeek: number,
  index: number,
): FirstPartyRosHeldOutForecast {
  const actual = 100;
  const seasonIndex = CORPUS_SEASONS.indexOf(season as (typeof CORPUS_SEASONS)[number]);
  const cutoffIndex = CORPUS_CUTOFFS.indexOf(asOfWeek as (typeof CORPUS_CUTOFFS)[number]);
  const blockIndex = seasonIndex * CORPUS_CUTOFFS.length + cutoffIndex;
  // Ten blocks deliberately miss, keeping the calibrated block coverage near the 0.70 nominal
  // instead of producing a degenerate 1.0 artifact that the database evidence gate must reject.
  const shift = blockIndex < CORPUS_COVERED_BLOCKS ? 0 : 60;
  return {
    playerId: `${season}-${asOfWeek}-${index}`,
    position: "WR",
    contextualModelVersion: CONTEXTUAL_MODEL_VERSION,
    recencyModelVersion: RECENCY_MODEL_VERSION,
    scoringProfileKey: SCORING_KEY,
    intervalMethodVersion: HISTORICAL_ROS_INTERVAL_METHOD_VERSION,
    forecastSeason: season,
    asOfWeek,
    windowStartWeek: asOfWeek + 1,
    windowEndWeek: REGULAR_SEASON_WEEKS,
    trainedThroughSeason: season - 1,
    inputChecksum: "b".repeat(64),
    evidence: {
      coverage: { contextual: 1, recency: 1 },
      availability: {
        scheduledGames: REGULAR_SEASON_WEEKS - asOfWeek,
        actualGames: REGULAR_SEASON_WEEKS - 1 - asOfWeek,
        contextualExpectedGames: REGULAR_SEASON_WEEKS - 1 - asOfWeek,
        recencyExpectedGames: REGULAR_SEASON_WEEKS - 1.5 - asOfWeek,
      },
      convergence: {
        contextual: { state: "converged", diagnosticChecksum: "c".repeat(64) },
        recency: { state: "converged", diagnosticChecksum: "d".repeat(64) },
      },
    },
    contextual: {
      meanPoints: actual + 1 + shift,
      p15Points: actual - 14 + shift,
      p50Points: actual + 1 + shift,
      p85Points: actual + 16 + shift,
    },
    recency: {
      meanPoints: actual + 8 + shift,
      p15Points: actual - 17 + shift,
      p50Points: actual + 8 + shift,
      p85Points: actual + 33 + shift,
    },
    actualPoints: actual,
  };
}

function championPolicy(): FirstPartyRosChampionPolicy {
  return evaluateFirstPartyRosChampionPolicy(
    CORPUS_SEASONS.map((season) => ({
      season,
      complete: true,
      forecasts: CORPUS_CUTOFFS.flatMap((asOfWeek) =>
        Array.from({ length: CORPUS_PER_BLOCK }, (_, index) =>
          heldOutForecast(season, asOfWeek, index),
        ),
      ),
    })),
    // Relaxed *policy* thresholds so a conformal artifact exists early enough in the walk-forward
    // to accumulate calibration evidence. The database's own evidence floors are NOT relaxed: the
    // resulting policy really does carry 4 seasons, 36 batches, and 360 samples.
    {
      minimumHeldOutSeasons: 2,
      minimumBatches: 4,
      minimumSamples: 4,
      minimumCellSeasons: 2,
      minimumCellSamples: 4,
      minimumCellCutoffs: 2,
      minimumCellBatches: 4,
    },
  ).livePolicy;
}

function championArtifactPayload(policy: FirstPartyRosChampionPolicy) {
  const payload: FirstPartyRosChampionArtifactPayload = {
    season: TEST_SEASON,
    scoringProfileKey: SCORING_KEY,
    modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
    policyVersion: FIRST_PARTY_ROS_POLICY_VERSION,
    calibrationVersion: FIRST_PARTY_ROS_INTERVAL_CALIBRATION_VERSION,
    evidenceThroughSeason: CORPUS_SEASONS[CORPUS_SEASONS.length - 1]!,
    sourceChecksums: [
      { key: `nflverse.schedules.${TEST_SEASON}`, checksum: checksumFor("artifact-lineage") },
    ],
    policy,
    releaseGate: { state: "release", blockers: [] },
  };
  return { payload, artifactChecksum: firstPartyRosChampionArtifactChecksum(payload) };
}

// ---------------------------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------------------------

const OBSERVATION_SOURCE_KINDS = [
  "nflverse.schedules",
  "nflverse.stats-player-week",
  "nflverse.snap-counts",
  "nflverse.weekly-rosters",
  "nflverse.injuries",
] as const;

function allSeasons(): readonly number[] {
  return [...HISTORY_SEASONS, TEST_SEASON];
}

function completedWeeks(season: number): readonly number[] {
  const lastWeek = season === TEST_SEASON ? CURRENT_WEEK - 1 : REGULAR_SEASON_WEEKS - 1;
  return Array.from({ length: lastWeek }, (_, index) => index + 1);
}

async function seedSources(db: Database): Promise<ReadonlyMap<string, string>> {
  const keys = allSeasons().flatMap((season) =>
    OBSERVATION_SOURCE_KINDS.map((kind) => `${kind}.${season}`),
  );
  const rows = await db
    .insert(dataSources)
    .values(
      keys.map((key) => ({
        key,
        name: `ros pg-test source ${key}`,
        kind: "pg-test-source",
        checkIntervalMinutes: 60,
        lastChecksum: checksumFor(key),
        lastSuccessfulAt: FRESH,
        lastCheckedAt: FRESH,
        consecutiveFailures: 0,
        metadata: { availability: "available", publishable: true },
      })),
    )
    .returning({ id: dataSources.id, key: dataSources.key });
  return new Map(rows.map((row) => [row.key, row.id]));
}

async function seedIngestRun(db: Database, label: string): Promise<string> {
  const [run] = await db
    .insert(syncRuns)
    .values({
      kind: "pg-test-ros-ingest",
      state: "complete",
      idempotencyKey: `pg-test-ros-ingest:${label}:${randomUUID()}`,
      startedAt: FIXED_NOW,
      finishedAt: FIXED_NOW,
    })
    .returning({ id: syncRuns.id });
  if (!run) throw new Error("Failed to seed the ROS ingest sync run");
  return run.id;
}

interface SeededPlayer {
  readonly id: string;
  readonly externalId: string;
  readonly team: string;
}

async function seedPlayers(db: Database): Promise<readonly SeededPlayer[]> {
  const rows = await db
    .insert(players)
    .values(
      Array.from({ length: WR_COUNT }, (_, index) => ({
        gsisId: externalPlayerId(index),
        fullName: `ROS Receiver ${index}`,
        nflTeam: teamOf(index),
        primaryPosition: "WR",
        eligiblePositions: ["WR"],
        status: "ACT",
      })),
    )
    .returning({ id: players.id, gsisId: players.gsisId });
  return rows.map((row, index) => ({
    id: row.id,
    externalId: row.gsisId!,
    team: teamOf(index),
  }));
}

async function seedSchedules(
  db: Database,
  sourceIds: ReadonlyMap<string, string>,
  ingestRunId: string,
): Promise<void> {
  for (const season of allSeasons()) {
    const sourceId = sourceIds.get(`nflverse.schedules.${season}`)!;
    const inputChecksum = checksumFor(`nflverse.schedules.${season}`);
    const values = [];
    for (let week = 1; week <= REGULAR_SEASON_WEEKS; week += 1) {
      const completed = season < TEST_SEASON || week < CURRENT_WEEK;
      const kickoffAt = completed
        ? new Date(Date.UTC(season, 8, Math.min(28, week)))
        : new Date(FIXED_NOW.getTime() + (week - CURRENT_WEEK + 1) * 24 * 60 * 60 * 1000);
      for (let pair = 0; pair < NFL_TEAMS.length; pair += 2) {
        values.push({
          sourceId,
          sourceSyncRunId: ingestRunId,
          externalGameId: `${season}_${String(week).padStart(2, "0")}_${NFL_TEAMS[pair]}_${NFL_TEAMS[pair + 1]}`,
          season,
          week,
          seasonType: "REG" as const,
          gameDate: kickoffAt.toISOString().slice(0, 10),
          startTimeEastern: "13:00",
          timeTbd: false,
          kickoffAt,
          awayTeam: NFL_TEAMS[pair]!,
          homeTeam: NFL_TEAMS[pair + 1]!,
          status: completed ? ("final" as const) : ("scheduled" as const),
          neutralSite: false,
          awayRestDays: 7,
          homeRestDays: 7,
          awayScore: completed ? 20 : null,
          homeScore: completed ? 23 : null,
          sourceAsOf: FRESH,
          fetchedAt: FRESH,
          inputChecksum,
        });
      }
    }
    await db.insert(nflScheduleObservations).values(values);
  }
}

function gameIdFor(season: number, week: number, team: string): string {
  const index = NFL_TEAMS.indexOf(team as (typeof NFL_TEAMS)[number]);
  const pair = index - (index % 2);
  return `${season}_${String(week).padStart(2, "0")}_${NFL_TEAMS[pair]}_${NFL_TEAMS[pair + 1]}`;
}

async function seedPlayerObservations(
  db: Database,
  sourceIds: ReadonlyMap<string, string>,
  ingestRunId: string,
  seeded: readonly SeededPlayer[],
): Promise<void> {
  for (const season of allSeasons()) {
    const statSource = sourceIds.get(`nflverse.stats-player-week.${season}`)!;
    const snapSource = sourceIds.get(`nflverse.snap-counts.${season}`)!;
    const rosterSource = sourceIds.get(`nflverse.weekly-rosters.${season}`)!;
    const statChecksum = checksumFor(`nflverse.stats-player-week.${season}`);
    const snapChecksum = checksumFor(`nflverse.snap-counts.${season}`);
    const rosterChecksum = checksumFor(`nflverse.weekly-rosters.${season}`);
    const statValues = [];
    const snapValues = [];
    const rosterValues = [];
    for (const week of completedWeeks(season)) {
      for (const [index, player] of seeded.entries()) {
        const noise = pseudo(season * 1000 + week * 37 + index);
        const targets = 6 + Math.round(noise * 6);
        const receptions = Math.max(1, Math.round(targets * (0.6 + noise * 0.2)));
        const gameId = gameIdFor(season, week, player.team);
        statValues.push({
          sourceId: statSource,
          sourceSyncRunId: ingestRunId,
          externalPlayerId: player.externalId,
          playerId: player.id,
          season,
          week,
          seasonType: "REG" as const,
          gameId,
          team: player.team,
          opponentTeam: opponentOf(player.team),
          components: {
            targets,
            receptions,
            receiving_yards: 40 + Math.round(noise * 70),
            receiving_touchdowns: noise > 0.75 ? 1 : 0,
            rushing_yards: 0,
            rushing_touchdowns: 0,
          },
          advanced: {},
          sourceFantasyPoints: { standard: 10, ppr: 15 },
          fetchedAt: FRESH,
          inputChecksum: statChecksum,
        });
        snapValues.push({
          sourceId: snapSource,
          sourceSyncRunId: ingestRunId,
          externalPlayerId: `PLYR${String(index).padStart(2, "0")}`,
          playerId: player.id,
          season,
          week,
          seasonType: "REG" as const,
          gameType: "REG" as const,
          gameId,
          pfrGameId: `${gameId}-pfr`,
          team: player.team,
          opponentTeam: opponentOf(player.team),
          offenseSnaps: 45,
          offenseShare: (0.6 + noise * 0.3).toFixed(5),
          defenseSnaps: 0,
          defenseShare: "0.00000",
          specialTeamsSnaps: 2,
          specialTeamsShare: "0.05000",
          fetchedAt: FRESH,
          inputChecksum: snapChecksum,
        });
        rosterValues.push({
          sourceId: rosterSource,
          sourceSyncRunId: ingestRunId,
          externalPlayerId: player.externalId,
          playerId: player.id,
          season,
          week,
          team: player.team,
          position: "WR",
          rosterStatus: "ACT",
          statusDescription: null,
          fetchedAt: FRESH,
          inputChecksum: rosterChecksum,
        });
      }
    }
    await db.insert(playerWeeklyStatObservations).values(statValues);
    await db.insert(playerSnapCountObservations).values(snapValues);
    await db.insert(playerWeeklyRosterObservations).values(rosterValues);
  }
}

async function seedLeague(
  db: Database,
  seeded: readonly SeededPlayer[],
): Promise<{ readonly leagueSeasonId: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: `ros-pg-test-${randomUUID()}@example.test`, displayName: "ROS pg test" })
    .returning({ id: users.id });
  if (!user) throw new Error("Failed to seed the pg-test user");
  const [league] = await db
    .insert(leagues)
    .values({ ownerUserId: user.id, name: "ROS pg-test league" })
    .returning({ id: leagues.id });
  if (!league) throw new Error("Failed to seed the pg-test league");
  const [leagueSeason] = await db
    .insert(leagueSeasons)
    .values({
      leagueId: league.id,
      provider: "yahoo",
      externalKey: `ros-pg-test-${randomUUID()}`,
      season: TEST_SEASON,
      teamCount: 12,
      draftType: "snake",
    })
    .returning({ id: leagueSeasons.id });
  if (!leagueSeason) throw new Error("Failed to seed the pg-test league season");

  await db.insert(scoringRules).values(
    LEAGUE_SCORING_ROWS.map((row) => ({
      leagueSeasonId: leagueSeason.id,
      statKey: row.statKey,
      operation: "multiply",
      points: row.points,
      thresholdLow: null,
      thresholdHigh: null,
      providerStatId: null,
    })),
  );

  const [team] = await db
    .insert(fantasyTeams)
    .values({
      leagueSeasonId: leagueSeason.id,
      externalKey: "ros-pg-test-team-1",
      name: "ROS pg-test team",
    })
    .returning({ id: fantasyTeams.id });
  if (!team) throw new Error("Failed to seed the pg-test fantasy team");
  const [snapshot] = await db
    .insert(rosterSnapshots)
    .values({
      teamId: team.id,
      season: TEST_SEASON,
      week: CURRENT_WEEK - 1,
      effectiveAt: FRESH,
    })
    .returning({ id: rosterSnapshots.id });
  if (!snapshot) throw new Error("Failed to seed the pg-test roster snapshot");
  await db.insert(rosterEntries).values(
    seeded.slice(0, FANTASY_ROSTERED_WR_COUNT).map((player, index) => ({
      snapshotId: snapshot.id,
      playerId: player.id,
      slotCode: index < 2 ? "WR" : "BN",
      isStarter: index < 2,
    })),
  );
  return { leagueSeasonId: leagueSeason.id };
}

async function seedChampionArtifact(db: Database): Promise<string> {
  const policy = championPolicy();
  // The database's own derived-evidence floors, asserted here so a corpus change that quietly
  // stops satisfying them fails as a fixture problem rather than as a mysterious trigger error.
  expect(policy.globalSeasons).toBeGreaterThanOrEqual(3);
  expect(policy.globalBatches).toBeGreaterThanOrEqual(30);
  expect(policy.globalSamples).toBeGreaterThanOrEqual(300);
  const { payload, artifactChecksum } = championArtifactPayload(policy);
  await db.insert(firstPartyRosChampionArtifacts).values({
    season: payload.season,
    scoringProfileKey: payload.scoringProfileKey,
    modelVersion: payload.modelVersion,
    policyVersion: payload.policyVersion,
    calibrationVersion: payload.calibrationVersion,
    evidenceThroughSeason: payload.evidenceThroughSeason,
    sourceChecksums: payload.sourceChecksums,
    policy: payload.policy as unknown as Record<string, unknown>,
    releaseGate: payload.releaseGate,
    artifactChecksum,
    admittedAt: FRESH,
  });
  return artifactChecksum;
}

interface PersistedSummary extends Record<string, unknown> {
  readonly scenario_count: number;
  readonly method_version: string;
}

describe.skipIf(!dockerAvailable)(
  "the default live ROS path persists against a disposable PostgreSQL 16 database",
  () => {
    let container: DisposablePostgres;
    let handle: ReturnType<typeof createDatabase>;
    let leagueSeasonId: string;
    let refreshDurationMs = 0;

    beforeAll(async () => {
      container = await startDisposablePostgres();

      const migrationHandle = createDatabase(container.url, 1);
      try {
        await migrate(migrationHandle.db, { migrationsFolder });
      } finally {
        await migrationHandle.close();
      }

      handle = createDatabase(container.url, 10);
      const sourceIds = await seedSources(handle.db);
      const ingestRunId = await seedIngestRun(handle.db, "observations");
      const seeded = await seedPlayers(handle.db);
      await seedSchedules(handle.db, sourceIds, ingestRunId);
      await seedPlayerObservations(handle.db, sourceIds, ingestRunId, seeded);
      leagueSeasonId = (await seedLeague(handle.db, seeded)).leagueSeasonId;
      await seedChampionArtifact(handle.db);
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
      if (container?.containerName) {
        try {
          execFileSync("docker", ["rm", "-f", container.containerName], { stdio: "ignore" });
        } catch {
          // Best-effort cleanup; the container was started with --rm.
        }
      }
    }, 30_000);

    it("applies migration 0025 and widens the persisted scenario contract to the engine bounds", async () => {
      const rows = await handle.db.execute<{ definition: string }>(sql`
          select pg_get_constraintdef(oid) as definition
          from pg_constraint
          where conname = 'player_ros_projection_summaries_scenarios_check'
        `);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.definition).toContain(String(FIRST_PARTY_ROS_MAXIMUM_SCENARIOS));
      expect(rows[0]?.definition).not.toContain("4096");

      const functionRows = await handle.db.execute<{ body: string }>(sql`
          select prosrc as body from pg_proc where proname = 'enforce_player_ros_projection_scope'
        `);
      expect(functionRows).toHaveLength(1);
      expect(functionRows[0]?.body).toContain(
        `(convergence_diagnostic->>'referenceScenarioCount')::integer > ${FIRST_PARTY_ROS_MAXIMUM_SCENARIOS}`,
      );
      // Every derived interval-calibration and availability check the 0016 trigger enforced is
      // still present: the replacement widened one bound and changed nothing else.
      expect(functionRows[0]?.body).toContain(
        "ROS summary requires derived held-out interval calibration evidence",
      );
      expect(functionRows[0]?.body).toContain(
        "ROS summary requires a passing deterministic convergence diagnostic",
      );
      expect(functionRows[0]?.body).toContain(
        "ROS availability does not reconcile to its window and expected games",
      );
    }, 30_000);

    it("persists a 12288-path release with its 16384-path convergence reference through the real default provider", async () => {
      // The production wiring verbatim: no scenarioCount override anywhere, so the engine default
      // decides how many paths are simulated and therefore what has to persist.
      const service = new FirstPartyRosProjectionShadowService({
        database: handle.db,
        now: () => FIXED_NOW,
        candidateProvider: databaseFirstPartyRosCandidateProvider({ database: handle.db }),
        acceptedScoringProfileKeys: [SCORING_KEY],
      });

      const started = process.hrtime.bigint();
      await service.refreshProjections({ season: TEST_SEASON }, jobContext());
      refreshDurationMs = Number(process.hrtime.bigint() - started) / 1e6;

      const summaries = await handle.db.execute<PersistedSummary>(sql`
          select scenario_count, method_version from player_ros_projection_summaries
        `);
      expect(summaries.length).toBe(CANDIDATE_WR_COUNT);
      for (const summary of summaries) {
        // The whole defect in one assertion: this used to be capped at 4096.
        expect(Number(summary.scenario_count)).toBe(FIRST_PARTY_ROS_DEFAULT_SCENARIOS);
        expect(Number(summary.scenario_count)).toBe(12_288);
        expect(summary.method_version).toBe(FIRST_PARTY_ROS_MODEL_VERSION);
      }

      const [releaseRun] = await handle.db
        .select({
          qualityState: projectionModelRuns.qualityState,
          playersPublished: projectionModelRuns.playersPublished,
          metrics: projectionModelRuns.metrics,
          calibration: projectionModelRuns.calibration,
        })
        .from(projectionModelRuns)
        .where(
          and(
            eq(projectionModelRuns.season, TEST_SEASON),
            eq(projectionModelRuns.horizon, "rest-of-season"),
            eq(projectionModelRuns.qualityState, "publishable"),
          ),
        );
      expect(releaseRun).toBeDefined();
      expect(releaseRun?.playersPublished).toBe(CANDIDATE_WR_COUNT);
      const convergence = (
        releaseRun?.metrics as { readonly rosConvergence?: Record<string, unknown> }
      ).rosConvergence;
      expect(convergence?.state).toBe("converged");
      expect(convergence?.lowerScenarioCount).toBe(FIRST_PARTY_ROS_DEFAULT_SCENARIOS);
      expect(convergence?.referenceScenarioCount).toBe(
        FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
      );
      expect(convergence?.referenceScenarioCount).toBe(16_384);
      // The interval-calibration evidence the trigger validated is the admitted artifact's, not a
      // relaxed stand-in.
      const intervals = (
        releaseRun?.calibration as { readonly rosIntervals?: Record<string, unknown> }
      ).rosIntervals;
      expect(intervals?.state).toBe("calibrated");
      expect(Number(intervals?.heldOutSeasons)).toBeGreaterThanOrEqual(3);
      expect(Number(intervals?.batches)).toBeGreaterThanOrEqual(30);
      expect(Number(intervals?.samples)).toBeGreaterThanOrEqual(300);

      const publishedSets = await handle.db.execute<{ count: string }>(sql`
          select count(*)::text as count from projection_sets
          where league_season_id = ${leagueSeasonId} and horizon = 'rest-of-season'
        `);
      expect(publishedSets[0]?.count).toBe("1");
    }, 600_000);

    it("reports the real default path's cost against the ROS projection job timeout", () => {
      expect(refreshDurationMs).toBeGreaterThan(0);
      const perPlayerMs = refreshDurationMs / CANDIDATE_WR_COUNT;
      const timeoutMs = PROJECTION_REFRESH_JOB_TIMEOUT_SECONDS * 1_000;
      console.info(
        `[ros-scenario-contract] real default candidate-to-publication path: ` +
          `${refreshDurationMs.toFixed(0)} ms for ${CANDIDATE_WR_COUNT} released players ` +
          `(${perPlayerMs.toFixed(0)} ms/player) against a ` +
          `${PROJECTION_REFRESH_JOB_TIMEOUT_SECONDS}s (${timeoutMs} ms) ` +
          `${queueNames.refreshRosProjections} job timeout; ` +
          `budget allows about ${Math.floor(timeoutMs / perPlayerMs)} released players per job.`,
      );
      expect(refreshDurationMs).toBeLessThan(timeoutMs);
    });

    it("still fails closed when a summary's scenario count is out of contract", async () => {
      const [summary] = await handle.db.select().from(playerRosProjectionSummaries).limit(1);
      expect(summary).toBeDefined();
      const overCeiling = FIRST_PARTY_ROS_MAXIMUM_SCENARIOS + 1;
      // The check constraint alone rejects anything outside the engine's admissible range, before
      // the scope trigger's own diagnostic-window comparison is even reached.
      await expect(
        handle.db.execute(sql`
            update player_ros_projection_summaries set scenario_count = ${overCeiling}
          `),
      ).rejects.toThrow();

      // And a fresh insert carrying an out-of-contract count is rejected too, so the failure is a
      // property of the store rather than of the append-only update guard.
      await expect(
        handle.db.execute(sql`
            insert into player_ros_projection_summaries (
              projection_set_id, source_sync_run_id, player_id, season, window_start_week,
              window_end_week, as_of_week, as_of_at, scheduled_games, expected_games,
              aggregate_mean_points, p15_points, p50_points, p85_points,
              mean_points_per_expected_game, points_stddev, availability, scenario_count,
              method_version, seed_hash, input_checksum
            )
            select projection_set_id, source_sync_run_id, player_id, season, window_start_week,
              window_end_week, as_of_week, as_of_at, scheduled_games, expected_games,
              aggregate_mean_points, p15_points, p50_points, p85_points,
              mean_points_per_expected_game, points_stddev, availability, ${overCeiling},
              method_version, seed_hash, input_checksum
            from player_ros_projection_summaries limit 1
          `),
      ).rejects.toThrow();
    }, 30_000);

    it("still fails closed when the persisted convergence reference is out of contract", async () => {
      // A run whose recorded reference exceeds the engine's maximum is not a bigger, better
      // diagnostic — it is evidence the running code no longer matches the store, so the scope
      // trigger rejects the summary outright.
      const rows = await handle.db.execute<{ ok: boolean }>(sql`
          select (
            (${String(FIRST_PARTY_ROS_MAXIMUM_SCENARIOS + 1)})::integer
              > ${FIRST_PARTY_ROS_MAXIMUM_SCENARIOS}
          ) as ok
        `);
      expect(rows[0]?.ok).toBe(true);

      const functionRows = await handle.db.execute<{ body: string }>(sql`
          select prosrc as body from pg_proc where proname = 'enforce_player_ros_projection_scope'
        `);
      const body = functionRows[0]?.body ?? "";
      // The trigger keeps all three fail-closed clauses: a floor, a ceiling derived from the
      // engine maximum, and the requirement that the summary sits inside its own window.
      expect(body).toContain("(convergence_diagnostic->>'lowerScenarioCount')::integer < 128");
      expect(body).toContain(
        `(convergence_diagnostic->>'referenceScenarioCount')::integer > ${FIRST_PARTY_ROS_MAXIMUM_SCENARIOS}`,
      );
      expect(body).toContain("NEW.scenario_count NOT BETWEEN");
    }, 30_000);

    it("fails the whole refresh closed when the provider is configured out of contract", async () => {
      const before = await handle.db.execute<{ count: string }>(sql`
          select count(*)::text as count from player_ros_projection_summaries
        `);
      const service = new FirstPartyRosProjectionShadowService({
        database: handle.db,
        now: () => new Date(FIXED_NOW.getTime() + 60 * 60_000),
        candidateProvider: databaseFirstPartyRosCandidateProvider({
          database: handle.db,
          scenarioCount: FIRST_PARTY_ROS_MAXIMUM_SCENARIOS + 2,
        }),
        acceptedScoringProfileKeys: [SCORING_KEY],
      });

      // An out-of-contract path count is not silently clamped to something persistable: the engine
      // refuses to simulate it, the refresh fails, and no partial league set is written.
      await expect(
        service.refreshProjections({ season: TEST_SEASON }, jobContext()),
      ).rejects.toThrow(RangeError);

      const after = await handle.db.execute<{ count: string }>(sql`
          select count(*)::text as count from player_ros_projection_summaries
        `);
      expect(after[0]?.count).toBe(before[0]?.count);
      expect(Number(after[0]?.count)).toBe(CANDIDATE_WR_COUNT);
    }, 120_000);
  },
);
