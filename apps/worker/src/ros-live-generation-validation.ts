import {
  FIRST_PARTY_PROJECTION_MODEL_VERSION,
  DEFENSE_POINTS_ALLOWED_DEFINITIONS,
  type ProjectionDefensePointsAllowedDefinition,
  FIRST_PARTY_ROS_MODEL_VERSION,
  projectionScoringProfileKey,
  type ProjectionScoringProfile,
} from "@laces-out/projections";
import {
  HISTORICAL_ROS_AVAILABILITY_CALIBRATION_VERSION,
  HISTORICAL_ROS_ROLE_CALIBRATION_VERSION,
  HISTORICAL_ROS_KICKER_CALIBRATION_VERSION,
} from "./first-party-ros-backtest.js";
import type { calibrateFirstPartyRosPlayerHistory } from "./first-party-ros-candidate-provider.js";
import type { FirstPartyTeamDefenseCalibration } from "@laces-out/projections";
import type {
  FirstPartyRosPublicationTarget,
  FirstPartyRosWindow,
} from "./first-party-ros-projections.js";

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid live ROS cached object");
  return value as Record<string, unknown>;
}
function requireValue(condition: boolean): asserts condition {
  if (!condition) throw new TypeError("Live ROS cached generation identity or shape mismatch");
}
function numericRecord(value: unknown): void {
  requireValue(
    Object.values(record(value)).every(
      (entry) => typeof entry === "number" && Number.isFinite(entry),
    ),
  );
}
function intervals(value: unknown): void {
  for (const item of Object.values(record(value))) {
    const row = record(item);
    requireValue(
      Number.isSafeInteger(row.samples) &&
        Number(row.samples) >= 0 &&
        typeof row.fallback === "boolean",
    );
    for (const key of ["lowerError", "upperError", "mae", "rmse"])
      requireValue(typeof row[key] === "number" && Number.isFinite(row[key]));
  }
}
export function restoreRosLiveCalibration(value: unknown): {
  readonly player: ReturnType<typeof calibrateFirstPartyRosPlayerHistory>;
  readonly defenseByDefinition: Readonly<
    Record<ProjectionDefensePointsAllowedDefinition, FirstPartyTeamDefenseCalibration>
  >;
} {
  const root = record(value);
  const player = record(root.player);
  const weekly = record(player.weekly);
  requireValue(weekly.modelVersion === FIRST_PARTY_PROJECTION_MODEL_VERSION);
  for (const item of Object.values(record(weekly.intervals))) intervals(item);
  const defenses = record(root.defenseByDefinition);
  requireValue(Object.keys(defenses).length === DEFENSE_POINTS_ALLOWED_DEFINITIONS.length);
  for (const definition of DEFENSE_POINTS_ALLOWED_DEFINITIONS) {
    requireValue(Object.hasOwn(defenses, definition));
    const defense = record(defenses[definition]);
    requireValue(defense.modelVersion === FIRST_PARTY_PROJECTION_MODEL_VERSION);
    intervals(defense.intervals);
  }
  const availability = record(player.availability);
  requireValue(availability.version === HISTORICAL_ROS_AVAILABILITY_CALIBRATION_VERSION);
  numericRecord(availability.global);
  for (const key of [
    "newAbsenceByPositionStreak",
    "recoveryByPositionStreak",
    "absentRecoveryByPosition",
    "asymptoteByPositionStreak",
  ])
    numericRecord(availability[key]);
  const role = record(player.role);
  requireValue(role.version === HISTORICAL_ROS_ROLE_CALIBRATION_VERSION);
  numericRecord(role.fallback);
  for (const item of Object.values(record(role.byPosition))) numericRecord(item);
  const kicker = record(player.kicker);
  requireValue(kicker.version === HISTORICAL_ROS_KICKER_CALIBRATION_VERSION);
  for (const key of ["fgEventDispersion", "xpDispersion", "centerVolatility"])
    requireValue(typeof kicker[key] === "number" && Number.isFinite(kicker[key]));
  for (const [key, length] of [
    ["leagueBucketMix", 3],
    ["leagueMissBucketMix", 6],
  ] as const)
    requireValue(
      Array.isArray(kicker[key]) &&
        kicker[key].length === length &&
        kicker[key].every((entry) => typeof entry === "number" && Number.isFinite(entry)),
    );
  numericRecord(kicker.dispersionAudit);
  numericRecord(kicker.evidence);
  requireValue(kicker.familyAudit === "within-bounds" || kicker.familyAudit === "out-of-bounds");
  return structuredClone(value) as ReturnType<typeof restoreRosLiveCalibration>;
}

/** Canonical templates contain public player facts; aliases and league identity are always applied anew. */
export function restoreRosLiveTargetTemplate(
  value: unknown,
  expected: {
    readonly scoringProfileKey: string;
    readonly asOfAt: string;
    readonly season: number;
    readonly window: FirstPartyRosWindow;
  },
): Omit<FirstPartyRosPublicationTarget, "leagueSeasonId"> {
  const root = record(value);
  requireValue(!Object.hasOwn(root, "leagueSeasonId"));
  requireValue(
    root.leagueScoringProfileKey === expected.scoringProfileKey &&
      projectionScoringProfileKey(
        record(root.leagueScoringProfile) as unknown as ProjectionScoringProfile,
      ) === expected.scoringProfileKey,
  );
  requireValue(
    typeof root.sourceAsOf === "string" &&
      Number.isFinite(Date.parse(root.sourceAsOf)) &&
      new Date(root.sourceAsOf).toISOString() === root.sourceAsOf,
  );
  requireValue(
    Array.isArray(root.evidence) &&
      root.evidence.length > 0 &&
      Array.isArray(root.supportedPositions) &&
      Array.isArray(root.released) &&
      root.released.length > 0,
  );
  const universe = record(root.candidateUniverse);
  requireValue(
    Array.isArray(universe.playerAliases) &&
      universe.playerAliases.length === 0 &&
      Array.isArray(universe.playerAliasIssues) &&
      universe.playerAliasIssues.length === 0,
  );
  const ids = new Set<string>();
  for (const item of root.released) {
    const entry = record(item);
    const projection = record(entry.projection);
    const provenance = record(projection.provenance);
    requireValue(
      typeof entry.playerId === "string" &&
        !ids.has(entry.playerId) &&
        projection.playerId === entry.playerId,
    );
    ids.add(entry.playerId);
    requireValue(
      provenance.modelVersion === FIRST_PARTY_ROS_MODEL_VERSION &&
        provenance.asOfAt === expected.asOfAt &&
        provenance.season === expected.season &&
        provenance.asOfWeek === expected.window.asOfWeek &&
        provenance.windowStartWeek === expected.window.windowStartWeek &&
        provenance.windowEndWeek === expected.window.windowEndWeek &&
        provenance.scoringProfileKey === expected.scoringProfileKey,
    );
  }
  return {
    ...structuredClone(value as Omit<FirstPartyRosPublicationTarget, "leagueSeasonId">),
    sourceAsOf: new Date(root.sourceAsOf),
  };
}
