import type { MarginalIntervalQuantiles } from "./marginal-interval-calibration.js";
import { sha256Hex } from "./sha256.js";

/** A fixed descriptive development screen, never a production admission or probability guarantee. */
export const MARGINAL_INTERVAL_EVIDENCE_VERSION = "season-cutoff-player-marginal-evidence-v1";
export const MARGINAL_INTERVAL_SCREEN_VERSION = "marginal-coverage-tail-development-screen-v1";
export const MARGINAL_INTERVAL_EVIDENCE_MAX_ROWS = 20_000;
const MAX_BLOCKS = 201 * 18;
const QUANTILES = [0.15, 0.5, 0.85] as const;
const ENDPOINTS = ["p15Points", "p50Points", "p85Points"] as const;
type Triple<T> = readonly [T, T, T];

export interface MarginalIntervalEvaluationRow extends MarginalIntervalQuantiles {
  readonly seriesKey: string;
  readonly identity: string;
  readonly playerId: string;
  readonly forecastSeason: number;
  readonly asOfWeek: number;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly scheduledGames: number;
  readonly actualPoints: number;
  readonly rawQuantiles: MarginalIntervalQuantiles;
  readonly artifactChecksum: string;
  readonly trainedThroughSeason: number;
}

export interface MarginalIntervalFraction {
  readonly numerator: string;
  readonly denominator: string;
}

export interface MarginalIntervalEndpointCounts {
  readonly below: number;
  readonly equal: number;
  readonly above: number;
}

/** Enough statistics to reconstruct descriptive scores; the source rows stay checksum-bound. */
export interface MarginalIntervalEvidenceBlock {
  readonly forecastSeason: number;
  readonly asOfWeek: number;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly scheduledGamesRange: readonly [number, number];
  readonly artifactChecksum: string;
  readonly trainedThroughSeason: number;
  readonly sourceRowsChecksum: string;
  readonly samples: number;
  readonly coverageCount: number;
  readonly lowerTailCount: number;
  readonly upperTailCount: number;
  readonly endpointCounts: Triple<MarginalIntervalEndpointCounts>;
  readonly pinballSums: Triple<number>;
  readonly wisSum: number;
  readonly rawWisSum: number;
  readonly intervalScoreSum: number;
  readonly widthSum: number;
}

export interface MarginalIntervalDescriptiveMetrics {
  readonly coverage: MarginalIntervalFraction;
  readonly lowerTail: MarginalIntervalFraction;
  readonly upperTail: MarginalIntervalFraction;
  readonly endpointFractions: Triple<{
    readonly below: MarginalIntervalFraction;
    readonly equal: MarginalIntervalFraction;
    readonly above: MarginalIntervalFraction;
  }>;
  readonly pinball: Triple<number>;
  readonly wis: number;
  readonly rawWis: number;
  readonly intervalScore: number;
  readonly width: number;
}

interface EvidenceSummary {
  readonly seasons: number;
  readonly blocks: number;
  readonly samples: number;
  readonly distinctCutoffs: number;
  readonly metrics: MarginalIntervalDescriptiveMetrics | null;
}

export interface MarginalIntervalEvidence {
  readonly schemaVersion: 1;
  readonly version: typeof MARGINAL_INTERVAL_EVIDENCE_VERSION;
  readonly target: "individual-player-marginal-quantiles";
  readonly quantiles: typeof QUANTILES;
  readonly weighting: "equal-season-equal-cutoff-equal-player";
  readonly interpretation: "overlapping-outcomes-descriptive-only";
  readonly seriesKey: string;
  readonly sourceRowsChecksum: string;
  readonly blocks: readonly MarginalIntervalEvidenceBlock[];
  readonly overall: EvidenceSummary;
  readonly perSeason: readonly (EvidenceSummary & { readonly forecastSeason: number })[];
  readonly descriptive: {
    readonly seasonRange: {
      readonly coverage: readonly [number, number];
      readonly lowerTail: readonly [number, number];
      readonly upperTail: readonly [number, number];
      readonly wis: readonly [number, number];
      readonly rawWis: readonly [number, number];
      readonly intervalScore: readonly [number, number];
      readonly width: readonly [number, number];
    } | null;
    readonly leaveOneSeasonOut: readonly (EvidenceSummary & { readonly excludedSeason: number })[];
  };
  readonly evidenceChecksum: string;
}

export type MarginalIntervalScreenReason =
  | "invalid-evidence"
  | "fewer-than-1-seasons"
  | "fewer-than-3-blocks"
  | "fewer-than-18-rows"
  | "coverage-below-three-fifths"
  | "lower-tail-above-one-quarter"
  | "upper-tail-above-one-quarter";

export interface MarginalIntervalScreenResult {
  readonly version: typeof MARGINAL_INTERVAL_SCREEN_VERSION;
  readonly state:
    "descriptive-screen-passed" | "insufficient-evidence" | "failed-screen" | "invalid-evidence";
  readonly reasons: readonly MarginalIntervalScreenReason[];
  readonly evidenceChecksum: string | null;
  readonly overall: EvidenceSummary | null;
}

function fail(label: string): never {
  throw new TypeError(`Marginal interval evidence ${label}`);
}

function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail(`${label} has missing or unknown fields`);
  return value as Record<string, unknown>;
}

function array(value: unknown, min: number, max: number, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    fail(`${label} has an invalid array bound`);
  if (Object.keys(value).length !== value.length) fail(`${label} must be a dense array`);
  for (let index = 0; index < value.length; index++)
    if (!Object.hasOwn(value, index)) fail(`${label} must be a dense array`);
  return value;
}

function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    fail(`${label} must be an integer in ${min}..${max}`);
  return value === 0 ? 0 : value;
}

function finite(value: unknown, label: string, nonnegative = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (nonnegative && value < 0))
    fail(`${label} must be ${nonnegative ? "nonnegative and " : ""}finite`);
  return value === 0 ? 0 : value;
}

function text(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max)
    fail(`${label} must be bounded nonempty text`);
  return value;
}

function checksum(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    fail(`${label} must be a SHA256 digest`);
  return value;
}

function quantiles(value: unknown, label: string): MarginalIntervalQuantiles {
  const fields = object(value, ENDPOINTS, label);
  const result = {
    p15Points: finite(fields.p15Points, `${label}.p15Points`),
    p50Points: finite(fields.p50Points, `${label}.p50Points`),
    p85Points: finite(fields.p85Points, `${label}.p85Points`),
  };
  if (result.p15Points > result.p50Points || result.p50Points > result.p85Points)
    fail(`${label} must be ordered`);
  return result;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Canonical order makes JSONB object key reordering immaterial; array order remains meaningful. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("cannot serialize undefined evidence");
  return encoded;
}

function sameValue(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    if (
      !Array.isArray(actual) ||
      actual.length !== expected.length ||
      Object.keys(actual).length !== actual.length
    )
      return false;
    for (let index = 0; index < expected.length; index++)
      if (!Object.hasOwn(actual, index) || !sameValue(actual[index], expected[index])) return false;
    return true;
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    const keys = Object.keys(expectedRecord);
    return (
      Object.keys(actualRecord).length === keys.length &&
      keys.every(
        (key) => Object.hasOwn(actual, key) && sameValue(actualRecord[key], expectedRecord[key]),
      )
    );
  }
  return actual === expected;
}

const ROW_KEYS = [
  "seriesKey",
  "identity",
  "playerId",
  "forecastSeason",
  "asOfWeek",
  "windowStartWeek",
  "windowEndWeek",
  "scheduledGames",
  "actualPoints",
  ...ENDPOINTS,
  "rawQuantiles",
  "artifactChecksum",
  "trainedThroughSeason",
] as const;

function validateRow(value: unknown, seriesKey: string): MarginalIntervalEvaluationRow {
  const row = object(value, ROW_KEYS, "row");
  if (row.seriesKey !== seriesKey) fail("row has a different series identity");
  const forecastSeason = integer(row.forecastSeason, 2000, 2200, "forecast season");
  const asOfWeek = integer(row.asOfWeek, 0, 17, "cutoff");
  const windowStartWeek = integer(row.windowStartWeek, asOfWeek + 1, 18, "window start");
  const windowEndWeek = integer(row.windowEndWeek, windowStartWeek, 18, "window end");
  return {
    seriesKey,
    identity: text(row.identity, 8_192, "row identity"),
    playerId: text(row.playerId, 256, "player identity"),
    forecastSeason,
    asOfWeek,
    windowStartWeek,
    windowEndWeek,
    scheduledGames: integer(
      row.scheduledGames,
      1,
      Math.min(17, windowEndWeek - windowStartWeek + 1),
      "scheduled games",
    ),
    actualPoints: finite(row.actualPoints, "actual points"),
    ...quantiles(
      { p15Points: row.p15Points, p50Points: row.p50Points, p85Points: row.p85Points },
      "corrected quantiles",
    ),
    rawQuantiles: quantiles(row.rawQuantiles, "raw quantiles"),
    artifactChecksum: checksum(row.artifactChecksum, "fit artifact checksum"),
    trainedThroughSeason: integer(
      row.trainedThroughSeason,
      1999,
      forecastSeason - 1,
      "fit training season",
    ),
  };
}

function pinball(actual: number, predicted: number, tau: number): number {
  return finite(
    actual >= predicted ? tau * (actual - predicted) : (1 - tau) * (predicted - actual),
    "pinball loss",
    true,
  );
}

function scores(actual: number, q: MarginalIntervalQuantiles) {
  const width = finite(q.p85Points - q.p15Points, "interval width", true);
  const intervalScore = finite(
    width +
      (actual < q.p15Points ? (2 / 0.3) * (q.p15Points - actual) : 0) +
      (actual > q.p85Points ? (2 / 0.3) * (actual - q.p85Points) : 0),
    "interval score",
    true,
  );
  const wis = finite(
    (0.5 * Math.abs(actual - q.p50Points) + 0.15 * intervalScore) / 1.5,
    "WIS",
    true,
  );
  return { width, intervalScore, wis };
}

function buildBlock(rows: readonly MarginalIntervalEvaluationRow[]): MarginalIntervalEvidenceBlock {
  const first = rows[0]!;
  const endpointCounts = QUANTILES.map(() => ({ below: 0, equal: 0, above: 0 }));
  const pinballSums = [0, 0, 0];
  let coverageCount = 0,
    lowerTailCount = 0,
    upperTailCount = 0,
    wisSum = 0,
    rawWisSum = 0,
    intervalScoreSum = 0,
    widthSum = 0;
  let minimumGames = 17,
    maximumGames = 1;
  for (const row of rows) {
    if (row.windowStartWeek !== first.windowStartWeek || row.windowEndWeek !== first.windowEndWeek)
      fail("one cutoff has conflicting forecast windows");
    if (row.actualPoints < row.p15Points) lowerTailCount++;
    else if (row.actualPoints > row.p85Points) upperTailCount++;
    else coverageCount++;
    for (let index = 0; index < 3; index++) {
      const predicted = row[ENDPOINTS[index]!];
      const category =
        row.actualPoints < predicted ? "below" : row.actualPoints > predicted ? "above" : "equal";
      endpointCounts[index]![category]++;
      pinballSums[index] = finite(
        pinballSums[index]! + pinball(row.actualPoints, predicted, QUANTILES[index]!),
        "pinball sum",
        true,
      );
    }
    const corrected = scores(row.actualPoints, row);
    wisSum = finite(wisSum + corrected.wis, "WIS sum", true);
    rawWisSum = finite(
      rawWisSum + scores(row.actualPoints, row.rawQuantiles).wis,
      "raw WIS sum",
      true,
    );
    intervalScoreSum = finite(
      intervalScoreSum + corrected.intervalScore,
      "interval score sum",
      true,
    );
    widthSum = finite(widthSum + corrected.width, "width sum", true);
    minimumGames = Math.min(minimumGames, row.scheduledGames);
    maximumGames = Math.max(maximumGames, row.scheduledGames);
  }
  return {
    forecastSeason: first.forecastSeason,
    asOfWeek: first.asOfWeek,
    windowStartWeek: first.windowStartWeek,
    windowEndWeek: first.windowEndWeek,
    scheduledGamesRange: [minimumGames, maximumGames],
    artifactChecksum: first.artifactChecksum,
    trainedThroughSeason: first.trainedThroughSeason,
    // Hash bounded individual rows before their ordered digest list. A long series key shared by
    // 20,000 rows must not require constructing a second enormous serialized row corpus.
    sourceRowsChecksum: sha256Hex(canonicalJson(rows.map((row) => sha256Hex(canonicalJson(row))))),
    samples: rows.length,
    coverageCount,
    lowerTailCount,
    upperTailCount,
    endpointCounts: endpointCounts as unknown as Triple<MarginalIntervalEndpointCounts>,
    pinballSums: pinballSums as unknown as Triple<number>,
    wisSum,
    rawWisSum,
    intervalScoreSum,
    widthSum,
  };
}

type Rational = readonly [bigint, bigint];
function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}
function add(a: Rational, b: Rational): Rational {
  const denominator = a[1] * b[1];
  const numerator = a[0] * b[1] + b[0] * a[1];
  const divisor = gcd(numerator, denominator);
  return [numerator / divisor, denominator / divisor];
}
function fraction(value: Rational): MarginalIntervalFraction {
  return { numerator: value[0].toString(), denominator: value[1].toString() };
}
function fractionNumber(value: MarginalIntervalFraction): number {
  // Denominators can exceed binary64. This conversion is display-only; screen comparisons stay exact.
  return Number((BigInt(value.numerator) * 10n ** 16n) / BigInt(value.denominator)) / 1e16;
}

function summarize(blocks: readonly MarginalIntervalEvidenceBlock[]): EvidenceSummary {
  const bySeason = new Map<number, number>();
  for (const block of blocks)
    bySeason.set(block.forecastSeason, (bySeason.get(block.forecastSeason) ?? 0) + 1);
  const summary = {
    seasons: bySeason.size,
    blocks: blocks.length,
    samples: blocks.reduce((sum, block) => sum + block.samples, 0),
    distinctCutoffs: new Set(blocks.map((block) => block.asOfWeek)).size,
  };
  if (blocks.length === 0) return { ...summary, metrics: null };
  const weightedCount = (count: (block: MarginalIntervalEvidenceBlock) => number) =>
    fraction(
      blocks.reduce<Rational>(
        (total, block) =>
          add(total, [
            BigInt(count(block)),
            BigInt(bySeason.size * bySeason.get(block.forecastSeason)! * block.samples),
          ]),
        [0n, 1n],
      ),
    );
  const weightedScore = (score: (block: MarginalIntervalEvidenceBlock) => number) =>
    finite(
      blocks.reduce(
        (total, block) =>
          total +
          score(block) / block.samples / bySeason.get(block.forecastSeason)! / bySeason.size,
        0,
      ),
      "weighted score",
      true,
    );
  return {
    ...summary,
    metrics: {
      coverage: weightedCount((block) => block.coverageCount),
      lowerTail: weightedCount((block) => block.lowerTailCount),
      upperTail: weightedCount((block) => block.upperTailCount),
      endpointFractions: QUANTILES.map((_, index) => ({
        below: weightedCount((block) => block.endpointCounts[index]!.below),
        equal: weightedCount((block) => block.endpointCounts[index]!.equal),
        above: weightedCount((block) => block.endpointCounts[index]!.above),
      })) as unknown as MarginalIntervalDescriptiveMetrics["endpointFractions"],
      pinball: QUANTILES.map((_, index) =>
        weightedScore((block) => block.pinballSums[index]!),
      ) as unknown as Triple<number>,
      wis: weightedScore((block) => block.wisSum),
      rawWis: weightedScore((block) => block.rawWisSum),
      intervalScore: weightedScore((block) => block.intervalScoreSum),
      width: weightedScore((block) => block.widthSum),
    },
  };
}

function envelope(
  seriesKey: string,
  sourceRowsChecksum: string,
  blocks: readonly MarginalIntervalEvidenceBlock[],
): MarginalIntervalEvidence {
  const seasons = [...new Set(blocks.map((block) => block.forecastSeason))].sort((a, b) => a - b);
  const perSeason = seasons.map((forecastSeason) => ({
    forecastSeason,
    ...summarize(blocks.filter((block) => block.forecastSeason === forecastSeason)),
  }));
  const range = (
    get: (value: MarginalIntervalDescriptiveMetrics) => number,
  ): readonly [number, number] => {
    const values = perSeason.map((season) => get(season.metrics!));
    return [Math.min(...values), Math.max(...values)];
  };
  const payload: Omit<MarginalIntervalEvidence, "evidenceChecksum"> = {
    schemaVersion: 1,
    version: MARGINAL_INTERVAL_EVIDENCE_VERSION,
    target: "individual-player-marginal-quantiles",
    quantiles: [0.15, 0.5, 0.85],
    weighting: "equal-season-equal-cutoff-equal-player",
    interpretation: "overlapping-outcomes-descriptive-only",
    seriesKey,
    sourceRowsChecksum,
    blocks,
    overall: summarize(blocks),
    perSeason,
    descriptive: {
      seasonRange:
        seasons.length === 0
          ? null
          : {
              coverage: range((metrics) => fractionNumber(metrics.coverage)),
              lowerTail: range((metrics) => fractionNumber(metrics.lowerTail)),
              upperTail: range((metrics) => fractionNumber(metrics.upperTail)),
              wis: range((metrics) => metrics.wis),
              rawWis: range((metrics) => metrics.rawWis),
              intervalScore: range((metrics) => metrics.intervalScore),
              width: range((metrics) => metrics.width),
            },
      leaveOneSeasonOut:
        seasons.length < 2
          ? []
          : seasons.map((excludedSeason) => ({
              excludedSeason,
              ...summarize(blocks.filter((block) => block.forecastSeason !== excludedSeason)),
            })),
    },
  };
  return { ...payload, evidenceChecksum: sha256Hex(canonicalJson(payload)) };
}

/** Builds evidence only from strictly prior-fitted forecasts; no current-season refitting is allowed. */
export function buildMarginalIntervalEvidence(input: {
  readonly seriesKey: string;
  readonly rows: readonly MarginalIntervalEvaluationRow[];
}): MarginalIntervalEvidence {
  object(input, ["seriesKey", "rows"], "input");
  const seriesKey = text(input.seriesKey, 8_192, "series identity");
  const rows = array(input.rows, 0, MARGINAL_INTERVAL_EVIDENCE_MAX_ROWS, "rows")
    .map((row) => validateRow(row, seriesKey))
    .sort(
      (a, b) =>
        a.forecastSeason - b.forecastSeason ||
        a.asOfWeek - b.asOfWeek ||
        compareText(a.playerId, b.playerId) ||
        compareText(a.identity, b.identity),
    );
  const identities = new Set<string>();
  const semanticIdentities = new Set<string>();
  const seasonFits = new Map<number, string>();
  const groups = new Map<string, MarginalIntervalEvaluationRow[]>();
  for (const row of rows) {
    const semanticIdentity = canonicalJson([row.forecastSeason, row.asOfWeek, row.playerId]);
    if (identities.has(row.identity) || semanticIdentities.has(semanticIdentity))
      fail("contains duplicate forecast identities");
    identities.add(row.identity);
    semanticIdentities.add(semanticIdentity);
    const fitIdentity = canonicalJson([row.artifactChecksum, row.trainedThroughSeason]);
    if (seasonFits.has(row.forecastSeason) && seasonFits.get(row.forecastSeason) !== fitIdentity)
      fail("fit must stay locked throughout a forecast season");
    seasonFits.set(row.forecastSeason, fitIdentity);
    const key = `${row.forecastSeason}:${row.asOfWeek}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const blocks = [...groups.values()].map(buildBlock);
  return envelope(seriesKey, sourceBlockChecksum(blocks), blocks);
}

/** Ordered block digests bind the complete ordered raw-row corpus without exposing its rows. */
function sourceBlockChecksum(blocks: readonly MarginalIntervalEvidenceBlock[]): string {
  return sha256Hex(
    canonicalJson(
      blocks.map((block) => [block.forecastSeason, block.asOfWeek, block.sourceRowsChecksum]),
    ),
  );
}

const BLOCK_KEYS = [
  "forecastSeason",
  "asOfWeek",
  "windowStartWeek",
  "windowEndWeek",
  "scheduledGamesRange",
  "artifactChecksum",
  "trainedThroughSeason",
  "sourceRowsChecksum",
  "samples",
  "coverageCount",
  "lowerTailCount",
  "upperTailCount",
  "endpointCounts",
  "pinballSums",
  "wisSum",
  "rawWisSum",
  "intervalScoreSum",
  "widthSum",
] as const;

function validateBlock(value: unknown): MarginalIntervalEvidenceBlock {
  const block = object(value, BLOCK_KEYS, "block");
  const forecastSeason = integer(block.forecastSeason, 2000, 2200, "block season");
  const asOfWeek = integer(block.asOfWeek, 0, 17, "block cutoff");
  const windowStartWeek = integer(block.windowStartWeek, asOfWeek + 1, 18, "block window start");
  const windowEndWeek = integer(block.windowEndWeek, windowStartWeek, 18, "block window end");
  const games = array(block.scheduledGamesRange, 2, 2, "block game range");
  const minimumGames = integer(
    games[0],
    1,
    Math.min(17, windowEndWeek - windowStartWeek + 1),
    "minimum games",
  );
  const maximumGames = integer(
    games[1],
    minimumGames,
    Math.min(17, windowEndWeek - windowStartWeek + 1),
    "maximum games",
  );
  const samples = integer(block.samples, 1, MARGINAL_INTERVAL_EVIDENCE_MAX_ROWS, "block samples");
  if (samples === 1 && minimumGames !== maximumGames)
    fail("one-row block cannot have different minimum and maximum scheduled games");
  const coverageCount = integer(block.coverageCount, 0, samples, "coverage count");
  const lowerTailCount = integer(block.lowerTailCount, 0, samples, "lower-tail count");
  const upperTailCount = integer(block.upperTailCount, 0, samples, "upper-tail count");
  if (coverageCount + lowerTailCount + upperTailCount !== samples)
    fail("block outcome counts must partition samples");
  const endpointCounts = array(block.endpointCounts, 3, 3, "endpoint counts").map((value) => {
    const counts = object(value, ["below", "equal", "above"], "endpoint count");
    const result = {
      below: integer(counts.below, 0, samples, "below count"),
      equal: integer(counts.equal, 0, samples, "equal count"),
      above: integer(counts.above, 0, samples, "above count"),
    };
    if (result.below + result.equal + result.above !== samples)
      fail("endpoint counts must partition samples");
    return result;
  });
  if (endpointCounts[0]!.below !== lowerTailCount || endpointCounts[2]!.above !== upperTailCount)
    fail("endpoint counts disagree with tails");
  for (let index = 1; index < 3; index++) {
    if (
      endpointCounts[index - 1]!.below > endpointCounts[index]!.below ||
      endpointCounts[index - 1]!.above < endpointCounts[index]!.above
    )
      fail("endpoint counts contradict ordered quantiles");
  }
  const pinballSums = array(block.pinballSums, 3, 3, "pinball sums").map((value) =>
    finite(value, "pinball sum", true),
  );
  for (let index = 0; index < 3; index++)
    if (endpointCounts[index]!.equal === samples && pinballSums[index] !== 0)
      fail("all-tied endpoint must have zero pinball loss");
  const result: MarginalIntervalEvidenceBlock = {
    forecastSeason,
    asOfWeek,
    windowStartWeek,
    windowEndWeek,
    scheduledGamesRange: [minimumGames, maximumGames],
    samples,
    coverageCount,
    lowerTailCount,
    upperTailCount,
    artifactChecksum: checksum(block.artifactChecksum, "block fit checksum"),
    trainedThroughSeason: integer(
      block.trainedThroughSeason,
      1999,
      forecastSeason - 1,
      "block fit season",
    ),
    sourceRowsChecksum: checksum(block.sourceRowsChecksum, "block source checksum"),
    endpointCounts: endpointCounts as unknown as Triple<MarginalIntervalEndpointCounts>,
    pinballSums: pinballSums as unknown as Triple<number>,
    wisSum: finite(block.wisSum, "WIS sum", true),
    rawWisSum: finite(block.rawWisSum, "raw WIS sum", true),
    intervalScoreSum: finite(block.intervalScoreSum, "interval score sum", true),
    widthSum: finite(block.widthSum, "width sum", true),
  };
  if (result.intervalScoreSum < result.widthSum) fail("interval score cannot be below width");
  return result;
}

/**
 * Reconstructs every summary and checks the checksum after strict compact-block validation.
 * This detects corruption, not forged source data: callers must authenticate the admitted artifact
 * and sourceRowsChecksum. Compact evidence cannot independently recover its original raw rows.
 */
export function validateMarginalIntervalEvidence(value: unknown): MarginalIntervalEvidence {
  const record = object(
    value,
    [
      "schemaVersion",
      "version",
      "target",
      "quantiles",
      "weighting",
      "interpretation",
      "seriesKey",
      "sourceRowsChecksum",
      "blocks",
      "overall",
      "perSeason",
      "descriptive",
      "evidenceChecksum",
    ],
    "envelope",
  );
  const seriesKey = text(record.seriesKey, 8_192, "series identity");
  const sourceRowsChecksum = checksum(record.sourceRowsChecksum, "source checksum");
  checksum(record.evidenceChecksum, "evidence checksum");
  const blocks = array(record.blocks, 0, MAX_BLOCKS, "blocks").map(validateBlock);
  let samples = 0;
  const seasonFits = new Map<number, string>();
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!;
    const previous = blocks[index - 1];
    if (
      previous &&
      (previous.forecastSeason > block.forecastSeason ||
        (previous.forecastSeason === block.forecastSeason && previous.asOfWeek >= block.asOfWeek))
    )
      fail("blocks must be unique and chronologically sorted");
    samples += block.samples;
    if (samples > MARGINAL_INTERVAL_EVIDENCE_MAX_ROWS) fail("total samples exceed row bound");
    const fitIdentity = canonicalJson([block.artifactChecksum, block.trainedThroughSeason]);
    if (
      seasonFits.has(block.forecastSeason) &&
      seasonFits.get(block.forecastSeason) !== fitIdentity
    )
      fail("block fit must stay locked throughout a season");
    seasonFits.set(block.forecastSeason, fitIdentity);
  }
  const reconstructed = envelope(seriesKey, sourceRowsChecksum, blocks);
  if (sourceRowsChecksum !== sourceBlockChecksum(blocks))
    fail("source checksum does not match ordered block digests");
  if (!sameValue(record, reconstructed))
    fail("summary, semantics or checksum does not match reconstructed blocks");
  return reconstructed;
}

/** Fixed exact screen. WIS is diagnostic here; admission owns proper-score benchmarks and scope. */
export function evaluateMarginalIntervalEvidence(value: unknown): MarginalIntervalScreenResult {
  let evidence: MarginalIntervalEvidence;
  try {
    evidence = validateMarginalIntervalEvidence(value);
  } catch {
    return {
      version: MARGINAL_INTERVAL_SCREEN_VERSION,
      state: "invalid-evidence",
      reasons: ["invalid-evidence"],
      evidenceChecksum: null,
      overall: null,
    };
  }
  const { overall, evidenceChecksum } = evidence;
  const reasons: MarginalIntervalScreenReason[] = [];
  if (overall.seasons < 1) reasons.push("fewer-than-1-seasons");
  if (overall.blocks < 3) reasons.push("fewer-than-3-blocks");
  if (overall.samples < 18) reasons.push("fewer-than-18-rows");
  if (reasons.length > 0)
    return {
      version: MARGINAL_INTERVAL_SCREEN_VERSION,
      state: "insufficient-evidence",
      reasons,
      evidenceChecksum,
      overall,
    };
  const metrics = overall.metrics!;
  if (5n * BigInt(metrics.coverage.numerator) < 3n * BigInt(metrics.coverage.denominator))
    reasons.push("coverage-below-three-fifths");
  if (4n * BigInt(metrics.lowerTail.numerator) > BigInt(metrics.lowerTail.denominator))
    reasons.push("lower-tail-above-one-quarter");
  if (4n * BigInt(metrics.upperTail.numerator) > BigInt(metrics.upperTail.denominator))
    reasons.push("upper-tail-above-one-quarter");
  return {
    version: MARGINAL_INTERVAL_SCREEN_VERSION,
    state: reasons.length === 0 ? "descriptive-screen-passed" : "failed-screen",
    reasons,
    evidenceChecksum,
    overall,
  };
}
