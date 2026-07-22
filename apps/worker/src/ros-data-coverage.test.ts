import { describe, expect, it } from "vitest";

import {
  ROS_COVERAGE_POSITIONS,
  auditHistoricalRosCoverage,
  type RosHistoricalCoverageInput,
  type RosPlayerCoverageFact,
  type RosScheduleCoverageFact,
} from "./ros-data-coverage.js";

function completeSeason(
  season: number,
  weeks = 12,
): {
  players: RosPlayerCoverageFact[];
  schedules: RosScheduleCoverageFact[];
} {
  const players: RosPlayerCoverageFact[] = [];
  const schedules: RosScheduleCoverageFact[] = [];
  for (let week = 1; week <= weeks; week += 1) {
    schedules.push({ season, week, gameId: `${season}-${week}`, complete: true });
    for (const position of ROS_COVERAGE_POSITIONS) {
      const playerId = `${season}-${week}-${position}`;
      for (const dataset of [
        "weekly-stats",
        "weekly-rosters",
        "injuries",
        "snap-counts",
      ] as const) {
        players.push({ dataset, season, week, position, playerId });
      }
    }
  }
  return { players, schedules };
}

function passingInput(): RosHistoricalCoverageInput {
  const seasons = [2018, 2019, 2020, 2021, 2022, 2023];
  const artifacts = seasons.map((season) => completeSeason(season));
  return {
    seasons,
    heldOutSeasons: [2021, 2022, 2023],
    players: artifacts.flatMap((artifact) => artifact.players),
    schedules: artifacts.flatMap((artifact) => artifact.schedules),
  };
}

describe("historical ROS data coverage", () => {
  it("qualifies three fully held-out seasons and at least 30 chronological batches", () => {
    const report = auditHistoricalRosCoverage(passingInput());

    expect(report.state).toBe("qualified");
    expect(report.fullyHeldOutSeasons).toEqual([2021, 2022, 2023]);
    expect(report.completeAsOfBatches).toBe(33);
    expect(report.seasons[0]).toMatchObject({
      season: 2021,
      priorSeasons: [2018, 2019, 2020],
      eligibleAsOfWeeks: 11,
      completeAsOfWeeks: 11,
      fullyHeldOut: true,
    });
    expect(report.seasons[0]?.weeks[0]).toMatchObject({ targetWeek: 2, asOfWeek: 1 });
  });

  it("reports missingness by exact season, as-of week, and position", () => {
    const input = passingInput();
    const report = auditHistoricalRosCoverage({
      ...input,
      players: input.players.filter(
        (fact) =>
          !(
            fact.dataset === "snap-counts" &&
            fact.season === 2022 &&
            fact.week === 5 &&
            fact.position === "RB"
          ),
      ),
    });

    expect(report.state).toBe("insufficient");
    expect(report.fullyHeldOutSeasons).toEqual([2021, 2023]);
    const week = report.seasons
      .find((season) => season.season === 2022)
      ?.weeks.find((candidate) => candidate.targetWeek === 6);
    const runningBack = week?.positions.find((position) => position.position === "RB");
    expect(week).toMatchObject({ asOfWeek: 5, complete: false });
    expect(runningBack).toMatchObject({
      priorStatPlayers: 1,
      priorSnapPlayers: 0,
      snapMatchRate: 0,
      complete: false,
      reasons: ["missing_snaps", "snap_match_rate"],
    });
    expect(runningBack?.missingSnapPlayerIds).toEqual(["2022-5-RB"]);
  });

  it("does not let target-week rows satisfy prior-week feature coverage", () => {
    const input = passingInput();
    const report = auditHistoricalRosCoverage({
      ...input,
      players: input.players.filter(
        (fact) =>
          !(
            fact.dataset === "weekly-rosters" &&
            fact.season === 2021 &&
            fact.week === 2 &&
            fact.position === "WR"
          ),
      ),
    });

    const week = report.seasons[0]?.weeks.find((candidate) => candidate.targetWeek === 3);
    const receiver = week?.positions.find((position) => position.position === "WR");
    expect(receiver).toMatchObject({
      outcomePlayers: 1,
      priorRosterPlayers: 0,
      complete: false,
    });
    expect(receiver?.missingRosterPlayerIds).toEqual(["2021-2-WR"]);
  });

  it("treats injury rows as sparse signals while still requiring a weekly injury batch", () => {
    const input = passingInput();
    const report = auditHistoricalRosCoverage({
      ...input,
      players: input.players.filter(
        (fact) =>
          !(
            fact.dataset === "injuries" &&
            fact.season === 2021 &&
            fact.week === 4 &&
            fact.position === "TE"
          ),
      ),
    });

    const week = report.seasons[0]?.weeks.find((candidate) => candidate.targetWeek === 5);
    expect(week?.complete).toBe(true);
    expect(week?.injuryBatchRows).toBe(4);
    expect(week?.positions.find((position) => position.position === "TE")?.priorInjuryReports).toBe(
      0,
    );
  });

  it("does not count a nominal prior season when one required source is absent", () => {
    const input = passingInput();
    const report = auditHistoricalRosCoverage({
      ...input,
      players: input.players.filter(
        (fact) => !(fact.dataset === "injuries" && fact.season === 2020),
      ),
    });

    expect(report.seasons[0]?.priorSeasons).toEqual([2018, 2019]);
    expect(report.seasons[0]?.fullyHeldOut).toBe(false);
    expect(
      report.seasons[0]?.priorSeasonCoverage.find((season) => season.season === 2020),
    ).toMatchObject({ complete: false, missingDatasets: ["injuries"] });
  });

  it("rejects inputs beyond the bounded season and row limits", () => {
    const input = passingInput();
    expect(() =>
      auditHistoricalRosCoverage({
        ...input,
        seasons: Array.from({ length: 13 }, (_, index) => 2010 + index),
      }),
    ).toThrow("bounded to 12 seasons");
    expect(() =>
      auditHistoricalRosCoverage({
        ...input,
        thresholds: { maximumFacts: 10 },
      }),
    ).toThrow("bounded to 10 total facts");
  });
});
