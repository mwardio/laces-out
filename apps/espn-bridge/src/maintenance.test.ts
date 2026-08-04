import { describe, expect, it } from "vitest";

import {
  baselineSyncIntervalMs,
  defaultMaintenanceState,
  maintenancePlan,
  pollFailureBackoffUntil,
  validateAgentPollResponse,
  validateMaintenanceState,
} from "./maintenance.js";

const now = new Date("2026-09-13T16:00:00.000Z");
const request = {
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  externalLeagueId: "12345",
  season: 2026,
  minimumCaptureAt: "2026-09-13T15:59:00.000Z",
  expiresAt: "2026-09-14T15:59:00.000Z",
  requiredArtifacts: ["core", "transactions"] as const,
};

describe("ESPN bridge maintenance", () => {
  it("validates the bounded sync-agent poll contract", () => {
    expect(
      validateAgentPollResponse({
        schemaVersion: 1,
        generatedAt: now.toISOString(),
        pollAfterSeconds: 300,
        requests: [request],
      }).requests,
    ).toEqual([request]);
    expect(() =>
      validateAgentPollResponse({
        schemaVersion: 1,
        generatedAt: now.toISOString(),
        pollAfterSeconds: 5,
        requests: [request],
      }),
    ).toThrow(/metadata/u);
  });

  it("runs only authorized requested leagues and respects login backoff", () => {
    const poll = validateAgentPollResponse({
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      pollAfterSeconds: 300,
      requests: [
        request,
        { ...request, requestId: "223e4567-e89b-42d3-a456-426614174000", externalLeagueId: "999" },
      ],
    });
    expect(
      maintenancePlan({
        configuration: { automaticSync: true, leagueIds: ["12345"], season: 2026 },
        state: defaultMaintenanceState,
        poll,
        now,
      }),
    ).toEqual({ kind: "requested", requests: [request] });
    expect(
      maintenancePlan({
        configuration: { automaticSync: true, leagueIds: ["12345"], season: 2026 },
        state: {
          ...defaultMaintenanceState,
          leagueBackoffUntil: { "12345": "2026-09-13T16:30:00.000Z" },
          lastBaselineAt: now.toISOString(),
        },
        poll,
        now,
      }),
    ).toEqual({ kind: "none" });
  });

  it("falls back to the six-hour baseline without creating a hot loop", () => {
    expect(
      maintenancePlan({
        configuration: { automaticSync: true, leagueIds: ["12345"], season: 2026 },
        state: defaultMaintenanceState,
        poll: null,
        now,
      }),
    ).toEqual({ kind: "baseline", leagueIds: ["12345"] });
    expect(
      maintenancePlan({
        configuration: { automaticSync: true, leagueIds: ["12345"], season: 2026 },
        state: {
          ...defaultMaintenanceState,
          lastBaselineAt: new Date(now.getTime() - baselineSyncIntervalMs + 1).toISOString(),
        },
        poll: null,
        now,
      }),
    ).toEqual({ kind: "none" });
    expect(
      maintenancePlan({
        configuration: { automaticSync: true, leagueIds: ["12345"], season: 2026 },
        state: {
          ...defaultMaintenanceState,
          leagueBackoffUntil: { "12345": "2026-09-13T16:30:00.000Z" },
        },
        poll: null,
        now,
      }),
    ).toEqual({ kind: "none" });
  });

  it("fails closed on corrupt persisted state and caps poll backoff", () => {
    expect(validateMaintenanceState({ schemaVersion: 1, consecutivePollFailures: -1 })).toEqual(
      defaultMaintenanceState,
    );
    expect(Date.parse(pollFailureBackoffUntil(99, now)) - now.getTime()).toBe(60 * 60 * 1000);
  });
});
