import { leagueScoringPositionComponents, LEAGUE_SCORING_POSITIONS } from "./league-scoring.js";
import {
  FIRST_PARTY_ROS_MAXIMUM_SCENARIOS,
  FIRST_PARTY_ROS_MINIMUM_SCENARIOS,
  FIRST_PARTY_ROS_DEFAULT_SCENARIOS,
  FIRST_PARTY_ROS_MODEL_VERSION,
  projectFirstPartyRestOfSeason,
  type FirstPartyRosProjection,
  type FirstPartyRosProjectionInput,
  type FirstPartyRosProjectionProvenance,
} from "./rest-of-season.js";
import {
  canonicalProjectionScoringRules,
  projectionScoringProfileKey,
  type ProjectionScoringProfile,
} from "./scoring.js";

export const FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION = "ros-joint-component-outcomes-v1";

/** Football inputs only. Calibration and caller seed must also be scoring independent. */
export type FirstPartyRosOutcomeInput = Omit<FirstPartyRosProjectionInput, "scoringProfile">;

/**
 * Each column index describes the SAME complete remaining-season path. Keeping this alignment
 * preserves availability, correlations and the low tail when a league changes its points.
 * Columns contain sums of weekly components, including any already-modeled weekly transforms.
 * Raw threshold bonuses cannot be applied to these season totals.
 */
export interface FirstPartyRosOutcomeEnsemble {
  readonly schemaVersion: typeof FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION;
  readonly modelVersion: typeof FIRST_PARTY_ROS_MODEL_VERSION;
  readonly scenarioCount: number;
  readonly columns: Readonly<Record<string, Float64Array>>;
  readonly games: Uint8Array;
  readonly metadata: {
    readonly playerId: string;
    readonly position: FirstPartyRosProjection["position"];
    readonly scheduledGames: number;
    readonly provenance: Omit<FirstPartyRosProjectionProvenance, "scoringProfileKey">;
    readonly simulation: FirstPartyRosProjection["simulation"];
    readonly diagnostics: FirstPartyRosProjection["diagnostics"];
  };
}

export interface FirstPartyRosOutcomeScore {
  readonly seedHash: string;
  readonly diagnostics: FirstPartyRosProjection["diagnostics"];
  readonly expectedGames: number;
  readonly meanPoints: number;
  readonly standardDeviation: number;
  readonly p15Points: number;
  readonly p50Points: number;
  readonly p85Points: number;
  readonly scoringProfileKey: string;
  readonly scenarioCount: number;
}

/**
 * Retains one forecast's sufficient joint component vectors. The zero-valued internal scorer
 * does not influence any random draw or football transition. No league identity enters here.
 * This API does not by itself authorize publication: the input calibrations and held-out proof
 * must belong to the declared model, and league-specific evaluation still runs after rescoring.
 */
export function simulateFirstPartyRosOutcomes(
  input: FirstPartyRosOutcomeInput,
): FirstPartyRosOutcomeEnsemble {
  const columns: Record<string, Float64Array> = {};
  let games: Uint8Array | undefined;
  const scenarioCount = input.scenarioCount ?? FIRST_PARTY_ROS_DEFAULT_SCENARIOS;
  if (
    new Set(
      input.weeks.flatMap((week) => [
        ...Object.keys(week.contextualComponents),
        ...Object.keys(week.recencyComponents),
      ]),
    ).size > 512
  )
    throw new RangeError("Too many ROS outcome components");
  // The engine validates the scenario count before invoking the sink; avoid allocating from an
  // unvalidated count or restating its default here.
  const projection = projectFirstPartyRestOfSeason(
    {
      ...input,
      scoringProfile: {
        id: "football-outcomes-only",
        rules: [{ statId: "receptions", points: 0 }],
      },
    },
    (scenario) => {
      games ??= new Uint8Array(scenarioCount);
      games[scenario.index] = scenario.games;
      for (const [statId, value] of Object.entries(scenario.components)) {
        const column = (columns[statId] ??= new Float64Array(scenarioCount));
        column[scenario.index] = value;
      }
    },
  );
  const provenance: Omit<FirstPartyRosProjectionProvenance, "scoringProfileKey"> = {
    ...projection.provenance,
  };
  Reflect.deleteProperty(provenance, "scoringProfileKey");
  // Include known all-zero columns even when every path was unavailable.
  for (const statId of Object.keys(projection.expectedComponents)) {
    columns[statId] ??= new Float64Array(scenarioCount);
  }
  return {
    schemaVersion: FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION,
    modelVersion: FIRST_PARTY_ROS_MODEL_VERSION,
    scenarioCount,
    columns: Object.fromEntries(
      Object.entries(columns)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([statId, column]) => [statId, column.subarray(0, scenarioCount)]),
    ),
    games: games!.subarray(0, scenarioCount),
    metadata: {
      playerId: projection.playerId,
      position: projection.position,
      scheduledGames: projection.scheduledGames,
      provenance,
      simulation: projection.simulation,
      diagnostics: projection.diagnostics,
    },
  };
}

function quantile(sorted: readonly number[], probability: number): number {
  const offset = (sorted.length - 1) * probability;
  const lower = Math.floor(offset);
  return sorted[lower]! + (sorted[Math.ceil(offset)]! - sorted[lower]!) * (offset - lower);
}

/**
 * Reprices joint outcomes in O(paths × priced components), with no model fitting or simulation.
 * A prefix uses exactly the release draws from a larger convergence-reference ensemble.
 */
function scoreOutcomeDistribution(
  ensemble: FirstPartyRosOutcomeEnsemble,
  profile: ProjectionScoringProfile,
  scenarioCount: number,
  retainSamples: boolean,
): { readonly summary: FirstPartyRosOutcomeScore; readonly samples: readonly number[] | null } {
  if (
    ensemble.schemaVersion !== FIRST_PARTY_ROS_OUTCOME_SCHEMA_VERSION ||
    ensemble.modelVersion !== FIRST_PARTY_ROS_MODEL_VERSION ||
    ensemble.metadata.provenance.modelVersion !== ensemble.modelVersion ||
    ensemble.metadata.provenance.scenarioCount !== ensemble.scenarioCount
  ) {
    throw new TypeError("ROS outcome model or schema identity mismatch");
  }
  if (
    !Number.isSafeInteger(ensemble.scenarioCount) ||
    ensemble.scenarioCount < FIRST_PARTY_ROS_MINIMUM_SCENARIOS ||
    ensemble.scenarioCount > FIRST_PARTY_ROS_MAXIMUM_SCENARIOS ||
    ensemble.scenarioCount % 2 !== 0 ||
    !Number.isSafeInteger(scenarioCount) ||
    scenarioCount < FIRST_PARTY_ROS_MINIMUM_SCENARIOS ||
    scenarioCount > ensemble.scenarioCount ||
    scenarioCount % 2 !== 0 ||
    !(ensemble.games instanceof Uint8Array) ||
    ensemble.games.length !== ensemble.scenarioCount
  ) {
    throw new RangeError("Invalid ROS outcome scenario count");
  }
  const columnEntries = Object.entries(ensemble.columns);
  if (columnEntries.length === 0 || columnEntries.length > 512)
    throw new RangeError("Invalid ROS outcome component count");
  for (const [statId, column] of columnEntries) {
    if (
      !statId.trim() ||
      !(column instanceof Float64Array) ||
      column.length !== ensemble.scenarioCount
    )
      throw new TypeError("Invalid ROS outcome component column");
    // Inspect the full persisted vector, including beyond a requested release prefix.
    if (column.some((value) => !Number.isFinite(value)))
      throw new TypeError("Non-finite ROS outcome component");
  }
  if (
    !Number.isSafeInteger(ensemble.metadata.scheduledGames) ||
    ensemble.metadata.scheduledGames < 0 ||
    ensemble.metadata.scheduledGames > 18 ||
    ensemble.games.some((value) => value > ensemble.metadata.scheduledGames)
  ) {
    throw new RangeError("Invalid ROS outcome games");
  }
  const scoringProfileKey = projectionScoringProfileKey(profile);
  const rules = canonicalProjectionScoringRules(profile.rules);
  if (!LEAGUE_SCORING_POSITIONS.includes(ensemble.metadata.position))
    throw new TypeError("Invalid ROS outcome position");
  const vocabulary = leagueScoringPositionComponents(ensemble.metadata.position);
  const allComponents = new Set(
    LEAGUE_SCORING_POSITIONS.flatMap((position) => [...leagueScoringPositionComponents(position)]),
  );
  for (const rule of rules) {
    if (rule.bonuses.length > 0)
      throw new TypeError("Weekly threshold bonuses cannot be scored from season component totals");
    if (!allComponents.has(rule.statId))
      throw new TypeError(`Unknown scoring component ${rule.statId}`);
    if (
      rule.points !== 0 &&
      vocabulary.has(rule.statId) &&
      !Object.hasOwn(ensemble.columns, rule.statId)
    )
      throw new TypeError(`ROS outcomes lack scored component ${rule.statId}`);
  }
  const priced = rules.filter(
    (rule) => rule.points !== 0 && Object.hasOwn(ensemble.columns, rule.statId),
  );
  const points = new Array<number>(scenarioCount);
  let pointsSum = 0;
  let gamesSum = 0;
  for (let index = 0; index < scenarioCount; index += 1) {
    let total = 0;
    for (const rule of priced) total += ensemble.columns[rule.statId]![index]! * rule.points;
    if (!Number.isFinite(total)) throw new RangeError("ROS outcome score overflow");
    points[index] = total;
    pointsSum += total;
    gamesSum += ensemble.games[index]!;
  }
  const meanPoints = pointsSum / scenarioCount;
  const variance =
    points.reduce((sum, value) => sum + (value - meanPoints) ** 2, 0) / scenarioCount;
  if (!Number.isFinite(meanPoints) || !Number.isFinite(variance))
    throw new RangeError("ROS outcome distribution overflow");
  // Copy only on the explicit diagnostic path. Sorting for quantiles must not destroy physical
  // antithetic order, and a caller changing retained samples cannot alter the persisted vectors.
  const samples = retainSamples ? points.slice() : null;
  points.sort((left, right) => left - right);
  return {
    samples,
    summary: {
      seedHash: ensemble.metadata.provenance.seedHash,
      diagnostics: ensemble.metadata.diagnostics,
      expectedGames: gamesSum / scenarioCount,
      meanPoints,
      standardDeviation: Math.sqrt(variance),
      p15Points: quantile(points, 0.15),
      p50Points: quantile(points, 0.5),
      p85Points: quantile(points, 0.85),
      scoringProfileKey,
      scenarioCount,
    },
  };
}

/** Reprice validated paths with the existing summary and type-7 quantile definition unchanged. */
export function scoreFirstPartyRosOutcomes(
  ensemble: FirstPartyRosOutcomeEnsemble,
  profile: ProjectionScoringProfile,
  scenarioCount = ensemble.scenarioCount,
): FirstPartyRosOutcomeScore {
  return scoreOutcomeDistribution(ensemble, profile, scenarioCount, false).summary;
}

/**
 * The same validated scorer, additionally retaining scores in original adjacent antithetic-pair
 * order for numerical diagnostics. This returns a private score copy, never outcome columns.
 * A sample vector or its summary alone is not a convergence or predictive-accuracy assertion.
 */
export function scoreFirstPartyRosOutcomesWithSamples(
  ensemble: FirstPartyRosOutcomeEnsemble,
  profile: ProjectionScoringProfile,
  scenarioCount = ensemble.scenarioCount,
): { readonly summary: FirstPartyRosOutcomeScore; readonly samples: readonly number[] } {
  const result = scoreOutcomeDistribution(ensemble, profile, scenarioCount, true);
  return { summary: result.summary, samples: result.samples! };
}
