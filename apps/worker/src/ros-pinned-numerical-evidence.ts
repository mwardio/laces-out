import { createHash } from "node:crypto";
import {
  FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
  FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
  firstPartyRosSeedHash,
  projectionScoringProfileKey,
  rosProfileDefinitionFromKey,
  scoreFirstPartyRosOutcomes,
  scoreFirstPartyRosOutcomesWithSamples,
  type FirstPartyRosProjectionInput,
} from "@laces-out/projections";
import { evaluateRosNumericalReplication } from "../../../packages/projections/src/ros-numerical-replication.js";
import {
  restoreCachedRosHistoricalOutcome,
  rosHistoricalOutcomeCacheKey,
} from "./ros-historical-outcome-replay.js";
import type { RosOutcomeCache } from "./ros-outcome-cache.js";

export const ROS_PINNED_NUMERICAL_EVIDENCE_VERSION = "pinned-ros-numerical-evidence-v1";
export const ROS_PINNED_NUMERICAL_SCORER_VERSION = "ros-joint-component-exact-scoring-v1";
const SHA256 = /^[a-f0-9]{64}$/u;

export interface PinnedRosNumericalEvidenceInput {
  /** Trusted cache codec; this adapter never writes, simulates or fetches missing outcomes. */
  readonly cache: Pick<RosOutcomeCache, "read">;
  /** Original complete football input, including original seed, cutoff and exact league rules. */
  readonly forecast: FirstPartyRosProjectionInput;
  /** Independent execution-manifest pin, never obtained from this same unverified read. */
  readonly expectedManifestChecksum: string;
  /** Caller authenticates predeclaration, membership and completeness in its frozen runner. */
  readonly family: {
    readonly size: number;
    readonly errorBudget: number;
    readonly protocolChecksum: string;
  };
  readonly signal?: AbortSignal;
}

export class PinnedRosNumericalEvidenceError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "missing_outcomes"
      | "corrupt_outcomes"
      | "manifest_pin_mismatch"
      | "forecast_identity_mismatch"
      | "scorer_summary_mismatch",
  ) {
    super(`Pinned ROS numerical evidence: ${code}`);
    this.name = "PinnedRosNumericalEvidenceError";
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length)
      throw new PinnedRosNumericalEvidenceError("invalid_input");
    for (let i = 0; i < value.length; i++)
      if (!Object.hasOwn(value, i)) throw new PinnedRosNumericalEvidenceError("invalid_input");
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
      .join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined || (typeof value === "number" && !Number.isFinite(value)))
    throw new PinnedRosNumericalEvidenceError("invalid_input");
  return result;
}

/**
 * Candidate diagnostics bound to an independently pinned cache manifest and complete forecast
 * identity. The key is rederived from captured football inputs; metadata self-consistency alone
 * cannot substitute for the original seed or as-of timestamp. The production scorer supplies the
 * original-order scores, and both summaries must agree exactly with that scorer.
 *
 * This proves storage/input/scoring linkage, not how the simulator was executed, family selection,
 * IID assumptions, predictive accuracy or release qualification. A frozen execution manifest must
 * separately bind source/build bytes and the complete predeclared family. No live gate invokes it.
 */
export async function evaluatePinnedRosNumericalEvidence(input: PinnedRosNumericalEvidenceInput) {
  const { cache, signal } = input;
  signal?.throwIfAborted();
  // Capture caller-owned values before the first await. Computing the key validates the bounded
  // canonical football payload; rebuilding the profile detaches every scoring rule and bonus.
  const forecast = structuredClone(input.forecast);
  const key = rosHistoricalOutcomeCacheKey(forecast);
  const scoringProfile = rosProfileDefinitionFromKey(
    projectionScoringProfileKey(forecast.scoringProfile),
  ).profile;
  const manifestChecksum = input.expectedManifestChecksum;
  const family = {
    size: input.family.size,
    errorBudget: input.family.errorBudget,
    protocolChecksum: input.family.protocolChecksum,
  };
  if (
    typeof manifestChecksum !== "string" ||
    !SHA256.test(manifestChecksum) ||
    typeof family.protocolChecksum !== "string" ||
    !SHA256.test(family.protocolChecksum) ||
    !Number.isSafeInteger(family.size) ||
    family.size < 1 ||
    !Number.isFinite(family.errorBudget) ||
    family.errorBudget <= 0 ||
    family.errorBudget >= 1 ||
    typeof forecast.seed !== "string" ||
    !forecast.seed.trim() ||
    typeof forecast.asOfAt !== "string" ||
    !Number.isFinite(Date.parse(forecast.asOfAt)) ||
    new Date(forecast.asOfAt).toISOString() !== forecast.asOfAt
  )
    throw new PinnedRosNumericalEvidenceError("invalid_input");
  const expectedSeedHash = firstPartyRosSeedHash(forecast);
  const read = await cache.read(key, {
    expectedScenarioCount: FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
    ...(signal ? { signal } : {}),
  });
  signal?.throwIfAborted();
  if (read.state === "missing") throw new PinnedRosNumericalEvidenceError("missing_outcomes");
  if (read.state === "corrupt") throw new PinnedRosNumericalEvidenceError("corrupt_outcomes");
  if (read.manifestChecksum !== manifestChecksum)
    throw new PinnedRosNumericalEvidenceError("manifest_pin_mismatch");
  const ensemble = restoreCachedRosHistoricalOutcome(read.ensemble, key, {
    playerId: forecast.playerId,
    position: forecast.position,
    forecastSeason: forecast.season,
    asOfWeek: forecast.asOfWeek,
    windowStartWeek: forecast.windowStartWeek,
    windowEndWeek: forecast.windowEndWeek,
    inputChecksum: forecast.inputChecksum,
    strategy: forecast.strategy,
    weeklyModelVersion: forecast.weeklyModelVersion,
    scheduledGames: forecast.weeks.filter((week) => week.scheduled).length,
  });
  if (
    read.ensemble.metadata.seed !== forecast.seed ||
    ensemble.metadata.provenance.asOfAt !== forecast.asOfAt ||
    ensemble.metadata.provenance.seedHash !== expectedSeedHash
  )
    throw new PinnedRosNumericalEvidenceError("forecast_identity_mismatch");
  const full = scoreFirstPartyRosOutcomesWithSamples(ensemble, scoringProfile);
  const prefix = scoreFirstPartyRosOutcomes(
    ensemble,
    scoringProfile,
    FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
  );
  const evaluation = evaluateRosNumericalReplication({
    scores: full.samples,
    games: ensemble.games,
    position: forecast.position,
    scheduledGames: ensemble.metadata.scheduledGames,
    provenance: {
      modelVersion: key.modelVersion,
      scorerVersion: ROS_PINNED_NUMERICAL_SCORER_VERSION,
      scoringProfileKey: full.summary.scoringProfileKey,
      seedHash: expectedSeedHash,
      inputChecksum: forecast.inputChecksum,
      vectorChecksum: manifestChecksum,
    },
    familySize: family.size,
    familyErrorBudget: family.errorBudget,
  });
  for (const [actual, expected] of [
    [evaluation.summaries.release, prefix],
    [evaluation.summaries.reference, full.summary],
  ] as const) {
    for (const name of Object.keys(actual) as (keyof typeof actual)[]) {
      if (actual[name] !== expected[name])
        throw new PinnedRosNumericalEvidenceError("scorer_summary_mismatch");
    }
  }
  signal?.throwIfAborted();
  const body = {
    version: ROS_PINNED_NUMERICAL_EVIDENCE_VERSION,
    purpose: "candidate-numerical-evidence-only",
    sourceVerification: "pinned-cache-manifest-and-forecast-identity",
    source: { key, manifestChecksum },
    family,
    familyAuthentication: "caller-declaration-not-verified-here",
    simulationExecutionAuthentication: "not-verified-here",
    canAuthorizeRelease: false,
    canAuthorizeModelAdoption: false,
    evaluation,
  } as const;
  return {
    ...body,
    evidenceChecksum: createHash("sha256").update(canonical(body)).digest("hex"),
  };
}

export type PinnedRosNumericalEvidence = Awaited<
  ReturnType<typeof evaluatePinnedRosNumericalEvidence>
>;

/** Recompute from the same independent pins and verified cache, never trust receipt hashes alone. */
export async function pinnedRosNumericalEvidenceMatchesSource(
  evidence: unknown,
  input: PinnedRosNumericalEvidenceInput,
): Promise<boolean> {
  input.signal?.throwIfAborted();
  let captured: string;
  try {
    captured = canonical(evidence);
  } catch {
    return false;
  }
  const recomputed = await evaluatePinnedRosNumericalEvidence(input);
  return captured === canonical(recomputed);
}
