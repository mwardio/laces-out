import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  NFLVERSE_WEEKLY_ROSTERS_SOURCE_KEY,
  NflverseWeeklyRostersSource,
  buildNflverseWeeklyRostersUrl,
  weeklyRostersIdentityKey,
  type NflverseDatasetState,
} from "./index.js";

const fixture = readFileSync(new URL("./fixtures/weekly-rosters.csv", import.meta.url), "utf8");
const EMPTY_STATE: NflverseDatasetState = {
  etag: null,
  lastModified: null,
  checksumSha256: null,
};
const TEAMS = [
  "ARI",
  "ATL",
  "BAL",
  "BUF",
  "CAR",
  "CHI",
  "CIN",
  "CLE",
  "DAL",
  "DEN",
  "DET",
  "GB",
  "HOU",
  "IND",
  "JAX",
  "KC",
  "LA",
  "LAC",
  "LV",
  "MIA",
  "MIN",
  "NE",
  "NO",
  "NYG",
  "NYJ",
  "PHI",
  "PIT",
  "SEA",
  "SF",
  "TB",
  "TEN",
  "WAS",
] as const;
const POSITIONS = ["QB", "RB", "WR", "TE", "OL", "DL", "LB", "DB", "K", "P", "LS"];

function csvRows(body: string): string[][] {
  return body
    .trimEnd()
    .split("\n")
    .map((line) => line.split(","));
}

function completeFixture(): string {
  const [header = [], ...templates] = csvRows(fixture);
  const column = (name: string) => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`Weekly roster fixture omitted ${name}`);
    return index;
  };
  const rows = [header];
  for (const [teamIndex, selectedTeam] of TEAMS.entries()) {
    for (let playerIndex = 0; playerIndex < 42; playerIndex += 1) {
      const sequence = teamIndex * 42 + playerIndex;
      const padded = String(sequence).padStart(7, "0");
      const uuidSuffix = String(sequence).padStart(12, "0");
      const row = [...(templates[sequence % templates.length] ?? [])];
      row[column("season")] = "2025";
      row[column("week")] = "1";
      row[column("game_type")] = "REG";
      row[column("team")] = selectedTeam;
      row[column("position")] = POSITIONS[playerIndex % POSITIONS.length] ?? "WR";
      row[column("depth_chart_position")] = row[column("position")] ?? "WR";
      row[column("ngs_position")] =
        playerIndex === 4 ? "INTERIOR_LINE" : (row[column("position")] ?? "WR");
      row[column("jersey_number")] = String(playerIndex % 100);
      row[column("status")] = playerIndex % 2 === 0 ? "ACT" : "RES";
      row[column("status_description_abbr")] = playerIndex % 2 === 0 ? "A01" : "R01";
      row[column("full_name")] = `Player ${padded}`;
      row[column("first_name")] = "Player";
      row[column("last_name")] = padded;
      row[column("football_name")] = `P${padded}`;
      row[column("gsis_id")] = sequence % 53 === 0 ? "" : `00-${padded}`;
      row[column("esb_id")] = `PLY${padded}`;
      row[column("gsis_it_id")] = String(100_000 + sequence);
      row[column("smart_id")] = `10000000-0000-4000-8000-${uuidSuffix}`;
      row[column("espn_id")] = String(1_000_000 + sequence);
      row[column("yahoo_id")] = String(2_000_000 + sequence);
      row[column("sleeper_id")] = String(3_000_000 + sequence);
      row[column("sportradar_id")] = `20000000-0000-4000-8000-${uuidSuffix}`;
      row[column("rotowire_id")] = String(4_000_000 + sequence);
      row[column("pff_id")] = String(5_000_000 + sequence);
      row[column("pfr_id")] = `Plyr${padded}`;
      row[column("fantasy_data_id")] = String(6_000_000 + sequence);
      row[column("draft_club")] = selectedTeam;
      rows.push(row);
    }
  }
  return `${rows.map((row) => row.join(",")).join("\n")}\n`;
}

function withoutColumn(body: string, name: string): string {
  const rows = csvRows(body);
  const index = rows[0]?.indexOf(name) ?? -1;
  if (index < 0) throw new Error(`Weekly roster fixture omitted ${name}`);
  return rows
    .map((row) => {
      const copy = [...row];
      copy.splice(index, 1);
      return copy.join(",");
    })
    .join("\n");
}

describe("NflverseWeeklyRostersSource", () => {
  it("tracks the current published weekly-rosters schema", () => {
    expect(csvRows(fixture)[0]).toEqual([
      "season",
      "team",
      "position",
      "depth_chart_position",
      "jersey_number",
      "status",
      "full_name",
      "first_name",
      "last_name",
      "birth_date",
      "height",
      "weight",
      "college",
      "gsis_id",
      "espn_id",
      "sportradar_id",
      "yahoo_id",
      "rotowire_id",
      "pff_id",
      "pfr_id",
      "fantasy_data_id",
      "sleeper_id",
      "years_exp",
      "headshot_url",
      "ngs_position",
      "week",
      "game_type",
      "status_description_abbr",
      "football_name",
      "esb_id",
      "gsis_it_id",
      "smart_id",
      "entry_year",
      "rookie_year",
      "draft_club",
      "draft_number",
    ]);
  });

  it("normalizes a complete weekly roster and preserves conditional release state", async () => {
    const requested: Array<{ readonly url: string; readonly headers: Headers }> = [];
    const source = new NflverseWeeklyRostersSource({
      now: () => new Date("2026-07-21T20:00:00.000Z"),
      fetch: (input, init) => {
        requested.push({ url: input.toString(), headers: new Headers(init?.headers) });
        return Promise.resolve(
          new Response(completeFixture(), {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              etag: '"rosters-2025-v2"',
              "last-modified": "Tue, 21 Jul 2026 19:00:00 GMT",
            },
          }),
        );
      },
    });

    const result = await source.check(2025, {
      ...EMPTY_STATE,
      etag: '"rosters-2025-v1"',
      lastModified: "Mon, 20 Jul 2026 19:00:00 GMT",
    });

    expect(requested).toHaveLength(1);
    expect(requested[0]?.url).toBe(buildNflverseWeeklyRostersUrl(2025));
    expect(requested[0]?.headers.get("if-none-match")).toBe('"rosters-2025-v1"');
    expect(requested[0]?.headers.get("if-modified-since")).toBe("Mon, 20 Jul 2026 19:00:00 GMT");
    expect(result).toMatchObject({
      state: "changed",
      sourceKey: NFLVERSE_WEEKLY_ROSTERS_SOURCE_KEY,
      season: 2025,
      checkedAt: "2026-07-21T20:00:00.000Z",
      rowsRead: 1_344,
      rowsRejected: 0,
      coveredWeeks: [1],
      coveredSeasonTypes: ["REG"],
      coveredTeams: [...TEAMS].sort(),
      weekCoverage: [
        {
          week: 1,
          seasonType: "REG",
          gameType: "REG",
          teams: 32,
          players: 1_344,
          minimumPlayersPerTeam: 42,
        },
      ],
      etag: '"rosters-2025-v2"',
    });
    if (result.state !== "changed") throw new Error("Expected changed weekly rosters");
    expect(result.checksumSha256).toMatch(/^[a-f0-9]{64}$/u);
    const fallbackPlayer = result.observations[0];
    expect(fallbackPlayer).toMatchObject({
      gsisId: null,
      esbId: "PLY0000000",
      smartId: "10000000-0000-4000-8000-000000000000",
      team: "ARI",
      position: "QB",
      status: "ACT",
      statusCategory: "active",
    });
    if (!fallbackPlayer) throw new Error("Expected fallback-identity player");
    expect(weeklyRostersIdentityKey(fallbackPlayer)).toBe("PLY0000000");
    expect(weeklyRostersIdentityKey({ ...fallbackPlayer, esbId: null })).toBe(
      "10000000-0000-4000-8000-000000000000",
    );
    const gsisPlayer = result.observations.find((row) => row.fullName === "Player 0000001");
    if (!gsisPlayer) throw new Error("Expected GSIS-identity player");
    expect(weeklyRostersIdentityKey(gsisPlayer)).toBe("00-0000001");
    expect(gsisPlayer).toMatchObject({
      status: "RES",
      statusCategory: "reserve",
    });
    expect(result.observations.find((row) => row.ngsPosition === "INTERIOR_LINE")).toBeDefined();
  });

  it("uses the body checksum when the release omits HTTP validators", async () => {
    const body = completeFixture();
    const source = new NflverseWeeklyRostersSource({
      fetch: () => Promise.resolve(new Response(body)),
    });
    const first = await source.check(2025, EMPTY_STATE);
    const second = await source.check(2025, {
      etag: null,
      lastModified: null,
      checksumSha256: first.checksumSha256,
    });
    expect(second).toMatchObject({ state: "unchanged", checksumSha256: first.checksumSha256 });
  });

  it("accepts historical rows whose optional status description is blank", async () => {
    const rows = csvRows(completeFixture());
    const descriptionIndex = rows[0]?.indexOf("status_description_abbr") ?? -1;
    for (const row of rows.slice(1)) row[descriptionIndex] = "";
    const source = new NflverseWeeklyRostersSource({
      fetch: () => Promise.resolve(new Response(rows.map((row) => row.join(",")).join("\n"))),
    });

    const result = await source.check(2025, EMPTY_STATE);

    expect(result).toMatchObject({ state: "changed", rowsRejected: 0 });
    if (result.state !== "changed") throw new Error("Expected changed weekly rosters");
    expect(result.observations.every((row) => row.statusDescriptionAbbr === null)).toBe(true);
  });

  it("accepts the eight-team Wild Card format used before the 2020 playoff expansion", async () => {
    const rows = csvRows(completeFixture());
    const header = rows[0] ?? [];
    const seasonIndex = header.indexOf("season");
    const weekIndex = header.indexOf("week");
    const gameTypeIndex = header.indexOf("game_type");
    const teamIndex = header.indexOf("team");
    const wildcardTeams = new Set(TEAMS.slice(0, 8));
    const regularRows = rows.slice(1).map((row) => {
      const copy = [...row];
      copy[seasonIndex] = "2019";
      return copy;
    });
    const wildcardRows = regularRows
      .filter((row) => wildcardTeams.has(row[teamIndex] as (typeof TEAMS)[number]))
      .map((row) => {
        const copy = [...row];
        copy[weekIndex] = "2";
        copy[gameTypeIndex] = "WC";
        return copy;
      });
    const body = [header, ...regularRows, ...wildcardRows].map((row) => row.join(",")).join("\n");
    const source = new NflverseWeeklyRostersSource({
      fetch: () => Promise.resolve(new Response(body)),
    });
    const result = await source.check(2019, EMPTY_STATE);
    expect(result).toMatchObject({
      state: "changed",
      weekCoverage: [
        expect.objectContaining({ week: 1, gameType: "REG", teams: 32 }),
        expect.objectContaining({ week: 2, gameType: "WC", teams: 8 }),
      ],
    });
  });

  it("counts malformed and duplicate rows without admitting them", async () => {
    const body = completeFixture();
    const rows = csvRows(body);
    const statusIndex = rows[0]?.indexOf("status") ?? -1;
    const malformed = [...(rows[2] ?? [])];
    malformed[statusIndex] = "not a status";
    const missingIdentity = [...(rows[3] ?? [])];
    for (const identityColumn of ["gsis_id", "esb_id", "smart_id"]) {
      const index = rows[0]?.indexOf(identityColumn) ?? -1;
      missingIdentity[index] = "";
    }
    const withRejectedRows = `${body.trimEnd()}\n${rows[1]?.join(",")}\n${malformed.join(",")}\n${missingIdentity.join(",")}\n`;
    const source = new NflverseWeeklyRostersSource({
      fetch: () => Promise.resolve(new Response(withRejectedRows)),
    });

    const result = await source.check(2025, EMPTY_STATE);

    expect(result).toMatchObject({
      state: "changed",
      rowsRead: 1_347,
      rowsRejected: 3,
      rejections: { invalidIdentity: 1, invalidStatus: 1, duplicate: 1 },
    });
  });

  it("preserves distinct historical status observations for one player-week", async () => {
    const body = completeFixture();
    const rows = csvRows(body);
    const secondStatus = [...(rows[1] ?? [])];
    secondStatus[rows[0]?.indexOf("status") ?? -1] = "INA";
    secondStatus[rows[0]?.indexOf("status_description_abbr") ?? -1] = "I01";
    const source = new NflverseWeeklyRostersSource({
      fetch: () => Promise.resolve(new Response(`${body.trimEnd()}\n${secondStatus.join(",")}\n`)),
    });

    const result = await source.check(2025, EMPTY_STATE);

    if (result.state !== "changed") throw new Error("Expected changed weekly rosters");
    expect(result).toMatchObject({ rowsRead: 1_345, rowsRejected: 0 });
    expect(
      result.observations.filter(
        (row) => row.team === "ARI" && weeklyRostersIdentityKey(row) === "PLY0000000",
      ),
    ).toEqual([
      expect.objectContaining({ status: "ACT", statusCategory: "active" }),
      expect.objectContaining({ status: "INA", statusCategory: "inactive" }),
    ]);
  });

  it("fails closed when a required identity column disappears", async () => {
    const source = new NflverseWeeklyRostersSource({
      fetch: () => Promise.resolve(new Response(withoutColumn(completeFixture(), "smart_id"))),
    });
    await expect(source.check(2025, EMPTY_STATE)).rejects.toMatchObject({
      code: "INVALID_CSV",
      retryable: false,
    });
  });

  it("rejects an artifact that is missing a season team", async () => {
    const rows = csvRows(completeFixture());
    const teamIndex = rows[0]?.indexOf("team") ?? -1;
    const incomplete = rows.filter((row, index) => index === 0 || row[teamIndex] !== "WAS");
    const source = new NflverseWeeklyRostersSource({
      fetch: () => Promise.resolve(new Response(incomplete.map((row) => row.join(",")).join("\n"))),
    });
    await expect(source.check(2025, EMPTY_STATE)).rejects.toMatchObject({
      code: "QUALITY_THRESHOLD",
      retryable: false,
    });
  });

  it("validates the published season range before fetching", async () => {
    const source = new NflverseWeeklyRostersSource({
      fetch: () => Promise.resolve(new Response(completeFixture())),
    });
    await expect(source.check(2001, EMPTY_STATE)).rejects.toMatchObject({
      code: "INVALID_CONTEXT",
      retryable: false,
    });
  });
});
