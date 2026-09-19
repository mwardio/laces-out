import { describe, expect, it } from "vitest";

import {
  rosProfileValidationIsTransient,
  rosProfileRecoveryDelayMs,
  rosProfileRecoveryMarker,
} from "./ros-profile-recovery-state.js";

describe("ROS replay recovery state", () => {
  it("uses 15-minute exponential cooldowns capped at six hours", () => {
    expect([1, 2, 3, 4, 5, 6, 20, Number.MAX_SAFE_INTEGER].map(rosProfileRecoveryDelayMs)).toEqual(
      [15, 30, 60, 120, 240, 360, 360, 360].map((minutes) => minutes * 60_000),
    );
  });

  it("keeps legacy markers valid while retaining explicit replay cycle identities", () => {
    const automaticRecovery = {
      version: "ready-corpus-replay-v1",
      corpusIdentity: "a".repeat(64),
      state: "attempted",
      requestedAt: "2026-09-18T12:00:00Z",
    };
    expect(rosProfileRecoveryMarker({ automaticRecovery })).toEqual(automaticRecovery);
    expect(
      rosProfileRecoveryMarker({ automaticRecovery: { ...automaticRecovery, recoveryAttempt: 2 } }),
    ).toMatchObject({ recoveryAttempt: 2 });
    for (const recoveryAttempt of [0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1])
      expect(
        rosProfileRecoveryMarker({ automaticRecovery: { ...automaticRecovery, recoveryAttempt } }),
      ).toBeUndefined();
  });
});

it("permits only named dependency failures to recover after shared evidence repair", () => {
  for (const dependency of ["bundle", "candidate", "previous", "training"])
    for (const reason of ["unconfigured", "missing", "corrupt", "incompatible"])
      expect(
        rosProfileValidationIsTransient({
          state: "failed",
          blockers: [`marginal_dependency_${dependency}_${reason}`],
        }),
      ).toBe(true);
  for (const blocker of [
    "marginal_dependency_other_missing",
    "marginal_dependency_previous_low_coverage",
    "marginal_portfolio_failed",
  ])
    expect(rosProfileValidationIsTransient({ state: "failed", blockers: [blocker] })).toBe(false);
});
