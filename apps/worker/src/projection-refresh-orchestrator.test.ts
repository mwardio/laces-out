import { describe, expect, it, vi } from "vitest";

import type { ProjectionLockWindowState } from "./projection-lock-window.js";
import { ProjectionRefreshOrchestrator } from "./projection-refresh-orchestrator.js";

const context = {
  jobId: "projection-job",
  signal: new AbortController().signal,
};

function harness(lockState: ProjectionLockWindowState) {
  const refreshCatalog = vi.fn(() => Promise.resolve());
  const refreshWeeklyStats = vi.fn(() => Promise.resolve());
  const refreshSnapCounts = vi.fn(() => Promise.resolve());
  const refreshWeeklyRosters = vi.fn(() => Promise.resolve());
  const refreshInjuries = vi.fn(() => Promise.resolve());
  const refreshTeamWeeklyStats = vi.fn(() => Promise.resolve());
  const refreshSleeperCatalog = vi.fn(() => Promise.resolve());
  const refreshSchedule = vi.fn(() => Promise.resolve());
  const refreshWeeklyProjections = vi.fn(() => Promise.resolve());
  const enqueueRosProjections = vi.fn(() => Promise.resolve());
  const checkLockWindow = vi.fn(() => Promise.resolve(lockState));
  const currentSeason = vi.fn(() => 2027);
  const service = new ProjectionRefreshOrchestrator({
    currentSeason,
    lockWindow: { check: checkLockWindow },
    catalog: { refresh: refreshCatalog },
    weeklyData: {
      refreshWeeklyStats,
      refreshSnapCounts,
      refreshWeeklyRosters,
      refreshInjuries,
      refreshTeamWeeklyStats,
    },
    sleeperCatalog: { refreshCatalog: refreshSleeperCatalog },
    schedule: { refresh: refreshSchedule },
    weeklyProjections: { refreshProjections: refreshWeeklyProjections },
    enqueueRosProjections,
  });
  return {
    service,
    currentSeason,
    checkLockWindow,
    refreshCatalog,
    refreshWeeklyStats,
    refreshSnapCounts,
    refreshWeeklyRosters,
    refreshInjuries,
    refreshTeamWeeklyStats,
    refreshSleeperCatalog,
    refreshSchedule,
    refreshWeeklyProjections,
    enqueueRosProjections,
  };
}

describe("projection refresh orchestration", () => {
  it("runs weekly and ROS horizons during the nightly full refresh", async () => {
    const input = harness({ active: false, forceFinalCheck: false, nextKickoffAt: null });

    await input.service.refreshProjections(
      { season: 2026, horizon: "full", reason: "scheduled" },
      context,
    );

    expect(input.currentSeason).toHaveBeenCalledOnce();
    expect(input.checkLockWindow).not.toHaveBeenCalled();
    expect(input.refreshCatalog).toHaveBeenCalledWith(false);
    expect(input.refreshWeeklyStats).toHaveBeenCalledWith(2027, false);
    expect(input.refreshSchedule).toHaveBeenCalledWith(2027, false);
    expect(input.refreshWeeklyProjections).toHaveBeenCalledWith(
      { season: 2027, horizon: "full", reason: "scheduled" },
      context,
    );
    expect(input.enqueueRosProjections).toHaveBeenCalledWith({
      season: 2027,
      horizon: "full",
      reason: "scheduled",
    });
    expect(input.enqueueRosProjections.mock.invocationCallOrder[0]).toBeGreaterThan(
      input.refreshWeeklyProjections.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("publishes fresh weekly projections near kickoff without running ROS", async () => {
    const input = harness({
      active: true,
      forceFinalCheck: false,
      nextKickoffAt: "2027-09-12T17:00:00.000Z",
    });

    await input.service.refreshProjections(
      { season: 2026, horizon: "weekly", reason: "lock-window" },
      context,
    );

    expect(input.checkLockWindow).toHaveBeenCalledWith(2027);
    expect(input.refreshCatalog).toHaveBeenCalledWith(false);
    expect(input.refreshWeeklyStats).toHaveBeenCalledWith(2027, false);
    expect(input.refreshSnapCounts).toHaveBeenCalledWith(2027, false);
    expect(input.refreshWeeklyRosters).toHaveBeenCalledWith(2027, false);
    expect(input.refreshInjuries).toHaveBeenCalledWith(2027, false);
    expect(input.refreshTeamWeeklyStats).toHaveBeenCalledWith(2027, false);
    expect(input.refreshSleeperCatalog).toHaveBeenCalledWith(false);
    expect(input.refreshSchedule).toHaveBeenCalledWith(2027, false);
    expect(input.refreshWeeklyProjections).toHaveBeenCalledOnce();
    expect(input.enqueueRosProjections).not.toHaveBeenCalled();
  });

  it("forces the final source checks but still keeps ROS off the lock path", async () => {
    const input = harness({
      active: true,
      forceFinalCheck: true,
      nextKickoffAt: "2027-09-12T17:00:00.000Z",
    });

    await input.service.refreshProjections(
      { season: 2026, horizon: "weekly", reason: "lock-window" },
      context,
    );

    expect(input.refreshCatalog).toHaveBeenCalledWith(true);
    expect(input.refreshWeeklyStats).toHaveBeenCalledWith(2027, true);
    expect(input.refreshSchedule).toHaveBeenCalledWith(2027, true);
    expect(input.enqueueRosProjections).not.toHaveBeenCalled();
  });

  it("does no source or model work outside an active lock window", async () => {
    const input = harness({
      active: false,
      forceFinalCheck: false,
      nextKickoffAt: "2027-09-12T20:00:00.000Z",
    });

    await input.service.refreshProjections(
      { season: 2026, horizon: "weekly", reason: "lock-window" },
      context,
    );

    expect(input.checkLockWindow).toHaveBeenCalledWith(2027);
    expect(input.refreshCatalog).not.toHaveBeenCalled();
    expect(input.refreshWeeklyProjections).not.toHaveBeenCalled();
    expect(input.enqueueRosProjections).not.toHaveBeenCalled();
  });
});
