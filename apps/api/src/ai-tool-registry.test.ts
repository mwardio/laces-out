import { RECOMMENDATION_ALGORITHM_VERSION } from "@laces-out/decisions";
import { describe, expect, it, vi } from "vitest";

import { AI_TOOL_LOOP_LIMITS } from "./ai-tool-loop.js";
import { createAiToolRegistry, type AiToolContext } from "./ai-tool-registry.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const LEAGUE_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_LEAGUE_ID = "20000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-09-18T12:00:00.000Z");

function context(overrides: Partial<AiToolContext> = {}): AiToolContext {
  return { userId: USER_ID, leagueId: LEAGUE_ID, draftId: null, now: NOW, ...overrides };
}

function player(id: string, name: string, projectedPoints: number) {
  return {
    id,
    name,
    positions: ["WR"],
    nflTeam: "SEA",
    status: "active",
    projectedPoints,
  };
}

const SNAPSHOT_CHECKSUM = "9".repeat(64);

/**
 * The REAL `InSeasonDecisionSnapshot` shape, field for field — including the ADR 0003 pair its
 * provenance carries and this registry passes straight through.
 */
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: NOW.toISOString(),
    league: { id: LEAGUE_ID, name: "Wide Right League", season: 2026, week: 3, provider: "espn" },
    team: { id: "t1", name: "Fourth & Long", faabRemaining: 42 },
    provenance: {
      algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
      inputChecksum: SNAPSHOT_CHECKSUM,
      leagueLastSyncedAt: NOW.toISOString(),
      rosterEffectiveAt: NOW.toISOString(),
      projectionSet: {
        id: "40000000-0000-4000-8000-000000000001",
        source: "laces-out",
        version: "v8",
        horizon: "week",
        sourceObservedAt: NOW.toISOString(),
        sourceObservedAtStatus: "verified",
        importedAt: NOW.toISOString(),
      },
      projectionFreshness: { state: "fresh", observedAt: NOW.toISOString(), label: "Fresh" },
    },
    coverage: { leagueTeams: 12, teamsWithRosters: 12 },
    lineup: {
      state: "available",
      metric: "mean",
      feasible: true,
      currentProjectedPoints: 108.2,
      optimalProjectedPoints: 110.6,
      projectedGain: 2.4,
      assignments: [],
      changes: [
        {
          slotId: "FLEX",
          slotLabel: "FLEX",
          remove: player("p2", "Alcott", 9.1),
          add: player("p1", "Reed", 12.4),
          projectedPointDelta: 2.4,
        },
      ],
      execution: { mode: "provider-required", provider: "espn", label: "Open ESPN", url: null },
      notes: [],
    },
    waivers: { state: "available", recommendations: [], notes: [] },
    trades: { state: "available", bestForMe: [], fairest: [], notes: [] },
    ...overrides,
  };
}

function registry(decisionsSnapshot: () => Promise<unknown>) {
  const getSnapshot = vi.fn(decisionsSnapshot);
  return { getSnapshot, tools: createAiToolRegistry({ decisions: { getSnapshot } }) };
}

function lineupTool(decisionsSnapshot: () => Promise<unknown>) {
  const { getSnapshot, tools } = registry(decisionsSnapshot);
  const tool = tools.get("get_lineup_recommendation");
  if (!tool) throw new Error("Expected the lineup tool to be registered");
  return { getSnapshot, tool };
}

describe("get_lineup_recommendation", () => {
  it("registers exactly the declared tools, all read-only", () => {
    const tools = createAiToolRegistry({ decisions: { getSnapshot: () => Promise.resolve({}) } });
    expect([...tools.keys()]).toEqual(["get_lineup_recommendation"]);
    for (const tool of tools.values()) {
      expect(tool.definition.readOnly).toBe(true);
      expect(tool.definition.parameters.additionalProperties).toBe(false);
    }
  });

  it("re-checks membership through the decision service on every call", async () => {
    const { getSnapshot, tool } = lineupTool(() => Promise.resolve(snapshot()));

    const first = await tool.execute(context(), {});
    const second = await tool.execute(context(), { week: 3 });

    expect(first.state).toBe("ok");
    expect(second.state).toBe("ok");
    // Authorization is never cached across turns.
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(getSnapshot).toHaveBeenNthCalledWith(1, USER_ID, LEAGUE_ID);
    expect(getSnapshot).toHaveBeenNthCalledWith(2, USER_ID, LEAGUE_ID);
  });

  it("denies a non-member exactly as the deterministic route does", async () => {
    const { tool } = lineupTool(() => Promise.resolve(undefined));

    await expect(tool.execute(context(), {})).resolves.toMatchObject({
      state: "denied",
      code: "NOT_AUTHORIZED",
    });
  });

  it("treats a model-supplied league id as untrusted and never reads that league", async () => {
    const { getSnapshot, tool } = lineupTool(() => Promise.resolve(snapshot()));

    const outcome = await tool.execute(context(), { week: 3, leagueId: OTHER_LEAGUE_ID });

    expect(outcome).toMatchObject({ state: "denied", code: "INVALID_ARGUMENTS" });
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it("treats a model-supplied user id as untrusted and never reads any snapshot", async () => {
    const { getSnapshot, tool } = lineupTool(() => Promise.resolve(snapshot()));

    const outcome = await tool.execute(context(), {
      userId: "10000000-0000-4000-8000-000000000099",
    });

    expect(outcome).toMatchObject({ state: "denied", code: "INVALID_ARGUMENTS" });
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it("carries the engine's own ADR 0003 pair, never a synthesized one", async () => {
    const { tool } = lineupTool(() => Promise.resolve(snapshot()));

    const outcome = await tool.execute(context(), {});
    if (outcome.state !== "ok") throw new Error("Expected an ok outcome");

    // Both halves are the snapshot's own, passed through rather than recomputed here.
    expect(outcome.provenance.algorithmVersion).toBe(RECOMMENDATION_ALGORITHM_VERSION);
    expect(outcome.provenance.inputChecksum).toBe(SNAPSHOT_CHECKSUM);
    // The scope says which deterministic surface the digest belongs to.
    expect(outcome.provenance.checksumScope).toBe("decision-snapshot-provenance");
    expect(outcome.provenance.generatedAt).toBe(NOW.toISOString());
    expect(outcome.provenance.warnings).toEqual([]);
  });

  it("passes the snapshot's checksum through instead of deriving a narrower one", async () => {
    const digest = async (patch: Record<string, unknown>) => {
      const { tool } = lineupTool(() => Promise.resolve(snapshot(patch)));
      const outcome = await tool.execute(context(), {});
      if (outcome.state !== "ok") throw new Error("Expected an ok outcome");
      return outcome.provenance.inputChecksum;
    };

    // The snapshot's checksum already covers the inputs; the tool moves it, it does not re-derive it.
    const moved = "1".repeat(64);
    expect(await digest({ provenance: { ...snapshot().provenance, inputChecksum: moved } })).toBe(
      moved,
    );
    // A field the snapshot's own checksum does not treat as identifying cannot move the digest here
    // either — the tool has no independent opinion about what identifies a run.
    expect(await digest({ coverage: { leagueTeams: 12, teamsWithRosters: 11 } })).toBe(
      SNAPSHOT_CHECKSUM,
    );
    expect(
      await digest({
        league: { id: LEAGUE_ID, name: "Renamed", season: 2026, week: 4, provider: "espn" },
      }),
    ).toBe(SNAPSHOT_CHECKSUM);
  });

  it("refuses to answer rather than synthesize provenance the snapshot did not state", async () => {
    for (const broken of [
      { ...snapshot().provenance, inputChecksum: undefined },
      { ...snapshot().provenance, inputChecksum: "not-a-digest" },
      { ...snapshot().provenance, algorithmVersion: "" },
    ]) {
      const { tool } = lineupTool(() => Promise.resolve(snapshot({ provenance: broken })));
      await expect(tool.execute(context(), {})).resolves.toMatchObject({
        state: "unavailable",
        code: "PROVENANCE_UNREADABLE",
      });
    }
  });

  it("warns when the deterministic run's own provenance is degraded", async () => {
    const { tool } = lineupTool(() =>
      Promise.resolve(
        snapshot({
          provenance: {
            algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
            inputChecksum: SNAPSHOT_CHECKSUM,
            leagueLastSyncedAt: null,
            rosterEffectiveAt: null,
            projectionSet: null,
            projectionFreshness: { state: "stale", observedAt: null, label: "Stale" },
          },
        }),
      ),
    );

    const outcome = await tool.execute(context(), {});
    if (outcome.state !== "ok") throw new Error("Expected an ok outcome");

    expect(outcome.provenance.warnings).toContain(
      "projection-set-absent: the decision snapshot names no projection set",
    );
    expect(outcome.provenance.warnings).toContain("projection-freshness: stale");
  });

  it("exposes only the section it wraps, bounded to the loop's result cap", async () => {
    const { tool } = lineupTool(() => Promise.resolve(snapshot()));

    const outcome = await tool.execute(context(), {});
    if (outcome.state !== "ok") throw new Error("Expected an ok outcome");

    const serialized = JSON.stringify(outcome.data);
    expect(serialized.length).toBeLessThanOrEqual(AI_TOOL_LOOP_LIMITS.maxToolResultChars);
    expect(outcome.data).toMatchObject({
      lineup: {
        state: "available",
        changes: [{ slotLabel: "FLEX", add: { name: "Reed" }, projectedPointDelta: 2.4 }],
      },
      projectionFreshness: { state: "fresh" },
    });
    expect(serialized).not.toContain("waivers");
    expect(serialized).not.toContain("faabRemaining");
    expect(serialized).not.toContain("bestForMe");
  });

  it("reports an unavailable deterministic section instead of inventing one", async () => {
    const { tool } = lineupTool(() =>
      Promise.resolve(
        snapshot({
          lineup: {
            state: "unavailable",
            reasons: [{ code: "NO_PROJECTIONS", message: "No compatible projection set." }],
          },
        }),
      ),
    );

    await expect(tool.execute(context(), {})).resolves.toMatchObject({
      state: "unavailable",
      code: "NO_PROJECTIONS",
      message: "No compatible projection set.",
    });
  });

  it("reports a snapshot with no readable lineup section as unavailable, not as an answer", async () => {
    const { tool } = lineupTool(() => Promise.resolve({ generatedAt: NOW.toISOString() }));

    await expect(tool.execute(context(), {})).resolves.toMatchObject({
      state: "unavailable",
      code: "SECTION_UNREADABLE",
    });
  });
});
