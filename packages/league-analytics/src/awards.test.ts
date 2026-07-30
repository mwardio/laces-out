import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  awardableWeeks,
  calculateWeeklyAwards,
  latestAwardableWeek,
  type CalculateWeeklyAwardsInput,
  type WeeklyAwardId,
  type WeeklyAwardsResult,
} from "./awards.js";
import type { LeagueWeekInput, WeeklyMatchupInput } from "./season.js";

const TEAMS = [
  { teamId: "A" },
  { teamId: "B" },
  { teamId: "C" },
  { teamId: "D" },
  { teamId: "E" },
  { teamId: "F" },
];

/**
 * Week 1: A 120 beats B 118, C 100 beats D 60, E 90 beats F 88. No lineup points.
 * Week 2: A 100 beats B 95, C 95 beats D 80, E 70 ties F 70. A, B and D report lineups.
 * Week 3: F has no score, so A's matchup never completes. B 105 beats C 100, D 99 beats E 60.
 */
const WEEKS: readonly LeagueWeekInput[] = [
  {
    week: 1,
    performances: [
      { teamId: "A", points: 120 },
      { teamId: "B", points: 118 },
      { teamId: "C", points: 100 },
      { teamId: "D", points: 60 },
      { teamId: "E", points: 90 },
      { teamId: "F", points: 88 },
    ],
    matchups: [
      { teamAId: "A", teamBId: "B" },
      { teamAId: "C", teamBId: "D" },
      { teamAId: "E", teamBId: "F" },
    ],
  },
  {
    week: 2,
    performances: [
      { teamId: "A", points: 100, actualLineupPoints: 100, optimalLineupPoints: 130 },
      { teamId: "B", points: 95, actualLineupPoints: 95, optimalLineupPoints: 100 },
      { teamId: "C", points: 95 },
      { teamId: "D", points: 80, actualLineupPoints: 80, optimalLineupPoints: 80 },
      { teamId: "E", points: 70 },
      { teamId: "F", points: 70 },
    ],
    matchups: [
      { teamAId: "A", teamBId: "B" },
      { teamAId: "C", teamBId: "D" },
      { teamAId: "E", teamBId: "F" },
    ],
  },
  {
    week: 3,
    performances: [
      { teamId: "A", points: 110 },
      { teamId: "B", points: 105 },
      { teamId: "C", points: 100 },
      { teamId: "D", points: 99 },
      { teamId: "E", points: 60 },
    ],
    matchups: [
      { teamAId: "A", teamBId: "F" },
      { teamAId: "B", teamBId: "C" },
      { teamAId: "D", teamBId: "E" },
    ],
  },
];

const ALL_AWARD_IDS: readonly WeeklyAwardId[] = [
  "bad-beat",
  "horseshoe",
  "bench-warmer",
  "beatdown",
  "photo-finish",
];

function awardsFor(week: number, overrides: Partial<CalculateWeeklyAwardsInput> = {}) {
  return calculateWeeklyAwards({ teams: TEAMS, weeks: WEEKS, week, ...overrides });
}

function award(result: WeeklyAwardsResult, id: WeeklyAwardId) {
  return result.awards.find((entry) => entry.id === id);
}

function withheld(result: WeeklyAwardsResult, id: WeeklyAwardId) {
  return result.withheld.find((entry) => entry.id === id);
}

function reasonCodes(result: WeeklyAwardsResult, id: WeeklyAwardId) {
  return withheld(result, id)?.reasons.map((reason) => reason.code) ?? [];
}

function reverseWeek(week: LeagueWeekInput): LeagueWeekInput {
  const matchups: WeeklyMatchupInput[] = [...(week.matchups ?? [])]
    .reverse()
    .map((matchup) => ({ teamAId: matchup.teamBId, teamBId: matchup.teamAId }));
  return week.matchups === undefined
    ? { week: week.week, performances: [...week.performances].reverse() }
    : { week: week.week, performances: [...week.performances].reverse(), matchups };
}

function reverseInput(input: CalculateWeeklyAwardsInput): CalculateWeeklyAwardsInput {
  return {
    ...input,
    teams: [...input.teams].reverse(),
    weeks: [...input.weeks].reverse().map(reverseWeek),
  };
}

describe("calculateWeeklyAwards", () => {
  it("names every award from one fully scored week", () => {
    const result = awardsFor(1);

    // All-play rates over six scored teams: A 1, B 0.8, C 0.6, E 0.4, F 0.2, D 0.
    expect(award(result, "bad-beat")).toMatchObject({
      teamId: "B",
      value: 0.8,
      unit: "percent",
      detail: {
        opponentTeamId: "A",
        teamPoints: 118,
        opponentPoints: 120,
        allPlayWins: 4,
        allPlayGames: 5,
      },
    });
    expect(award(result, "horseshoe")).toMatchObject({
      teamId: "E",
      value: 0.4,
      unit: "percent",
      detail: { opponentTeamId: "F", teamPoints: 90, opponentPoints: 88, allPlayWins: 2 },
    });
    expect(award(result, "beatdown")).toMatchObject({
      teamId: "C",
      value: 40,
      unit: "points",
      detail: { opponentTeamId: "D", teamPoints: 100, opponentPoints: 60 },
    });
    // A and E both won by two; the lexicographically smallest team ID breaks it.
    expect(award(result, "photo-finish")).toMatchObject({
      teamId: "A",
      value: 2,
      unit: "points",
      detail: { opponentTeamId: "B" },
    });
    expect(result.week).toBe(1);
  });

  it("returns one definition per award id and never loses an award", () => {
    const result = awardsFor(1);

    expect(result.definitions.map((definition) => definition.id)).toEqual(ALL_AWARD_IDS);
    expect(result.definitions.every((definition) => definition.definition.length > 20)).toBe(true);
    expect([...result.awards, ...result.withheld].map((entry) => entry.id).sort()).toEqual(
      [...ALL_AWARD_IDS].sort(),
    );
    expect(result.awards.every((entry) => entry.label.length > 0)).toBe(true);
    expect(award(result, "beatdown")?.definition).toBe(
      result.definitions.find((definition) => definition.id === "beatdown")?.definition,
    );
  });

  it("withholds Bench Warmer when no team reports lineup points", () => {
    const result = awardsFor(1);

    expect(award(result, "bench-warmer")).toBeUndefined();
    expect(reasonCodes(result, "bench-warmer")).toEqual(["LINEUP_POINTS_MISSING"]);
    expect(withheld(result, "bench-warmer")?.reasons[0]?.message).toContain("lineup points");
  });

  it("awards Bench Warmer the largest supplied optimal-minus-actual gap", () => {
    const result = awardsFor(2);

    expect(award(result, "bench-warmer")).toMatchObject({
      teamId: "A",
      value: 30,
      unit: "points",
      detail: { opponentTeamId: "B", teamPoints: 100, opponentPoints: 95 },
    });
  });

  it("ignores a team whose optimal lineup is below its actual lineup", () => {
    const result = calculateWeeklyAwards({
      teams: TEAMS,
      week: 4,
      weeks: [
        {
          week: 4,
          performances: [
            { teamId: "A", points: 100, actualLineupPoints: 100, optimalLineupPoints: 90 },
            { teamId: "B", points: 90, actualLineupPoints: 90, optimalLineupPoints: 95 },
          ],
        },
      ],
    });

    expect(award(result, "bench-warmer")).toMatchObject({ teamId: "B", value: 5 });
  });

  it("withholds Bench Warmer when every supplied lineup is inconsistent", () => {
    const result = calculateWeeklyAwards({
      teams: TEAMS,
      week: 4,
      weeks: [
        {
          week: 4,
          performances: [
            { teamId: "A", points: 100, actualLineupPoints: 100, optimalLineupPoints: 90 },
            { teamId: "B", points: 90 },
          ],
        },
      ],
    });

    expect(reasonCodes(result, "bench-warmer")).toEqual(["NO_QUALIFYING_TEAM"]);
  });

  it("withholds Photo Finish when the closest margin clears the threshold", () => {
    const result = awardsFor(2);

    expect(award(result, "photo-finish")).toBeUndefined();
    expect(reasonCodes(result, "photo-finish")).toEqual(["NO_QUALIFYING_TEAM"]);
    expect(withheld(result, "photo-finish")?.reasons[0]?.message).toContain("5 points");
    expect(award(result, "beatdown")).toMatchObject({ teamId: "C", value: 15 });
  });

  it("honors a caller-supplied Photo Finish threshold", () => {
    expect(award(awardsFor(2, { photoFinishThreshold: 5 }), "photo-finish")).toMatchObject({
      teamId: "A",
      value: 5,
    });
    expect(award(awardsFor(1, { photoFinishThreshold: 1 }), "photo-finish")).toBeUndefined();
  });

  it("keeps a tied matchup out of every award", () => {
    const result = awardsFor(2);
    const teamIds = result.awards.flatMap((entry) => [entry.teamId, entry.detail.opponentTeamId]);

    // E and F tied at 70, so neither is a winner, a loser, or a margin holder.
    expect(teamIds).not.toContain("E");
    expect(teamIds).not.toContain("F");
    expect(award(result, "bad-beat")).toMatchObject({ teamId: "B", value: 0.7 });
    expect(award(result, "horseshoe")).toMatchObject({ teamId: "C", value: 0.7 });
  });

  it("withholds every head-to-head award when the only matchup is a tie", () => {
    const result = calculateWeeklyAwards({
      teams: TEAMS,
      week: 4,
      weeks: [
        {
          week: 4,
          performances: [
            { teamId: "A", points: 100 },
            { teamId: "B", points: 100 },
          ],
          matchups: [{ teamAId: "A", teamBId: "B" }],
        },
      ],
    });

    expect(result.awards).toEqual([]);
    for (const id of ["bad-beat", "horseshoe", "beatdown", "photo-finish"] as const) {
      expect(reasonCodes(result, id)).toEqual(["NO_QUALIFYING_TEAM"]);
    }
  });

  it("treats scores inside the tie tolerance as a tie", () => {
    const week: LeagueWeekInput = {
      week: 4,
      performances: [
        { teamId: "A", points: 100 },
        { teamId: "B", points: 100.005 },
      ],
      matchups: [{ teamAId: "A", teamBId: "B" }],
    };

    expect(
      calculateWeeklyAwards({ teams: TEAMS, weeks: [week], week: 4, tieTolerance: 0.01 }).awards,
    ).toEqual([]);
    expect(
      calculateWeeklyAwards({ teams: TEAMS, weeks: [week], week: 4 }).awards.map(
        (entry) => entry.id,
      ),
    ).toEqual(["bad-beat", "horseshoe", "beatdown", "photo-finish"]);
  });

  it("excludes a matchup with a missing score without inferring a result", () => {
    const result = awardsFor(3);
    const teamIds = result.awards.flatMap((entry) => [entry.teamId, entry.detail.opponentTeamId]);

    // F has no week 3 score, so A versus F never completes; neither team places.
    expect(teamIds).not.toContain("F");
    expect(teamIds).not.toContain("A");
    expect(award(result, "bad-beat")).toMatchObject({
      teamId: "C",
      value: 0.5,
      detail: { opponentTeamId: "B", allPlayGames: 4 },
    });
    expect(award(result, "horseshoe")).toMatchObject({ teamId: "D", value: 0.25 });
    expect(award(result, "beatdown")).toMatchObject({ teamId: "D", value: 39 });
  });

  it("withholds head-to-head awards when no matchup has both scores", () => {
    const result = calculateWeeklyAwards({
      teams: TEAMS,
      week: 4,
      weeks: [
        {
          week: 4,
          performances: [{ teamId: "A", points: 100 }],
          matchups: [{ teamAId: "A", teamBId: "B" }],
        },
      ],
    });

    expect(reasonCodes(result, "beatdown")).toEqual(["SCORES_INCOMPLETE"]);
    expect(reasonCodes(result, "bad-beat")).toEqual(["SCORES_INCOMPLETE"]);
  });

  it("withholds head-to-head awards when the week carries no matchups", () => {
    const result = calculateWeeklyAwards({
      teams: TEAMS,
      week: 4,
      weeks: [
        {
          week: 4,
          performances: [
            { teamId: "A", points: 100 },
            { teamId: "B", points: 60 },
          ],
        },
      ],
    });

    expect(result.awards).toEqual([]);
    expect(reasonCodes(result, "horseshoe")).toEqual(["MATCHUPS_MISSING"]);
    expect(reasonCodes(result, "photo-finish")).toEqual(["MATCHUPS_MISSING"]);
    expect(reasonCodes(result, "bench-warmer")).toEqual(["LINEUP_POINTS_MISSING"]);
  });

  it("withholds every award for a week that is not supplied", () => {
    const result = awardsFor(9);

    expect(result.week).toBe(9);
    expect(result.awards).toEqual([]);
    expect(result.withheld.map((entry) => entry.id)).toEqual(ALL_AWARD_IDS);
    expect(result.withheld.every((entry) => entry.reasons[0]?.code === "WEEK_MISSING")).toBe(true);
    expect(result.definitions.map((definition) => definition.id)).toEqual(ALL_AWARD_IDS);
  });

  it("is independent of team, week, performance, and matchup ordering", () => {
    const input: CalculateWeeklyAwardsInput = { teams: TEAMS, weeks: WEEKS, week: 1 };

    expect(calculateWeeklyAwards(input)).toEqual(calculateWeeklyAwards(input));
    expect(calculateWeeklyAwards(reverseInput(input))).toEqual(calculateWeeklyAwards(input));
    expect(calculateWeeklyAwards(reverseInput({ ...input, week: 3 }))).toEqual(awardsFor(3));
  });

  it("rejects invalid input rather than guessing", () => {
    expect(() => awardsFor(0)).toThrow(/week must be a positive integer/u);
    expect(() => awardsFor(1, { photoFinishThreshold: -1 })).toThrow(
      /photoFinishThreshold must be greater than or equal to zero/u,
    );
    expect(() => awardsFor(1, { tieTolerance: -0.5 })).toThrow(/tieTolerance/u);
    expect(() => calculateWeeklyAwards({ teams: [], weeks: WEEKS, week: 1 })).toThrow(
      /At least one team/u,
    );
    expect(() =>
      calculateWeeklyAwards({
        teams: TEAMS,
        week: 1,
        weeks: [{ week: 1, performances: [{ teamId: "Z", points: 10 }] }],
      }),
    ).toThrow(/Unknown team Z/u);
  });
});

describe("latestAwardableWeek", () => {
  it("returns the most recent week that yields an award", () => {
    expect(latestAwardableWeek({ teams: TEAMS, weeks: WEEKS })).toBe(3);
  });

  it("skips later weeks that produce nothing", () => {
    const weeks: readonly LeagueWeekInput[] = [
      ...WEEKS,
      // Week 4 has scores but no schedule and no lineup points, so nothing is awardable.
      {
        week: 4,
        performances: [
          { teamId: "A", points: 100 },
          { teamId: "B", points: 90 },
        ],
      },
    ];

    expect(latestAwardableWeek({ teams: TEAMS, weeks })).toBe(3);
  });

  it("returns null when no week yields an award", () => {
    expect(
      latestAwardableWeek({
        teams: TEAMS,
        weeks: [
          {
            week: 1,
            performances: [
              { teamId: "A", points: 100 },
              { teamId: "B", points: 90 },
            ],
          },
        ],
      }),
    ).toBe(null);
    expect(latestAwardableWeek({ teams: TEAMS, weeks: [] })).toBe(null);
  });
});

describe("awardableWeeks", () => {
  it("lists every week that yields an award, ascending", () => {
    expect(awardableWeeks({ teams: TEAMS, weeks: WEEKS })).toEqual([1, 2, 3]);
  });

  it("omits weeks the evidence cannot award", () => {
    const weeks: readonly LeagueWeekInput[] = [
      // Week 1 has scores but no schedule and no lineup points, so nothing is awardable.
      {
        week: 1,
        performances: [
          { teamId: "A", points: 100 },
          { teamId: "B", points: 90 },
        ],
      },
      ...WEEKS.filter((week) => week.week !== 1),
    ];

    expect(awardableWeeks({ teams: TEAMS, weeks })).toEqual([2, 3]);
  });

  it("sorts unsorted input and never repeats a week", () => {
    const shuffled = [...WEEKS].reverse();
    expect(awardableWeeks({ teams: TEAMS, weeks: shuffled })).toEqual([1, 2, 3]);
  });

  it("rejects a duplicate week rather than awarding it twice", () => {
    expect(() => awardableWeeks({ teams: TEAMS, weeks: [...WEEKS, ...WEEKS.slice(0, 1)] })).toThrow(
      /weeks/u,
    );
  });

  it("is empty when no week yields an award", () => {
    expect(awardableWeeks({ teams: TEAMS, weeks: [] })).toEqual([]);
    expect(
      awardableWeeks({
        teams: TEAMS,
        weeks: [
          {
            week: 1,
            performances: [
              { teamId: "A", points: 100 },
              { teamId: "B", points: 90 },
            ],
          },
        ],
      }),
    ).toEqual([]);
  });

  it("agrees with latestAwardableWeek on its final entry", () => {
    const weeks = awardableWeeks({ teams: TEAMS, weeks: WEEKS });
    expect(latestAwardableWeek({ teams: TEAMS, weeks: WEEKS })).toBe(weeks.at(-1));
  });
});

interface GeneratedWeek {
  readonly present: readonly boolean[];
  readonly points: readonly number[];
  readonly lineupBonus: readonly (number | null)[];
  readonly rotation: number;
  readonly scheduled: boolean;
}

const leagueArbitrary = fc.integer({ min: 2, max: 6 }).chain((teamCount) => {
  const teamIds = Array.from({ length: teamCount }, (_, index) => `team-${index}`);
  const perTeam = { minLength: teamCount, maxLength: teamCount } as const;
  return fc.record({
    teamIds: fc.constant(teamIds),
    weeks: fc.array(
      fc.record({
        present: fc.array(fc.boolean(), perTeam),
        points: fc.array(fc.integer({ min: 0, max: 200 }), perTeam),
        lineupBonus: fc.array(fc.option(fc.integer({ min: -10, max: 40 })), perTeam),
        rotation: fc.integer({ min: 0, max: teamCount - 1 }),
        scheduled: fc.boolean(),
      }),
      { minLength: 1, maxLength: 3 },
    ),
  });
});

function buildLeague(league: {
  readonly teamIds: readonly string[];
  readonly weeks: readonly GeneratedWeek[];
}): Omit<CalculateWeeklyAwardsInput, "week"> {
  const weeks = league.weeks.map((generated, index): LeagueWeekInput => {
    const performances = league.teamIds.flatMap((teamId, teamIndex) => {
      if (generated.present[teamIndex] !== true) return [];
      const points = generated.points[teamIndex] ?? 0;
      const bonus = generated.lineupBonus[teamIndex] ?? null;
      return [
        bonus === null
          ? { teamId, points }
          : {
              teamId,
              points,
              actualLineupPoints: points,
              optimalLineupPoints: points + bonus,
            },
      ];
    });
    const rotated = [
      ...league.teamIds.slice(generated.rotation),
      ...league.teamIds.slice(0, generated.rotation),
    ];
    const matchups: WeeklyMatchupInput[] = [];
    for (let position = 0; position + 1 < rotated.length; position += 2) {
      const teamAId = rotated[position];
      const teamBId = rotated[position + 1];
      if (teamAId !== undefined && teamBId !== undefined) matchups.push({ teamAId, teamBId });
    }
    return generated.scheduled
      ? { week: index + 1, performances, matchups }
      : { week: index + 1, performances };
  });
  return { teams: league.teamIds.map((teamId) => ({ teamId })), weeks };
}

describe("weekly award properties", () => {
  it("only names teams that have a score in the awarded week, and ignores input order", () => {
    fc.assert(
      fc.property(leagueArbitrary, (league) => {
        const input = buildLeague(league);
        for (const week of input.weeks) {
          const scored = new Set(week.performances.map((performance) => performance.teamId));
          const result = calculateWeeklyAwards({ ...input, week: week.week });
          const reversed = calculateWeeklyAwards(reverseInput({ ...input, week: week.week }));

          expect(reversed).toEqual(result);
          expect([...result.awards, ...result.withheld].map((entry) => entry.id).sort()).toEqual(
            [...ALL_AWARD_IDS].sort(),
          );
          for (const entry of result.awards) {
            expect(scored.has(entry.teamId)).toBe(true);
            expect(entry.detail.opponentTeamId === null).toBe(entry.detail.opponentPoints === null);
            if (entry.detail.opponentTeamId !== null) {
              expect(scored.has(entry.detail.opponentTeamId)).toBe(true);
            }
            expect(Number.isFinite(entry.value)).toBe(true);
          }
        }
      }),
    );
  });

  it("keeps each award consistent with the result it claims", () => {
    fc.assert(
      fc.property(leagueArbitrary, (league) => {
        const input = buildLeague(league);
        for (const week of input.weeks) {
          const result = calculateWeeklyAwards({ ...input, week: week.week });
          const badBeat = award(result, "bad-beat");
          const horseshoe = award(result, "horseshoe");
          const beatdown = award(result, "beatdown");
          const photoFinish = award(result, "photo-finish");
          const benchWarmer = award(result, "bench-warmer");

          // A Bad Beat team really lost; a Horseshoe team really won.
          if (badBeat) {
            expect(badBeat.detail.opponentPoints).not.toBeNull();
            expect(badBeat.detail.opponentPoints ?? 0).toBeGreaterThan(
              badBeat.detail.teamPoints ?? 0,
            );
          }
          if (horseshoe) {
            expect(horseshoe.detail.opponentPoints).not.toBeNull();
            expect(horseshoe.detail.teamPoints ?? 0).toBeGreaterThan(
              horseshoe.detail.opponentPoints ?? 0,
            );
          }
          for (const entry of [beatdown, photoFinish]) {
            if (!entry) continue;
            expect(entry.value).toBeCloseTo(
              (entry.detail.teamPoints ?? 0) - (entry.detail.opponentPoints ?? 0),
            );
            expect(entry.value).toBeGreaterThan(0);
          }
          if (beatdown && photoFinish) {
            expect(beatdown.value).toBeGreaterThanOrEqual(photoFinish.value);
            expect(photoFinish.value).toBeLessThanOrEqual(3);
          }
          if (benchWarmer) expect(benchWarmer.value).toBeGreaterThanOrEqual(0);
          const latest = latestAwardableWeek(input);
          if (result.awards.length > 0) expect(latest ?? 0).toBeGreaterThanOrEqual(week.week);
        }
      }),
    );
  });
});
