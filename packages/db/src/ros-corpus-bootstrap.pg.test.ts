/** Schema contract against disposable PostgreSQL; never opens the application database. */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, firstPartyRosCorpusBootstraps } from "./index.js";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!dockerAvailable())("Shared ROS bootstrap ledger against PostgreSQL", () => {
  const container = `laces-ros-bootstrap-schema-pg-${randomUUID().slice(0, 8)}`;
  const now = new Date("2026-09-18T14:00:00Z");
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
        container,
        "--cpus=1",
        "--memory=256m",
        "--memory-swap=256m",
        "--tmpfs",
        "/var/lib/postgresql/data",
        "-e",
        "POSTGRES_USER=bootstrap_test",
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "-e",
        "POSTGRES_DB=bootstrap_test",
        "-p",
        "127.0.0.1::5432",
        "postgres:17-alpine",
      ],
      { stdio: "ignore" },
    );
    const port = Number(
      execFileSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" })
        .trim()
        .split(":")
        .pop(),
    );
    if (!Number.isInteger(port) || port <= 0) throw new Error("Disposable database port missing");
    handle = createDatabase(
      `postgres://bootstrap_test:${password}@127.0.0.1:${port}/bootstrap_test`,
      3,
    );
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        execFileSync(
          "docker",
          ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "bootstrap_test"],
          {
            stdio: "ignore",
          },
        );
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("Disposable database did not start");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    await migrate(handle.db, {
      migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await handle?.close();
    } finally {
      execFileSync("docker", ["rm", "-f", "-v", container], { stdio: "ignore" });
    }
  }, 30_000);

  const fresh = () => ({
    requestIdentity: createHash("sha256").update(randomUUID()).digest("hex"),
    season: 2026,
    protocol: { model: "fixture-v1", windows: [2022, 2023, 2024, 2025] },
  });

  it("records migration 0052 and gives one physical request one durable row", async () => {
    const input = fresh();
    const [row] = await handle.db.insert(firstPartyRosCorpusBootstraps).values(input).returning();
    expect(row).toMatchObject({
      ...input,
      state: "pending",
      attempt: 0,
      corpusIdentity: null,
      sourceSnapshotId: null,
      sourceSnapshotState: null,
      diagnostic: {},
    });
    await expect(handle.db.insert(firstPartyRosCorpusBootstraps).values(input)).rejects.toThrow();
    const hash = createHash("sha256")
      .update(
        readFileSync(new URL("../migrations/0052_ros_corpus_bootstraps.sql", import.meta.url)),
      )
      .digest("hex");
    const migrated = await handle.db.execute<{ hash: string }>(sql`
      select hash from drizzle.__drizzle_migrations where hash = ${hash}
    `);
    expect([...migrated]).toEqual([{ hash }]);
  });

  it.each(
    [
      { requestIdentity: "not-a-hash" },
      { requestIdentity: "A".repeat(64) },
      { season: 2006 },
      { season: 2201 },
      { state: "unknown" },
      { attempt: -1 },
      { attempt: 2_147_483_648 },
      { corpusIdentity: "not-a-hash" },
      { protocol: [] },
      { diagnostic: [] },
      { diagnostic: { detail: "😃".repeat(5_000) } },
      { reasonCode: "x".repeat(129) },
      { state: "ready", corpusIdentity: "a".repeat(64) },
      { state: "ready", verifiedAt: now },
    ].map((override, index) => ({
      override,
      case: `${index + 1}: ${Object.keys(override).join("+")}`,
    })),
  )("rejects malformed or unbounded bootstrap data $case", async ({ override }) => {
    const input = { ...fresh(), ...override } as typeof firstPartyRosCorpusBootstraps.$inferInsert;
    await expect(handle.db.insert(firstPartyRosCorpusBootstraps).values(input)).rejects.toThrow();
  });

  it("requires coherent source snapshot identity, status, and qualification evidence", async () => {
    const sourceSnapshotId = randomUUID();
    for (const override of [
      { sourceSnapshotId },
      { sourceSnapshotId, sourceSnapshotCreatedAt: now },
      { sourceSnapshotState: "capturing", sourceSnapshotCreatedAt: now },
      { sourceSnapshotId, sourceSnapshotState: "unknown", sourceSnapshotCreatedAt: now },
      { sourceSnapshotId, sourceSnapshotState: "qualified", sourceSnapshotCreatedAt: now },
      { sourceSnapshotQualifiedAt: now },
    ]) {
      const input = {
        ...fresh(),
        ...override,
      } as typeof firstPartyRosCorpusBootstraps.$inferInsert;
      await expect(handle.db.insert(firstPartyRosCorpusBootstraps).values(input)).rejects.toThrow();
    }
    for (const sourceSnapshotState of ["capturing", "unqualified", "qualified"] as const) {
      await handle.db.insert(firstPartyRosCorpusBootstraps).values({
        ...fresh(),
        sourceSnapshotId,
        sourceSnapshotState,
        sourceSnapshotCreatedAt: now,
        ...(sourceSnapshotState === "qualified" ? { sourceSnapshotQualifiedAt: now } : {}),
      });
    }
  });

  it("rejects nonfinite lifecycle dates", async () => {
    const input = fresh();
    await handle.db.insert(firstPartyRosCorpusBootstraps).values(input);
    await expect(
      handle.db.execute(sql`
      update first_party_ros_corpus_bootstraps set next_attempt_at = 'infinity'::timestamptz
      where request_identity = ${input.requestIdentity}
    `),
    ).rejects.toThrow();
    await expect(
      handle.db.execute(sql`
      update first_party_ros_corpus_bootstraps set verified_at = '-infinity'::timestamptz
      where request_identity = ${input.requestIdentity}
    `),
    ).rejects.toThrow();
  });

  it("locks physical request identity while accepting JSONB key reordering", async () => {
    const input = fresh();
    await handle.db.insert(firstPartyRosCorpusBootstraps).values(input);
    const where = eq(firstPartyRosCorpusBootstraps.requestIdentity, input.requestIdentity);
    await handle.db
      .update(firstPartyRosCorpusBootstraps)
      .set({
        protocol: { windows: input.protocol.windows, model: input.protocol.model },
      })
      .where(where);
    for (const update of [
      { requestIdentity: "b".repeat(64) },
      { season: 2027 },
      { protocol: { ...input.protocol, model: "other-model" } },
    ])
      await expect(
        handle.db.update(firstPartyRosCorpusBootstraps).set(update).where(where),
      ).rejects.toThrow();
  });

  it("retains the first ready corpus through an integrity block and permits its verified restoration", async () => {
    const input = fresh();
    await handle.db.insert(firstPartyRosCorpusBootstraps).values(input);
    const where = eq(firstPartyRosCorpusBootstraps.requestIdentity, input.requestIdentity);
    await handle.db
      .update(firstPartyRosCorpusBootstraps)
      .set({
        state: "ready",
        corpusIdentity: "a".repeat(64),
        verifiedAt: now,
      })
      .where(where);
    await handle.db
      .update(firstPartyRosCorpusBootstraps)
      .set({
        state: "blocked-integrity",
        reasonCode: "ready_corpus_missing",
      })
      .where(where);
    for (const corpusIdentity of [null, "b".repeat(64)])
      await expect(
        handle.db.update(firstPartyRosCorpusBootstraps).set({ corpusIdentity }).where(where),
      ).rejects.toThrow();
    await handle.db
      .update(firstPartyRosCorpusBootstraps)
      .set({
        state: "ready",
        corpusIdentity: "a".repeat(64),
        verifiedAt: now,
        reasonCode: null,
      })
      .where(where);
    const [restored] = await handle.db.select().from(firstPartyRosCorpusBootstraps).where(where);
    expect(restored).toMatchObject({
      state: "ready",
      corpusIdentity: "a".repeat(64),
      reasonCode: null,
    });
  });
});
