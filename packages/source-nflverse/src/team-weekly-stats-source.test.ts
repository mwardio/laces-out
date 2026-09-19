import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { NflverseDatasetSourceError, type NflverseDatasetState } from "./release-source.js";
import {
  NFLVERSE_PLAY_BY_PLAY_SOURCE_KEY,
  NFLVERSE_PLAY_BY_PLAY_ATTRIBUTION,
  NFLVERSE_PLAY_BY_PLAY_ATTRIBUTION_URL,
  type NflversePlayByPlayLoader,
} from "./play-by-play-source.js";
import {
  NFLVERSE_DEFENSE_SCORING_EVENTS_VERSION,
  type DefenseScoringEventKind,
} from "./defense-scoring-events.js";
import { NFLVERSE_DEFENSE_SCORING_EVENT_COMPONENTS } from "./defense-scoring-components.js";
import { teamScoringEventsFixture } from "./team-scoring.test-fixtures.js";
import {
  NFLVERSE_TEAM_WEEKLY_STATS_SOURCE_KEY,
  NFLVERSE_TEAM_WEEKLY_STATS_COMPONENT_SCHEMA,
  NflverseTeamWeeklyStatsSource,
  buildNflverseTeamWeeklyStatsUrl,
} from "./team-weekly-stats-source.js";

const fixture = readFileSync(new URL("./fixtures/team-weekly-stats.csv", import.meta.url), "utf8");
const EMPTY_STATE: NflverseDatasetState = {
  etag: null,
  lastModified: null,
  checksumSha256: null,
};
const playByPlay = {
  load: (season: number) =>
    Promise.resolve({
      checkedAt: "2026-07-21T18:00:00.000Z",
      sourceKey: NFLVERSE_PLAY_BY_PLAY_SOURCE_KEY,
      sourceUrl: `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv.gz`,
      attribution: NFLVERSE_PLAY_BY_PLAY_ATTRIBUTION,
      attributionUrl: NFLVERSE_PLAY_BY_PLAY_ATTRIBUTION_URL,
      license: "CC BY 4.0" as const,
      season,
      etag: '"pbp-v1"',
      lastModified: "Tue, 21 Jul 2026 17:00:00 GMT",
      checksumSha256: "b".repeat(64),
      rowsRead: 8,
      rowsRejected: 0,
      coveredGames: 2,
      playerTouchdowns: [],
      defenseScoringEvents: [
        teamScoringEventsFixture({
          game: {
            season,
            week: 1,
            seasonType: "REG",
            gameId: "2024_01_TEN_CHI",
            homeTeam: "CHI",
            awayTeam: "TEN",
          },
          checksum: "b".repeat(64),
          checkedAt: "2026-07-21T18:00:00.000Z",
          events: [
            { team: "CHI", kind: "defensive-interception-touchdown" },
            { team: "CHI", kind: "blocked-punt-touchdown" },
          ],
        }),
        teamScoringEventsFixture({
          game: {
            season,
            week: 19,
            seasonType: "POST",
            gameId: "2024_19_PIT_BAL",
            homeTeam: "BAL",
            awayTeam: "PIT",
          },
          checksum: "b".repeat(64),
          checkedAt: "2026-07-21T18:00:00.000Z",
          events: [],
        }),
      ],
      observations: [
        {
          season,
          week: 1,
          seasonType: "REG" as const,
          gameId: "2024_01_TEN_CHI",
          team: "CHI",
          opponentTeam: "TEN",
          fourthDownStops: 2,
        },
        {
          season,
          week: 1,
          seasonType: "REG" as const,
          gameId: "2024_01_TEN_CHI",
          team: "TEN",
          opponentTeam: "CHI",
          fourthDownStops: 1,
        },
        {
          season,
          week: 19,
          seasonType: "POST" as const,
          gameId: "2024_19_PIT_BAL",
          team: "BAL",
          opponentTeam: "PIT",
          fourthDownStops: 0,
        },
        {
          season,
          week: 19,
          seasonType: "POST" as const,
          gameId: "2024_19_PIT_BAL",
          team: "PIT",
          opponentTeam: "BAL",
          fourthDownStops: 0,
        },
      ],
    }),
} satisfies NflversePlayByPlayLoader;

function scoringLoader(
  events: readonly { team: string; kind: DefenseScoringEventKind }[],
): NflversePlayByPlayLoader {
  return {
    async load(season) {
      const result = await playByPlay.load(season);
      return {
        ...result,
        defenseScoringEvents: [
          result.defenseScoringEvents[0]!,
          teamScoringEventsFixture({
            game: {
              season,
              week: 19,
              seasonType: "POST",
              gameId: "2024_19_PIT_BAL",
              homeTeam: "BAL",
              awayTeam: "PIT",
            },
            checksum: result.checksumSha256,
            checkedAt: result.checkedAt,
            events,
          }),
        ],
      };
    },
  };
}

function teamSource(
  options: ConstructorParameters<typeof NflverseTeamWeeklyStatsSource>[0] = {},
): NflverseTeamWeeklyStatsSource {
  return new NflverseTeamWeeklyStatsSource({ playByPlay, ...options });
}

function csvRows(body: string): string[][] {
  return body
    .trimEnd()
    .split("\n")
    .map((line) => line.split(","));
}

function removeColumn(body: string, name: string): string {
  const rows = csvRows(body);
  const index = rows[0]?.indexOf(name) ?? -1;
  if (index < 0) throw new Error(`Fixture omitted ${name}`);
  return rows
    .map((row) => {
      const copy = [...row];
      copy.splice(index, 1);
      return copy.join(",");
    })
    .join("\n");
}

function replaceTeamCell(body: string, team: string, column: string, value: string): string {
  const rows = csvRows(body);
  const header = rows[0] ?? [];
  const teamIndex = header.indexOf("team");
  const columnIndex = header.indexOf(column);
  if (teamIndex < 0 || columnIndex < 0) throw new Error("Fixture schema is incomplete");
  const target = rows.find((row, index) => index > 0 && row[teamIndex] === team);
  if (!target) throw new Error(`Fixture omitted team ${team}`);
  target[columnIndex] = value;
  return rows.map((row) => row.join(",")).join("\n");
}

describe("NflverseTeamWeeklyStatsSource", () => {
  it("exports all eighteen stable scoring-event count component names", () => {
    expect(Object.keys(NFLVERSE_DEFENSE_SCORING_EVENT_COMPONENTS)).toHaveLength(18);
    for (const [kind, component] of Object.entries(NFLVERSE_DEFENSE_SCORING_EVENT_COMPONENTS))
      expect(component).toBe(`scoring_event_${kind.replaceAll("-", "_")}`);
  });
  it("normalizes complete reciprocal REG and POST team games for opponent and D/ST models", async () => {
    const requests: Array<{ readonly url: string; readonly headers: Headers }> = [];
    const source = teamSource({
      now: () => new Date("2026-07-21T18:00:00.000Z"),
      fetch: (input, init) => {
        requests.push({ url: input.toString(), headers: new Headers(init?.headers) });
        return Promise.resolve(
          new Response(fixture, {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              etag: '"team-2024-v2"',
              "last-modified": "Tue, 21 Jul 2026 17:00:00 GMT",
            },
          }),
        );
      },
    });

    const result = await source.check(2024, {
      ...EMPTY_STATE,
      etag: '"team-2024-v1"',
      lastModified: "Mon, 20 Jul 2026 17:00:00 GMT",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(buildNflverseTeamWeeklyStatsUrl(2024));
    expect(requests[0]?.headers.get("if-none-match")).toBeNull();
    expect(requests[0]?.headers.get("if-modified-since")).toBeNull();
    expect(result).toMatchObject({
      state: "changed",
      sourceKey: NFLVERSE_TEAM_WEEKLY_STATS_SOURCE_KEY,
      season: 2024,
      checkedAt: "2026-07-21T18:00:00.000Z",
      rowsRead: 4,
      rowsRejected: 0,
      coveredWeeks: [1, 19],
      coveredSeasonTypes: ["REG", "POST"],
      coveredTeams: ["BAL", "CHI", "PIT", "TEN"],
      etag: '"team-2024-v2"',
    });
    if (result.state !== "changed") throw new Error("Expected changed team stats");
    expect(result.checksumSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.observations).toHaveLength(4);

    const chicago = result.observations.find((row) => row.team === "CHI");
    expect(chicago).toMatchObject({
      season: 2024,
      week: 1,
      seasonType: "REG",
      gameId: "2024_01_TEN_CHI",
      opponentTeam: "TEN",
      advanced: {
        passing_epa: -12.146704188691,
        passing_cpoe: -19.8383863629966,
        rushing_epa: -0.795930482714666,
        receiving_epa: -8.07137292242008,
      },
    });
    expect(chicago?.components).toMatchObject({
      passing_completions: 14,
      passing_attempts: 29,
      passing_yards: 93,
      rushing_yards: 84,
      total_offensive_yards: 148,
      offensive_fumbles_total: 3,
      offensive_fumbles_lost: 1,
      defensive_fumbles_forced: 1,
      defensive_fumbles_recovered: 1,
      defensive_sacks: 3,
      defensive_interceptions: 2,
      defensive_interception_return_yards: 52,
      defensive_touchdowns: 1,
      defensive_safeties: 0,
      defensive_two_point_returns: 0,
      fourth_down_stops: 2,
      special_teams_touchdowns: 1,
      field_goals_made: 3,
      field_goals_attempted: 3,
      field_goals_made_50_59: 1,
      extra_points_made: 1,
      punts_attempted: 6,
      punting_yards: 270,
      punt_return_yards_allowed: 30,
    });

    const baltimore = result.observations.find((row) => row.team === "BAL");
    expect(baltimore).toMatchObject({
      week: 19,
      seasonType: "POST",
      opponentTeam: "PIT",
    });
    expect(baltimore?.components).toMatchObject({
      total_offensive_yards: 464,
      defensive_sacks: 4,
      defensive_safeties: 0,
      field_goals_attempted: 0,
    });
  });

  it("retains a nonzero defensive safety without folding it into touchdown totals", async () => {
    const withSafety = replaceTeamCell(fixture, "BAL", "def_safeties", "1");
    const source = teamSource({
      fetch: () => Promise.resolve(new Response(withSafety)),
    });
    const result = await source.check(2024, EMPTY_STATE);
    if (result.state !== "changed") throw new Error("Expected changed team stats");
    expect(result.observations.find((row) => row.team === "BAL")?.components).toMatchObject({
      defensive_safeties: 1,
      defensive_touchdowns: 0,
    });
  });

  it("stores defensive conversion returns as counts without changing touchdowns or safeties", async () => {
    const csv = replaceTeamCell(fixture, "BAL", "def_2pt_made", "1");
    const result = await teamSource({
      fetch: () => Promise.resolve(new Response(csv)),
      playByPlay: scoringLoader([{ team: "BAL", kind: "defensive-two-point-return" }]),
    }).check(2024, EMPTY_STATE);
    if (result.state !== "changed") throw new Error("Expected changed team stats");
    expect(result.observations.find((row) => row.team === "BAL")?.components).toMatchObject({
      defensive_two_point_returns: 1,
      defensive_touchdowns: 0,
      defensive_safeties: 0,
    });
    expect(
      result.observations.find((row) => row.team === "PIT")?.components.defensive_two_point_returns,
    ).toBe(0);
  });

  it("recovers both Pittsburgh defensive touchdowns from one complete official PBP download", async () => {
    // The team CSV retains the test fixture's non-scoring fields; its TD aggregate mirrors the
    // official problematic split (def_tds=1, fumble_recovery_tds=1). All 185 PBP rows are captured.
    const rows = csvRows(fixture);
    const header = rows[0]!;
    const adapted = [
      header,
      ...rows.slice(1, 3).map((values) => {
        const copy = [...values];
        const own = copy[header.indexOf("team")] === "CHI" ? "PIT" : "CLE";
        for (const [column, value] of Object.entries({
          season: "2023",
          week: "2",
          season_type: "REG",
          game_id: "2023_02_CLE_PIT",
          team: own,
          opponent_team: own === "PIT" ? "CLE" : "PIT",
          def_tds: own === "PIT" ? "1" : "0",
          fumble_recovery_tds: own === "PIT" ? "1" : "0",
          special_teams_tds: "0",
          def_2pt_made: "0",
        }))
          copy[header.indexOf(column)] = value;
        return copy;
      }),
    ]
      .map((values) => values.join(","))
      .join("\n");
    const pbp = gzipSync(
      readFileSync(new URL("./fixtures/play-by-play-cle-pit-2023.csv", import.meta.url)),
    );
    const requests: string[] = [];
    const source = new NflverseTeamWeeklyStatsSource({
      now: () => new Date("2026-07-21T18:00:00.000Z"),
      fetch: (url) => {
        requests.push(url.toString());
        return Promise.resolve(
          new Response(url.toString().includes("/pbp/") ? new Uint8Array(pbp) : adapted),
        );
      },
    });
    const result = await source.check(2023, EMPTY_STATE);
    if (result.state !== "changed") throw new Error("Expected complete team scoring");
    expect(requests.filter((url) => url.includes("/pbp/"))).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(result.observations.find((row) => row.team === "PIT")?.components).toMatchObject({
      defensive_touchdowns: 2,
      raw_defensive_touchdowns: 1,
      fumble_recovery_touchdowns: 1,
      special_teams_touchdowns: 0,
      raw_special_teams_touchdowns: 0,
      scoring_event_defensive_interception_touchdown: 1,
      scoring_event_defensive_fumble_touchdown: 1,
      scoring_event_offensive_fumble_touchdown: 0,
      scoring_event_totals_complete: 1,
      scoring_points_total: 26,
    });
    expect(result.defenseScoringEventsVersion).toBe(NFLVERSE_DEFENSE_SCORING_EVENTS_VERSION);
  });

  it("excludes offensive fumble touchdowns and retains classified special-team fumbles and rare events", async () => {
    const events = [
      "offensive-fumble-touchdown",
      "kickoff-fumble-touchdown",
      "punt-fumble-touchdown",
      "one-point-safety",
    ] as const;
    const result = await teamSource({
      fetch: () =>
        Promise.resolve(new Response(replaceTeamCell(fixture, "BAL", "fumble_recovery_tds", "3"))),
      playByPlay: scoringLoader(events.map((kind) => ({ team: "BAL", kind }))),
    }).check(2024, EMPTY_STATE);
    if (result.state !== "changed") throw new Error("Expected complete team scoring");
    const components = result.observations.find((row) => row.team === "BAL")!.components;
    expect(components).toMatchObject({
      defensive_touchdowns: 0,
      special_teams_touchdowns: 2,
      raw_special_teams_touchdowns: 0,
      fumble_recovery_touchdowns: 3,
      one_point_safeties: 1,
      scoring_event_offensive_fumble_touchdown: 1,
      scoring_event_kickoff_fumble_touchdown: 1,
      scoring_event_punt_fumble_touchdown: 1,
      scoring_points_total: 19,
      scoring_event_totals_complete: 1,
    });
    expect(
      Object.values(NFLVERSE_DEFENSE_SCORING_EVENT_COMPONENTS).every(
        (field) => Number.isSafeInteger(components[field]) && components[field] >= 0,
      ),
    ).toBe(true);
  });

  it("rejects conversion count disagreement between official CSV and its complete event ledger", async () => {
    await expect(
      teamSource({
        fetch: () => Promise.resolve(new Response(fixture)),
        playByPlay: scoringLoader([{ team: "BAL", kind: "defensive-two-point-return" }]),
      }).check(2024, EMPTY_STATE),
    ).rejects.toThrow(/def_2pt_made/);
  });

  it("rejects legacy, missing, unfinished and mismatched scoring capability before an unchanged result can be reused", async () => {
    const original = await playByPlay.load(2024);
    const valid = await teamSource({ fetch: () => Promise.resolve(new Response(fixture)) }).check(
      2024,
      EMPTY_STATE,
    );
    const { defenseScoringEvents: removedEvents, ...legacy } = original;
    expect(removedEvents).toHaveLength(2);
    const first = original.defenseScoringEvents[0]!;
    const variants = [
      legacy,
      { ...original, defenseScoringEvents: [] },
      {
        ...original,
        defenseScoringEvents: [
          { ...first, state: "unresolved" as const, teams: null },
          original.defenseScoringEvents[1]!,
        ],
      },
      {
        ...original,
        defenseScoringEvents: [
          { ...first, provenance: { ...first.provenance, artifactChecksumSha256: "c".repeat(64) } },
          original.defenseScoringEvents[1]!,
        ],
      },
      {
        ...original,
        defenseScoringEvents: [
          {
            ...first,
            teams: first.teams!.map((team) => ({
              ...team,
              defensiveTouchdowns: team.defensiveTouchdowns + 1,
            })),
          },
          original.defenseScoringEvents[1]!,
        ],
      },
    ];
    for (const changed of variants) {
      const source = teamSource({
        fetch: () => Promise.resolve(new Response(fixture)),
        playByPlay: { load: () => Promise.resolve(changed) },
      });
      await expect(
        source.check(2024, { ...EMPTY_STATE, checksumSha256: valid.checksumSha256 }),
      ).rejects.toMatchObject({ code: "QUALITY_THRESHOLD" });
    }
  });

  it.each(["", "NA", "-1", "0.5", "21", "Infinity", "return"])(
    "rejects malformed defensive conversion count %j instead of inventing zero",
    async (value) => {
      const csv = replaceTeamCell(fixture, "BAL", "def_2pt_made", value);
      await expect(
        teamSource({ fetch: () => Promise.resolve(new Response(csv)) }).check(2024, EMPTY_STATE),
      ).rejects.toMatchObject({ code: "QUALITY_THRESHOLD" });
    },
  );

  it("requires the official defensive conversion-return column", async () => {
    const csv = removeColumn(fixture, "def_2pt_made");
    await expect(
      teamSource({ fetch: () => Promise.resolve(new Response(csv)) }).check(2024, EMPTY_STATE),
    ).rejects.toMatchObject({
      code: "INVALID_CSV",
      message: "nflverse team weekly stats omitted required column def_2pt_made",
    });
  });

  it.each(["team-week-with-fourth-downs-v1", "nflverse-team-week-components-v2"])(
    "replays unchanged upstream bytes under old %s contract and then becomes idempotent",
    async (oldSchema) => {
      const raw = createHash("sha256").update(fixture).digest("hex");
      const legacy = createHash("sha256")
        .update(`${oldSchema}:${raw}:${"b".repeat(64)}`)
        .digest("hex");
      const current = createHash("sha256")
        .update(
          `${NFLVERSE_TEAM_WEEKLY_STATS_COMPONENT_SCHEMA}:${NFLVERSE_DEFENSE_SCORING_EVENTS_VERSION}:${raw}:${"b".repeat(64)}`,
        )
        .digest("hex");
      const source = teamSource({
        fetch: () =>
          Promise.resolve(new Response(fixture, { headers: { etag: '"same-team-bytes"' } })),
      });
      const result = await source.check(2024, {
        etag: '"same-team-bytes"',
        lastModified: null,
        checksumSha256: legacy,
      });
      expect(result).toMatchObject({
        state: "changed",
        checksumSha256: current,
        teamWeeklyChecksumSha256: raw,
      });
      expect(current).not.toBe(legacy);
      expect(
        await source.check(2024, {
          etag: '"same-team-bytes"',
          lastModified: null,
          checksumSha256: current,
        }),
      ).toMatchObject({
        state: "unchanged",
        checksumSha256: current,
        teamWeeklyChecksumSha256: raw,
      });
    },
  );

  it("accepts an official blocked punt that is not credited as a punt attempt", async () => {
    const withBlockedPunt = replaceTeamCell(
      replaceTeamCell(fixture, "CHI", "pt_att", "0"),
      "CHI",
      "pt_blocked",
      "1",
    );
    const source = teamSource({
      fetch: () => Promise.resolve(new Response(withBlockedPunt)),
    });
    const result = await source.check(2024, EMPTY_STATE);
    if (result.state !== "changed") throw new Error("Expected changed team stats");
    expect(result.observations.find((row) => row.team === "CHI")?.components).toMatchObject({
      punts_attempted: 0,
      punts_blocked: 1,
    });
  });

  it("rejects unconditioned304 rather than overlooking PBP-only changes", async () => {
    const source = teamSource({
      fetch: () => Promise.resolve(new Response(null, { status: 304 })),
    });
    await expect(
      source.check(2024, {
        etag: '"same"',
        lastModified: "Tue, 21 Jul 2026 17:00:00 GMT",
        checksumSha256: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM" });
  });

  it("fails closed when an upstream model input column disappears", async () => {
    const source = teamSource({
      fetch: () => Promise.resolve(new Response(removeColumn(fixture, "def_sacks"))),
    });
    await expect(source.check(2024, EMPTY_STATE)).rejects.toMatchObject({
      code: "INVALID_CSV",
      message: "nflverse team weekly stats omitted required column def_sacks",
    });
  });

  it("rejects duplicate headers instead of accepting csv-parse key overwrite", async () => {
    const duplicateHeader = fixture.replace(
      "def_fumbles_forced,def_sacks",
      "def_fumbles_forced,def_fumbles_forced",
    );
    const source = teamSource({
      fetch: () => Promise.resolve(new Response(duplicateHeader)),
    });
    await expect(source.check(2024, EMPTY_STATE)).rejects.toMatchObject({
      code: "INVALID_CSV",
      message: "nflverse team weekly stats contain invalid or duplicate headers",
    });
  });

  it("rejects internally inconsistent team totals rather than repairing them", async () => {
    const invalid = replaceTeamCell(fixture, "CHI", "completions", "30");
    const source = teamSource({
      fetch: () => Promise.resolve(new Response(invalid)),
    });
    await expect(source.check(2024, EMPTY_STATE)).rejects.toMatchObject({
      code: "QUALITY_THRESHOLD",
      message: "nflverse team weekly stats rejected 2 of 4 rows",
    });
  });

  it("rejects a partial game because opponent adjustments require both reciprocal rows", async () => {
    const partial = fixture
      .trimEnd()
      .split("\n")
      .filter((line) => !line.startsWith("2024,1,TEN,"))
      .join("\n");
    const source = teamSource({
      fetch: () => Promise.resolve(new Response(partial)),
    });
    await expect(source.check(2024, EMPTY_STATE)).rejects.toMatchObject({
      code: "QUALITY_THRESHOLD",
      message: "nflverse team weekly stats rejected 1 of 3 rows",
    });
  });

  it("rejects duplicate team-game observations instead of selecting one by input order", async () => {
    const lines = fixture.trimEnd().split("\n");
    const duplicate = [...lines, lines[1] ?? ""].join("\n");
    const source = teamSource({
      fetch: () => Promise.resolve(new Response(duplicate)),
    });
    await expect(source.check(2024, EMPTY_STATE)).rejects.toMatchObject({
      code: "QUALITY_THRESHOLD",
      message: "nflverse team weekly stats rejected 1 of 5 rows",
    });
  });

  it.each([
    {
      name: "unexpected response type",
      response: new Response(fixture, { headers: { "content-type": "text/html" } }),
      code: "CONTENT_TYPE",
    },
    {
      name: "season artifact that is not published",
      response: new Response(null, { status: 404 }),
      code: "NOT_AVAILABLE",
    },
    {
      name: "oversized declared response",
      response: new Response(fixture, {
        headers: { "content-length": String(8 * 1024 * 1024 + 1) },
      }),
      code: "TOO_LARGE",
    },
  ])("rejects $name", async ({ response, code }) => {
    const source = teamSource({
      fetch: () => Promise.resolve(response.clone()),
    });
    const error = await source.check(2024, EMPTY_STATE).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NflverseDatasetSourceError);
    expect(error).toMatchObject({ code, retryable: false });
  });

  it("validates season context before fetching", async () => {
    let fetched = false;
    const source = teamSource({
      fetch: () => {
        fetched = true;
        return Promise.resolve(new Response(fixture));
      },
    });
    await expect(source.check(2010, EMPTY_STATE)).rejects.toMatchObject({
      code: "INVALID_CONTEXT",
    });
    expect(fetched).toBe(false);
  });
});
