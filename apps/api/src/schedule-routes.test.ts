import { loadEnvironment } from "@fantasy/config";
import type { ScheduleByesResponse, ScheduleResponse } from "@fantasy/contracts";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";
import { defaultScheduleSeason } from "./schedule-routes.js";

function authService(): AuthService {
  const repository: AuthRepository = {
    findUserByEmail: () => Promise.resolve(undefined),
    createSession: () => Promise.resolve(),
    findSession: () => Promise.resolve(undefined),
    touchSession: () => Promise.resolve(),
    deleteSession: () => Promise.resolve(),
    deleteExpiredSessions: () => Promise.resolve(),
  };
  return new AuthService(repository);
}

const source: ScheduleResponse["source"] = {
  dataset: "schedule",
  state: "available",
  key: "nflverse.schedules.2025",
  name: "NFL schedule",
  attribution: "nflverse",
  attributionUrl: "https://github.com/nflverse/nflverse-data",
  fetchedAt: "2026-01-01T00:00:00.000Z",
  checksumSha256: "c".repeat(64),
  coveredWeeks: [1],
  coveredTeams: ["AAA", "BBB"],
  quality: { rowsRead: 1, rowsRejected: 0 },
  reason: null,
};

const scheduleResponse: ScheduleResponse = {
  generatedAt: "2026-07-25T00:00:00.000Z",
  filters: { season: 2025, week: 1, team: "AAA" },
  source,
  games: [
    {
      gameId: "2025_01_AAA_BBB",
      week: 1,
      gameDate: "2025-09-07",
      startTimeEastern: "13:00",
      timeTbd: false,
      kickoffAt: "2025-09-07T17:00:00.000Z",
      awayTeam: "AAA",
      homeTeam: "BBB",
      status: "final",
      neutralSite: false,
      awayScore: 20,
      homeScore: 27,
    },
  ],
  teams: [
    {
      team: "AAA",
      weeks: [
        {
          week: 1,
          state: "game",
          reason: null,
          opponent: "BBB",
          venue: "away",
          gameId: "2025_01_AAA_BBB",
          kickoffAt: "2025-09-07T17:00:00.000Z",
          timeTbd: false,
          status: "final",
          restDays: 7,
          teamScore: 20,
          opponentScore: 27,
        },
      ],
      bye: { status: "available", byeWeeks: [], reason: null },
    },
  ],
  definitions: {
    bye: "A bye is reported only inside affirmed coverage.",
    venue: "Venue is stored.",
  },
};

const byesResponse: ScheduleByesResponse = {
  generatedAt: "2026-07-25T00:00:00.000Z",
  season: 2025,
  source,
  byeWeeks: { AAA: 7 },
  withheld: [{ team: "BBB", reason: "The admitted schedule does not affirm coverage." }],
  definition: "A bye is reported only inside affirmed coverage.",
};

describe("Schedule routes", () => {
  it("serves the schedule publicly and forwards the parsed filters", async () => {
    const getSchedule = vi.fn(() => Promise.resolve(scheduleResponse));
    const getByeWeeks = vi.fn(() => Promise.resolve(byesResponse));
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authService(),
      schedule: { getSchedule, getByeWeeks },
    });

    const result = await app.inject({
      method: "GET",
      url: "/v1/schedule?season=2025&week=1&team=aaa",
    });
    expect(result.statusCode).toBe(200);
    expect(getSchedule).toHaveBeenCalledWith({ season: 2025, week: 1, team: "AAA" });
    await app.close();
  });

  it("serves the bye lookup for a season", async () => {
    const getSchedule = vi.fn(() => Promise.resolve(scheduleResponse));
    const getByeWeeks = vi.fn(() => Promise.resolve(byesResponse));
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authService(),
      schedule: { getSchedule, getByeWeeks },
    });

    const result = await app.inject({
      method: "GET",
      url: "/v1/schedule/byes?season=2025",
    });

    expect(result.statusCode).toBe(200);
    expect(getByeWeeks).toHaveBeenCalledWith(2025);
    expect(result.json()).toMatchObject({ byeWeeks: { AAA: 7 } });
    await app.close();
  });

  it("rejects a malformed team before calling the service", async () => {
    const getSchedule = vi.fn(() => Promise.resolve(scheduleResponse));
    const getByeWeeks = vi.fn(() => Promise.resolve(byesResponse));
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authService(),
      schedule: { getSchedule, getByeWeeks },
    });

    const result = await app.inject({
      method: "GET",
      url: "/v1/schedule?team=toolongforateam",
    });

    expect(result.statusCode).toBe(400);
    expect(getSchedule).not.toHaveBeenCalled();
    await app.close();
  });

  it("serves 503 when no schedule service is configured", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authService(),
    });

    const result = await app.inject({
      method: "GET",
      url: "/v1/schedule",
    });

    expect(result.statusCode).toBe(503);
    await app.close();
  });

  it("moves schedule research to the upcoming season in the schedule-release window", () => {
    expect(defaultScheduleSeason(new Date("2026-01-25T00:00:00.000Z"))).toBe(2025);
    expect(defaultScheduleSeason(new Date("2026-05-01T00:00:00.000Z"))).toBe(2026);
    expect(defaultScheduleSeason(new Date("2026-07-25T00:00:00.000Z"))).toBe(2026);
  });
});
