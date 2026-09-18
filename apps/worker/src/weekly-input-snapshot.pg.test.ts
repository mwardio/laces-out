/**
 * Exercises the real PostgreSQL snapshot and publication-lock boundary in a disposable database.
 * Only the nine input tables' queried columns are needed; migration coverage lives in the
 * publisher's existing PostgreSQL suite. Never reads an ambient application connection string.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";

import { createDatabase } from "@laces-out/db";
import { sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  lockWeeklyPublicationInputs,
  readWeeklyMutableInputChecksum,
  WEEKLY_PUBLICATION_STATEMENT_TIMEOUT_MS,
  type WeeklyInputDatabase,
} from "./weekly-input-snapshot.js";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function signal() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function postgresErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  return "cause" in error ? postgresErrorCode(error.cause) : undefined;
}

const season = 2031;
const ids = {
  source: "10000000-0000-4000-8000-000000000001",
  league: "10000000-0000-4000-8000-000000000002",
  team: "10000000-0000-4000-8000-000000000003",
  snapshot: "10000000-0000-4000-8000-000000000004",
  player: "10000000-0000-4000-8000-000000000005",
  otherPlayer: "10000000-0000-4000-8000-000000000006",
  externalId: "10000000-0000-4000-8000-000000000007",
  observation: "10000000-0000-4000-8000-000000000008",
  rule: "10000000-0000-4000-8000-000000000009",
} as const;

const tableDefinitions = [
  `create table data_sources (
    id uuid primary key, key text unique, last_checksum text,
    last_successful_at timestamptz, updated_at timestamptz default now()
  )`,
  `create table players (
    id uuid primary key, gsis_id text, full_name text, nfl_team text,
    primary_position text, status text, last_season integer,
    updated_at timestamptz default now()
  )`,
  `create table player_external_ids (
    id uuid primary key, player_id uuid, source text, external_id text,
    updated_at timestamptz default now()
  )`,
  `create table player_source_observations (
    id uuid primary key, source_id uuid, external_player_id text, player_id uuid,
    gsis_id text, status text, injury_status text, practice_participation text,
    observed_at timestamptz default now(), updated_at timestamptz default now()
  )`,
  `create table league_seasons (
    id uuid primary key, season integer, provider text, current_week integer,
    team_count integer, updated_at timestamptz default now()
  )`,
  `create table fantasy_teams (
    id uuid primary key, league_season_id uuid, updated_at timestamptz default now()
  )`,
  `create table roster_snapshots (
    id uuid primary key, team_id uuid, effective_at timestamptz,
    created_at timestamptz default now()
  )`,
  `create table roster_entries (id uuid primary key, snapshot_id uuid, player_id uuid)`,
  `create table scoring_rules (
    id uuid primary key, league_season_id uuid, stat_key text, operation text,
    points numeric, threshold_low numeric, threshold_high numeric,
    provider_stat_id text, position_types text[]
  )`,
  `create table publication_probe (id integer primary key)`,
];

describe.skipIf(!dockerAvailable())("weekly input boundary against disposable PostgreSQL", () => {
  const containerName = `laces-weekly-snapshot-pg-${randomUUID().slice(0, 8)}`;
  let main: ReturnType<typeof createDatabase>;
  let reader: ReturnType<typeof createDatabase>;
  let writer: ReturnType<typeof createDatabase>;

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
        "--memory=192m",
        "--memory-swap=192m",
        "--shm-size=32m",
        "--tmpfs",
        "/var/lib/postgresql/data:rw,size=96m",
        "-e",
        "POSTGRES_USER=weekly_snapshot_test",
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "-e",
        "POSTGRES_DB=weekly_snapshot_test",
        "-p",
        "127.0.0.1::5432",
        "postgres:17-alpine",
        "-c",
        "shared_buffers=16MB",
        "-c",
        "max_connections=10",
        "-c",
        "work_mem=1MB",
        "-c",
        "maintenance_work_mem=16MB",
        "-c",
        "statement_timeout=5000",
        "-c",
        "idle_in_transaction_session_timeout=10000",
      ],
      { stdio: "ignore", timeout: 30_000 },
    );
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
            "weekly_snapshot_test",
            "-d",
            "weekly_snapshot_test",
          ],
          { stdio: "ignore", timeout: 3000 },
        );
        break;
      } catch {
        if (Date.now() >= deadline)
          throw new Error("Disposable weekly snapshot database did not start");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    const mapping = execFileSync("docker", ["port", containerName, "5432/tcp"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    const port = Number(mapping.split(":").at(-1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Disposable weekly snapshot database port missing");
    }
    const connection = `postgres://weekly_snapshot_test:${password}@127.0.0.1:${port}/weekly_snapshot_test`;
    main = createDatabase(connection, 1);
    reader = createDatabase(connection, 1);
    writer = createDatabase(connection, 1);
    for (const definition of tableDefinitions) await main.db.execute(sql.raw(definition));
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([main?.close(), reader?.close(), writer?.close()]);
    try {
      execFileSync("docker", ["rm", "-f", "-v", containerName], {
        stdio: "ignore",
        timeout: 10_000,
      });
    } catch {
      // --rm also removes the isolated container when PostgreSQL exits unexpectedly.
    }
  }, 30_000);

  beforeEach(async () => {
    await main.db.execute(sql`truncate table data_sources,players,player_external_ids,
      player_source_observations,league_seasons,fantasy_teams,roster_snapshots,roster_entries,
      scoring_rules,publication_probe`);
    const fixtures = [
      sql`insert into data_sources(id,key,last_checksum,last_successful_at)
        values(${ids.source},'sleeper.players',${"a".repeat(64)},'2031-09-01T12:00:00Z')`,
      sql`insert into players(id,gsis_id,full_name,nfl_team,primary_position,status,last_season)
        values(${ids.player},'00-0000001','Fixture Receiver','CHI','WR','ACTIVE',${season}),
          (${ids.otherPlayer},'00-0000002','Fixture Tight End','GB','TE','ACTIVE',${season})`,
      sql`insert into player_external_ids(id,player_id,source,external_id)
        values(${ids.externalId},${ids.player},'yahoo','yahoo-player')`,
      sql`insert into player_source_observations(id,source_id,external_player_id,player_id,
        gsis_id,status,injury_status,practice_participation)
        values(${ids.observation},${ids.source},'sleeper-player',${ids.player},
          '00-0000001','ACTIVE',null,'FULL')`,
      sql`insert into league_seasons(id,season,provider,current_week,team_count)
        values(${ids.league},${season},'yahoo',1,1)`,
      sql`insert into fantasy_teams(id,league_season_id) values(${ids.team},${ids.league})`,
      sql`insert into roster_snapshots(id,team_id,effective_at)
        values(${ids.snapshot},${ids.team},'2031-09-01T12:00:00Z')`,
      sql`insert into roster_entries(id,snapshot_id,player_id)
        values(${randomUUID()},${ids.snapshot},${ids.player})`,
      sql`insert into scoring_rules(id,league_season_id,stat_key,operation,points,position_types)
        values(${ids.rule},${ids.league},'receptions','multiply',1,array['WR','TE'])`,
    ];
    for (const fixture of fixtures) await main.db.execute(fixture);
  });

  async function heldTransaction(
    handle: ReturnType<typeof createDatabase>,
    acquire: (transaction: WeeklyInputDatabase) => Promise<void>,
    rollback?: Error,
  ) {
    const acquired = signal();
    const released = signal();
    const finished = handle.db
      .transaction(async (transaction) => {
        await acquire(transaction);
        acquired.resolve();
        await released.promise;
        if (rollback) throw rollback;
      })
      .then(
        () => undefined,
        (error: unknown) => {
          acquired.reject(error);
          return error;
        },
      );
    await acquired.promise;
    return { release: released.resolve, finished };
  }

  async function attemptBlockedWrite(statement: SQL): Promise<string | undefined> {
    try {
      await writer.db.transaction(async (transaction) => {
        await transaction.execute(sql`set local lock_timeout='100ms'`);
        await transaction.execute(statement);
      });
      return undefined;
    } catch (error) {
      return postgresErrorCode(error);
    }
  }

  it("blocks all nine mutable input writers during publication and releases after commit", async () => {
    const mutations = [
      sql`update data_sources set last_checksum=${"b".repeat(64)} where id=${ids.source}`,
      sql`update fantasy_teams set updated_at='2031-09-02T00:00:00Z' where id=${ids.team}`,
      sql`update league_seasons set current_week=2 where id=${ids.league}`,
      sql`update player_external_ids set external_id='changed-yahoo-player' where id=${ids.externalId}`,
      sql`update player_source_observations set status='OUT' where id=${ids.observation}`,
      sql`update players set primary_position='TE' where id=${ids.player}`,
      sql`update roster_entries set player_id=${ids.otherPlayer} where snapshot_id=${ids.snapshot}`,
      sql`update roster_snapshots set effective_at='2031-09-02T00:00:00Z' where id=${ids.snapshot}`,
      sql`update scoring_rules set points=2 where id=${ids.rule}`,
    ];
    const boundary = await heldTransaction(reader, async (transaction) => {
      await lockWeeklyPublicationInputs(transaction);
      await transaction.execute(sql`insert into publication_probe values(1)`);
    });
    let outcome: unknown;
    try {
      for (const mutation of mutations) expect(await attemptBlockedWrite(mutation)).toBe("55P03");
    } finally {
      boundary.release();
      outcome = await boundary.finished;
    }
    expect(outcome).toBeUndefined();
    for (const mutation of mutations) await writer.db.execute(mutation);
    const committed = await main.db.execute<{ id: number }>(sql`select id from publication_probe`);
    expect(committed.map((row) => row.id)).toEqual([1]);
  }, 10_000);

  it("blocks a new optional-source row and releases locks and output on rollback", async () => {
    const rollback = new Error("Intentional publication rollback");
    const insertSource = sql`insert into data_sources(id,key,last_checksum,last_successful_at)
      values(${randomUUID()},'nflverse.weekly-rosters.2031',${"c".repeat(64)},'2031-09-01T12:00:00Z')`;
    const boundary = await heldTransaction(
      reader,
      async (transaction) => {
        await lockWeeklyPublicationInputs(transaction);
        await transaction.execute(sql`insert into publication_probe values(1)`);
      },
      rollback,
    );
    let outcome: unknown;
    try {
      expect(await attemptBlockedWrite(insertSource)).toBe("55P03");
    } finally {
      boundary.release();
      outcome = await boundary.finished;
    }
    expect(outcome).toBe(rollback);
    await writer.db.execute(insertSource);
    const rolledBack = await main.db.execute<{ id: number }>(sql`select id from publication_probe`);
    expect(rolledBack).toHaveLength(0);
    const arrived = await main.db.execute<{ key: string }>(sql`
      select key from data_sources where key='nflverse.weekly-rosters.2031'`);
    expect(arrived).toHaveLength(1);
  });

  it("cancels a real slow statement, rolls back, releases locks and preserves pooled connection reuse", async () => {
    expect(WEEKLY_PUBLICATION_STATEMENT_TIMEOUT_MS).toBe(2_000);
    const [initial] = await reader.db.execute<{ timeout: string; backend: number }>(sql`
      select current_setting('statement_timeout') as timeout,pg_backend_pid() as backend`);
    let failure: unknown;
    const started = performance.now();
    try {
      await reader.db.transaction(async (transaction) => {
        await lockWeeklyPublicationInputs(transaction);
        await transaction.execute(sql`insert into publication_probe values(1)`);
        await transaction.execute(sql`select pg_sleep(3)`);
      });
    } catch (error) {
      failure = error;
    }
    const elapsed = performance.now() - started;
    expect(postgresErrorCode(failure)).toBe("57014");
    expect(elapsed).toBeGreaterThanOrEqual(1800);
    expect(elapsed).toBeLessThan(5000);

    // A distinct client can write again without waiting for the rolled-back transaction's locks.
    await writer.db.transaction(async (transaction) => {
      await transaction.execute(sql`set local lock_timeout='100ms'`);
      await transaction.execute(
        sql`update players set primary_position='TE' where id=${ids.player}`,
      );
    });
    const rolledBack = await main.db.execute<{ id: number }>(sql`select id from publication_probe`);
    expect(rolledBack).toHaveLength(0);

    // Statement cancellation preserves the original backend, and SET LOCAL resets on rollback.
    // Backend-killing transaction_timeout was rejected after exposing a postgres-js recovery bug.
    const [recovered] = await reader.db.execute<{
      timeout: string;
      backend: number;
      value: number;
    }>(sql`
      select current_setting('statement_timeout') as timeout,pg_backend_pid() as backend,1 as value`);
    expect(recovered?.value).toBe(1);
    expect(recovered?.backend).toBe(initial?.backend);
    expect(recovered?.timeout).toBe(initial?.timeout);
  }, 20_000);

  it("fails NOWAIT against an active writer and releases earlier acquired table locks", async () => {
    const activeWriter = await heldTransaction(writer, async (transaction) => {
      await transaction.execute(sql`update scoring_rules set points=2 where id=${ids.rule}`);
    });
    try {
      let failure: unknown;
      try {
        await reader.db.transaction((transaction) => lockWeeklyPublicationInputs(transaction));
      } catch (error) {
        failure = error;
      }
      expect(postgresErrorCode(failure)).toBe("55P03");
      // data_sources precedes the conflicting scoring_rules lock. The failed transaction must
      // release it even while the unrelated original writer is still open.
      await main.db.transaction(async (transaction) => {
        await transaction.execute(sql`set local lock_timeout='100ms'`);
        await transaction.execute(
          sql`insert into data_sources(id,key) values(${randomUUID()},'new.source')`,
        );
      });
    } finally {
      activeWriter.release();
      expect(await activeWriter.finished).toBeUndefined();
    }
  });

  it("detects catalog, status, crosswalk, rules and roster changes while ignoring timestamp touches", async () => {
    const checksum = () => readWeeklyMutableInputChecksum(main.db, season, ids.source);
    const original = await checksum();
    for (const touch of [
      sql`update players set updated_at='2031-09-02T00:00:00Z'`,
      sql`update player_source_observations set updated_at='2031-09-02T00:00:00Z',observed_at='2031-09-02T00:00:00Z'`,
      sql`update data_sources set updated_at='2031-09-02T00:00:00Z',last_successful_at='2031-09-02T00:00:00Z'`,
      sql`update league_seasons set updated_at='2031-09-02T00:00:00Z'`,
      sql`update player_external_ids set updated_at='2031-09-02T00:00:00Z'`,
    ])
      await writer.db.execute(touch);
    expect(await checksum()).toBe(original);
    let previous = original;
    for (const mutation of [
      sql`update players set primary_position='TE' where id=${ids.player}`,
      sql`update player_source_observations set injury_status='OUT' where id=${ids.observation}`,
      sql`update player_external_ids set player_id=${ids.otherPlayer} where id=${ids.externalId}`,
      sql`update scoring_rules set points=0.5 where id=${ids.rule}`,
      sql`update roster_entries set player_id=${ids.otherPlayer} where snapshot_id=${ids.snapshot}`,
    ]) {
      await writer.db.execute(mutation);
      const changed = await checksum();
      expect(changed).not.toBe(previous);
      previous = changed;
    }
  });

  it("treats an equivalent newer roster snapshot as unchanged but detects new membership", async () => {
    const original = await readWeeklyMutableInputChecksum(main.db, season, ids.source);
    const replacementSnapshot = randomUUID();
    await writer.db.transaction(async (transaction) => {
      await transaction.execute(sql`insert into roster_snapshots(id,team_id,effective_at)
        values(${replacementSnapshot},${ids.team},'2031-09-02T12:00:00Z')`);
      await transaction.execute(sql`insert into roster_entries(id,snapshot_id,player_id)
        values(${randomUUID()},${replacementSnapshot},${ids.player})`);
    });
    expect(await readWeeklyMutableInputChecksum(main.db, season, ids.source)).toBe(original);
    await writer.db.execute(sql`insert into roster_entries(id,snapshot_id,player_id)
      values(${randomUUID()},${replacementSnapshot},${ids.otherPlayer})`);
    expect(await readWeeklyMutableInputChecksum(main.db, season, ids.source)).not.toBe(original);
  });

  it("keeps catalog reads coherent within a repeatable-read snapshot while another writer commits", async () => {
    let captured: string | undefined;
    await reader.db.transaction(
      async (transaction) => {
        captured = await readWeeklyMutableInputChecksum(transaction, season, ids.source);
        const before = await transaction.execute<{ primary_position: string }>(sql`
        select primary_position from players where id=${ids.player}`);
        expect(before[0]?.primary_position).toBe("WR");
        // This succeeds while the read snapshot remains open: assembly does not hold SHARE locks
        // across later CPU work. Publication's separate locked checksum must notice the change.
        await writer.db.execute(
          sql`update players set primary_position='TE' where id=${ids.player}`,
        );
        const after = await transaction.execute<{ primary_position: string }>(sql`
        select primary_position from players where id=${ids.player}`);
        expect(after[0]?.primary_position).toBe("WR");
        expect(await readWeeklyMutableInputChecksum(transaction, season, ids.source)).toBe(
          captured,
        );
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    expect(await readWeeklyMutableInputChecksum(main.db, season, ids.source)).not.toBe(captured);
  });
});
