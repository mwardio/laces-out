import {
  projectionScoringProfileKey,
  rosScoringProfile,
  runFirstPartyProjectionBacktest,
  runFirstPartyTeamDefenseBacktest,
  type FirstPartyTeamDefenseWeeklyStatLine,
  type FirstPartyWeeklyStatLine,
  type ProjectionScoringProfile,
} from "@laces-out/projections";
import { describe, expect, it } from "vitest";

import {
  calibrateHistoricalRosAvailability,
  calibrateHistoricalRosKicker,
  calibrateHistoricalRosRole,
} from "./first-party-ros-backtest.js";
import {
  assembleFirstPartyRosDefenseCandidateInputs,
  buildFirstPartyRosPlayerCandidate,
  simulateFirstPartyRosCandidate,
} from "./first-party-ros-candidates.js";
import type { ProjectionScheduleFact } from "./first-party-projection-inputs.js";

const scoringProfile: ProjectionScoringProfile = {
  id: "test-live-ros-ppr",
  version: "1",
  rules: [
    { statId: "receptions", points: 1 },
    { statId: "receiving_yards", points: 0.1 },
    { statId: "receiving_touchdowns", points: 6 },
    { statId: "rushing_yards", points: 0.1 },
    { statId: "rushing_touchdowns", points: 6 },
  ],
};

const seasons = [2024, 2025, 2026] as const;
const teams = ["BUF", "MIA", "NYJ", "NEP"] as const;

function opponentOf(team: string): string {
  const index = teams.indexOf(team as (typeof teams)[number]);
  return teams[(index + 1) % teams.length]!;
}

function pseudo(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function buildHistory(): readonly FirstPartyWeeklyStatLine[] {
  const rows: FirstPartyWeeklyStatLine[] = [];
  for (const season of seasons) {
    const lastWeek = season === 2026 ? 6 : 16;
    for (let week = 1; week <= lastWeek; week += 1) {
      for (let playerIndex = 0; playerIndex < 16; playerIndex += 1) {
        const team = teams[playerIndex % teams.length]!;
        const noise = pseudo(season * 1000 + week * 37 + playerIndex);
        const targets = 6 + Math.round(noise * 6);
        const receptions = Math.max(1, Math.round(targets * (0.6 + noise * 0.2)));
        rows.push({
          playerId: `wr-${playerIndex}`,
          position: "WR",
          season,
          week,
          team,
          opponent: opponentOf(team),
          snapShare: 0.6 + noise * 0.3,
          targetShare: 0.15 + noise * 0.1,
          played: true,
          components: {
            targets,
            receptions,
            receiving_yards: 40 + Math.round(noise * 70),
            receiving_touchdowns: noise > 0.75 ? 1 : 0,
            rushing_yards: 0,
            rushing_touchdowns: 0,
          },
        });
      }
    }
  }
  return rows;
}

function buildSchedules(): readonly ProjectionScheduleFact[] {
  const schedules: ProjectionScheduleFact[] = [];
  for (const season of seasons) {
    const lastWeek = 18;
    for (let week = 1; week <= lastWeek; week += 1) {
      for (let pairIndex = 0; pairIndex < teams.length; pairIndex += 2) {
        const home = teams[pairIndex]!;
        const away = teams[pairIndex + 1]!;
        const completed = season < 2026 || week <= 6;
        schedules.push({
          season,
          week,
          gameId: `${season}-${week}-${home}`,
          homeTeam: home,
          awayTeam: away,
          awayScore: completed ? 20 : null,
          homeScore: completed ? 23 : null,
          kickoffAt: new Date(Date.UTC(season, 8, week)),
          status: completed ? "final" : "scheduled",
        });
      }
    }
  }
  return schedules;
}

describe("first-party live ROS candidate builder", () => {
  const history = buildHistory();
  const schedules = buildSchedules();
  const calibration = runFirstPartyProjectionBacktest(history).calibration;
  const availabilityCalibration = calibrateHistoricalRosAvailability(
    history,
    schedules,
    scoringProfile,
  );
  const roleCalibration = calibrateHistoricalRosRole(history, schedules, scoringProfile);
  const kickerCalibration = calibrateHistoricalRosKicker(history, schedules, scoringProfile);

  it("builds contextual and recency centers for the whole remaining window", () => {
    const candidate = buildFirstPartyRosPlayerCandidate({
      player: { playerId: "wr-0", position: "WR", team: "BUF" },
      window: { season: 2026, asOfWeek: 6, windowStartWeek: 7, windowEndWeek: 12 },
      featureHistory: history,
      calibration,
      availabilityCalibration,
      roleCalibration,
      kickerCalibration,
      injuries: [],
      schedules,
      scoringProfile,
      seed: "live:2026:6:wr-0",
      scenarioCount: 256,
    });
    expect(candidate).not.toBeNull();
    expect(candidate!.scheduledGames).toBe(6);
    expect(candidate!.coverage.contextual).toBe(1);
    expect(candidate!.coverage.recency).toBe(1);
    expect(candidate!.contextual.state).toBe("projected");
    expect(candidate!.recency.state).toBe("projected");
    expect(candidate!.bucket).toBe("five-to-eight");
    expect(candidate!.contextual.weekly).toHaveLength(6);
    expect(candidate!.scoringProfileKey).toBe(projectionScoringProfileKey(scoringProfile));
    expect(candidate!.inputChecksum).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("spans the full window, counting a missing team game as a bye rather than truncating", () => {
    // Drop BUF's Week 9 game so the window contains a genuine bye that must still be modelled.
    const withBye = schedules.filter(
      (game) =>
        !(
          game.season === 2026 &&
          game.week === 9 &&
          (game.homeTeam === "BUF" || game.awayTeam === "BUF")
        ),
    );
    const candidate = buildFirstPartyRosPlayerCandidate({
      player: { playerId: "wr-0", position: "WR", team: "BUF" },
      window: { season: 2026, asOfWeek: 6, windowStartWeek: 7, windowEndWeek: 12 },
      featureHistory: history,
      calibration,
      availabilityCalibration,
      roleCalibration,
      kickerCalibration,
      injuries: [],
      schedules: withBye,
      scoringProfile,
      seed: "live:2026:6:wr-0",
      scenarioCount: 256,
    });
    expect(candidate).not.toBeNull();
    expect(candidate!.contextual.weekly).toHaveLength(6);
    expect(candidate!.scheduledGames).toBe(5);
    const byeWeek = candidate!.contextual.weekly.find((week) => week.week === 9);
    expect(byeWeek).toMatchObject({ scheduled: false, bye: true, availabilityProbability: 0 });
  });

  it("builds and scores a complete D/ST remaining-season candidate", () => {
    const defenseHistory: FirstPartyTeamDefenseWeeklyStatLine[] = [];
    for (const season of seasons) {
      const lastWeek = season === 2026 ? 6 : 16;
      for (let week = 1; week <= lastWeek; week += 1) {
        for (const team of teams) {
          defenseHistory.push({
            team,
            season,
            week,
            opponent: opponentOf(team),
            components: {
              defensive_sacks: 2 + (week % 3),
              defensive_interceptions: week % 2,
              defensive_fumble_recoveries: (week + 1) % 2,
              defensive_safeties: 0,
              defensive_touchdowns: week % 7 === 0 ? 1 : 0,
              defensive_blocked_kicks: 0,
              special_teams_touchdowns: 0,
              points_allowed: 17 + (week % 10),
              yards_allowed: 290 + week * 3,
            },
          });
        }
      }
    }
    const defenseProfile = rosScoringProfile("espn-standard-2pt").profile;
    const assembled = assembleFirstPartyRosDefenseCandidateInputs({
      defense: { playerId: "DST:BUF", team: "BUF" },
      window: { season: 2026, asOfWeek: 6, windowStartWeek: 7, windowEndWeek: 12 },
      featureHistory: defenseHistory,
      calibration: runFirstPartyTeamDefenseBacktest(
        defenseHistory.filter((row) => row.season < 2026),
      ).calibration,
      schedules,
      scoringProfile: defenseProfile,
      seed: "live:2026:6:DST:BUF",
      scenarioCount: 256,
    });

    expect(assembled).not.toBeNull();
    const candidate = simulateFirstPartyRosCandidate(assembled!);
    expect(candidate.position).toBe("DST");
    expect(candidate.scheduledGames).toBe(6);
    expect(candidate.contextual.state).toBe("projected");
    expect(candidate.recency.state).toBe("projected");
    expect(candidate.contextual.meanPoints).toBeGreaterThan(0);
    expect(candidate.inputChecksum).toMatch(/^[a-f0-9]{64}$/u);
  });
});
