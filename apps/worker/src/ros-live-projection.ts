import type { FirstPartyRosProjection, FirstPartyRosProjectionInput } from "@laces-out/projections";

/**
 * ROS publication consumes season uncertainty and per-week availability. It does not consume
 * weekly point distributions. Keeping this contract explicit lets persisted joint SEASON outcomes
 * reprice every supported additive league without inventing weekly scores or retaining huge unused
 * week-by-component matrices. Core simulations remain assignable to this narrower live contract.
 */
export type FirstPartyRosLiveProjection = Omit<FirstPartyRosProjection, "weekly"> & {
  readonly weekly: readonly Pick<
    FirstPartyRosProjection["weekly"][number],
    "week" | "scheduled" | "bye" | "availabilityProbability"
  >[];
};
export type FirstPartyRosLiveProjector = (
  input: FirstPartyRosProjectionInput,
) => FirstPartyRosLiveProjection;
