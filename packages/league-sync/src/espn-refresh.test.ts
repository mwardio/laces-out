import { describe, expect, it } from "vitest";

import {
  ESPN_FRESHNESS_POLICIES,
  advanceEspnArtifactFreshness,
  espnFreshnessContext,
  espnRefreshBucket,
  evaluateEspnRefresh,
  nextEspnDirectCircuitOpenUntil,
  relevantEspnArtifactFamilies,
} from "./espn-refresh.js";

const NOW = new Date("2026-10-04T17:00:00.000Z");

describe("ESPN refresh policy", () => {
  it("uses the planned active, near-lock, and offseason windows", () => {
    expect(ESPN_FRESHNESS_POLICIES.active).toEqual({
      staleAfterMs: 30 * 60_000,
      minimumRefreshIntervalMs: 15 * 60_000,
    });
    expect(ESPN_FRESHNESS_POLICIES["near-lock"]).toEqual({
      staleAfterMs: 15 * 60_000,
      minimumRefreshIntervalMs: 10 * 60_000,
    });
    expect(ESPN_FRESHNESS_POLICIES.offseason).toEqual({
      staleAfterMs: 6 * 60 * 60_000,
      minimumRefreshIntervalMs: 60 * 60_000,
    });
    expect(espnFreshnessContext({ seasonStatus: "active", hasActiveMatchup: true })).toBe(
      "near-lock",
    );
  });

  it("keeps core and supplemental freshness independent", () => {
    const evaluation = evaluateEspnRefresh({
      seasonStatus: "active",
      currentWeek: 4,
      hasActiveMatchup: false,
      artifactFreshness: {
        core: new Date(NOW.getTime() - 5 * 60_000),
        "available-players": new Date(NOW.getTime() - 31 * 60_000),
        "weekly-box-scores": new Date(NOW.getTime() - 10 * 60_000),
        transactions: new Date(NOW.getTime() - 10 * 60_000),
        "completed-draft": new Date(NOW.getTime() - 10 * 60_000),
      },
      now: NOW,
    });

    expect(evaluation.current).toBe(false);
    expect(evaluation.staleArtifacts).toEqual(["available-players"]);
  });

  it("advances available-player freshness only after both component feeds are current", () => {
    const freeAgentsAt = new Date("2026-10-04T16:55:00.000Z");
    const waiversAt = new Date("2026-10-04T16:56:00.000Z");
    const afterFreeAgents = advanceEspnArtifactFreshness({
      current: {},
      artifact: "available-players",
      availability: "free-agent",
      effectiveAt: freeAgentsAt,
    });
    expect(afterFreeAgents).toEqual({
      "available-free-agents": freeAgentsAt.toISOString(),
    });

    const afterWaivers = advanceEspnArtifactFreshness({
      current: afterFreeAgents,
      artifact: "available-players",
      availability: "waivers",
      effectiveAt: waiversAt,
    });
    expect(afterWaivers["available-players"]).toBe(freeAgentsAt.toISOString());

    const refreshedFreeAgents = advanceEspnArtifactFreshness({
      current: afterWaivers,
      artifact: "available-players",
      availability: "free-agent",
      effectiveAt: new Date("2026-10-04T16:57:00.000Z"),
    });
    expect(refreshedFreeAgents["available-players"]).toBe(waiversAt.toISOString());
    expect(() =>
      advanceEspnArtifactFreshness({
        current: {},
        artifact: "available-players",
        effectiveAt: NOW,
      }),
    ).toThrow(/availability scope/u);
  });

  it("does not treat absent inapplicable preseason supplements as stale", () => {
    expect(relevantEspnArtifactFamilies({ seasonStatus: "preseason", currentWeek: null })).toEqual([
      "core",
    ]);
    expect(
      evaluateEspnRefresh({
        seasonStatus: "preseason",
        currentWeek: null,
        hasActiveMatchup: false,
        artifactFreshness: { core: new Date(NOW.getTime() - 5 * 60_000) },
        now: NOW,
      }).current,
    ).toBe(true);
  });

  it("makes idempotency server-owned and stable inside a cooldown bucket", () => {
    const first = espnRefreshBucket({
      leagueSeasonId: "60000000-0000-4000-8000-000000000001",
      now: NOW,
      minimumRefreshIntervalMs: 15 * 60_000,
    });
    const second = espnRefreshBucket({
      leagueSeasonId: "60000000-0000-4000-8000-000000000001",
      now: new Date(NOW.getTime() + 30_000),
      minimumRefreshIntervalMs: 15 * 60_000,
    });
    expect(first).toBe(second);
    expect(first).not.toContain("user");
  });

  it("opens direct circuits after repeated failures or immediately after rate limiting", () => {
    expect(nextEspnDirectCircuitOpenUntil({ consecutiveFailures: 4, now: NOW })).toBeNull();
    expect(
      nextEspnDirectCircuitOpenUntil({ consecutiveFailures: 5, now: NOW })?.toISOString(),
    ).toBe("2026-10-04T17:05:00.000Z");
    expect(
      nextEspnDirectCircuitOpenUntil({
        consecutiveFailures: 1,
        now: NOW,
        rateLimited: true,
      })?.toISOString(),
    ).toBe("2026-10-04T17:05:00.000Z");
  });
});
