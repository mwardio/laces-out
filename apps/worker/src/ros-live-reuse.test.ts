import {
  projectFirstPartyRestOfSeason,
  projectFirstPartyRestOfSeasonProfiles,
  type ProjectionScoringProfile,
} from "@laces-out/projections";
import { describe, expect, it, vi } from "vitest";

import { historicalOutcomeInputFixture } from "./ros-historical-outcome.test-fixtures.js";
import { createRosLiveProjectionReuse } from "./ros-live-reuse.js";
import { diagnoseBoundedFirstPartyRosConvergence } from "./first-party-ros-candidates.js";

describe("live shared football simulations", () => {
  it("simulates once across leagues and keeps scoring, seeds and path counts correctly scoped", () => {
    const ppr = historicalOutcomeInputFixture({ scenarioCount: 128 });
    const half: ProjectionScoringProfile = {
      id: "half",
      rules: ppr.scoringProfile.rules.map((rule) => ({
        ...rule,
        points: rule.statId === "receptions" ? 0.5 : rule.points,
      })),
    };
    const simulate = vi.fn(projectFirstPartyRestOfSeasonProfiles);
    const project = createRosLiveProjectionReuse({
      profiles: [ppr.scoringProfile, half],
      simulate,
    });
    const first = project(ppr);
    const second = project({ ...ppr, scoringProfile: half });
    expect(first).toEqual(projectFirstPartyRestOfSeason(ppr));
    expect(second).toEqual(projectFirstPartyRestOfSeason({ ...ppr, scoringProfile: half }));
    expect(first.expectedComponents).toEqual(second.expectedComponents);
    expect(simulate).toHaveBeenCalledTimes(1);
    project({ ...ppr, seed: "different-physical-paths" });
    project({ ...ppr, scenarioCount: 256 });
    expect(simulate).toHaveBeenCalledTimes(3);
    // A publication calibration or caller mutation cannot contaminate the retained raw result.
    (first as { meanPoints: number }).meanPoints = 999;
    expect(project(ppr).meanPoints).not.toBe(999);
  });

  it("honors its memory bound and rejects a profile absent from the pinned snapshot", () => {
    const input = historicalOutcomeInputFixture({ scenarioCount: 128 });
    const simulate = vi.fn(projectFirstPartyRestOfSeasonProfiles);
    const project = createRosLiveProjectionReuse({
      profiles: [input.scoringProfile],
      maximumBytes: 0,
      simulate,
    });
    project(input);
    project(input);
    expect(simulate).toHaveBeenCalledTimes(2);
    expect(() =>
      project({
        ...input,
        scoringProfile: { id: "unseen", rules: [{ statId: "receptions", points: 2 }] },
      }),
    ).toThrow("not pinned");
  });

  it.each(["seed", "profile", "cutoff"])(
    "rejects a reused convergence projection with different %s",
    (part) => {
      const input = historicalOutcomeInputFixture({ scenarioCount: 128 });
      const releaseProjection = projectFirstPartyRestOfSeason(input);
      const changed = {
        ...input,
        ...(part === "seed" ? { seed: "foreign" } : {}),
        ...(part === "cutoff" ? { asOfAt: "2026-10-01T12:01:00.000Z" } : {}),
        ...(part === "profile"
          ? { scoringProfile: { id: "foreign", rules: [{ statId: "receptions", points: 0.5 }] } }
          : {}),
      };
      expect(() =>
        diagnoseBoundedFirstPartyRosConvergence({
          projectionInput: changed,
          releaseProjection,
          releaseScenarioCount: 128,
          referenceScenarioCount: 256,
        }),
      ).toThrow("does not match");
    },
  );
});
