import { describe, expect, it, vi } from "vitest";

import {
  recomputeLeagueRecommendations,
  type RecommendationRunInsert,
  type RecommendationRunWriter,
} from "./league-recommendation-recompute.js";
import type { RecommendationRunIdentity } from "./recommendation-run.js";

/** Mirrors the recommendation_runs_identity_unique index the real ledger relies on. */
function memoryWriter(): RecommendationRunWriter & {
  readonly inserts: RecommendationRunIdentity[];
} {
  const seen = new Map<string, string>();
  const inserts: RecommendationRunIdentity[] = [];
  const key = (identity: RecommendationRunIdentity) =>
    [
      identity.leagueSeasonId,
      identity.fantasyTeamId,
      identity.kind,
      identity.algorithmVersion,
      identity.inputChecksum,
    ].join("|");
  return {
    inserts,
    findRun: (identity) => {
      const runId = seen.get(key(identity));
      return Promise.resolve(runId ? { runId } : undefined);
    },
    insertRun: (input: RecommendationRunInsert) => {
      const existing = seen.get(key(input.identity));
      if (existing) return Promise.resolve({ runId: existing, inserted: false });
      const runId = `run-${seen.size + 1}`;
      seen.set(key(input.identity), runId);
      inserts.push(input.identity);
      return Promise.resolve({ runId, inserted: true });
    },
  };
}

const leagueSeasonId = "league-season-1";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    week: 3,
    scoringRulesChecksum: "scoring-1",
    slotRulesChecksum: "slots-1",
    rosterSnapshotIds: ["snapshot-1"],
    projectionSetIds: ["set-1"],
    marketSignalAsOf: "2026-09-10T11:00:00.000Z",
    availabilityAsOf: null,
    leagueLastSyncedAt: "2026-09-10T11:30:00.000Z",
    rosterEffectiveAt: "2026-09-10T11:00:00.000Z",
    projectionFreshness: {
      state: "fresh" as const,
      observedAt: "2026-09-10T11:00:00.000Z",
      label: "Updated within the hour",
    },
    warnings: [],
    sections: { lineup: [], waiver: [], trade: [] },
    ...overrides,
  };
}

function snapshotSource() {
  return vi.fn(() => Promise.resolve(snapshot()));
}

describe("recomputeLeagueRecommendations", () => {
  it("writes one run per claimed team and kind", async () => {
    const writer = memoryWriter();

    const result = await recomputeLeagueRecommendations({
      leagueSeasonId,
      kinds: ["lineup", "waiver"],
      claimedTeamIds: ["team-1", "team-2"],
      buildSnapshot: snapshotSource(),
      writer,
      signal: new AbortController().signal,
    });

    expect(writer.inserts).toHaveLength(4);
    expect(result.runs.every((run) => run.inserted)).toBe(true);
    expect(result.leagueSeasonId).toBe(leagueSeasonId);
  });

  it("is idempotent: a replay with identical inputs writes no new run", async () => {
    const writer = memoryWriter();
    const input = {
      leagueSeasonId,
      kinds: ["lineup"] as const,
      claimedTeamIds: ["team-1"],
      buildSnapshot: snapshotSource(),
      writer,
      signal: new AbortController().signal,
    };

    await recomputeLeagueRecommendations(input);
    const afterFirst = writer.inserts.length;
    const second = await recomputeLeagueRecommendations(input);

    expect(writer.inserts).toHaveLength(afterFirst);
    expect(second.runs.every((run) => run.inserted)).toBe(false);
  });

  it("checks for the existing run before attempting an insert", async () => {
    const writer = memoryWriter();
    const insertRun = vi.fn((input: RecommendationRunInsert) => writer.insertRun(input));
    const spied: RecommendationRunWriter = {
      findRun: (identity) => writer.findRun(identity),
      insertRun,
    };
    const input = {
      leagueSeasonId,
      kinds: ["lineup"] as const,
      claimedTeamIds: ["team-1"],
      buildSnapshot: snapshotSource(),
      writer: spied,
      signal: new AbortController().signal,
    };

    await recomputeLeagueRecommendations(input);
    await recomputeLeagueRecommendations(input);

    // The unique index is the second line of defense, not the first: a replay must not depend on a
    // constraint violation to stay idempotent.
    expect(insertRun).toHaveBeenCalledTimes(1);
  });

  it("writes a new run once a material input changes", async () => {
    const writer = memoryWriter();
    const buildSnapshot = snapshotSource();
    const base = {
      leagueSeasonId,
      kinds: ["lineup"] as const,
      claimedTeamIds: ["team-1"],
      writer,
      signal: new AbortController().signal,
    };

    await recomputeLeagueRecommendations({ ...base, buildSnapshot });
    buildSnapshot.mockResolvedValueOnce(snapshot({ rosterSnapshotIds: ["snapshot-2"] }));
    await recomputeLeagueRecommendations({ ...base, buildSnapshot });

    expect(writer.inserts).toHaveLength(2);
  });

  it("rejects a kind with no in-season producer instead of silently ignoring it", async () => {
    await expect(
      recomputeLeagueRecommendations({
        leagueSeasonId,
        kinds: ["draft"],
        claimedTeamIds: ["team-1"],
        buildSnapshot: snapshotSource(),
        writer: memoryWriter(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Unsupported recommendation kind: draft");
  });

  it("stops between teams when the job is cancelled", async () => {
    const controller = new AbortController();
    const buildSnapshot = vi.fn(() => {
      controller.abort();
      return Promise.resolve(snapshot());
    });

    await expect(
      recomputeLeagueRecommendations({
        leagueSeasonId,
        kinds: ["lineup"],
        claimedTeamIds: ["team-1", "team-2"],
        buildSnapshot,
        writer: memoryWriter(),
        signal: controller.signal,
      }),
    ).rejects.toThrow("Recommendation recompute was aborted during shutdown");
    expect(buildSnapshot).toHaveBeenCalledTimes(1);
  });

  it("records a team the snapshot cannot serve instead of writing an empty run", async () => {
    const writer = memoryWriter();

    const result = await recomputeLeagueRecommendations({
      leagueSeasonId,
      kinds: ["lineup"],
      claimedTeamIds: ["team-1"],
      buildSnapshot: () => Promise.resolve(null),
      writer,
      signal: new AbortController().signal,
    });

    expect(writer.inserts).toHaveLength(0);
    expect(result.skipped).toEqual([{ fantasyTeamId: "team-1", reason: "SNAPSHOT_UNAVAILABLE" }]);
  });

  it("retains algorithm version, input checksum, freshness, and warnings on every run", async () => {
    const writer = memoryWriter();
    const captured: RecommendationRunInsert[] = [];
    const spied: RecommendationRunWriter = {
      findRun: (identity) => writer.findRun(identity),
      insertRun: (input) => {
        captured.push(input);
        return writer.insertRun(input);
      },
    };

    await recomputeLeagueRecommendations({
      leagueSeasonId,
      kinds: ["lineup"],
      claimedTeamIds: ["team-1"],
      buildSnapshot: snapshotSource(),
      writer: spied,
      signal: new AbortController().signal,
    });

    const written = captured[0];
    expect(written?.identity.algorithmVersion).toMatch(/^in-season-decisions-v\d+$/u);
    expect(written?.identity.inputChecksum).toMatch(/^[0-9a-f]{64}$/u);
    expect(written?.provenance.randomSeed).toBeNull();
    expect(written?.provenance.inputs.freshness).toBeDefined();
    expect(written?.provenance.inputs.projectionSetIds).toEqual(["set-1"]);
    expect(written?.provenance.warnings).toContain("PRIVATE_PROJECTION_SETS_EXCLUDED");
  });

  it("always requests league-visible projection sets so no run can carry a private set", async () => {
    const buildSnapshot = snapshotSource();

    await recomputeLeagueRecommendations({
      leagueSeasonId,
      kinds: ["lineup"],
      claimedTeamIds: ["team-1"],
      buildSnapshot,
      writer: memoryWriter(),
      signal: new AbortController().signal,
    });

    // A league-scoped row computed from one user's private projection set would leak that user's
    // projections into a row the change-event feed later surfaces league-wide.
    expect(buildSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: "league-only", fantasyTeamId: "team-1" }),
    );
  });

  it("preserves the snapshot's own warnings alongside the visibility restriction", async () => {
    const writer = memoryWriter();
    const captured: RecommendationRunInsert[] = [];

    await recomputeLeagueRecommendations({
      leagueSeasonId,
      kinds: ["lineup"],
      claimedTeamIds: ["team-1"],
      buildSnapshot: () => Promise.resolve(snapshot({ warnings: ["ROSTER_MISSING"] })),
      writer: {
        findRun: (identity) => writer.findRun(identity),
        insertRun: (input) => {
          captured.push(input);
          return writer.insertRun(input);
        },
      },
      signal: new AbortController().signal,
    });

    expect(captured[0]?.provenance.warnings).toEqual([
      "PRIVATE_PROJECTION_SETS_EXCLUDED",
      "ROSTER_MISSING",
    ]);
  });
});
