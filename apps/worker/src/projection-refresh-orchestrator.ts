import type { ProjectionRefreshJob } from "@laces-out/jobs";

import type { ProjectionRefreshService, WorkerJobContext } from "./jobs.js";
import type { ProjectionLockWindowState } from "./projection-lock-window.js";

interface BooleanRefreshService {
  refresh(force?: boolean): Promise<unknown>;
}

interface SeasonRefreshService {
  refresh(season: number, force?: boolean): Promise<unknown>;
}

interface WeeklyInputRefreshService {
  refreshWeeklyStats(season: number, force?: boolean): Promise<unknown>;
  refreshSnapCounts(season: number, force?: boolean): Promise<unknown>;
  refreshWeeklyRosters(season: number, force?: boolean): Promise<unknown>;
  refreshInjuries(season: number, force?: boolean): Promise<unknown>;
  refreshTeamWeeklyStats(season: number, force?: boolean): Promise<unknown>;
}

export interface ProjectionRefreshOrchestratorInput {
  readonly currentSeason: () => number;
  readonly lockWindow: {
    check(season: number): Promise<ProjectionLockWindowState>;
  };
  readonly catalog: BooleanRefreshService;
  readonly weeklyData: WeeklyInputRefreshService;
  readonly sleeperCatalog: {
    refreshCatalog(force?: boolean): Promise<unknown>;
  };
  readonly schedule: SeasonRefreshService;
  readonly weeklyProjections: ProjectionRefreshService;
  readonly enqueueRosProjections: (job: ProjectionRefreshJob) => Promise<unknown>;
}

/**
 * Keeps game-day freshness independent from the expensive ROS rail. A scheduled or on-demand job
 * refreshes both horizons; a lock-window job refreshes current inputs and weekly output only.
 */
export class ProjectionRefreshOrchestrator implements ProjectionRefreshService {
  readonly #input: ProjectionRefreshOrchestratorInput;

  constructor(input: ProjectionRefreshOrchestratorInput) {
    this.#input = input;
  }

  async refreshProjections(job: ProjectionRefreshJob, context: WorkerJobContext): Promise<void> {
    const effectiveJob =
      job.reason === "scheduled" || job.reason === "lock-window"
        ? { ...job, season: this.#input.currentSeason() }
        : job;
    const lockWindow =
      effectiveJob.reason === "lock-window"
        ? await this.#input.lockWindow.check(effectiveJob.season)
        : null;
    if (lockWindow !== null && !lockWindow.active) return;

    // The final near-lock pass bypasses conditional source clocks once, inside a bounded
    // ten-minute window. Other frequent cron ticks remain conditional and cheap.
    const forceCurrentInputs = lockWindow?.forceFinalCheck === true;

    // Refresh every current-season weekly input before forecasting. Each source owns a claim
    // window and conditional request, so overlapping/manual sweeps coalesce and unchanged
    // artifacts do not produce new immutable observations.
    await this.#input.catalog.refresh(forceCurrentInputs);
    await this.#input.weeklyData.refreshWeeklyStats(effectiveJob.season, forceCurrentInputs);
    await this.#input.weeklyData.refreshSnapCounts(effectiveJob.season, forceCurrentInputs);
    await this.#input.weeklyData.refreshWeeklyRosters(effectiveJob.season, forceCurrentInputs);
    await this.#input.weeklyData.refreshInjuries(effectiveJob.season, forceCurrentInputs);
    await this.#input.weeklyData.refreshTeamWeeklyStats(effectiveJob.season, forceCurrentInputs);
    await this.#input.sleeperCatalog.refreshCatalog(forceCurrentInputs);
    await this.#input.schedule.refresh(effectiveJob.season, forceCurrentInputs);
    await this.#input.weeklyProjections.refreshProjections(effectiveJob, context);

    // ROS is a shared, multi-hour universe simulation. It belongs to the nightly full run and
    // explicit on-demand runs, never to the frequent game-day lock window.
    const horizon =
      effectiveJob.reason === "lock-window" ? "weekly" : (effectiveJob.horizon ?? "full");
    if (horizon === "full") {
      await this.#input.enqueueRosProjections(effectiveJob);
    }
  }
}
