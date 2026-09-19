// A standalone entry keeps CPU-heavy replay outside the queue worker event loop.
// Only a closed dependency diagnostic crosses stdout on failure; arbitrary errors stay stderr.
import { RosHistoricalOutcomeReplayError } from "./ros-historical-outcome-replay.js";

try {
  await import("../scripts/validate-first-party-ros.js");
} catch (error) {
  const reason =
    error instanceof RosHistoricalOutcomeReplayError
      ? error.code === "outcome_evidence_not_ready"
        ? "missing"
        : error.code === "outcome_evidence_corrupt"
          ? "corrupt"
          : "incompatible"
      : error instanceof Error && error.message === "ROS historical corpus is missing"
        ? "missing"
        : error instanceof Error && error.message === "ROS historical corpus is corrupt"
          ? "corrupt"
          : undefined;
  if (reason === undefined) throw error;
  process.stdout.write(
    `${JSON.stringify({ state: "ros-replay-dependency-unavailable-v1", reason })}\n`,
  );
  process.exitCode = 1;
}
