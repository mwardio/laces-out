import { createHash } from "node:crypto";

import {
  FIRST_PARTY_PROJECTION_MODEL_VERSION,
  FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS,
  FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
  FIRST_PARTY_ROS_MAXIMUM_SCENARIOS,
  FIRST_PARTY_ROS_MINIMUM_SCENARIOS,
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_SEED_VERSION,
} from "@laces-out/projections";

import { FIRST_PARTY_PLAYER_HISTORY_VERSION } from "./first-party-projection-inputs.js";
import {
  HISTORICAL_ROS_AVAILABILITY_CALIBRATION_VERSION,
  HISTORICAL_ROS_CANDIDATE_PAIR_VERSION,
  HISTORICAL_ROS_KICKER_CALIBRATION_VERSION,
  HISTORICAL_ROS_PRODUCTION_BASIS_VERSION,
  HISTORICAL_ROS_ROLE_CALIBRATION_VERSION,
} from "./first-party-ros-backtest.js";

/** Bump when live preparation changes without changing one of its imported model versions. */
export const ROS_LIVE_PHYSICAL_IDENTITY_VERSION = "live-ros-physical-identity-v1";

export interface RosLivePhysicalIdentityInput {
  readonly season: number;
  readonly window: {
    readonly asOfWeek: number;
    readonly windowStartWeek: number;
    readonly windowEndWeek: number;
  };
  readonly scenarioCount?: number;
  readonly convergenceReferenceScenarioCount?: number;
  /** Include every relevant observation feed; missing feeds have both values explicitly null. */
  readonly sources: readonly {
    readonly key: string;
    readonly id: string | null;
    readonly checksum: string | null;
  }[];
  /** Actual captured rows, including mutable catalog joins and unresolved roster identities. */
  readonly rows: Readonly<Record<string, readonly unknown[]>>;
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite live ROS physical input");
    return JSON.stringify(value);
  }
  if (value instanceof Date) return JSON.stringify(Date.prototype.toISOString.call(value));
  if (typeof value !== "object") throw new TypeError("Invalid live ROS physical input");
  if (ancestors.has(value) || ancestors.size >= 64)
    throw new TypeError("Cyclic or overly nested live ROS physical input");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new TypeError("Live ROS physical inputs must be plain JSON or dates");
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new TypeError("Symbol keys are not live ROS physical inputs");
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return `[${Array.from(value, (entry) => canonicalJson(entry, ancestors)).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Sort the same captured rows used for assembly, retaining duplicates and caller ownership.
 * Serialize each row once and sort fixed-size digests, avoiding repeated serialization during
 * O(n log n) comparisons or a second serialized copy of an entire historical corpus.
 */
export function canonicalRosLiveRows<T>(rows: readonly T[]): T[] {
  return rows
    .map((row) => ({ row, digest: createHash("sha256").update(canonicalJson(row)).digest("hex") }))
    .sort((left, right) => {
      if (left.digest !== right.digest) return left.digest < right.digest ? -1 : 1;
      if (left.row === right.row) return 0;
      // Preserve deterministic ordering even in a digest collision. Ordinary equal-content
      // duplicates remain separate entries and retain Array.sort's stable relative order.
      const leftJson = canonicalJson(left.row);
      const rightJson = canonicalJson(right.row);
      return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
    })
    .map(({ row }) => row);
}

/**
 * Identity of the captured football state, independent of league rules, aliases and wall time.
 * A durable generation maps this key to its ORIGINAL asOfAt; that time remains in each player's
 * assembled input checksum and seed. This identity must never replace those seeded identities.
 */
export function rosLivePhysicalIdentity(input: RosLivePhysicalIdentityInput): string {
  const scenarioCount = input.scenarioCount ?? FIRST_PARTY_ROS_DEFAULT_SCENARIOS;
  const referenceScenarioCount =
    input.convergenceReferenceScenarioCount ?? FIRST_PARTY_ROS_CONVERGENCE_REFERENCE_SCENARIOS;
  for (const count of [scenarioCount, referenceScenarioCount]) {
    if (
      !Number.isSafeInteger(count) ||
      count < FIRST_PARTY_ROS_MINIMUM_SCENARIOS ||
      count > FIRST_PARTY_ROS_MAXIMUM_SCENARIOS ||
      count % 2 !== 0
    )
      throw new RangeError("Invalid live ROS physical scenario count");
  }
  if (referenceScenarioCount < scenarioCount)
    throw new RangeError("Live ROS physical reference is shorter than the release");
  if (
    !Number.isSafeInteger(input.season) ||
    input.season < 1 ||
    !Number.isSafeInteger(input.window.asOfWeek) ||
    input.window.asOfWeek < 0 ||
    input.window.asOfWeek > 18 ||
    !Number.isSafeInteger(input.window.windowStartWeek) ||
    input.window.windowStartWeek < 1 ||
    !Number.isSafeInteger(input.window.windowEndWeek) ||
    input.window.windowEndWeek < input.window.windowStartWeek ||
    input.window.windowEndWeek > 18
  )
    throw new RangeError("Invalid live ROS physical window");
  const sourceKeys = new Set<string>();
  const sources = input.sources.map(({ key, id, checksum }) => {
    if (
      typeof key !== "string" ||
      !key.trim() ||
      sourceKeys.has(key) ||
      !(
        (id === null && checksum === null) ||
        (typeof id === "string" &&
          id.trim().length > 0 &&
          typeof checksum === "string" &&
          checksum.trim().length > 0)
      )
    )
      throw new TypeError("Invalid live ROS physical source manifest");
    sourceKeys.add(key);
    return { key, id, checksum };
  });
  const hash = createHash("sha256");
  hash.update(
    canonicalJson({
      version: ROS_LIVE_PHYSICAL_IDENTITY_VERSION,
      versions: {
        weeklyModel: FIRST_PARTY_PROJECTION_MODEL_VERSION,
        rosModel: FIRST_PARTY_ROS_MODEL_VERSION,
        rosSeed: FIRST_PARTY_ROS_SEED_VERSION,
        playerHistory: FIRST_PARTY_PLAYER_HISTORY_VERSION,
        candidatePair: HISTORICAL_ROS_CANDIDATE_PAIR_VERSION,
        productionBasis: HISTORICAL_ROS_PRODUCTION_BASIS_VERSION,
        availabilityCalibration: HISTORICAL_ROS_AVAILABILITY_CALIBRATION_VERSION,
        roleCalibration: HISTORICAL_ROS_ROLE_CALIBRATION_VERSION,
        kickerCalibration: HISTORICAL_ROS_KICKER_CALIBRATION_VERSION,
        playerAssembly: "live-ros-football-input-v2",
        defenseAssembly: "live-ros-defense-football-input-v2",
        defenseRecencyAssembly: "live-ros-defense-recency-adapter-v1",
      },
      season: input.season,
      window: {
        asOfWeek: input.window.asOfWeek,
        windowStartWeek: input.window.windowStartWeek,
        windowEndWeek: input.window.windowEndWeek,
      },
      scenarioCount,
      referenceScenarioCount,
    }),
  );
  hash.update("\n");
  const addRows = (kind: string, name: string, rows: readonly unknown[]) => {
    hash.update(canonicalJson({ kind, name, count: rows.length }));
    hash.update("\n");
    for (const row of canonicalRosLiveRows(rows)) {
      hash.update(canonicalJson(row));
      hash.update("\n");
    }
  };
  addRows("sources", "observation-feeds", sources);
  for (const name of Object.keys(input.rows).sort()) addRows("facts", name, input.rows[name]!);
  return hash.digest("hex");
}
