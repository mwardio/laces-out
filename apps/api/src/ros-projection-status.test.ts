import { describe, expect, it } from "vitest";

import { deriveRunAudit, type RosModelRunRow } from "./ros-projection-status.js";

function shadowRun(overrides: Partial<RosModelRunRow> = {}): RosModelRunRow {
  return {
    sourceSyncRunId: "20000000-0000-4000-8000-000000000001",
    qualityState: "degraded",
    season: 2026,
    windowStartWeek: 6,
    windowEndWeek: 18,
    asOfWeek: 5,
    asOfAt: new Date("2026-10-10T00:00:00.000Z"),
    playersEvaluated: 0,
    playersPublished: 0,
    inputChecksum: "c".repeat(64),
    configuration: { mode: "shadow" },
    metrics: {
      diagnostics: ["weekly_projection_window_incomplete", "shadow_publication_disabled"],
      gate: { cleared: false },
    },
    sourceAsOf: new Date("2026-10-09T00:00:00.000Z"),
    createdAt: new Date("2026-10-10T01:00:00.000Z"),
    ...overrides,
  };
}

describe("deriveRunAudit", () => {
  it("surfaces shadow diagnostics as reasons and never permits publication", () => {
    const audit = deriveRunAudit(shadowRun());
    expect(audit.mode).toBe("shadow");
    expect(audit.canPublish).toBe(false);
    expect(audit.reasons).toContain("shadow_publication_disabled");
    expect(audit.evidenceGate).toEqual({ cleared: false });
    expect(audit.asOfAt).toBe("2026-10-10T00:00:00.000Z");
  });

  it("reads withheld reasons from a release run and only publishes a populated release", () => {
    const audit = deriveRunAudit(
      shadowRun({
        qualityState: "publishable",
        playersPublished: 200,
        playersEvaluated: 200,
        configuration: { mode: "release" },
        metrics: { withheldReasons: ["ros_release_gate_withheld"], releasingBuckets: 3 },
      }),
    );
    expect(audit.mode).toBe("release");
    expect(audit.canPublish).toBe(true);
    expect(audit.reasons).toEqual(["ros_release_gate_withheld"]);
  });

  it("does not publish a release with zero published players", () => {
    const audit = deriveRunAudit(
      shadowRun({
        qualityState: "publishable",
        playersPublished: 0,
        configuration: { mode: "release" },
        metrics: {},
      }),
    );
    expect(audit.canPublish).toBe(false);
    expect(audit.reasons).toEqual([]);
  });
});
