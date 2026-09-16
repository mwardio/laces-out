import { describe, expect, it } from "vitest";

import {
  buildPlayoffOddsInput,
  type PlayoffOddsMatchupRow,
  type PlayoffOddsTeamRow,
} from "./playoff-odds.js";

const teams: readonly PlayoffOddsTeamRow[] = [
  { teamId: "a", wins: 1, losses: 0, ties: 0, pointsFor: 110 },
  { teamId: "b", wins: 0, losses: 1, ties: 0, pointsFor: 99 },
];

const played: PlayoffOddsMatchupRow = {
  week: 1,
  status: "final",
  homeTeamId: "a",
  awayTeamId: "b",
  homeScore: 110,
  awayScore: 99,
};

const upcoming: PlayoffOddsMatchupRow = {
  week: 2,
  status: "scheduled",
  homeTeamId: "a",
  awayTeamId: "b",
  homeScore: null,
  awayScore: null,
};

describe("buildPlayoffOddsInput", () => {
  it("treats only unfinished matchups as remaining", () => {
    const input = buildPlayoffOddsInput({
      regularSeasonMatchupPeriods: 2,
      matchups: [played, upcoming],
      teams,
      playoffTeamCount: 1,
      seed: "league:1:week:2",
    });

    expect(input?.remainingMatchups).toEqual([{ week: 2, teamAId: "a", teamBId: "b" }]);
    expect(input?.seed).toBe("league:1:week:2");
    expect(input?.playoffTeamCount).toBe(1);
  });

  it("treats an in-progress matchup as remaining", () => {
    const input = buildPlayoffOddsInput({
      regularSeasonMatchupPeriods: 2,
      matchups: [played, { ...upcoming, status: "in-progress" }],
      teams,
      playoffTeamCount: 1,
      seed: "s",
    });

    expect(input?.remainingMatchups).toHaveLength(1);
  });

  it("withholds the simulation when the playoff team count is unknown", () => {
    const input = buildPlayoffOddsInput({
      regularSeasonMatchupPeriods: 2,
      matchups: [played, upcoming],
      teams,
      playoffTeamCount: null,
      seed: "s",
    });

    expect(input).toBeNull();
  });

  it("withholds the simulation when no matchups remain", () => {
    const input = buildPlayoffOddsInput({
      regularSeasonMatchupPeriods: 2,
      matchups: [played],
      teams,
      playoffTeamCount: 1,
      seed: "s",
    });

    expect(input).toBeNull();
  });

  it("withholds the simulation when a remaining matchup references an unknown team", () => {
    const input = buildPlayoffOddsInput({
      regularSeasonMatchupPeriods: 2,
      matchups: [{ ...upcoming, awayTeamId: "ghost" }],
      teams,
      playoffTeamCount: 1,
      seed: "s",
    });

    expect(input).toBeNull();
  });

  it("withholds the simulation when the playoff field cannot be seeded", () => {
    expect(
      buildPlayoffOddsInput({
        regularSeasonMatchupPeriods: 2,
        matchups: [upcoming],
        teams,
        playoffTeamCount: 0,
        seed: "s",
      }),
    ).toBeNull();
    expect(
      buildPlayoffOddsInput({
        regularSeasonMatchupPeriods: 2,
        matchups: [upcoming],
        teams,
        playoffTeamCount: 3,
        seed: "s",
      }),
    ).toBeNull();
    expect(
      buildPlayoffOddsInput({
        regularSeasonMatchupPeriods: 2,
        matchups: [upcoming],
        teams: [teams[0]!],
        playoffTeamCount: 1,
        seed: "s",
      }),
    ).toBeNull();
  });

  it("is deterministic under input reordering", () => {
    const later: PlayoffOddsMatchupRow = { ...upcoming, week: 3 };
    const first = buildPlayoffOddsInput({
      regularSeasonMatchupPeriods: 2,
      matchups: [upcoming, later, played],
      teams,
      playoffTeamCount: 1,
      seed: "s",
    });
    const reordered = buildPlayoffOddsInput({
      regularSeasonMatchupPeriods: 2,
      matchups: [played, later, upcoming],
      teams: [teams[1]!, teams[0]!],
      playoffTeamCount: 1,
      seed: "s",
    });

    expect(reordered).toEqual(first);
    expect(first?.remainingMatchups.map((matchup) => matchup.week)).toEqual([2]);
  });

  it("collapses a duplicated matchup row into one remaining game", () => {
    const input = buildPlayoffOddsInput({
      regularSeasonMatchupPeriods: 2,
      matchups: [played, upcoming, { ...upcoming }],
      teams,
      playoffTeamCount: 1,
      seed: "s",
    });

    expect(input?.remainingMatchups).toHaveLength(1);
  });
  it("excludes postseason games from qualification", () => {
    const input = buildPlayoffOddsInput({
      regularSeasonMatchupPeriods: 2,
      matchups: [played, upcoming, { ...upcoming, week: 3 }],
      teams,
      playoffTeamCount: 1,
      seed: "s",
    });
    expect(input?.remainingMatchups).toEqual([{ week: 2, teamAId: "a", teamBId: "b" }]);
  });

  it("withholds unknown and truncated regular-season schedules", () => {
    for (const end of [null, 3]) {
      expect(
        buildPlayoffOddsInput({
          regularSeasonMatchupPeriods: end,
          matchups: [played, upcoming],
          teams,
          playoffTeamCount: 1,
          seed: "s",
        }),
      ).toBeNull();
    }
  });

  it("withholds a week that omits a synchronized team", () => {
    expect(
      buildPlayoffOddsInput({
        regularSeasonMatchupPeriods: 2,
        matchups: [played, upcoming],
        teams: [...teams, { teamId: "c", wins: 0, losses: 0, ties: 0, pointsFor: 0 }],
        playoffTeamCount: 1,
        seed: "s",
      }),
    ).toBeNull();
  });

  it("does not silently discard a final matchup whose score is missing", () => {
    expect(
      buildPlayoffOddsInput({
        regularSeasonMatchupPeriods: 2,
        matchups: [{ ...played, homeScore: null }, upcoming],
        teams,
        playoffTeamCount: 1,
        seed: "s",
      }),
    ).toBeNull();
  });
});
