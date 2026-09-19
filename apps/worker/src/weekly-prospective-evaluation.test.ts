import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectionScoringProfileKey } from "../../../packages/projections/src/scoring.js";
import {
  evaluateWeeklyProspectiveLedger,
  type WeeklyProspectiveCandidate,
  type WeeklyOutcomeObservationSnapshot,
} from "./weekly-prospective-evaluation.js";
import {
  NFL_GAME_FINALITY_SOURCE,
  NFL_GAME_FINALITY_VERSION,
  type NflGameFinalitySource,
} from "./nfl-game-finality.js";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const profile = {
  id: "frozen-ppr",
  rules: [
    { statId: "receiving_yards", points: 0.1 },
    { statId: "receptions", points: 1 },
  ],
};
const game = {
  gameId: "2026_02_DET_BUF",
  home: "BUF",
  away: "DET",
  kickoffAt: "2026-09-20T17:00:00.000Z",
};
const checked = "2026-09-21T02:00:00.000Z";
function candidate(patch: Partial<WeeklyProspectiveCandidate> = {}): WeeklyProspectiveCandidate {
  return {
    leagueSeasonId: "league",
    projectionSetId: "frozen-set",
    playerId: "frozen-player",
    scoringProfileSha256: hash(projectionScoringProfileKey(profile)),
    gsisId: "00-0000001",
    captureTeam: "BUF",
    identityBasis: "captured-gsis",
    forecast: { mean: "10.0000", floor: "8.0000", ceiling: "12.0000", confidence: "0.60000000" },
    captureGame: game,
    generationGame: game,
    pointCandidate: true,
    pointReasons: [],
    nominalIntervalCandidate: true,
    nominalCoverage: 0.7,
    intervalEndpointsValid: true,
    intervalReasons: [],
    ...patch,
  };
}
function document() {
  const status = () => ({ type: { completed: true, state: "post", name: "STATUS_FINAL" } });
  return {
    leagues: [{ slug: "nfl" }],
    season: { year: 2026, type: 2 },
    week: { number: 2 },
    events: [
      {
        id: "401000001",
        date: game.kickoffAt,
        season: { year: 2026, type: 2 },
        week: { number: 2 },
        status: status(),
        competitions: [
          {
            id: "401000001",
            date: game.kickoffAt,
            status: status(),
            competitors: [
              { homeAway: "home", team: { abbreviation: "BUF" } },
              { homeAway: "away", team: { abbreviation: "DET" } },
            ],
          },
        ],
      },
    ],
  };
}
function terminal(value: unknown = document()): NflGameFinalitySource {
  const payload = JSON.stringify(value);
  return {
    sourceKey: NFL_GAME_FINALITY_SOURCE,
    version: NFL_GAME_FINALITY_VERSION,
    url: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=2026&seasontype=2&week=2&limit=1000",
    payload,
    payloadChecksum: hash(payload),
    observedAt: "2026-09-21T01:00:00.000Z",
  };
}
function snapshot(): WeeklyOutcomeObservationSnapshot {
  const common = {
    sourceSyncRunId: "successful-run",
    fetchedAt: checked,
    season: 2026,
    week: 2,
    seasonType: "REG" as const,
  };
  return {
    capturedAt: "2026-09-21T03:00:00.000Z",
    sources: [
      {
        sourceId: "schedules",
        sourceKey: "nflverse.schedules.2026",
        inputChecksum: hash("schedule"),
        checkedAt: checked,
      },
      {
        sourceId: "player-stats",
        sourceKey: "nflverse.stats-player-week.2026",
        inputChecksum: hash("player-stats"),
        checkedAt: checked,
      },
      {
        sourceId: "team-stats",
        sourceKey: "nflverse.stats-team-week.2026",
        inputChecksum: hash("team-stats"),
        checkedAt: checked,
      },
    ],
    schedules: [
      {
        ...common,
        id: "schedule-observation",
        sourceId: "schedules",
        inputChecksum: hash("schedule"),
        externalGameId: game.gameId,
        kickoffAt: game.kickoffAt,
        homeTeam: game.home,
        awayTeam: game.away,
        status: "final",
      },
    ],
    players: [
      {
        ...common,
        id: "player-observation",
        sourceId: "player-stats",
        inputChecksum: hash("player-stats"),
        externalPlayerId: "00-0000001",
        playerId: "canonical-current-uuid",
        gameId: game.gameId,
        team: "BUF",
        opponentTeam: "DET",
        components: { receiving_yards: 80, receptions: 3 },
      },
    ],
    teams: [],
  };
}
function request(
  rows = [candidate()],
  observations = snapshot(),
  finalitySource: NflGameFinalitySource | null = terminal(),
) {
  const ledgerNdjson = rows.map((row) => JSON.stringify(row) + "\n").join("");
  const observationJson = JSON.stringify(observations);
  return {
    ledgerNdjson,
    ledgerChecksum: hash(ledgerNdjson),
    expectedRows: rows.length,
    season: 2026,
    week: 2,
    profiles: [profile],
    observationJson,
    observationChecksum: hash(observationJson),
    finalitySource,
  };
}

describe("frozen weekly ledger observed-outcome boundary", () => {
  it("joins real observation shapes and explicit finality before exact scoring and metrics", () => {
    const frozen = candidate();
    const result = evaluateWeeklyProspectiveLedger(request([frozen]));
    expect(result.rows[0]!.candidate).toEqual(frozen);
    expect(result.rows[0]!.actual).toMatchObject({
      state: "available",
      points: 11,
      finality: { state: "verified", providerEventId: "401000001" },
    });
    expect(result.overall).toMatchObject({
      capturedRows: 1,
      actualAvailable: 1,
      actualUnavailable: 0,
      point: { samples: 1, biasActualMinusForecast: 1, mae: 1, rmse: 1 },
      nominal70: { samples: 1, coverage: 1, below: 0, above: 0, width: 4, intervalScore: 4 },
    });
    expect(result.canAuthorizeRelease).toBe(false);
  });
  it("accepts semantically identical scoring profiles shared by several leagues", () => {
    const input = request();
    const result = evaluateWeeklyProspectiveLedger({
      ...input,
      profiles: [profile, { ...profile, id: "other-league", rules: [...profile.rules].reverse() }],
    });
    expect(result.overall.actualAvailable).toBe(1);
  });
  it("does not infer finality from persisted score-derived final, elapsed time or a completion flag", () => {
    expect(
      evaluateWeeklyProspectiveLedger(request([candidate()], snapshot(), null)).rows[0]!.actual,
    ).toMatchObject({ state: "unavailable", reasons: ["score-derived-finality-unproven"] });
    const unfinished = document();
    unfinished.events[0]!.competitions[0]!.status.type = {
      completed: false,
      state: "in",
      name: "STATUS_IN_PROGRESS",
    };
    expect(
      evaluateWeeklyProspectiveLedger(request([candidate()], snapshot(), terminal(unfinished)))
        .rows[0]!.actual.state,
    ).toBe("unavailable");
    const postponed = snapshot();
    Object.assign(postponed.schedules[0]!, { status: "postponed" });
    expect(
      evaluateWeeklyProspectiveLedger(request([candidate()], postponed)).rows[0]!.actual.reasons,
    ).toEqual(["persisted-game-not-final"]);
  });
  it("requires stats checked after terminal observation, while accepting reconfirmed unchanged bytes", () => {
    const stale = snapshot();
    Object.assign(stale.sources[1]!, { checkedAt: "2026-09-21T00:00:00.000Z" });
    Object.assign(stale.players[0]!, { fetchedAt: "2026-09-21T00:00:00.000Z" });
    expect(
      evaluateWeeklyProspectiveLedger(request([candidate()], stale)).rows[0]!.actual.reasons,
    ).toEqual(["stats-not-checked-after-finality"]);
    Object.assign(stale.sources[1]!, { checkedAt: checked });
    expect(
      evaluateWeeklyProspectiveLedger(request([candidate()], stale)).rows[0]!.actual.state,
    ).toBe("available");
  });
  it("does not score absent stat rows or sparse rows as DNP zero", () => {
    const missing = { ...snapshot(), players: [], rosterStatus: "inactive", complete: true };
    expect(
      evaluateWeeklyProspectiveLedger(request([candidate()], missing)).rows[0]!.actual,
    ).toMatchObject({
      state: "unavailable",
      points: null,
      reasons: ["actual-observation-missing-not-dnp"],
    });
    const sparse = snapshot();
    Object.assign(sparse.players[0]!, { components: { receiving_yards: 80 } });
    expect(
      evaluateWeeklyProspectiveLedger(request([candidate()], sparse)).rows[0]!.actual,
    ).toMatchObject({
      state: "unavailable",
      points: null,
      componentEvidence: { missingComponents: ["receptions"] },
    });
    Object.assign(sparse.players[0]!, { components: { receiving_yards: 0, receptions: 0 } });
    expect(
      evaluateWeeklyProspectiveLedger(request([candidate()], sparse)).rows[0]!.actual,
    ).toMatchObject({ state: "available", points: 0 });
  });
  it("retains unknown-role/unknown-policy point candidates without making a nominal claim", () => {
    const unknown = {
      ...candidate({
        nominalIntervalCandidate: false,
        nominalCoverage: null,
        intervalReasons: ["nominal-interval-policy-unknown-or-unusable"],
      }),
      publishedIntervalProvenance: null,
      frozenIntervalPolicyVersion: "unknown",
      capturePosition: null,
    };
    const result = evaluateWeeklyProspectiveLedger(request([unknown]));
    expect(result.overall.point.samples).toBe(1);
    expect(result.overall.nominal70).toMatchObject({
      samples: 0,
      coverage: null,
      intervalScore: null,
    });
    expect(result.rows[0]!.candidate).toEqual(unknown);
  });
  it("rejects source substitutions and conflicting player, game, team or duplicate identities", () => {
    const changed = snapshot();
    Object.assign(changed.players[0]!, { inputChecksum: hash("substitution") });
    expect(
      evaluateWeeklyProspectiveLedger(request([candidate()], changed)).rows[0]!.actual.state,
    ).toBe("unavailable");
    Object.assign(changed.players[0]!, { inputChecksum: hash("player-stats"), team: "KC" });
    expect(
      evaluateWeeklyProspectiveLedger(request([candidate()], changed)).rows[0]!.actual.reasons,
    ).toEqual(["actual-player-team-game-conflict"]);
    const duplicate = snapshot();
    Object.assign(duplicate, {
      players: [...duplicate.players, { ...duplicate.players[0]!, id: "duplicate" }],
    });
    expect(
      evaluateWeeklyProspectiveLedger(request([candidate()], duplicate)).rows[0]!.actual.reasons,
    ).toEqual(["actual-identity-ambiguous"]);
    const moved = snapshot();
    Object.assign(moved.schedules[0]!, { kickoffAt: "2026-09-20T20:00:00.000Z" });
    expect(
      evaluateWeeklyProspectiveLedger(request([candidate()], moved)).rows[0]!.actual.reasons,
    ).toEqual(["captured-outcome-game-conflict"]);
  });
  it("does not turn provider-neutral defensive model assumptions into observed components", () => {
    const observations = snapshot();
    const common = observations.players[0]!;
    Object.assign(observations, {
      teams: [
        {
          ...common,
          id: "home-team",
          sourceId: "team-stats",
          inputChecksum: hash("team-stats"),
          externalTeamId: "BUF",
          components: { defensive_sacks: 3, defensive_fumbles_recovered: 0 },
        },
        {
          ...common,
          id: "away-team",
          sourceId: "team-stats",
          inputChecksum: hash("team-stats"),
          externalTeamId: "DET",
          team: "DET",
          opponentTeam: "BUF",
          components: {
            field_goals_blocked: 0,
            extra_points_blocked: 0,
            punts_blocked: 0,
            total_offensive_yards: 300,
          },
        },
      ],
    });
    const defenseProfile = {
      id: "defense",
      rules: [
        { statId: "defensive_sacks", points: 1 },
        { statId: "points_allowed_0_probability", points: 10 },
        { statId: "defensive_two_point_returns", points: 2 },
      ],
    };
    const defense = candidate({
      gsisId: null,
      identityBasis: "captured-team-defense-alias",
      scoringProfileSha256: hash(projectionScoringProfileKey(defenseProfile)),
    });
    const input = { ...request([defense], observations), profiles: [defenseProfile] };
    expect(evaluateWeeklyProspectiveLedger(input).rows[0]!.actual).toMatchObject({
      state: "unavailable",
      componentEvidence: {
        missingComponents: ["defensive_two_point_returns", "points_allowed_0_probability"],
      },
    });
    const countProfile = {
      id: "counts",
      rules: [
        { statId: "defensive_sacks", points: 1 },
        { statId: "defensive_blocked_kicks", points: 2 },
      ],
    };
    expect(
      evaluateWeeklyProspectiveLedger({
        ...request(
          [{ ...defense, scoringProfileSha256: hash(projectionScoringProfileKey(countProfile)) }],
          observations,
        ),
        profiles: [countProfile],
      }).rows[0]!.actual,
    ).toMatchObject({ state: "available", points: 3 });
  });
  it("keeps the entire 19,922-row population and original exclusions without backfill", () => {
    const rows = Array.from({ length: 19_922 }, (_, index) =>
      index === 0
        ? candidate()
        : candidate({
            playerId: `excluded-${index}`,
            leagueSeasonId: `league-${index % 16}`,
            pointCandidate: false,
            pointReasons: ["capture-kickoff-not-future"],
            nominalIntervalCandidate: false,
            intervalReasons: ["capture-kickoff-not-future"],
          }),
    );
    const result = evaluateWeeklyProspectiveLedger(request(rows));
    expect(result.rows).toHaveLength(19_922);
    expect(result.rows.map((row) => row.candidate)).toEqual(rows);
    expect(result.overall).toMatchObject({
      capturedRows: 19_922,
      pointCandidates: 1,
      actualAvailable: 1,
      ineligible: 19_921,
      pointReasonCounts: { "capture-kickoff-not-future": 19_921 },
    });
  });
  it("refuses changed ledger bytes, row counts, outcome bytes and inconsistent nominal candidacy", () => {
    const input = request();
    expect(() =>
      evaluateWeeklyProspectiveLedger({ ...input, ledgerNdjson: input.ledgerNdjson + "\n" }),
    ).toThrow(/binding/);
    expect(() => evaluateWeeklyProspectiveLedger({ ...input, expectedRows: 2 })).toThrow(
      /population/,
    );
    expect(() =>
      evaluateWeeklyProspectiveLedger({ ...input, observationChecksum: hash("other") }),
    ).toThrow(/bytes/);
    expect(() =>
      evaluateWeeklyProspectiveLedger(request([candidate({ nominalCoverage: null })])),
    ).toThrow(/nominal/);
  });
});
