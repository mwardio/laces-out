import { describe, expect, it, vi } from "vitest";
import {
  evaluateRosNumericalFamily,
  rosNumericalFamilyExecutionChecksum,
  rosNumericalFamilyManifestChecksum,
  ROS_NUMERICAL_FAMILY_EXECUTION_VERSION,
  ROS_NUMERICAL_FAMILY_VERSION,
  type RosNumericalFamilyExecution,
  type RosNumericalFamilyExecutionMember,
  type RosNumericalFamilyInput,
  type RosNumericalFamilyManifest,
  type RosNumericalFamilyMember,
  type RosNumericalFamilyTrustAnchors,
} from "./ros-numerical-family.js";
import {
  evaluateRosNumericalReplication,
  ROS_NUMERICAL_REPLICATION_VERSION,
  type RosNumericalReplicationInput,
} from "./ros-numerical-replication.js";
import { projectionScoringProfileKey } from "./scoring.js";

const hash = (digit: string) => digit.repeat(64);
const profileA = projectionScoringProfileKey({ id: "a", rules: [{ statId: "sacks", points: 1 }] });
const profileB = projectionScoringProfileKey({ id: "b", rules: [{ statId: "sacks", points: -2 }] });
const scoresWithLegacyFailure = () =>
  Float64Array.from({ length: 16_384 }, (_, index) =>
    index < 6143 || (index >= 12_288 && index < 14_338) ? 0 : 100,
  );

function fixture(scores = scoresWithLegacyFailure()) {
  const members: RosNumericalFamilyMember[] = [0, 1].flatMap((replicate) =>
    [profileA, profileB].map((scoringProfileKey, profileIndex) => ({
      id: `${replicate}:${profileIndex}`,
      sourceInputIdentity: hash("a"),
      cacheIdentity: hash(replicate === 0 ? "b" : "c"),
      baselineSeedHash: hash("d"),
      replicate,
      position: "DST" as const,
      scheduledGames: 1,
      provenance: {
        modelVersion: "laces-ros-distribution-v13",
        scorerVersion: "ros-joint-component-exact-scoring-v1",
        scoringProfileKey,
        seedHash: hash(replicate === 0 ? "e" : "f"),
        inputChecksum: hash("1"),
      },
    })),
  );
  const family: RosNumericalFamilyManifest = {
    version: ROS_NUMERICAL_FAMILY_VERSION,
    numericalMethod: ROS_NUMERICAL_REPLICATION_VERSION,
    frozenAt: "2026-09-19T00:00:00.000Z",
    scope: { kind: "historical", corpusChecksum: hash("2") },
    sourceManifestChecksum: hash("3"),
    buildManifestChecksum: hash("4"),
    protocolChecksum: hash("5"),
    confirmation: "two-fresh-seed-numerical-confirmation",
    familyErrorBudget: 0.05,
    profiles: [profileA, profileB],
    members,
  };
  const originals = members.map((member) => ({
    cacheIdentity: member.cacheIdentity,
    input: {
      position: member.position,
      scheduledGames: member.scheduledGames,
      scores: Float64Array.from(scores, (score) =>
        member.provenance.scoringProfileKey === profileA ? score : -2 * score,
      ),
      games: new Uint8Array(16_384).fill(1),
      provenance: { ...member.provenance, vectorChecksum: hash("6") },
      familySize: members.length,
      familyErrorBudget: family.familyErrorBudget,
    } satisfies RosNumericalReplicationInput,
  }));
  const evaluations = originals.map((original) => evaluateRosNumericalReplication(original.input));
  const execution: RosNumericalFamilyExecution = {
    version: ROS_NUMERICAL_FAMILY_EXECUTION_VERSION,
    familyChecksum: rosNumericalFamilyManifestChecksum(family),
    startedAt: "2026-09-19T00:01:00.000Z",
    finishedAt: "2026-09-19T00:02:00.000Z",
    state: "completed",
    members: members.map((member, index) => ({
      id: member.id,
      state: "evaluated" as const,
      manifestChecksum: hash("6"),
      scoreVectorChecksum: evaluations[index]!.measurement.scoreVectorChecksum,
      gamesVectorChecksum: evaluations[index]!.gamesVectorChecksum,
      evaluationChecksum: evaluations[index]!.evidenceChecksum,
    })),
  };
  const expected: RosNumericalFamilyTrustAnchors = {
    familyChecksum: execution.familyChecksum,
    executionChecksum: rosNumericalFamilyExecutionChecksum(execution),
    sourceManifestChecksum: family.sourceManifestChecksum,
    buildManifestChecksum: family.buildManifestChecksum,
    protocolChecksum: family.protocolChecksum,
    scope: family.scope,
  };
  const readOriginalMember = vi.fn(async (member: RosNumericalFamilyMember) => {
    const index = members.findIndex((candidate) => candidate.id === member.id);
    return originals[index]!;
  });
  return {
    family,
    execution,
    expected,
    readOriginalMember,
    originals,
    evaluations,
    input: { family, execution, expected, readOriginalMember } satisfies RosNumericalFamilyInput,
  };
}

function withExecution(source: ReturnType<typeof fixture>, execution: RosNumericalFamilyExecution) {
  return {
    ...source.input,
    execution,
    expected: {
      ...source.expected,
      executionChecksum: rosNumericalFamilyExecutionChecksum(execution),
    },
  };
}

function repinFamily(source: ReturnType<typeof fixture>, family: RosNumericalFamilyManifest) {
  const checksum = rosNumericalFamilyManifestChecksum(family);
  const execution = { ...source.execution, familyChecksum: checksum };
  return {
    ...source.input,
    family,
    execution,
    expected: {
      ...source.expected,
      familyChecksum: checksum,
      executionChecksum: rosNumericalFamilyExecutionChecksum(execution),
    },
  };
}

describe("complete ROS numerical family linkage", () => {
  it("recomputes every ordered vector and preserves failed legacy diagnostics separately", async () => {
    const source = fixture();
    const result = await evaluateRosNumericalFamily(source.input);
    expect(result.effectiveNumericalState).toBe("within-tolerance");
    expect(result.counts).toEqual({
      declared: 4,
      evaluated: 4,
      missing: 0,
      unavailable: 0,
      empiricalFailures: 0,
      legacyFailures: 4,
    });
    expect(
      result.members.map((member) => (member.state === "evaluated" ? member.evaluation : null)),
    ).toEqual(source.evaluations);
    expect(source.readOriginalMember.mock.calls.map(([member]) => member.id)).toEqual([
      "0:0",
      "0:1",
      "1:0",
      "1:1",
    ]);
    expect(result).toMatchObject({
      complete: true,
      predictiveConfirmation: "not-established",
      canAuthorizeRelease: false,
      canAuthorizeModelAdoption: false,
    });
  });

  it("fails the empirical criterion for an actual shape shift despite unchanged legacy summaries", async () => {
    const scores = Float64Array.from({ length: 16_384 }, (_, index) => {
      if (index < 6144) return 0;
      if (index < 12_288) return 2;
      if (index < 13_824) return 0;
      if (index < 14_848) return 1;
      return 2;
    });
    const result = await evaluateRosNumericalFamily(fixture(scores).input);
    expect(result.effectiveNumericalState).toBe("outside-tolerance");
    expect(result.counts.empiricalFailures).toBe(4);
    expect(result.counts.legacyFailures).toBe(0);
  });

  it("retains absent members and the original denominator when execution is incomplete", async () => {
    const source = fixture();
    const execution = {
      ...source.execution,
      members: source.execution.members.filter((_, index) => index !== 1),
    };
    const result = await evaluateRosNumericalFamily(withExecution(source, execution));
    expect(result.complete).toBe(false);
    expect(result.familySize).toBe(4);
    expect(result.effectiveNumericalState).toBe("unavailable");
    expect(result.members[1]).toEqual({ id: "0:1", state: "missing" });
    expect(result.counts).toMatchObject({ declared: 4, evaluated: 3, missing: 1 });
    expect(source.readOriginalMember).toHaveBeenCalledTimes(3);
  });

  it("preserves an unavailable declaration without reading or excluding that member", async () => {
    const source = fixture();
    const members: RosNumericalFamilyExecutionMember[] = [...source.execution.members];
    members[1] = { id: "0:1", state: "unavailable", reason: "unsupported-scoring-component" };
    const result = await evaluateRosNumericalFamily(
      withExecution(source, { ...source.execution, members }),
    );
    expect(result.complete).toBe(true);
    expect(result.effectiveNumericalState).toBe("unavailable");
    expect(result.members[1]).toEqual(members[1]);
    expect(result.counts).toMatchObject({ declared: 4, evaluated: 3, unavailable: 1 });
    expect(source.readOriginalMember).toHaveBeenCalledTimes(3);
  });

  it("does not accept a failed terminal execution even when each retained vector passes", async () => {
    const source = fixture();
    const result = await evaluateRosNumericalFamily(
      withExecution(source, { ...source.execution, state: "failed" }),
    );
    expect(result.complete).toBe(false);
    expect(result.effectiveNumericalState).toBe("unavailable");
    expect(result.counts.evaluated).toBe(4);
  });

  it("rejects deleting an entire profile even after recomputing the supplied manifest hash", async () => {
    const source = fixture();
    const family = {
      ...source.family,
      profiles: [profileA],
      members: source.family.members.filter(
        (member) => member.provenance.scoringProfileKey === profileA,
      ),
    };
    const execution = {
      ...source.execution,
      familyChecksum: rosNumericalFamilyManifestChecksum(family),
    };
    await expect(
      evaluateRosNumericalFamily({ ...withExecution(source, execution), family }),
    ).rejects.toThrow(/family pin/);
    expect(source.readOriginalMember).not.toHaveBeenCalled();
  });

  it.each(["duplicate", "reordered", "unknown"])(
    "rejects %s execution membership with a valid new hash",
    async (kind) => {
      const source = fixture();
      const members = [...source.execution.members];
      if (kind === "duplicate") members[1] = members[0]!;
      if (kind === "reordered") [members[0], members[1]] = [members[1]!, members[0]!];
      if (kind === "unknown") members[1] = { ...members[1]!, id: "foreign" };
      await expect(
        evaluateRosNumericalFamily(withExecution(source, { ...source.execution, members })),
      ).rejects.toThrow(/execution member/);
      expect(source.readOriginalMember).not.toHaveBeenCalled();
    },
  );

  it.each(["evaluationChecksum", "scoreVectorChecksum", "gamesVectorChecksum"] as const)(
    "rejects rehashed falsification of %s using original values",
    async (field) => {
      const source = fixture();
      const members = source.execution.members.map((member, index) =>
        member.state === "evaluated" && index === 0 ? { ...member, [field]: hash("7") } : member,
      );
      await expect(
        evaluateRosNumericalFamily(withExecution(source, { ...source.execution, members })),
      ).rejects.toThrow(/ordered vector\/evaluation/);
    },
  );

  it("rejects within-prefix reordering even when all distribution summaries remain identical", async () => {
    const source = fixture();
    const scores = source.originals[0]!.input.scores;
    [scores[0], scores[6143]] = [scores[6143]!, scores[0]!];
    const altered = evaluateRosNumericalReplication(source.originals[0]!.input);
    expect(altered.summaries).toEqual(source.evaluations[0]!.summaries);
    expect(altered.legacyDiagnostic).toEqual(source.evaluations[0]!.legacyDiagnostic);
    await expect(evaluateRosNumericalFamily(source.input)).rejects.toThrow(
      /ordered vector\/evaluation/,
    );
  });

  it.each(["cache", "profile", "manifest", "family", "games"])(
    "rejects original %s substitutions",
    async (kind) => {
      const source = fixture();
      const original = source.originals[0]!;
      if (kind === "cache") original.cacheIdentity = hash("9");
      if (kind === "profile") original.input.provenance.scoringProfileKey = profileB;
      if (kind === "manifest") original.input.provenance.vectorChecksum = hash("9");
      if (kind === "family") original.input.familySize = 3;
      if (kind === "games") original.input.games[0] = 0;
      await expect(evaluateRosNumericalFamily(source.input)).rejects.toThrow(/mismatch/);
    },
  );

  it.each(["sourceManifestChecksum", "buildManifestChecksum", "protocolChecksum"] as const)(
    "checks independent %s even when other envelope pins are replaced",
    async (field) => {
      const source = fixture();
      await expect(
        evaluateRosNumericalFamily(repinFamily(source, { ...source.family, [field]: hash("8") })),
      ).rejects.toThrow(new RegExp(`${field} mismatch`));
    },
  );

  it("does not reuse historical evidence for a live snapshot or another as-of epoch", async () => {
    const source = fixture();
    const live = {
      ...source.family,
      scope: {
        kind: "live" as const,
        snapshotChecksum: hash("8"),
        asOfAt: "2026-09-19T00:00:00.000Z",
      },
    };
    const input = repinFamily(source, live);
    await expect(evaluateRosNumericalFamily(input)).rejects.toThrow(/scope mismatch/);
    const expected = { ...input.expected, scope: live.scope };
    expect((await evaluateRosNumericalFamily({ ...input, expected })).scope).toEqual(live.scope);
    await expect(
      evaluateRosNumericalFamily({
        ...input,
        expected: { ...expected, scope: { ...live.scope, asOfAt: "2026-09-19T01:00:00.000Z" } },
      }),
    ).rejects.toThrow(/scope mismatch/);
  });

  it.each([
    "baseline",
    "repeated",
    "missing-replicate",
    "missing-profile",
    "denominator",
    "profile-cache",
  ])("rejects %s confirmation relabeling", (kind) => {
    const source = fixture();
    let members = structuredClone(source.family.members);
    if (kind === "baseline")
      members = members.map((member) => ({
        ...member,
        baselineSeedHash: member.provenance.seedHash,
      }));
    if (kind === "repeated")
      members = members.map((member) => ({
        ...member,
        provenance: { ...member.provenance, seedHash: hash("e") },
      }));
    if (kind === "missing-replicate") members = members.filter((member) => member.replicate === 0);
    if (kind === "missing-profile") members = members.filter((member) => member.id !== "1:1");
    if (kind === "profile-cache")
      members = members.map((member) =>
        member.id === "0:1" ? { ...member, cacheIdentity: hash("9") } : member,
      );
    const family = {
      ...source.family,
      members,
      ...(kind === "denominator" ? { familyErrorBudget: Number.NaN } : {}),
    };
    expect(() => rosNumericalFamilyManifestChecksum(family)).toThrow();
  });

  it("validates original-seed diagnostics separately without claiming fresh confirmation", async () => {
    const source = fixture();
    const family = {
      ...source.family,
      confirmation: "original-seed-diagnostics" as const,
      members: source.family.members
        .filter((member) => member.replicate === 0)
        .map((member) => ({ ...member, baselineSeedHash: member.provenance.seedHash })),
    };
    expect(rosNumericalFamilyManifestChecksum(family)).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      rosNumericalFamilyManifestChecksum({
        ...family,
        confirmation: "two-fresh-seed-numerical-confirmation",
      }),
    ).toThrow(/seed/);
  });

  it.each(["method", "unknown-field", "sparse", "post-execution-freeze"])(
    "rejects %s contract drift",
    async (kind) => {
      const source = fixture();
      if (kind === "method") Object.assign(source.family, { numericalMethod: "legacy-v7" });
      if (kind === "unknown-field") Object.assign(source.family, { canAuthorizeRelease: true });
      if (kind === "sparse") Reflect.deleteProperty(source.family.members, "1");
      if (kind === "post-execution-freeze") {
        const family = { ...source.family, frozenAt: "2026-09-19T00:01:00.001Z" };
        await expect(evaluateRosNumericalFamily(repinFamily(source, family))).rejects.toThrow(
          /frozen before/,
        );
      } else await expect(evaluateRosNumericalFamily(source.input)).rejects.toThrow();
      expect(source.readOriginalMember).not.toHaveBeenCalled();
    },
  );

  it("captures the family and pins before awaiting mutable caller/reader objects", async () => {
    const source = fixture();
    const readOriginalMember = vi.fn(async (member: RosNumericalFamilyMember) => {
      const index = source.family.members.findIndex((candidate) => candidate.id === member.id);
      if (index === 0) {
        Object.assign(source.expected, { protocolChecksum: hash("9") });
        Object.assign(source.family.members[1]!, { id: "changed" });
        Object.assign(member, { id: "untrusted-reader-change" });
      }
      return source.originals[index === -1 ? 1 : index]!;
    });
    const result = await evaluateRosNumericalFamily({ ...source.input, readOriginalMember });
    expect(result.effectiveNumericalState).toBe("within-tolerance");
    expect(result.members.map((member) => member.id)).toEqual(["0:0", "0:1", "1:0", "1:1"]);
    expect(result.expected.protocolChecksum).toBe(hash("5"));
  });

  it("propagates codec corruption and cancellation without converting either to success", async () => {
    const source = fixture();
    await expect(
      evaluateRosNumericalFamily({
        ...source.input,
        readOriginalMember: async () => {
          throw new Error("corrupt-vector");
        },
      }),
    ).rejects.toThrow("corrupt-vector");
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(
      evaluateRosNumericalFamily({ ...source.input, signal: abort.signal }),
    ).rejects.toThrow("cancelled");
    expect(source.readOriginalMember).not.toHaveBeenCalled();
  });

  it("keeps the original cancellation signal across a reader await", async () => {
    const source = fixture();
    const abort = new AbortController();
    const input = {
      ...source.input,
      signal: abort.signal,
      readOriginalMember: async () => {
        input.signal = new AbortController().signal;
        abort.abort(new Error("original-signal-cancelled"));
        return source.originals[0]!;
      },
    };
    await expect(evaluateRosNumericalFamily(input)).rejects.toThrow("original-signal-cancelled");
  });
});
