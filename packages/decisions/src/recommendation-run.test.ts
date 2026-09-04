import { describe, expect, it } from "vitest";

import {
  RECOMMENDATION_ALGORITHM_VERSION,
  recommendationInputChecksum,
  recommendationRunProvenance,
  type RecommendationRunChecksumInput,
} from "./recommendation-run.js";

const base: RecommendationRunChecksumInput = {
  algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
  leagueSeasonId: "league-season-1",
  fantasyTeamId: "team-1",
  kind: "lineup",
  week: 3,
  scoringRulesChecksum: "scoring-1",
  slotRulesChecksum: "slots-1",
  rosterSnapshotIds: ["snapshot-b", "snapshot-a"],
  projectionSetIds: ["set-2", "set-1"],
  marketSignalAsOf: "2026-09-10T11:00:00.000Z",
  availabilityAsOf: null,
};

describe("recommendationInputChecksum", () => {
  it("is stable across equivalent input ordering", () => {
    expect(recommendationInputChecksum(base)).toBe(
      recommendationInputChecksum({
        ...base,
        rosterSnapshotIds: ["snapshot-a", "snapshot-b"],
        projectionSetIds: ["set-1", "set-2"],
      }),
    );
  });

  it("changes when any material input changes", () => {
    const reference = recommendationInputChecksum(base);
    expect(recommendationInputChecksum({ ...base, week: 4 })).not.toBe(reference);
    expect(recommendationInputChecksum({ ...base, scoringRulesChecksum: "scoring-2" })).not.toBe(
      reference,
    );
    expect(recommendationInputChecksum({ ...base, slotRulesChecksum: "slots-2" })).not.toBe(
      reference,
    );
    expect(recommendationInputChecksum({ ...base, projectionSetIds: ["set-3"] })).not.toBe(
      reference,
    );
    expect(recommendationInputChecksum({ ...base, rosterSnapshotIds: ["snapshot-c"] })).not.toBe(
      reference,
    );
    expect(recommendationInputChecksum({ ...base, fantasyTeamId: "team-2" })).not.toBe(reference);
    expect(recommendationInputChecksum({ ...base, kind: "waiver" })).not.toBe(reference);
    expect(recommendationInputChecksum({ ...base, marketSignalAsOf: null })).not.toBe(reference);
    expect(
      recommendationInputChecksum({ ...base, availabilityAsOf: "2026-09-10T10:00:00.000Z" }),
    ).not.toBe(reference);
  });

  it("changes when the algorithm version changes so an upgrade cannot replay a stale run", () => {
    expect(
      recommendationInputChecksum({ ...base, algorithmVersion: "in-season-decisions-v1" }),
    ).not.toBe(recommendationInputChecksum(base));
  });

  it("does not collide when a field boundary shifts between two id lists", () => {
    // A naive join would let ["a","b"] + ["c"] and ["a"] + ["b","c"] hash identically.
    expect(
      recommendationInputChecksum({
        ...base,
        rosterSnapshotIds: ["a", "b"],
        projectionSetIds: ["c"],
      }),
    ).not.toBe(
      recommendationInputChecksum({
        ...base,
        rosterSnapshotIds: ["a"],
        projectionSetIds: ["b", "c"],
      }),
    );
  });

  it("emits a hex sha-256 digest", () => {
    expect(recommendationInputChecksum(base)).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("recommendationRunProvenance", () => {
  const freshness = {
    state: "fresh",
    observedAt: "2026-09-10T11:00:00.000Z",
    label: "1h",
  } as const;

  it("assembles the ADR 0003 quartet from the same inputs the checksum covers", () => {
    const provenance = recommendationRunProvenance({
      checksumInput: base,
      leagueLastSyncedAt: "2026-09-10T11:30:00.000Z",
      rosterEffectiveAt: "2026-09-10T11:00:00.000Z",
      projectionFreshness: freshness,
      warnings: ["PRIVATE_PROJECTION_SETS_EXCLUDED"],
    });

    expect(provenance).toMatchObject({
      algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
      inputChecksum: recommendationInputChecksum(base),
      warnings: ["PRIVATE_PROJECTION_SETS_EXCLUDED"],
    });
    expect(provenance.inputs).toMatchObject({
      week: 3,
      projectionSetIds: ["set-1", "set-2"],
      rosterSnapshotIds: ["snapshot-a", "snapshot-b"],
      freshness,
      leagueLastSyncedAt: "2026-09-10T11:30:00.000Z",
      rosterEffectiveAt: "2026-09-10T11:00:00.000Z",
    });
  });

  it("leaves the random seed null because the engines are deterministic", () => {
    // ADR 0003 requires an explicit seed for a stochastic algorithm. Lineup, waiver, and trade are
    // deterministic, so an invented seed would be misleading provenance rather than reproducibility.
    expect(
      recommendationRunProvenance({
        checksumInput: base,
        leagueLastSyncedAt: null,
        rosterEffectiveAt: null,
        projectionFreshness: freshness,
        warnings: [],
      }).randomSeed,
    ).toBeNull();
  });

  it("records the persisted inputs in a canonically ordered bundle", () => {
    const first = recommendationRunProvenance({
      checksumInput: base,
      leagueLastSyncedAt: null,
      rosterEffectiveAt: null,
      projectionFreshness: freshness,
      warnings: [],
    });
    const second = recommendationRunProvenance({
      checksumInput: {
        ...base,
        rosterSnapshotIds: ["snapshot-a", "snapshot-b"],
        projectionSetIds: ["set-1", "set-2"],
      },
      leagueLastSyncedAt: null,
      rosterEffectiveAt: null,
      projectionFreshness: freshness,
      warnings: [],
    });

    expect(JSON.stringify(first.inputs)).toBe(JSON.stringify(second.inputs));
  });
});
