import { describe, expect, it, vi } from "vitest";

import type { RecommendationJob } from "./jobs.js";
import { RecommendationRecomputeService } from "./recommendation-recompute-service.js";

const job: RecommendationJob = { leagueSeasonId: "league-season-1", kinds: ["lineup", "waiver"] };

function context(signal = new AbortController().signal) {
  return { jobId: "recommendation-recompute-test", signal } as const;
}

describe("RecommendationRecomputeService", () => {
  it("recomputes only the claimed teams of the affected league season", async () => {
    const recompute = vi.fn(() =>
      Promise.resolve({ leagueSeasonId: job.leagueSeasonId, runs: [], skipped: [] }),
    );
    const service = new RecommendationRecomputeService({
      listClaimedTeamIds: () => Promise.resolve(["team-1"]),
      recompute,
    });

    await service.recomputeRecommendations(job, context());

    expect(recompute).toHaveBeenCalledWith(
      expect.objectContaining({
        leagueSeasonId: "league-season-1",
        kinds: ["lineup", "waiver"],
        claimedTeamIds: ["team-1"],
      }),
    );
  });

  it("completes as a stated no-op when no team in the league season is claimed", async () => {
    const recompute = vi.fn(() => Promise.reject(new Error("must not be called")));
    const service = new RecommendationRecomputeService({
      listClaimedTeamIds: () => Promise.resolve([]),
      recompute,
    });

    await expect(service.recomputeRecommendations(job, context())).resolves.toBeUndefined();
    expect(recompute).not.toHaveBeenCalled();
  });

  it("does not start an aborted job", async () => {
    const controller = new AbortController();
    controller.abort();
    const listClaimedTeamIds = vi.fn(() => Promise.resolve(["team-1"]));
    const service = new RecommendationRecomputeService({
      listClaimedTeamIds,
      recompute: () => Promise.reject(new Error("must not be called")),
    });

    await expect(service.recomputeRecommendations(job, context(controller.signal))).rejects.toThrow(
      "aborted during shutdown",
    );
    expect(listClaimedTeamIds).not.toHaveBeenCalled();
  });

  it("passes the job's abort signal through so a shutdown stops between teams", async () => {
    const controller = new AbortController();
    const recompute = vi.fn(() =>
      Promise.resolve({ leagueSeasonId: job.leagueSeasonId, runs: [], skipped: [] }),
    );
    const service = new RecommendationRecomputeService({
      listClaimedTeamIds: () => Promise.resolve(["team-1"]),
      recompute,
    });

    await service.recomputeRecommendations(job, context(controller.signal));

    expect(recompute).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  });

  it("propagates a failure so pg-boss retries and finally dead-letters", async () => {
    const failure = new Error("projection read failed");
    const service = new RecommendationRecomputeService({
      listClaimedTeamIds: () => Promise.resolve(["team-1"]),
      recompute: () => Promise.reject(failure),
    });

    await expect(service.recomputeRecommendations(job, context())).rejects.toBe(failure);
  });

  it("rejects an unsupported kind by name rather than ignoring it", async () => {
    const service = new RecommendationRecomputeService({
      listClaimedTeamIds: () => Promise.resolve(["team-1"]),
      recompute: () => Promise.reject(new Error("Unsupported recommendation kind: draft")),
    });

    await expect(
      service.recomputeRecommendations(
        { leagueSeasonId: "league-season-1", kinds: ["draft"] },
        context(),
      ),
    ).rejects.toThrow("Unsupported recommendation kind: draft");
  });
});
