import {
  evaluateRosNumericalReplication,
  ROS_NUMERICAL_REPLICATION_VERSION,
  type RosNumericalReplicationInput,
} from "./ros-numerical-replication.js";
import { projectionScoringRulesFromProfileKey } from "./scoring-position-keys.js";
import { sha256Hex } from "./sha256.js";

/** Inactive evidence contract. Admission must select/adopt the numerical method separately. */
export const ROS_NUMERICAL_FAMILY_VERSION = "ros-numerical-family-linkage-v1";
export const ROS_NUMERICAL_FAMILY_EXECUTION_VERSION = "ros-numerical-family-execution-v1";
const MAX_MEMBERS = 50_000;

export type RosNumericalFamilyScope =
  | { readonly kind: "historical"; readonly corpusChecksum: string }
  | { readonly kind: "live"; readonly snapshotChecksum: string; readonly asOfAt: string };

export interface RosNumericalFamilyMember {
  readonly id: string;
  /** Identity of the complete original physical input, excluding the confirmation seed/profile. */
  readonly sourceInputIdentity: string;
  /** Exact seeded physical cache identity. A profile never substitutes for this identity. */
  readonly cacheIdentity: string;
  readonly baselineSeedHash: string;
  readonly replicate: number;
  readonly position: RosNumericalReplicationInput["position"];
  readonly scheduledGames: number;
  readonly provenance: Omit<RosNumericalReplicationInput["provenance"], "vectorChecksum">;
}

export interface RosNumericalFamilyManifest {
  readonly version: typeof ROS_NUMERICAL_FAMILY_VERSION;
  readonly numericalMethod: typeof ROS_NUMERICAL_REPLICATION_VERSION;
  readonly frozenAt: string;
  readonly scope: RosNumericalFamilyScope;
  readonly sourceManifestChecksum: string;
  readonly buildManifestChecksum: string;
  readonly protocolChecksum: string;
  readonly confirmation: "original-seed-diagnostics" | "two-fresh-seed-numerical-confirmation";
  readonly familyErrorBudget: number;
  readonly profiles: readonly string[];
  /** Complete, ordered, predeclared source-input × replicate × exact-profile population. */
  readonly members: readonly RosNumericalFamilyMember[];
}

export type RosNumericalFamilyExecutionMember =
  | {
      readonly id: string;
      readonly state: "evaluated";
      readonly manifestChecksum: string;
      readonly scoreVectorChecksum: string;
      readonly gamesVectorChecksum: string;
      readonly evaluationChecksum: string;
    }
  | { readonly id: string; readonly state: "unavailable"; readonly reason: string };

export interface RosNumericalFamilyExecution {
  readonly version: typeof ROS_NUMERICAL_FAMILY_EXECUTION_VERSION;
  readonly familyChecksum: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly state: "completed" | "failed";
  /** Missing rows remain missing; unavailable rows remain failures, never denominator exclusions. */
  readonly members: readonly RosNumericalFamilyExecutionMember[];
}

export interface RosNumericalFamilyTrustAnchors {
  /** These pins must come from the independently authenticated runner, not the supplied envelope. */
  readonly familyChecksum: string;
  readonly executionChecksum: string;
  readonly sourceManifestChecksum: string;
  readonly buildManifestChecksum: string;
  readonly protocolChecksum: string;
  /** An admission caller must request its actual historical corpus or live snapshot explicitly. */
  readonly scope: RosNumericalFamilyScope;
}

export interface RosNumericalFamilyInput {
  readonly family: RosNumericalFamilyManifest;
  readonly execution: RosNumericalFamilyExecution;
  readonly expected: RosNumericalFamilyTrustAnchors;
  /**
   * Trusted original codec/scorer adapter, invoked sequentially. It must restore the exact complete
   * forecast and manifest; it must not simulate, choose a replacement seed, sort or resample.
   * Raw ordered values are recomputed here; an evaluator receipt is not an acceptable substitute.
   */
  readonly readOriginalMember: (
    member: RosNumericalFamilyMember,
    receipt: Extract<RosNumericalFamilyExecutionMember, { state: "evaluated" }>,
  ) => Promise<{ readonly cacheIdentity: string; readonly input: RosNumericalReplicationInput }>;
  readonly signal?: AbortSignal;
}

function fail(message: string): never {
  throw new TypeError(`ROS numerical family: ${message}`);
}

function object(value: unknown, keys: readonly string[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid object");
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    fail("unknown or missing fields");
}

function array(value: unknown, minimum: number, maximum: number): void {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum ||
    Object.keys(value).length !== value.length
  )
    fail("invalid bounded array");
  for (let index = 0; index < value.length; index++)
    if (!Object.hasOwn(value, index)) fail("sparse array");
}

function digest(value: unknown): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("invalid checksum");
}

function text(value: unknown, maximum = 256): void {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    fail("invalid bounded identity");
}

function timestamp(value: string): void {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail("invalid timestamp");
}

function scope(value: RosNumericalFamilyScope): void {
  if (value.kind === "historical") {
    object(value, ["kind", "corpusChecksum"]);
    digest(value.corpusChecksum);
  } else if (value.kind === "live") {
    object(value, ["kind", "snapshotChecksum", "asOfAt"]);
    digest(value.snapshotChecksum);
    timestamp(value.asOfAt);
  } else fail("unknown scope");
}

/** Canonical digests bind an exact validated shape, not evidence of how/when it was produced. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined || (typeof value === "number" && !Number.isFinite(value)))
    fail("invalid canonical value");
  return result;
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (canonical(actual) !== canonical(expected)) fail(message);
}

function validateFamily(family: RosNumericalFamilyManifest): void {
  object(family, [
    "version",
    "numericalMethod",
    "frozenAt",
    "scope",
    "sourceManifestChecksum",
    "buildManifestChecksum",
    "protocolChecksum",
    "confirmation",
    "familyErrorBudget",
    "profiles",
    "members",
  ]);
  if (
    family.version !== ROS_NUMERICAL_FAMILY_VERSION ||
    family.numericalMethod !== ROS_NUMERICAL_REPLICATION_VERSION
  )
    fail("unknown family or numerical method");
  if (
    !["original-seed-diagnostics", "two-fresh-seed-numerical-confirmation"].includes(
      family.confirmation,
    )
  )
    fail("unknown confirmation method");
  timestamp(family.frozenAt);
  scope(family.scope);
  for (const value of [
    family.sourceManifestChecksum,
    family.buildManifestChecksum,
    family.protocolChecksum,
  ])
    digest(value);
  if (
    typeof family.familyErrorBudget !== "number" ||
    !Number.isFinite(family.familyErrorBudget) ||
    family.familyErrorBudget <= 0 ||
    family.familyErrorBudget >= 1
  )
    fail("invalid family error budget");
  array(family.profiles, 1, 128);
  const profiles = new Set<string>();
  for (const profile of family.profiles) {
    text(profile, 65_536);
    projectionScoringRulesFromProfileKey(profile);
    if (profiles.has(profile)) fail("duplicate scoring profile");
    profiles.add(profile);
  }
  array(family.members, 1, MAX_MEMBERS);
  const ids = new Set<string>();
  const physicalProfiles = new Set<string>();
  const inputs = new Map<
    string,
    {
      context: string;
      members: Set<string>;
      seeds: Map<number, string>;
      cacheIdentities: Map<number, string>;
    }
  >();
  const fresh = family.confirmation === "two-fresh-seed-numerical-confirmation";
  for (const member of family.members) {
    object(member, [
      "id",
      "sourceInputIdentity",
      "cacheIdentity",
      "baselineSeedHash",
      "replicate",
      "position",
      "scheduledGames",
      "provenance",
    ]);
    text(member.id);
    for (const value of [member.sourceInputIdentity, member.cacheIdentity, member.baselineSeedHash])
      digest(value);
    if (
      !Number.isSafeInteger(member.replicate) ||
      member.replicate < 0 ||
      member.replicate > (fresh ? 1 : 0)
    )
      fail("invalid declared replicate");
    if (!["QB", "RB", "WR", "TE", "K", "DST"].includes(member.position)) fail("invalid position");
    if (
      !Number.isSafeInteger(member.scheduledGames) ||
      member.scheduledGames < 0 ||
      member.scheduledGames > 18
    )
      fail("invalid scheduled support");
    object(member.provenance, [
      "modelVersion",
      "scorerVersion",
      "scoringProfileKey",
      "seedHash",
      "inputChecksum",
    ]);
    text(member.provenance.modelVersion);
    text(member.provenance.scorerVersion);
    digest(member.provenance.seedHash);
    digest(member.provenance.inputChecksum);
    if (!profiles.has(member.provenance.scoringProfileKey)) fail("undeclared scoring profile");
    if (fresh === (member.provenance.seedHash === member.baselineSeedHash))
      fail("seed does not match declared confirmation role");
    if (ids.has(member.id)) fail("duplicate member identity");
    ids.add(member.id);
    const physicalProfile = canonical([
      member.provenance.modelVersion,
      member.cacheIdentity,
      member.provenance.scoringProfileKey,
    ]);
    if (physicalProfiles.has(physicalProfile)) fail("duplicate physical/profile evaluation");
    physicalProfiles.add(physicalProfile);
    const context = canonical({
      baselineSeedHash: member.baselineSeedHash,
      position: member.position,
      scheduledGames: member.scheduledGames,
      modelVersion: member.provenance.modelVersion,
      scorerVersion: member.provenance.scorerVersion,
      inputChecksum: member.provenance.inputChecksum,
    });
    const group = inputs.get(member.sourceInputIdentity) ?? {
      context,
      members: new Set<string>(),
      seeds: new Map<number, string>(),
      cacheIdentities: new Map<number, string>(),
    };
    if (group.context !== context) fail("source input context changed within family");
    const membership = canonical([member.replicate, member.provenance.scoringProfileKey]);
    if (group.members.has(membership)) fail("duplicate input/replicate/profile member");
    group.members.add(membership);
    const priorSeed = group.seeds.get(member.replicate);
    if (priorSeed !== undefined && priorSeed !== member.provenance.seedHash)
      fail("profile changed physical seed");
    group.seeds.set(member.replicate, member.provenance.seedHash);
    const priorCache = group.cacheIdentities.get(member.replicate);
    if (priorCache !== undefined && priorCache !== member.cacheIdentity)
      fail("profile changed physical cache identity");
    group.cacheIdentities.set(member.replicate, member.cacheIdentity);
    inputs.set(member.sourceInputIdentity, group);
  }
  for (const group of inputs.values()) {
    if (group.members.size !== profiles.size * (fresh ? 2 : 1))
      fail("incomplete declared profile/replicate family");
    if (fresh && group.seeds.get(0) === group.seeds.get(1)) fail("confirmation reused a seed");
  }
}

function validateExecution(execution: RosNumericalFamilyExecution): void {
  object(execution, ["version", "familyChecksum", "startedAt", "finishedAt", "state", "members"]);
  if (execution.version !== ROS_NUMERICAL_FAMILY_EXECUTION_VERSION)
    fail("unknown execution method");
  digest(execution.familyChecksum);
  timestamp(execution.startedAt);
  timestamp(execution.finishedAt);
  if (execution.finishedAt < execution.startedAt) fail("execution time order");
  if (execution.state !== "completed" && execution.state !== "failed")
    fail("nonterminal execution");
  array(execution.members, 0, MAX_MEMBERS);
  for (const member of execution.members) {
    if (member.state === "evaluated") {
      object(member, [
        "id",
        "state",
        "manifestChecksum",
        "scoreVectorChecksum",
        "gamesVectorChecksum",
        "evaluationChecksum",
      ]);
      for (const value of [
        member.manifestChecksum,
        member.scoreVectorChecksum,
        member.gamesVectorChecksum,
        member.evaluationChecksum,
      ])
        digest(value);
    } else if (member.state === "unavailable") {
      object(member, ["id", "state", "reason"]);
      text(member.reason);
    } else fail("unknown execution member state");
    text(member.id);
  }
}

export function rosNumericalFamilyManifestChecksum(family: RosNumericalFamilyManifest): string {
  validateFamily(family);
  return sha256Hex(canonical(family));
}

export function rosNumericalFamilyExecutionChecksum(
  execution: RosNumericalFamilyExecution,
): string {
  validateExecution(execution);
  return sha256Hex(canonical(execution));
}

/**
 * Reconstructs the effective empirical numerical result for the entire pinned family, retaining
 * every old diagnostic verbatim. This does not replace the combined convergence gate or adopt the
 * method. Source/build execution, predeclaration and the trust anchors require independent review;
 * hashes and timestamps cannot authenticate those facts themselves. Fresh numerical seeds provide
 * no independent football outcomes and no predictive-accuracy or true-CDF guarantee.
 */
export async function evaluateRosNumericalFamily(input: RosNumericalFamilyInput) {
  const { signal, readOriginalMember } = input;
  signal?.throwIfAborted();
  const family = structuredClone(input.family);
  const execution = structuredClone(input.execution);
  const expected = structuredClone(input.expected);
  validateFamily(family);
  validateExecution(execution);
  object(expected, [
    "familyChecksum",
    "executionChecksum",
    "sourceManifestChecksum",
    "buildManifestChecksum",
    "protocolChecksum",
    "scope",
  ]);
  for (const name of [
    "familyChecksum",
    "executionChecksum",
    "sourceManifestChecksum",
    "buildManifestChecksum",
    "protocolChecksum",
  ] as const)
    digest(expected[name]);
  scope(expected.scope);
  equal(family.scope, expected.scope, "scope mismatch");
  for (const name of [
    "sourceManifestChecksum",
    "buildManifestChecksum",
    "protocolChecksum",
  ] as const)
    if (family[name] !== expected[name]) fail(`${name} mismatch`);
  if (sha256Hex(canonical(family)) !== expected.familyChecksum) fail("family pin mismatch");
  if (sha256Hex(canonical(execution)) !== expected.executionChecksum)
    fail("execution pin mismatch");
  if (execution.familyChecksum !== expected.familyChecksum) fail("execution family mismatch");
  if (execution.startedAt < family.frozenAt) fail("family was not frozen before execution");
  const ordinals = new Map(family.members.map((member, index) => [member.id, index]));
  const receipts = new Map<string, RosNumericalFamilyExecutionMember>();
  let previousOrdinal = -1;
  for (const receipt of execution.members) {
    const ordinal = ordinals.get(receipt.id);
    if (ordinal === undefined || ordinal <= previousOrdinal)
      fail("unknown, duplicate or reordered execution member");
    receipts.set(receipt.id, receipt);
    previousOrdinal = ordinal;
  }
  const rows: (
    | { readonly id: string; readonly state: "missing" }
    | { readonly id: string; readonly state: "unavailable"; readonly reason: string }
    | {
        readonly id: string;
        readonly state: "evaluated";
        readonly evaluation: ReturnType<typeof evaluateRosNumericalReplication>;
      }
  )[] = [];
  for (const member of family.members) {
    signal?.throwIfAborted();
    const receipt = receipts.get(member.id);
    if (!receipt) {
      rows.push({ id: member.id, state: "missing" });
      continue;
    }
    if (receipt.state === "unavailable") {
      rows.push({ ...receipt });
      continue;
    }
    // Callers receive detached metadata; mutations across await cannot change the pinned claim.
    const original = await readOriginalMember(structuredClone(member), structuredClone(receipt));
    signal?.throwIfAborted();
    if (original.cacheIdentity !== member.cacheIdentity) fail("original cache identity mismatch");
    const source = original.input;
    // The evaluator bounds/validates the original vectors and provenance before any recursive
    // comparison; do not canonicalize a caller's arbitrary receipt or unknown proof tree.
    const evaluation = evaluateRosNumericalReplication(source);
    if (
      evaluation.position !== member.position ||
      evaluation.scheduledGames !== member.scheduledGames
    )
      fail("original support/position mismatch");
    equal(
      evaluation.measurement.provenance,
      { ...member.provenance, vectorChecksum: receipt.manifestChecksum },
      "original provenance mismatch",
    );
    if (
      evaluation.measurement.precision.familySize !== family.members.length ||
      evaluation.measurement.precision.familyErrorBudget !== family.familyErrorBudget
    )
      fail("original family denominator mismatch");
    if (
      evaluation.evidenceChecksum !== receipt.evaluationChecksum ||
      evaluation.measurement.scoreVectorChecksum !== receipt.scoreVectorChecksum ||
      evaluation.gamesVectorChecksum !== receipt.gamesVectorChecksum
    )
      fail("original ordered vector/evaluation mismatch");
    rows.push({ id: member.id, state: "evaluated", evaluation });
  }
  const counts = {
    declared: family.members.length,
    evaluated: rows.filter((row) => row.state === "evaluated").length,
    missing: rows.filter((row) => row.state === "missing").length,
    unavailable: rows.filter((row) => row.state === "unavailable").length,
    empiricalFailures: rows.filter(
      (row) => row.state === "evaluated" && row.evaluation.operational.state !== "within-tolerance",
    ).length,
    legacyFailures: rows.filter(
      (row) => row.state === "evaluated" && row.evaluation.legacyDiagnostic.state !== "converged",
    ).length,
  };
  const complete = execution.state === "completed" && counts.missing === 0;
  const effectiveNumericalState =
    !complete || counts.unavailable > 0
      ? "unavailable"
      : counts.empiricalFailures > 0
        ? "outside-tolerance"
        : "within-tolerance";
  const body = {
    version: ROS_NUMERICAL_FAMILY_VERSION,
    numericalMethod: ROS_NUMERICAL_REPLICATION_VERSION,
    scope: family.scope,
    confirmation: family.confirmation,
    expected,
    familySize: family.members.length,
    familyErrorBudget: family.familyErrorBudget,
    complete,
    effectiveNumericalState,
    counts,
    members: rows,
    authentication: "linkage-to-independent-trust-anchors-and-original-vector-reader",
    predictiveConfirmation: "not-established",
    canAuthorizeRelease: false,
    canAuthorizeModelAdoption: false,
  } as const;
  return { ...body, evidenceChecksum: sha256Hex(canonical(body)) };
}
