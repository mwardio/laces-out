import { loadEnvironment } from "@fantasy/config";
import type { ScheduleByesResponse, ScheduleResponse } from "@fantasy/contracts";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { AuthService, type AuthRepository } from "./auth.js";
import { defaultScheduleSeason } from "./schedule-routes.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_TOKEN = "s".repeat(32);
const COOKIE = `fantasy_session=${SESSION_TOKEN}`;

function authenticatedService(): AuthService {
  const repository: AuthRepository = {
    findUserByEmail: () => Promise.resolve(undefined),
    createSession: () => Promise.resolve(),
    findSession: () =>
      Promise.resolve({
        user: {
          id: USER_ID,
          email: "guru@example.com",
          displayName: "League Guru",
          role: "member",
        },
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        lastSeenAt: new Date(),
      }),
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
  it("requires authentication and forwards the parsed filters", async () => {
    const getSchedule = vi.fn(() => Promise.resolve(scheduleResponse));
    const getByeWeeks = vi.fn(() => Promise.resolve(byesResponse));
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      schedule: { getSchedule, getByeWeeks },
    });

    const denied = await app.inject({ method: "GET", url: "/v1/schedule?season=2025" });
    expect(denied.statusCode).toBe(401);
    expect(getSchedule).not.toHaveBeenCalled();

    const allowed = await app.inject({
      method: "GET",
      url: "/v1/schedule?season=2025&week=1&team=aaa",
      headers: { cookie: COOKIE },
    });
    expect(allowed.statusCode).toBe(200);
    expect(getSchedule).toHaveBeenCalledWith(USER_ID, { season: 2025, week: 1, team: "AAA" });
    await app.close();
  });

  it("serves the bye lookup for a season", async () => {
    const getSchedule = vi.fn(() => Promise.resolve(scheduleResponse));
    const getByeWeeks = vi.fn(() => Promise.resolve(byesResponse));
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      logger: false,
      requireAuthentication: true,
      authService: authenticatedService(),
      schedule: { getSchedule, getByeWeeks },
    });

    const result = await app.inject({
      method: "GET",
      url: "/v1/schedule/byes?season=2025",
      headers: { cookie: COOKIE },
    });

    expect(result.statusCode).toBe(200);
    expect(getByeWeeks).toHaveBeenCalledWith(USER_ID, 2025);
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
      authService: authenticatedService(),
      schedule: { getSchedule, getByeWeeks },
    });

    const result = await app.inject({
      method: "GET",
      url: "/v1/schedule?team=toolongforateam",
      headers: { cookie: COOKIE },
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
      authService: authenticatedService(),
    });

    const result = await app.inject({
      method: "GET",
      url: "/v1/schedule",
      headers: { cookie: COOKIE },
    });

    expect(result.statusCode).toBe(503);
    await app.close();
  });

  it("defaults to the most recently completed season before September", () => {
    expect(defaultScheduleSeason(new Date("2026-07-25T00:00:00.000Z"))).toBe(2025);
    expect(defaultScheduleSeason(new Date("2026-09-10T00:00:00.000Z"))).toBe(2026);
  });
});
