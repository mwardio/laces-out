import type { MarginalIntervalQuantiles } from "./marginal-interval-calibration.js";
import type { FirstPartyRosPosition, FirstPartyRosRemainingWeeksBucket } from "./rest-of-season.js";
import { projectionScoringRulesFromProfileKey } from "./scoring-position-keys.js";
import { sha256Hex } from "./sha256.js";

/** Fixed matched-score comparisons; passing is not a substitute for marginal coverage evidence. */
export const MARGINAL_INTERVAL_COMPARISON_VERSION = "matched-marginal-wis-comparison-v1";
const CELL_BENCHMARKS = ["same-physics-legacy", "previous-deployed"] as const;
const PORTFOLIO_BENCHMARKS = [
  "same-physics-raw",
  "same-physics-legacy",
  "previous-raw",
  "previous-deployed",
] as const;
type Benchmark = (typeof PORTFOLIO_BENCHMARKS)[number];

export interface MarginalIntervalComparisonCell {
  readonly position: FirstPartyRosPosition;
  readonly bucket: FirstPartyRosRemainingWeeksBucket;
}

export interface MarginalIntervalComparisonRow extends MarginalIntervalQuantiles {
  readonly playerId: string;
  readonly forecastSeason: number;
  readonly asOfWeek: number;
  readonly position: FirstPartyRosPosition;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly scheduledGames: number;
  readonly actualPoints: number;
}

export interface MarginalIntervalComparisonSource {
  readonly modelVersion: string;
  readonly policyVersion: string;
  readonly scoringProfileKey: string;
  readonly physicalCorpusChecksum: string;
  readonly reportChecksum: string;
}

export interface MarginalIntervalComparisonSeries {
  readonly source: MarginalIntervalComparisonSource;
  /** Already selected by the declared frozen policy; no intersection or best-strategy search. */
  readonly rows: readonly MarginalIntervalComparisonRow[];
}

interface ComparisonBlock {
  readonly asOfWeek: number;
  readonly windowStartWeek: number;
  readonly windowEndWeek: number;
  readonly samples: number;
  /** Binds outcome, schedule, identities and every candidate/benchmark quantile. */
  readonly rowsChecksum: string;
  readonly candidateWisSum: number;
  readonly benchmarkWisSums: Readonly<Partial<Record<Benchmark, number>>>;
}

interface ComparisonCell extends MarginalIntervalComparisonCell {
  readonly blocks: readonly ComparisonBlock[];
  readonly samples: number;
  readonly cohortChecksum: string;
  readonly candidateWis: number;
  readonly benchmarkWis: Readonly<Partial<Record<Benchmark, number>>>;
  /** A portfolio keeps these diagnostics even though its comparison weights cells equally. */
  readonly worseThan: readonly Benchmark[];
}

export interface MarginalIntervalComparison {
  readonly schemaVersion: 1;
  readonly version: typeof MARGINAL_INTERVAL_COMPARISON_VERSION;
  readonly scope: "final-live-cell" | "chronological-selected-portfolio";
  readonly evaluationSeason: number;
  readonly weighting: "equal-cell-equal-cutoff-equal-player";
  readonly candidateSource: MarginalIntervalComparisonSource;
  readonly benchmarkSources: Readonly<Partial<Record<Benchmark, MarginalIntervalComparisonSource>>>;
  readonly cells: readonly ComparisonCell[];
  readonly candidateWis: number;
  readonly benchmarkWis: Readonly<Partial<Record<Benchmark, number>>>;
  readonly state: "passed" | "failed";
  readonly worseThan: readonly Benchmark[];
  readonly evidenceChecksum: string;
}

function fail(message: string): never {
  throw new Error(`Marginal interval comparison: ${message}`);
}

function boundedText(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    fail("invalid bounded identity");
}

function integer(value: unknown, minimum: number, maximum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum)
    fail("invalid integer support");
}

function finite(value: unknown, nonnegative = false): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || (nonnegative && value < 0))
    fail("nonfinite or invalid score");
}

function digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("invalid checksum");
}

function denseArray(value: unknown, minimum: number, maximum: number): asserts value is unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum ||
    Object.keys(value).length !== value.length
  )
    fail("invalid bounded dense array");
  for (let index = 0; index < value.length; index++)
    if (!Object.hasOwn(value, index)) fail("sparse array");
}

function exactKeys(value: unknown, keys: readonly string[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid object");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail("missing or unknown fields");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
      .join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) fail("undefined field");
  return result;
}

function cellKey(cell: MarginalIntervalComparisonCell): string {
  if (
    !["QB", "RB", "WR", "TE", "K", "DST"].includes(cell.position) ||
    !["one-to-four", "five-to-eight", "nine-plus"].includes(cell.bucket)
  )
    fail("invalid cell");
  return `${cell.position}:${cell.bucket}`;
}

function source(value: MarginalIntervalComparisonSource): MarginalIntervalComparisonSource {
  exactKeys(value, [
    "modelVersion",
    "policyVersion",
    "scoringProfileKey",
    "physicalCorpusChecksum",
    "reportChecksum",
  ]);
  boundedText(value.modelVersion, 256);
  boundedText(value.policyVersion, 256);
  boundedText(value.scoringProfileKey, 65_536);
  projectionScoringRulesFromProfileKey(value.scoringProfileKey);
  digest(value.physicalCorpusChecksum);
  digest(value.reportChecksum);
  return { ...value };
}

function samePhysics(
  a: MarginalIntervalComparisonSource,
  b: MarginalIntervalComparisonSource,
): boolean {
  return a.modelVersion === b.modelVersion && a.physicalCorpusChecksum === b.physicalCorpusChecksum;
}

function validateSources(
  candidate: MarginalIntervalComparisonSource,
  benchmarks: Readonly<Partial<Record<Benchmark, MarginalIntervalComparisonSource>>>,
  names: readonly Benchmark[],
): void {
  source(candidate);
  exactKeys(benchmarks, names);
  for (const name of names) {
    const benchmark = source(benchmarks[name]!);
    if (candidate.scoringProfileKey !== benchmark.scoringProfileKey)
      fail("scoring profile mismatch");
    if (name.startsWith("same-physics") && !samePhysics(candidate, benchmark))
      fail("same-physics benchmark corpus mismatch");
  }
  if (
    names.includes("previous-raw") &&
    !samePhysics(benchmarks["previous-raw"]!, benchmarks["previous-deployed"]!)
  )
    fail("previous raw/deployed corpus mismatch");
}

function row(value: MarginalIntervalComparisonRow, season: number): MarginalIntervalComparisonRow {
  boundedText(value.playerId, 1024);
  integer(value.forecastSeason, 2000, 2200);
  if (value.forecastSeason !== season) fail("row outside the declared evaluation season");
  integer(value.asOfWeek, 0, 17);
  integer(value.windowStartWeek, value.asOfWeek + 1, 18);
  integer(value.windowEndWeek, value.windowStartWeek, 18);
  integer(value.scheduledGames, 1, Math.min(17, value.windowEndWeek - value.windowStartWeek + 1));
  for (const number of [value.actualPoints, value.p15Points, value.p50Points, value.p85Points])
    finite(number);
  if (value.p15Points > value.p50Points || value.p50Points > value.p85Points)
    fail("unordered quantiles");
  cellKey({ position: value.position, bucket: rowBucket(value) });
  return {
    playerId: value.playerId,
    forecastSeason: value.forecastSeason,
    asOfWeek: value.asOfWeek,
    position: value.position,
    windowStartWeek: value.windowStartWeek,
    windowEndWeek: value.windowEndWeek,
    scheduledGames: value.scheduledGames,
    actualPoints: value.actualPoints,
    p15Points: value.p15Points,
    p50Points: value.p50Points,
    p85Points: value.p85Points,
  };
}

function rowBucket(
  value: Pick<MarginalIntervalComparisonRow, "windowStartWeek" | "windowEndWeek">,
): FirstPartyRosRemainingWeeksBucket {
  const weeks = value.windowEndWeek - value.windowStartWeek + 1;
  return weeks <= 4 ? "one-to-four" : weeks <= 8 ? "five-to-eight" : "nine-plus";
}

function identity(value: MarginalIntervalComparisonRow): string {
  return JSON.stringify([value.position, value.forecastSeason, value.asOfWeek, value.playerId]);
}

function observation(value: MarginalIntervalComparisonRow): readonly (string | number)[] {
  return [
    value.position,
    value.forecastSeason,
    value.asOfWeek,
    value.playerId,
    value.windowStartWeek,
    value.windowEndWeek,
    value.scheduledGames,
    value.actualPoints,
  ];
}

function wis(value: MarginalIntervalComparisonRow): number {
  const intervalScore =
    value.p85Points -
    value.p15Points +
    (2 / 0.3) * Math.max(0, value.p15Points - value.actualPoints) +
    (2 / 0.3) * Math.max(0, value.actualPoints - value.p85Points);
  const score = (0.5 * Math.abs(value.actualPoints - value.p50Points) + 0.15 * intervalScore) / 1.5;
  finite(score, true);
  return score;
}

function average(values: readonly number[]): number {
  if (!values.length) fail("empty score support");
  const value = values.reduce((sum, value) => sum + value, 0) / values.length;
  finite(value, true);
  return value;
}

function scores(
  names: readonly Benchmark[],
  get: (name: Benchmark) => number,
): Partial<Record<Benchmark, number>> {
  return Object.fromEntries(names.map((name) => [name, get(name)]));
}

function build(input: {
  readonly scope: MarginalIntervalComparison["scope"];
  readonly evaluationSeason: number;
  readonly cells: readonly MarginalIntervalComparisonCell[];
  readonly candidate: MarginalIntervalComparisonSeries;
  readonly benchmarks: Readonly<Partial<Record<Benchmark, MarginalIntervalComparisonSeries>>>;
}): MarginalIntervalComparison {
  integer(input.evaluationSeason, 2000, 2200);
  denseArray(input.cells, 1, input.scope === "final-live-cell" ? 1 : 18);
  const names = input.scope === "final-live-cell" ? CELL_BENCHMARKS : PORTFOLIO_BENCHMARKS;
  exactKeys(input.benchmarks, names);
  const candidateSource = source(input.candidate.source);
  const benchmarkSources = Object.fromEntries(
    names.map((name) => [name, source(input.benchmarks[name]!.source)]),
  );
  validateSources(candidateSource, benchmarkSources, names);
  const cells = [...input.cells]
    .map((cell) => ({ position: cell.position, bucket: cell.bucket }))
    .sort((a, b) => cellKey(a).localeCompare(cellKey(b)));
  const allowed = new Set(cells.map(cellKey));
  if (allowed.size !== cells.length) fail("duplicate required cell");
  const index = (series: MarginalIntervalComparisonSeries) => {
    denseArray(series.rows, 1, 20_000);
    const result = new Map<string, MarginalIntervalComparisonRow>();
    for (const raw of series.rows) {
      const value = row(raw, input.evaluationSeason);
      if (!allowed.has(cellKey({ position: value.position, bucket: rowBucket(value) })))
        fail("unexpected cell");
      const key = identity(value);
      if (result.has(key)) fail("duplicate forecast identity");
      result.set(key, value);
    }
    return result;
  };
  const candidate = index(input.candidate);
  const benchmarks = Object.fromEntries(
    names.map((name) => [name, index(input.benchmarks[name]!)]),
  ) as Record<Benchmark, Map<string, MarginalIntervalComparisonRow>>;
  for (const name of names) {
    const benchmark = benchmarks[name];
    if (benchmark.size !== candidate.size) fail("missing or extra benchmark rows");
    for (const [key, value] of candidate) {
      const matched = benchmark.get(key);
      if (!matched || canonical(observation(value)) !== canonical(observation(matched)))
        fail("benchmark cohort, schedule or outcome mismatch");
    }
  }
  const resultCells = cells.map((cell): ComparisonCell => {
    const selected = [...candidate.values()]
      .filter((value) => value.position === cell.position && rowBucket(value) === cell.bucket)
      .sort(
        (a, b) =>
          a.asOfWeek - b.asOfWeek ||
          (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0),
      );
    if (!selected.length) fail("missing required cell");
    const blocks = [...new Set(selected.map((value) => value.asOfWeek))].map(
      (asOfWeek): ComparisonBlock => {
        const rows = selected.filter((value) => value.asOfWeek === asOfWeek);
        const first = rows[0]!;
        if (
          rows.some(
            (value) =>
              value.windowStartWeek !== first.windowStartWeek ||
              value.windowEndWeek !== first.windowEndWeek,
          )
        )
          fail("mixed cutoff windows");
        const sums = scores(names, (name) =>
          rows.reduce((sum, value) => sum + wis(benchmarks[name].get(identity(value))!), 0),
        );
        return {
          asOfWeek,
          windowStartWeek: first.windowStartWeek,
          windowEndWeek: first.windowEndWeek,
          samples: rows.length,
          rowsChecksum: sha256Hex(
            canonical(
              rows.map((value) => ({
                candidate: value,
                benchmarks: Object.fromEntries(
                  names.map((name) => [name, benchmarks[name].get(identity(value))!]),
                ),
              })),
            ),
          ),
          candidateWisSum: rows.reduce((sum, value) => sum + wis(value), 0),
          benchmarkWisSums: sums,
        };
      },
    );
    const candidateWis = average(blocks.map((block) => block.candidateWisSum / block.samples));
    const benchmarkWis = scores(names, (name) =>
      average(blocks.map((block) => block.benchmarkWisSums[name]! / block.samples)),
    );
    return {
      ...cell,
      blocks,
      samples: selected.length,
      cohortChecksum: sha256Hex(canonical(selected.map(observation))),
      candidateWis,
      benchmarkWis,
      worseThan: names.filter((name) => candidateWis > benchmarkWis[name]!),
    };
  });
  return finalize({
    schemaVersion: 1,
    version: MARGINAL_INTERVAL_COMPARISON_VERSION,
    scope: input.scope,
    evaluationSeason: input.evaluationSeason,
    weighting: "equal-cell-equal-cutoff-equal-player",
    candidateSource,
    benchmarkSources,
    cells: resultCells,
  });
}

type ComparisonBase = Omit<
  MarginalIntervalComparison,
  "candidateWis" | "benchmarkWis" | "state" | "worseThan" | "evidenceChecksum"
>;
function finalize(base: ComparisonBase): MarginalIntervalComparison {
  const names = base.scope === "final-live-cell" ? CELL_BENCHMARKS : PORTFOLIO_BENCHMARKS;
  const candidateWis = average(base.cells.map((cell) => cell.candidateWis));
  const benchmarkWis = scores(names, (name) =>
    average(base.cells.map((cell) => cell.benchmarkWis[name]!)),
  );
  const worseThan = names.filter((name) => candidateWis > benchmarkWis[name]!);
  const payload = {
    ...base,
    candidateWis,
    benchmarkWis,
    state: worseThan.length ? ("failed" as const) : ("passed" as const),
    worseThan,
  };
  return { ...payload, evidenceChecksum: sha256Hex(canonical(payload)) };
}

/** Required cell benchmarks are the selected legacy range on identical physics and previous deployment. */
export function compareMarginalIntervalCell(input: {
  readonly evaluationSeason: number;
  readonly cell: MarginalIntervalComparisonCell;
  readonly candidate: MarginalIntervalComparisonSeries;
  readonly benchmarks: Readonly<
    Record<(typeof CELL_BENCHMARKS)[number], MarginalIntervalComparisonSeries>
  >;
}): MarginalIntervalComparison {
  return build({ ...input, scope: "final-live-cell", cells: [input.cell] });
}

/** Each declared cell has equal weight; all four declared benchmarks and every row are required. */
export function compareMarginalIntervalPortfolio(input: {
  readonly evaluationSeason: number;
  readonly cells: readonly MarginalIntervalComparisonCell[];
  readonly candidate: MarginalIntervalComparisonSeries;
  readonly benchmarks: Readonly<
    Record<(typeof PORTFOLIO_BENCHMARKS)[number], MarginalIntervalComparisonSeries>
  >;
}): MarginalIntervalComparison {
  return build({ ...input, scope: "chronological-selected-portfolio" });
}

/** Reconstruct compact scores and pass/fail state. Hashes bind provenance, but are not signatures. */
export function marginalIntervalComparisonIsValid(
  value: unknown,
): value is MarginalIntervalComparison {
  try {
    exactKeys(value, [
      "schemaVersion",
      "version",
      "scope",
      "evaluationSeason",
      "weighting",
      "candidateSource",
      "benchmarkSources",
      "cells",
      "candidateWis",
      "benchmarkWis",
      "state",
      "worseThan",
      "evidenceChecksum",
    ]);
    const receipt = value as MarginalIntervalComparison;
    if (
      receipt.schemaVersion !== 1 ||
      receipt.version !== MARGINAL_INTERVAL_COMPARISON_VERSION ||
      !["final-live-cell", "chronological-selected-portfolio"].includes(receipt.scope) ||
      receipt.weighting !== "equal-cell-equal-cutoff-equal-player"
    )
      return false;
    integer(receipt.evaluationSeason, 2000, 2200);
    digest(receipt.evidenceChecksum);
    const names = receipt.scope === "final-live-cell" ? CELL_BENCHMARKS : PORTFOLIO_BENCHMARKS;
    validateSources(receipt.candidateSource, receipt.benchmarkSources, names);
    denseArray(receipt.cells, 1, receipt.scope === "final-live-cell" ? 1 : 18);
    let priorCell = "";
    for (const cell of receipt.cells) {
      exactKeys(cell, [
        "position",
        "bucket",
        "blocks",
        "samples",
        "cohortChecksum",
        "candidateWis",
        "benchmarkWis",
        "worseThan",
      ]);
      const key = cellKey(cell);
      if (key.localeCompare(priorCell) <= 0) return false;
      priorCell = key;
      digest(cell.cohortChecksum);
      denseArray(cell.blocks, 1, 18);
      let previousCutoff = -1;
      for (const block of cell.blocks) {
        exactKeys(block, [
          "asOfWeek",
          "windowStartWeek",
          "windowEndWeek",
          "samples",
          "rowsChecksum",
          "candidateWisSum",
          "benchmarkWisSums",
        ]);
        integer(block.asOfWeek, previousCutoff + 1, 17);
        previousCutoff = block.asOfWeek;
        integer(block.windowStartWeek, block.asOfWeek + 1, 18);
        integer(block.windowEndWeek, block.windowStartWeek, 18);
        if (rowBucket(block) !== cell.bucket) return false;
        integer(block.samples, 1, 20_000);
        digest(block.rowsChecksum);
        finite(block.candidateWisSum, true);
        exactKeys(block.benchmarkWisSums, names);
        for (const name of names) finite(block.benchmarkWisSums[name], true);
      }
      integer(cell.samples, 1, 20_000);
      if (cell.samples !== cell.blocks.reduce((sum, block) => sum + block.samples, 0)) return false;
      const expectedWis = average(
        cell.blocks.map((block) => block.candidateWisSum / block.samples),
      );
      const expectedBenchmarks = scores(names, (name) =>
        average(cell.blocks.map((block) => block.benchmarkWisSums[name]! / block.samples)),
      );
      if (
        cell.candidateWis !== expectedWis ||
        canonical(cell.benchmarkWis) !== canonical(expectedBenchmarks) ||
        canonical(cell.worseThan) !==
          canonical(names.filter((name) => expectedWis > expectedBenchmarks[name]!))
      )
        return false;
    }
    if (receipt.cells.reduce((sum, cell) => sum + cell.samples, 0) > 20_000) return false;
    const expected = finalize({
      schemaVersion: 1,
      version: MARGINAL_INTERVAL_COMPARISON_VERSION,
      scope: receipt.scope,
      evaluationSeason: receipt.evaluationSeason,
      weighting: receipt.weighting,
      candidateSource: receipt.candidateSource,
      benchmarkSources: receipt.benchmarkSources,
      cells: receipt.cells,
    });
    return canonical(expected) === canonical(receipt);
  } catch {
    return false;
  }
}
