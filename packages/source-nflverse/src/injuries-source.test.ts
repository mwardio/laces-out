import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  NFLVERSE_INJURIES_SOURCE_KEY,
  NflverseInjuriesSource,
  buildNflverseInjuriesUrl,
  type NflverseDatasetState,
} from "./index.js";

const fixture = readFileSync(new URL("./fixtures/injuries.csv", import.meta.url), "utf8");
const EMPTY_STATE: NflverseDatasetState = {
  etag: null,
  lastModified: null,
  checksumSha256: null,
};
const TEAMS = ["ARI", "ATL", "BUF", "CAR"] as const;

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
    if (index < 0) throw new Error(`Injury fixture omitted ${name}`);
    return index;
  };
  const rows = [header];
  for (const [teamIndex, selectedTeam] of TEAMS.entries()) {
    for (let playerIndex = 0; playerIndex < 4; playerIndex += 1) {
      const sequence = teamIndex * 4 + playerIndex;
      const padded = String(sequence).padStart(7, "0");
      const row = [...(templates[playerIndex % templates.length] ?? [])];
      row[column("team")] = selectedTeam;
      row[column("gsis_id")] = `00-${padded}`;
      row[column("full_name")] = `Player ${padded}`;
      row[column("first_name")] = "Player";
      row[column("last_name")] = padded;
      rows.push(row);
    }
  }
  return `${rows.map((row) => row.join(",")).join("\n")}\n`;
}

function withoutColumn(body: string, name: string): string {
  const rows = csvRows(body);
  const index = rows[0]?.indexOf(name) ?? -1;
  if (index < 0) throw new Error(`Injury fixture omitted ${name}`);
  return rows
    .map((row) => {
      const copy = [...row];
      copy.splice(index, 1);
      return copy.join(",");
    })
    .join("\n");
}

function legacyTimestampFixture(body: string): string {
  const rows = csvRows(body);
  const seasonTypeIndex = rows[0]?.indexOf("season_type") ?? -1;
  if (seasonTypeIndex < 0) throw new Error("Injury fixture omitted season_type");
  return rows
    .map((row, index) => {
      const copy = [...row];
      copy.splice(seasonTypeIndex, 1);
      copy.push(index === 0 ? "date_modified" : "2025-09-05T12:00:00Z");
      return copy.join(",");
    })
    .join("\n");
}

describe("NflverseInjuriesSource", () => {
  it("tracks the exact current injury-release schema", () => {
    expect(csvRows(fixture)[0]).toEqual([
      "season",
      "season_type",
      "game_type",
      "team",
      "week",
      "gsis_id",
      "position",
      "full_name",
      "first_name",
      "last_name",
      "report_primary_injury",
      "report_secondary_injury",
      "report_status",
      "practice_primary_injury",
      "practice_secondary_injury",
      "practice_status",
    ]);
  });

  it("normalizes sparse current-schema reports without requiring every team or week", async () => {
    const requests: Array<{ readonly url: string; readonly headers: Headers }> = [];
    const source = new NflverseInjuriesSource({
      now: () => new Date("2026-07-21T21:00:00.000Z"),
      fetch: (input, init) => {
        requests.push({ url: input.toString(), headers: new Headers(init?.headers) });
        return Promise.resolve(
          new Response(completeFixture(), {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              etag: '"injuries-2025-v2"',
              "last-modified": "Tue, 21 Jul 2026 20:00:00 GMT",
            },
          }),
        );
      },
    });

    const result = await source.check(2025, {
      ...EMPTY_STATE,
      etag: '"injuries-2025-v1"',
      lastModified: "Mon, 20 Jul 2026 20:00:00 GMT",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(buildNflverseInjuriesUrl(2025));
    expect(requests[0]?.headers.get("if-none-match")).toBe('"injuries-2025-v1"');
    expect(requests[0]?.headers.get("if-modified-since")).toBe("Mon, 20 Jul 2026 20:00:00 GMT");
    expect(result).toMatchObject({
      state: "changed",
      sourceKey: NFLVERSE_INJURIES_SOURCE_KEY,
      season: 2025,
      checkedAt: "2026-07-21T21:00:00.000Z",
      rowsRead: 16,
      rowsRejected: 0,
      coveredWeeks: [1, 3],
      coveredSeasonTypes: ["REG"],
      coveredTeams: [...TEAMS],
      coveredReportStatuses: ["out"],
      coveredPracticeStatuses: ["did-not-participate", "full", "limited"],
      datedSnapshots: 0,
      weekCoverage: [
        {
          week: 1,
          seasonType: "REG",
          gameType: "REG",
          teams: 4,
          players: 8,
          observations: 8,
        },
        {
          week: 3,
          seasonType: "REG",
          gameType: "REG",
          teams: 4,
          players: 8,
          observations: 8,
        },
      ],
      etag: '"injuries-2025-v2"',
    });
    if (result.state !== "changed") throw new Error("Expected changed injuries");
    expect(result.checksumSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.observations.find((row) => row.fullName === "Player 0000001")).toMatchObject({
      gsisId: "00-0000001",
      position: "G",
      report: { primaryInjury: "Knee", secondaryInjury: null, status: "out" },
      practice: { primaryInjury: "Knee", secondaryInjury: null, status: "limited" },
      dateModified: null,
    });
    expect(result.observations.find((row) => row.fullName === "Player 0000002")).toMatchObject({
      report: { primaryInjury: "Illness", secondaryInjury: null, status: null },
      practice: { primaryInjury: null, secondaryInjury: null, status: null },
    });
  });

  it("uses the body checksum when HTTP validators are absent", async () => {
    const body = completeFixture();
    const source = new NflverseInjuriesSource({
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

  it("preserves dated snapshots and rejects only an exact repeated snapshot", async () => {
    const legacy = legacyTimestampFixture(completeFixture());
    const rows = csvRows(legacy);
    const later = [...(rows[1] ?? [])];
    later[rows[0]?.indexOf("date_modified") ?? -1] = "2025-09-05T13:00:00Z";
    const body = `${legacy.trimEnd()}\n${later.join(",")}\n${later.join(",")}\n`;
    const source = new NflverseInjuriesSource({
      fetch: () => Promise.resolve(new Response(body)),
    });

    const result = await source.check(2025, EMPTY_STATE);

    if (result.state !== "changed") throw new Error("Expected changed injuries");
    expect(result).toMatchObject({
      rowsRead: 18,
      rowsRejected: 1,
      rejections: { duplicate: 1 },
      datedSnapshots: 17,
    });
    expect(result.observations.filter((row) => row.gsisId === "00-0000000")).toEqual([
      expect.objectContaining({ dateModified: "2025-09-05T12:00:00.000Z" }),
      expect.objectContaining({ dateModified: "2025-09-05T13:00:00.000Z" }),
    ]);
  });

  it("preserves different undated states for the same player-week", async () => {
    const body = completeFixture();
    const rows = csvRows(body);
    const changed = [...(rows[1] ?? [])];
    changed[rows[0]?.indexOf("report_primary_injury") ?? -1] = "Knee";
    changed[rows[0]?.indexOf("report_status") ?? -1] = "Questionable";
    const source = new NflverseInjuriesSource({
      fetch: () => Promise.resolve(new Response(`${body.trimEnd()}\n${changed.join(",")}\n`)),
    });

    const result = await source.check(2025, EMPTY_STATE);

    if (result.state !== "changed") throw new Error("Expected changed injuries");
    expect(result).toMatchObject({ rowsRead: 17, rowsRejected: 0 });
    expect(result.observations.filter((row) => row.gsisId === "00-0000000")).toHaveLength(2);
  });

  it("rejects a malformed optional historical timestamp", async () => {
    const legacy = legacyTimestampFixture(completeFixture());
    const rows = csvRows(legacy);
    const malformed = [...(rows[1] ?? [])];
    malformed[rows[0]?.indexOf("gsis_id") ?? -1] = "00-9000003";
    malformed[rows[0]?.indexOf("date_modified") ?? -1] = "September 5 at noon";
    const source = new NflverseInjuriesSource({
      fetch: () => Promise.resolve(new Response(`${legacy.trimEnd()}\n${malformed.join(",")}\n`)),
    });

    const result = await source.check(2025, EMPTY_STATE);

    expect(result).toMatchObject({
      state: "changed",
      rowsRead: 17,
      rowsRejected: 1,
      rejections: { invalidTimestamp: 1 },
      datedSnapshots: 16,
    });
  });

  it("rejects malformed report and empty injury observations while preserving valid rows", async () => {
    const body = completeFixture();
    const rows = csvRows(body);
    const header = rows[0] ?? [];
    const invalidReport = [...(rows[1] ?? [])];
    invalidReport[header.indexOf("gsis_id")] = "00-9000001";
    invalidReport[header.indexOf("report_primary_injury")] = "";
    invalidReport[header.indexOf("report_status")] = "Out";
    invalidReport[header.indexOf("practice_primary_injury")] = "";
    invalidReport[header.indexOf("practice_status")] = "";
    const empty = [...invalidReport];
    empty[header.indexOf("gsis_id")] = "00-9000002";
    empty[header.indexOf("report_status")] = "";
    const source = new NflverseInjuriesSource({
      fetch: () =>
        Promise.resolve(
          new Response(`${body.trimEnd()}\n${invalidReport.join(",")}\n${empty.join(",")}\n`),
        ),
    });

    const result = await source.check(2025, EMPTY_STATE);

    expect(result).toMatchObject({
      state: "changed",
      rowsRead: 18,
      rowsRejected: 2,
      rejections: { invalidReport: 1, emptyObservation: 1 },
    });
  });

  it("fails closed when a consumed injury column disappears", async () => {
    const source = new NflverseInjuriesSource({
      fetch: () =>
        Promise.resolve(new Response(withoutColumn(completeFixture(), "practice_status"))),
    });
    await expect(source.check(2025, EMPTY_STATE)).rejects.toMatchObject({
      code: "INVALID_CSV",
      retryable: false,
    });
  });

  it("rejects a catastrophically sparse artifact without requiring full league coverage", async () => {
    const rows = csvRows(completeFixture());
    const teamIndex = rows[0]?.indexOf("team") ?? -1;
    const incomplete = rows.filter((row, index) => index === 0 || row[teamIndex] !== "CAR");
    const source = new NflverseInjuriesSource({
      fetch: () => Promise.resolve(new Response(incomplete.map((row) => row.join(",")).join("\n"))),
    });
    await expect(source.check(2025, EMPTY_STATE)).rejects.toMatchObject({
      code: "QUALITY_THRESHOLD",
      retryable: false,
    });
  });

  it("validates the published season range before fetching", async () => {
    const source = new NflverseInjuriesSource({
      fetch: () => Promise.resolve(new Response(completeFixture())),
    });
    await expect(source.check(2008, EMPTY_STATE)).rejects.toMatchObject({
      code: "INVALID_CONTEXT",
      retryable: false,
    });
  });
});
