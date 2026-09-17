/** Uses an isolated disposable database; never reads or mutates the application database. */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  createDatabase,
  dataSources,
  playerExternalIds,
  players,
  playerWeeklyRosterObservations,
  syncRuns,
} from "@laces-out/db";
import {
  NFLVERSE_DATA_LICENSE,
  NFLVERSE_WEEKLY_ROSTERS_ATTRIBUTION,
  NFLVERSE_WEEKLY_ROSTERS_ATTRIBUTION_URL,
  NFLVERSE_WEEKLY_ROSTERS_SOURCE_KEY,
  NflverseWeeklyRostersSource,
  buildNflverseWeeklyRostersUrl,
  type NflverseWeeklyRosterPlayer,
  type NflverseWeeklyRostersCheckResult,
} from "@laces-out/source-nflverse";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resolveNflverseRosterIdentities } from "./nflverse-roster-identities.js";
import { NflverseWeeklyDataRefresher } from "./nflverse-weekly-data.js";

function dockerAvailable() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function observation(
  overrides: Partial<NflverseWeeklyRosterPlayer> = {},
): NflverseWeeklyRosterPlayer {
  return {
    season: 2026,
    week: 1,
    seasonType: "REG",
    gameType: "REG",
    team: "CHI",
    position: "WR",
    depthChartPosition: "WR",
    ngsPosition: "WR",
    jerseyNumber: 18,
    status: "ACT",
    statusCategory: "active",
    statusDescriptionAbbr: "A01",
    fullName: "Roster Receiver",
    firstName: "Roster",
    lastName: "Receiver",
    footballName: "Roster",
    gsisId: null,
    esbId: `PLY${randomBytes(8).toString("hex")}`,
    gsisItId: null,
    smartId: null,
    espnId: null,
    yahooId: null,
    sleeperId: null,
    sportradarId: null,
    rotowireId: null,
    pffId: null,
    pfrId: null,
    fantasyDataId: null,
    yearsExperience: 0,
    entryYear: 2026,
    rookieYear: 2026,
    draftClub: "CHI",
    draftNumber: 20,
    ...overrides,
  };
}

describe.skipIf(!dockerAvailable())("Roster identities against disposable PostgreSQL", () => {
  const containerName = `laces-roster-identities-pg-${randomUUID().slice(0, 8)}`;
  const now = new Date("2026-09-17T12:00:00.000Z");
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
        "--tmpfs",
        "/var/lib/postgresql/data",
        "-e",
        "POSTGRES_USER=roster_identity_test",
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "-e",
        "POSTGRES_DB=roster_identity_test",
        "-p",
        "127.0.0.1::5432",
        "postgres:17-alpine",
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
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error("Disposable roster identity database port missing");
    }
    handle = createDatabase(
      `postgres://roster_identity_test:${password}@127.0.0.1:${port}/roster_identity_test`,
      4,
    );
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        execFileSync(
          "docker",
          ["exec", containerName, "pg_isready", "-h", "127.0.0.1", "-U", "roster_identity_test"],
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
  }, 60_000);

  afterAll(async () => {
    try {
      await handle?.close();
    } finally {
      execFileSync("docker", ["rm", "-f", "-v", containerName], { stdio: "ignore" });
    }
  }, 30_000);

  const readPlayer = async (id: string) =>
    (await handle.db.select().from(players).where(eq(players.id, id)))[0];
  const readExternalId = async (source: string, externalId: string) =>
    handle.db
      .select()
      .from(playerExternalIds)
      .where(
        and(eq(playerExternalIds.source, source), eq(playerExternalIds.externalId, externalId)),
      );

  it.each(["esb", "smart"] as const)(
    "creates one canonical fantasy player and verified %s identity across replays",
    async (kind) => {
      const input = observation(kind === "smart" ? { esbId: null, smartId: randomUUID() } : {});
      const resolved = await resolveNflverseRosterIdentities(handle.db, [input], now);
      const id = resolved.get(input);
      expect(id).toEqual(expect.any(String));
      expect(await readPlayer(id!)).toMatchObject({
        gsisId: null,
        fullName: input.fullName,
        nflTeam: "CHI",
        primaryPosition: "WR",
        eligiblePositions: ["WR"],
      });
      const source = kind === "esb" ? "nflverse-esb" : "nflverse-smart";
      const externalId = (kind === "esb" ? input.esbId : input.smartId)!;
      expect(await readExternalId(source, externalId)).toEqual([
        expect.objectContaining({ playerId: id, verified: true }),
      ]);

      const replay = { ...input };
      const replayResult = await resolveNflverseRosterIdentities(handle.db, [replay], now);
      expect(replayResult.get(replay)).toBe(id);
      expect(replayResult.has(input)).toBe(false);
      expect(await readExternalId(source, externalId)).toHaveLength(1);
    },
  );

  it("attaches a later GSIS identity to the existing ESB canonical without creating a duplicate", async () => {
    const initial = observation();
    const originalId = (await resolveNflverseRosterIdentities(handle.db, [initial], now)).get(
      initial,
    )!;
    const later = { ...initial, week: 2, gsisId: "00-9100001" };
    const resolved = await resolveNflverseRosterIdentities(handle.db, [later], now);
    expect(resolved.get(later)).toBe(originalId);
    expect(await readPlayer(originalId)).toMatchObject({ gsisId: later.gsisId });
    expect(await readExternalId("nflverse-esb", initial.esbId!)).toEqual([
      expect.objectContaining({ playerId: originalId }),
    ]);
    expect(
      await handle.db.select().from(players).where(eq(players.gsisId, later.gsisId)),
    ).toHaveLength(1);
  });

  it("reuses a GSIS canonical and preserves current status when processing historical roster rows", async () => {
    const [existing] = await handle.db
      .insert(players)
      .values({
        gsisId: "00-9100002",
        fullName: "Roster Receiver",
        firstName: "Roster",
        lastName: "Receiver",
        nflTeam: "CHI",
        primaryPosition: "WR",
        eligiblePositions: ["WR"],
        status: "Active",
        rookieSeason: 2025,
        lastSeason: 2026,
        updatedAt: now,
      })
      .returning();
    const historical = observation({
      gsisId: existing!.gsisId,
      season: 2025,
      rookieYear: 2025,
      entryYear: 2025,
      team: "DET",
      status: "RES",
      statusCategory: "reserve",
      statusDescriptionAbbr: "R01",
    });
    expect(
      (await resolveNflverseRosterIdentities(handle.db, [historical], now)).get(historical),
    ).toBe(existing!.id);
    expect(await readPlayer(existing!.id)).toMatchObject({
      status: "Active",
      nflTeam: "CHI",
      lastSeason: 2026,
    });
  });

  it("fails closed when existing GSIS and ESB identities point to different canonical players", async () => {
    const esbOnly = observation();
    const esbPlayerId = (await resolveNflverseRosterIdentities(handle.db, [esbOnly], now)).get(
      esbOnly,
    )!;
    const [gsisPlayer] = await handle.db
      .insert(players)
      .values({
        gsisId: "00-9100003",
        fullName: esbOnly.fullName,
        nflTeam: esbOnly.team,
        primaryPosition: esbOnly.position,
        eligiblePositions: [esbOnly.position],
      })
      .returning();
    const conflict = { ...esbOnly, gsisId: gsisPlayer!.gsisId };
    expect((await resolveNflverseRosterIdentities(handle.db, [conflict], now)).has(conflict)).toBe(
      false,
    );
    expect(await readPlayer(esbPlayerId)).toMatchObject({ gsisId: null });
    expect(await readExternalId("nflverse-esb", esbOnly.esbId!)).toEqual([
      expect.objectContaining({ playerId: esbPlayerId }),
    ]);
    expect(await readPlayer(gsisPlayer!.id)).toMatchObject({ gsisId: gsisPlayer!.gsisId });
  });

  it.each(["gsis", "name"] as const)(
    "rejects every row for an ESB identifier shared by inconsistent %s identities",
    async (kind) => {
      const first = observation(kind === "gsis" ? { gsisId: "00-9100004" } : {});
      const second = {
        ...first,
        week: 2,
        ...(kind === "gsis"
          ? { gsisId: "00-9100005" }
          : { fullName: "Another Receiver", firstName: "Another" }),
      };
      const resolved = await resolveNflverseRosterIdentities(handle.db, [first, second], now);
      expect(resolved.has(first)).toBe(false);
      expect(resolved.has(second)).toBe(false);
      expect(await readExternalId("nflverse-esb", first.esbId!)).toEqual([]);
      if (kind === "gsis") {
        expect(
          await handle.db.select().from(players).where(eq(players.gsisId, first.gsisId!)),
        ).toEqual([]);
        expect(
          await handle.db.select().from(players).where(eq(players.gsisId, second.gsisId!)),
        ).toEqual([]);
      }
    },
  );

  it("does not merge a new authoritative identity into a player based on the same name", async () => {
    const first = observation();
    const second = observation();
    const resolved = await resolveNflverseRosterIdentities(handle.db, [first, second], now);
    expect(resolved.get(first)).toEqual(expect.any(String));
    expect(resolved.get(second)).toEqual(expect.any(String));
    expect(resolved.get(first)).not.toBe(resolved.get(second));
  });

  it.each(["esb-first", "smart-first"] as const)(
    "rejects competing GSIS claims through existing aliases before any write (%s)",
    async (order) => {
      const initial = observation({ smartId: randomUUID() });
      const originalId = (await resolveNflverseRosterIdentities(handle.db, [initial], now)).get(
        initial,
      )!;
      const esbRow = { ...initial, smartId: null, gsisId: "00-9100010" };
      const smartRow = { ...initial, esbId: null, gsisId: "00-9100011" };
      const input = order === "esb-first" ? [esbRow, smartRow] : [smartRow, esbRow];
      const before = await readPlayer(originalId);
      const countBefore = (await handle.db.select({ id: players.id }).from(players)).length;
      const result = await resolveNflverseRosterIdentities(handle.db, input, now);
      expect(result.size).toBe(0);
      expect(await readPlayer(originalId)).toEqual(before);
      expect(await readPlayer(originalId)).toMatchObject({ gsisId: null });
      expect(await readExternalId("nflverse-esb", initial.esbId!)).toEqual([
        expect.objectContaining({ playerId: originalId }),
      ]);
      expect(await readExternalId("nflverse-smart", initial.smartId!)).toEqual([
        expect.objectContaining({ playerId: originalId }),
      ]);
      expect(await handle.db.select({ id: players.id }).from(players)).toHaveLength(countBefore);
    },
  );

  it.each(["name", "position"] as const)(
    "rejects fallback-only evidence contradicting an established GSIS canonical's %s",
    async (field) => {
      const initial = observation({ gsisId: field === "name" ? "00-9100012" : "00-9100013" });
      const originalId = (await resolveNflverseRosterIdentities(handle.db, [initial], now)).get(
        initial,
      )!;
      const before = await readPlayer(originalId);
      const contradictory = {
        ...initial,
        gsisId: null,
        ...(field === "name" ? { fullName: "Another Receiver" } : { position: "RB" }),
      };
      expect((await resolveNflverseRosterIdentities(handle.db, [contradictory], now)).size).toBe(0);
      expect(await readPlayer(originalId)).toEqual(before);
      expect(await readExternalId("nflverse-esb", initial.esbId!)).toEqual([
        expect.objectContaining({ playerId: originalId }),
      ]);
    },
  );

  it.each([
    { label: "blank name", overrides: { fullName: "   " } },
    { label: "punctuation-only name", overrides: { fullName: "---" } },
    { label: "unknown team", overrides: { team: "UNKNOWN" } },
    { label: "unknown position", overrides: { position: "UNKNOWN" } },
  ])("rejects a new fallback identity with $label", async ({ overrides }) => {
    const input = observation(overrides);
    expect((await resolveNflverseRosterIdentities(handle.db, [input], now)).has(input)).toBe(false);
    expect(await readExternalId("nflverse-esb", input.esbId!)).toEqual([]);
  });

  it("rejects a fallback row whose name conflicts with its existing canonical identity", async () => {
    const initial = observation();
    const originalId = (await resolveNflverseRosterIdentities(handle.db, [initial], now)).get(
      initial,
    )!;
    const changed = {
      ...initial,
      fullName: "Someone Else",
      firstName: "Someone",
      lastName: "Else",
    };
    expect((await resolveNflverseRosterIdentities(handle.db, [changed], now)).has(changed)).toBe(
      false,
    );
    expect(await readPlayer(originalId)).toMatchObject({ fullName: initial.fullName });
    expect(await readExternalId("nflverse-esb", initial.esbId!)).toEqual([
      expect.objectContaining({ playerId: originalId }),
    ]);
  });

  it("serializes concurrent creation of an identical authoritative identity", async () => {
    const first = observation();
    const second = { ...first };
    const countBefore = (await handle.db.select({ id: players.id }).from(players)).length;
    const [left, right] = await Promise.all([
      resolveNflverseRosterIdentities(handle.db, [first], now),
      resolveNflverseRosterIdentities(handle.db, [second], now),
    ]);
    expect(left.get(first)).toEqual(expect.any(String));
    expect(right.get(second)).toBe(left.get(first));
    expect(left.has(second)).toBe(false);
    expect(right.has(first)).toBe(false);
    expect(await readExternalId("nflverse-esb", first.esbId!)).toHaveLength(1);
    expect(await handle.db.select({ id: players.id }).from(players)).toHaveLength(countBefore + 1);
  });

  it("replays a legacy unmatched roster into a new immutable selection and preserves it through 304 and forced replay", async () => {
    let checkedAt = now;
    const input = observation();
    const rawChecksum = "a".repeat(64);
    const sourceKey = `nflverse.weekly-rosters.${input.season}`;
    const sourceUrl = buildNflverseWeeklyRostersUrl(input.season);
    const etag = '"same-roster-bytes"';
    const lastModified = "Thu, 17 Sep 2026 10:00:00 GMT";
    const historicalCheckedAt = new Date(now.getTime() - 60 * 60_000);
    const [legacySource] = await handle.db
      .insert(dataSources)
      .values({
        key: sourceKey,
        name: "Legacy roster source",
        kind: "weekly_rosters",
        sourceUrl,
        checkIntervalMinutes: 30,
        nextCheckAt: historicalCheckedAt,
        lastCheckedAt: historicalCheckedAt,
        lastSuccessfulAt: historicalCheckedAt,
        lastChangedAt: historicalCheckedAt,
        lastChecksum: rawChecksum,
        etag,
        lastModified,
        metadata: { sourceSchemaVersion: 4, season: input.season, availability: "available" },
      })
      .returning();
    const [legacyRun] = await handle.db
      .insert(syncRuns)
      .values({
        kind: "weekly-rosters",
        state: "succeeded",
        idempotencyKey: `${sourceKey}:${rawChecksum}:v4`,
        startedAt: historicalCheckedAt,
        finishedAt: historicalCheckedAt,
        artifactChecksum: rawChecksum,
        recordsRead: 1,
        recordsWritten: 1,
      })
      .returning();
    const [legacyObservation] = await handle.db
      .insert(playerWeeklyRosterObservations)
      .values({
        sourceId: legacySource!.id,
        sourceSyncRunId: legacyRun!.id,
        externalPlayerId: input.esbId!,
        playerId: null,
        season: input.season,
        week: input.week,
        team: input.team,
        position: input.position,
        rosterStatus: input.status,
        statusDescription: input.statusDescriptionAbbr,
        fetchedAt: historicalCheckedAt,
        inputChecksum: rawChecksum,
      })
      .returning();
    const countBefore = (await handle.db.select({ id: players.id }).from(players)).length;
    const baseResult = () => ({
      checkedAt: checkedAt.toISOString(),
      sourceKey: NFLVERSE_WEEKLY_ROSTERS_SOURCE_KEY,
      sourceUrl,
      attribution: NFLVERSE_WEEKLY_ROSTERS_ATTRIBUTION,
      attributionUrl: NFLVERSE_WEEKLY_ROSTERS_ATTRIBUTION_URL,
      license: NFLVERSE_DATA_LICENSE,
      season: input.season,
      etag,
      lastModified,
      checksumSha256: rawChecksum,
    });
    const changedResult = (): NflverseWeeklyRostersCheckResult => ({
      ...baseResult(),
      state: "changed",
      observations: [input],
      rowsRead: 1,
      rowsRejected: 0,
      rejections: {
        invalidIdentity: 0,
        invalidContext: 0,
        invalidStatus: 0,
        invalidDetails: 0,
        duplicate: 0,
      },
      coveredWeeks: [1],
      coveredSeasonTypes: ["REG"],
      coveredTeams: [input.team],
      weekCoverage: [
        {
          week: 1,
          seasonType: "REG",
          gameType: "REG",
          teams: 1,
          players: 1,
          minimumPlayersPerTeam: 1,
        },
      ],
    });
    // This exercises the adapter's real writes and cache state, with parser coverage maintained
    // in source-nflverse. A transport that throws prevents any accidental live HTTP request.
    const source = new NflverseWeeklyRostersSource({
      fetch: () => Promise.reject(new Error("Unexpected network access in roster regression")),
    });
    const check = vi.spyOn(source, "check");
    check.mockImplementationOnce(async () => changedResult());
    const refresher = new NflverseWeeklyDataRefresher({
      database: handle.db,
      weeklyRostersSource: source,
      now: () => checkedAt,
    });
    const readSource = async () =>
      (await handle.db.select().from(dataSources).where(eq(dataSources.id, legacySource!.id)))[0]!;
    const readObservations = async () =>
      handle.db
        .select()
        .from(playerWeeklyRosterObservations)
        .where(eq(playerWeeklyRosterObservations.sourceId, legacySource!.id));

    try {
      expect(await refresher.refreshWeeklyRosters(input.season, true)).toMatchObject({
        state: "changed",
        rowsRead: 1,
        rowsWritten: 1,
        rowsUnmatched: 0,
      });
      expect(check.mock.calls[0]).toEqual([
        input.season,
        { etag: null, lastModified: null, checksumSha256: null },
      ]);
      const selected = await readSource();
      expect(selected.lastChecksum).toMatch(/^[a-f0-9]{64}$/u);
      expect(selected.lastChecksum).not.toBe(rawChecksum);
      expect(selected.metadata).toMatchObject({
        rawRosterChecksum: rawChecksum,
        rosterIdentityVersion: 1,
        publishable: true,
      });
      const observations = await readObservations();
      expect(observations).toHaveLength(2);
      expect(observations.find((row) => row.id === legacyObservation!.id)).toEqual(
        legacyObservation,
      );
      const repaired = observations.find((row) => row.inputChecksum === selected.lastChecksum)!;
      expect(repaired.playerId).toEqual(expect.any(String));
      expect(await readPlayer(repaired.playerId!)).toMatchObject({
        gsisId: null,
        fullName: input.fullName,
      });
      expect(await readExternalId("nflverse-esb", input.esbId!)).toEqual([
        expect.objectContaining({ playerId: repaired.playerId }),
      ]);

      checkedAt = new Date(checkedAt.getTime() + 31 * 60_000);
      check.mockImplementationOnce(async () => ({ ...baseResult(), state: "unchanged" }));
      expect(await refresher.refreshWeeklyRosters(input.season)).toMatchObject({
        state: "unchanged",
        rowsWritten: 0,
      });
      expect(check.mock.calls[1]).toEqual([
        input.season,
        { etag, lastModified, checksumSha256: rawChecksum },
      ]);
      expect((await readSource()).lastChecksum).toBe(selected.lastChecksum);
      expect(await readObservations()).toEqual(observations);

      checkedAt = new Date(checkedAt.getTime() + 60_000);
      check.mockImplementationOnce(async () => changedResult());
      expect(await refresher.refreshWeeklyRosters(input.season, true)).toMatchObject({
        state: "changed",
        rowsWritten: 0,
        rowsUnmatched: 0,
      });
      expect(check.mock.calls[2]).toEqual([
        input.season,
        { etag: null, lastModified: null, checksumSha256: null },
      ]);
      expect((await readSource()).lastChecksum).toBe(selected.lastChecksum);
      expect(await readObservations()).toEqual(observations);
      expect(await handle.db.select({ id: players.id }).from(players)).toHaveLength(
        countBefore + 1,
      );
      expect(await readExternalId("nflverse-esb", input.esbId!)).toHaveLength(1);
    } finally {
      check.mockRestore();
    }
  });
});
