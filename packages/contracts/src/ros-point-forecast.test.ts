import { describe, expect, it } from "vitest";
import {
  projectionPlayerListResponseSchema,
  projectionSetSummarySchema,
  projectionPlayerRosSummarySchema,
  projectionPlayerRowSchema,
} from "./index.js";
const summary = {
  windowStartWeek: 15,
  windowEndWeek: 18,
  asOfWeek: 14,
  asOfAt: "2026-09-20T12:00:00.000Z",
  scheduledGames: 4,
  expectedGames: 3.5,
  meanPointsPerExpectedGame: 10,
  medianPoints: 35,
  pointsStddev: 8,
};
const row = {
  playerId: "00000000-0000-4000-8000-000000000001",
  fullName: "Sample player",
  nflTeam: "DAL",
  primaryPosition: "WR",
  eligiblePositions: ["WR"],
  status: null,
  overallRank: 1,
  positionRank: 1,
  meanPoints: 35,
  floorPoints: null,
  ceilingPoints: null,
  confidence: null,
  ros: { ...summary, forecastKind: "point-only", medianPoints: null, pointsStddev: null },
};
const set = {
  id: row.playerId,
  leagueSeasonId: row.playerId,
  creatorUserId: null,
  creatorDisplayName: null,
  origin: "laces-out",
  managed: {
    rosForecastKind: "point-only",
    rosInterval: null,
    modelVersion: "v13",
    computedAt: summary.asOfAt,
    inputCheckedAt: summary.asOfAt,
    trainingCutoff: null,
    statsThrough: null,
    qualityState: "publishable",
    championByPosition: [],
    coverage: null,
    warnings: [],
    backtest: null,
  },
  visibility: "league",
  sourceLabel: "Expected ROS points",
  sourceFileName: null,
  season: 2026,
  week: null,
  horizon: "rest-of-season",
  playerCount: 1,
  inputChecksum: `sha256:${"a".repeat(64)}`,
  sourceChecksum: `sha256:${"b".repeat(64)}`,
  sourceObservedAt: summary.asOfAt,
  sourceObservedAtStatus: "verified",
  importedAt: summary.asOfAt,
  isOwnedByCurrentUser: false,
};
describe("explicit point ROS wire contract", () => {
  it("requires consistent point metadata and row population", () => {
    expect(
      projectionPlayerListResponseSchema.safeParse({ projectionSet: set, players: [row] }).success,
    ).toBe(true);
    expect(
      projectionPlayerListResponseSchema.safeParse({
        projectionSet: set,
        players: [{ ...row, ros: summary }],
      }).success,
    ).toBe(false);
    expect(
      projectionPlayerListResponseSchema.safeParse({
        projectionSet: { ...set, managed: { ...set.managed, rosForecastKind: null } },
        players: [row],
      }).success,
    ).toBe(false);
  });
  it("rejects calibrated interval claims and weekly scope on point metadata", () => {
    const interval = {
      kind: "legacy-block-cqr",
      method: "season-blocked-split-conformal-cqr-v1",
      quantiles: [0.15, 0.5, 0.85],
      evidenceInterpretation: "historical-descriptive",
      evidenceChecksum: "a".repeat(64),
    };
    expect(
      projectionSetSummarySchema.safeParse({
        ...set,
        managed: { ...set.managed, rosInterval: interval },
      }).success,
    ).toBe(false);
    expect(
      projectionSetSummarySchema.safeParse({ ...set, horizon: "week", week: 15 }).success,
    ).toBe(false);
  });
  it("retains old distribution payloads and permits explicit point-only nulls", () => {
    expect(projectionPlayerRosSummarySchema.safeParse(summary).success).toBe(true);
    expect(projectionPlayerRowSchema.safeParse(row).success).toBe(true);
  });
  it("rejects absent distribution statistics without an explicit point kind", () => {
    expect(
      projectionPlayerRosSummarySchema.safeParse({
        ...summary,
        medianPoints: null,
        pointsStddev: null,
      }).success,
    ).toBe(false);
    expect(
      projectionPlayerRosSummarySchema.safeParse({
        ...row.ros,
        forecastKind: "calibrated-distribution",
      }).success,
    ).toBe(false);
  });
  it.each(["medianPoints", "pointsStddev"])("rejects point-only %s", (field) => {
    expect(projectionPlayerRosSummarySchema.safeParse({ ...row.ros, [field]: 0 }).success).toBe(
      false,
    );
  });
  it.each(["floorPoints", "ceilingPoints"])("rejects point-only %s", (field) => {
    expect(projectionPlayerRowSchema.safeParse({ ...row, [field]: 35 }).success).toBe(false);
  });
});
