import { describe, expect, it } from "vitest";

import { recommendationRunInputsSchema } from "./recommendation-runs.js";

describe("recommendation run input compatibility", () => {
  it("decodes pre-v3 stored inputs without a source snapshot checksum", () => {
    const decoded = recommendationRunInputsSchema.parse({
      week: 2,
      scoringRulesChecksum: null,
      slotRulesChecksum: null,
      rosterSnapshotIds: [],
      projectionSetIds: [],
      marketSignalAsOf: null,
      availabilityAsOf: null,
      leagueLastSyncedAt: null,
      rosterEffectiveAt: null,
      freshness: { state: "missing", observedAt: null, label: "No projection set" },
    });

    expect(decoded.sourceSnapshotChecksum).toBeNull();
  });
});
