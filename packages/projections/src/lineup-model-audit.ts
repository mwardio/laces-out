import {
  firstPartyRecentRoleContext,
  applyFirstPartyProjectionChampionPolicy,
  evaluateFirstPartyBacktestForScoringProfile,
  runFirstPartyProjectionBacktest,
  type FirstPartyBacktestPrediction,
  type FirstPartyProjectionTarget,
  type FirstPartyProjectionBacktest,
  type FirstPartyWeeklyStatLine,
} from "./first-party.js";
import {
  scoreProjectionStatComponents,
  type ProjectionScoringProfile,
  type ProjectionStatComponents,
} from "./scoring.js";

/** Offline challengers only. Promotion requires separate calibration and publication gates. */
export const LINEUP_CHALLENGERS = [
  "recent-role",
  "regressed-touchdowns",
  "role-and-touchdowns",
] as const;
export type LineupChallenger = (typeof LINEUP_CHALLENGERS)[number];
const ordinal = (row: { season: number; week: number }) => row.season * 25 + row.week;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const supported = (position: string) => ["RB", "WR", "TE"].includes(position);
const samePoints = (left: number, right: number) => Math.abs(left - right) <= 1e-9;
interface PreparedAuditHistory {
  readonly prior: readonly FirstPartyWeeklyStatLine[];
  readonly players: ReadonlyMap<string, readonly FirstPartyWeeklyStatLine[]>;
  readonly positionMeans: Map<string, number>;
}
const PREPARED_AUDIT_HISTORY = new WeakMap<
  readonly FirstPartyWeeklyStatLine[],
  Map<string, PreparedAuditHistory>
>();
function prepareAuditHistory(
  history: readonly FirstPartyWeeklyStatLine[],
  target: FirstPartyProjectionTarget,
): PreparedAuditHistory {
  let cached = PREPARED_AUDIT_HISTORY.get(history);
  if (!cached) {
    cached = new Map();
    PREPARED_AUDIT_HISTORY.set(history, cached);
  }
  const key = `${target.position}:${ordinal(target)}`;
  const existing = cached.get(key);
  if (existing) return existing;
  const prior = history.filter(
    (row) =>
      row.position === target.position && row.played !== false && ordinal(row) < ordinal(target),
  );
  const players = new Map<string, FirstPartyWeeklyStatLine[]>();
  for (const row of prior) {
    const rows = players.get(row.playerId) ?? [];
    rows.push(row);
    players.set(row.playerId, rows);
  }
  for (const [id, rows] of players)
    players.set(id, rows.sort((a, b) => ordinal(a) - ordinal(b)).slice(-24));
  const prepared = { prior, players, positionMeans: new Map<string, number>() };
  cached.set(key, prepared);
  return prepared;
}

/** No target-week stats, designation, or realized usage is accepted as a feature. */
export function lineupChallengerComponents(input: {
  readonly variant: LineupChallenger;
  readonly target: FirstPartyProjectionTarget;
  readonly history: readonly FirstPartyWeeklyStatLine[];
  readonly baseline: ProjectionStatComponents;
}): ProjectionStatComponents {
  const { target, baseline } = input;
  if (!supported(target.position)) return baseline;
  const prepared = prepareAuditHistory(input.history, target);
  const { prior } = prepared;
  const player = prepared.players.get(target.playerId) ?? [];
  if (player.length === 0) return baseline;
  const weight = (row: FirstPartyWeeklyStatLine) => 0.5 ** ((ordinal(target) - ordinal(row)) / 6);
  const weighted = (
    rows: readonly FirstPartyWeeklyStatLine[],
    get: (row: FirstPartyWeeklyStatLine) => number | undefined,
  ) => {
    let total = 0,
      weights = 0;
    for (const row of rows) {
      const value = get(row);
      if (value === undefined || !Number.isFinite(value)) continue;
      total += value * weight(row);
      weights += weight(row);
    }
    return weights ? total / weights : undefined;
  };
  const positionMean = (component: string) => {
    let value = prepared.positionMeans.get(component);
    if (value === undefined) {
      value = weighted(prior, (row) => row.components[component] ?? 0) ?? 0;
      prepared.positionMeans.set(component, value);
    }
    return value;
  };
  const components: Record<string, number> = { ...baseline };
  if (input.variant !== "regressed-touchdowns") {
    // Current-season/current-team participation can reveal a changed role before a long window
    // catches up. The existing model's four-game window and 0.65–1.35 bounds remain fixed.
    const current = player.filter(
      (row) => row.season === target.season && row.team === target.team,
    );
    const role = firstPartyRecentRoleContext(current.length ? current : player, target.playerId);
    for (const [share, keys] of [
      ["targetShare", ["targets", "receptions", "receiving_yards", "receiving_touchdowns"]],
      ["carryShare", ["carries", "rushing_yards", "rushing_touchdowns"]],
    ] as const) {
      const observed = weighted(player, (row) => row[share]);
      const recent = role?.[share];
      if (observed === undefined || recent === undefined) continue;
      const multiplier =
        observed < 0.04 ? clamp(0.65 + recent, 0.65, 1.35) : clamp(recent / observed, 0.65, 1.35);
      for (const key of keys) components[key] = (baseline[key] ?? 0) * multiplier;
    }
  }
  if (input.variant !== "recent-role") {
    for (const [opportunities, touchdowns] of [
      ["targets", "receiving_touchdowns"],
      ["carries", "rushing_touchdowns"],
    ] as const) {
      const priorVolume = positionMean(opportunities);
      const priorScores = positionMean(touchdowns);
      const playerVolume = weighted(player, (row) => row.components[opportunities] ?? 0) ?? 0;
      const playerScores = weighted(player, (row) => row.components[touchdowns] ?? 0) ?? 0;
      // Four position-average games are the same prior strength as the contextual model.
      const denominator = playerVolume * player.length + priorVolume * 4;
      if (denominator > 0)
        components[touchdowns] =
          (components[opportunities] ?? 0) *
          clamp((playerScores * player.length + priorScores * 4) / denominator, 0, 1);
    }
  }
  return components;
}

interface AuditRow {
  readonly season: number;
  readonly week: number;
  readonly position: string;
  readonly baseline: number;
  readonly candidate: number;
  readonly actual: number;
  readonly limitedHistory: boolean;
  readonly roleChanged: boolean;
}

function metrics(rows: readonly AuditRow[]) {
  const mean = (values: readonly number[]) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const baselineMae = mean(rows.map((row) => Math.abs(row.baseline - row.actual)));
  const candidateMae = mean(rows.map((row) => Math.abs(row.candidate - row.actual)));
  const weeks = new Map<number, AuditRow[]>();
  for (const row of rows) {
    const key = ordinal(row);
    const batch = weeks.get(key) ?? [];
    batch.push(row);
    weeks.set(key, batch);
  }
  let pairs = 0,
    baselineRegret = 0,
    candidateRegret = 0,
    rankedPairs = 0,
    baselineCorrect = 0,
    candidateCorrect = 0;
  for (const batch of weeks.values()) {
    for (let a = 0; a < batch.length; a++)
      for (let b = a + 1; b < batch.length; b++) {
        const left = batch[a]!,
          right = batch[b]!;
        // Common FLEX-eligible choices within five baseline points, both projecting at least five.
        // Selection uses predictions, never the realized outcome. This is not a user's roster.
        if (
          Math.min(left.baseline, right.baseline) < 5 ||
          Math.abs(left.baseline - right.baseline) > 5
        )
          continue;
        const regret = (leftPrediction: number, rightPrediction: number) => {
          if (samePoints(left.actual, right.actual)) return 0;
          const chosen = samePoints(leftPrediction, rightPrediction)
            ? (left.actual + right.actual) / 2
            : leftPrediction > rightPrediction
              ? left.actual
              : right.actual;
          return Math.max(left.actual, right.actual) - chosen;
        };
        baselineRegret += regret(left.baseline, right.baseline);
        candidateRegret += regret(left.candidate, right.candidate);
        if (!samePoints(left.actual, right.actual)) {
          const correct = (leftPrediction: number, rightPrediction: number) =>
            samePoints(leftPrediction, rightPrediction)
              ? 0.5
              : Number(
                  Math.sign(leftPrediction - rightPrediction) ===
                    Math.sign(left.actual - right.actual),
                );
          baselineCorrect += correct(left.baseline, right.baseline);
          candidateCorrect += correct(left.candidate, right.candidate);
          rankedPairs++;
        }
        pairs++;
      }
  }
  return {
    samples: rows.length,
    weekBatches: weeks.size,
    baselineMae,
    candidateMae,
    improvement:
      baselineMae && candidateMae !== null ? (baselineMae - candidateMae) / baselineMae : null,
    comparisonPairs: pairs,
    baselineRegret: pairs ? baselineRegret / pairs : null,
    candidateRegret: pairs ? candidateRegret / pairs : null,
    rankedPairs,
    baselineRankAccuracy: rankedPairs ? baselineCorrect / rankedPairs : null,
    candidateRankAccuracy: rankedPairs ? candidateCorrect / rankedPairs : null,
  };
}

export function auditLineupChallenger(input: {
  readonly history: readonly FirstPartyWeeklyStatLine[];
  readonly predictions: readonly FirstPartyBacktestPrediction[];
  readonly profile: ProjectionScoringProfile;
  readonly variant: LineupChallenger;
}) {
  const rows: AuditRow[] = [];
  const candidatePredictions: FirstPartyBacktestPrediction[] = [];
  const byWeek = new Map<number, FirstPartyWeeklyStatLine[]>();
  const countsByWeek = new Map<number, Map<string, number>>();
  const targetByPlayerWeek = new Map(
    input.history.map((row) => [`${row.playerId}:${ordinal(row)}`, row]),
  );
  for (const prediction of input.predictions) {
    if (!supported(prediction.position)) continue;
    const key = ordinal(prediction);
    let history = byWeek.get(key);
    if (!history) {
      history = input.history.filter((row) => ordinal(row) < key);
      byWeek.set(key, history);
      const counts = new Map<string, number>();
      for (const row of history)
        if (row.played !== false) counts.set(row.playerId, (counts.get(row.playerId) ?? 0) + 1);
      countsByWeek.set(key, counts);
    }
    const actualRow = targetByPlayerWeek.get(`${prediction.playerId}:${key}`);
    if (!actualRow) throw new Error("Backtest outcome is absent from the supplied history");
    const target = {
      playerId: prediction.playerId,
      season: prediction.season,
      week: prediction.week,
      position: prediction.position,
      team: actualRow.team,
    };
    const candidate = lineupChallengerComponents({
      variant: input.variant,
      target,
      history,
      baseline: prediction.baseline,
    });
    candidatePredictions.push({ ...prediction, predicted: candidate });
    const roleOnly =
      input.variant === "recent-role"
        ? candidate
        : lineupChallengerComponents({
            variant: "recent-role",
            target,
            history,
            baseline: prediction.baseline,
          });
    const priorGames = countsByWeek.get(key)?.get(target.playerId) ?? 0;
    const baseline = scoreProjectionStatComponents(prediction.baseline, input.profile);
    const rolePoints = scoreProjectionStatComponents(roleOnly, input.profile);
    rows.push({
      season: prediction.season,
      week: prediction.week,
      position: prediction.position,
      baseline,
      candidate: scoreProjectionStatComponents(candidate, input.profile),
      actual: scoreProjectionStatComponents(prediction.actual, input.profile),
      limitedHistory: priorGames <= 4,
      roleChanged: baseline > 0 && Math.abs(rolePoints - baseline) / baseline >= 0.2,
    });
  }
  const overall = metrics(rows);
  const earlySeason = metrics(rows.filter((row) => row.week <= 4));
  const roleChanges = metrics(rows.filter((row) => row.roleChanged));
  const limitedHistory = metrics(rows.filter((row) => row.limitedHistory));
  const byPosition = Object.fromEntries(
    ["RB", "WR", "TE"].map((position) => [
      position,
      metrics(rows.filter((row) => row.position === position)),
    ]),
  );
  const enough =
    overall.samples >= 100 &&
    overall.weekBatches >= 8 &&
    earlySeason.samples >= 100 &&
    roleChanges.samples >= 100 &&
    limitedHistory.samples >= 100;
  const noRegression = [
    earlySeason,
    roleChanges,
    limitedHistory,
    ...Object.values(byPosition),
  ].every((value) => value.samples > 0 && value.improvement !== null && value.improvement >= 0);
  const clearsResearchGate =
    enough &&
    (overall.improvement ?? -1) >= 0.02 &&
    noRegression &&
    overall.candidateRegret !== null &&
    overall.baselineRegret !== null &&
    overall.candidateRegret <= overall.baselineRegret;
  // Use the same prior-only position selection and point-residual calibration as production.
  // Component bounds from the source backtest are not candidate-calibrated and are not reported
  // as evidence here; this evaluation learns fantasy-point intervals from earlier errors.
  const challengerBacktest = {
    ...runFirstPartyProjectionBacktest([]),
    predictions: candidatePredictions,
  };
  const champion = applyFirstPartyProjectionChampionPolicy(challengerBacktest, input.profile);
  const rolling = evaluateFirstPartyBacktestForScoringProfile(champion.backtest, input.profile);
  return {
    variant: input.variant,
    scoringProfile: input.profile.id,
    overall,
    earlySeason,
    roleChanges,
    limitedHistory,
    byPosition,
    clearsResearchGate,
    championPolicy: champion.policy.byPosition,
    rollingPointCalibration: { byPosition: rolling.byPosition, overall: rolling.overall },
    promotion: "disabled-pending-independent-calibration-and-publication-gates" as const,
  };
}

const HISTORY_COHORTS = ["0", "1-3", "4-11", "12+"] as const;
type HistoryCohort = (typeof HISTORY_COHORTS)[number];
const historyCohort = (games: number): HistoryCohort =>
  games === 0 ? "0" : games <= 3 ? "1-3" : games <= 11 ? "4-11" : "12+";
const playerWeekKey = (row: { playerId: string; season: number; week: number }) =>
  `${row.playerId}:${ordinal(row)}`;

/**
 * Scores locked historical forecasts without retroactively applying the final live strategy.
 * Coverage counts describe supplied historical outcomes, not a reconstructed preseason roster.
 */
export function auditLineupProduction(input: {
  readonly history: readonly FirstPartyWeeklyStatLine[];
  readonly backtest: FirstPartyProjectionBacktest;
  readonly profile: ProjectionScoringProfile;
}) {
  const priorGames = new Map<string, number>();
  const historyCounts = new Map<string, number>();
  const historyWeeks = new Map<number, FirstPartyWeeklyStatLine[]>();
  for (const row of input.history) {
    if (!supported(row.position)) continue;
    const week = ordinal(row);
    const batch = historyWeeks.get(week) ?? [];
    batch.push(row);
    historyWeeks.set(week, batch);
  }
  for (const week of [...historyWeeks.keys()].sort((a, b) => a - b)) {
    const rows = historyWeeks.get(week)!;
    for (const row of rows) {
      const key = playerWeekKey(row);
      if (priorGames.has(key)) throw new Error("Duplicate historical lineup outcome");
      priorGames.set(key, historyCounts.get(row.playerId) ?? 0);
    }
    for (const row of rows) {
      if (row.played === false) continue;
      const key = row.playerId;
      historyCounts.set(key, (historyCounts.get(key) ?? 0) + 1);
    }
  }
  const champion = applyFirstPartyProjectionChampionPolicy(input.backtest, input.profile);
  const rolling = evaluateFirstPartyBacktestForScoringProfile(
    {
      ...champion.backtest,
      predictions: champion.backtest.predictions.filter((row) => supported(row.position)),
    },
    input.profile,
  );
  const rows: Array<AuditRow & { readonly cohort: HistoryCohort }> = [];
  const seen = new Set<string>();
  for (const prediction of champion.backtest.predictions) {
    if (!supported(prediction.position)) continue;
    const key = playerWeekKey(prediction);
    const count = priorGames.get(key);
    if (count === undefined)
      throw new Error("Backtest outcome is absent from the supplied history");
    if (seen.has(key)) throw new Error("Duplicate historical lineup prediction");
    seen.add(key);
    rows.push({
      season: prediction.season,
      week: prediction.week,
      position: prediction.position,
      baseline: scoreProjectionStatComponents(prediction.baseline, input.profile),
      candidate: scoreProjectionStatComponents(prediction.predicted, input.profile),
      actual: scoreProjectionStatComponents(prediction.actual, input.profile),
      limitedHistory: count <= 3,
      roleChanged: false,
      cohort: historyCohort(count),
    });
  }
  const evaluatedWeeks = new Set(input.backtest.predictions.map(ordinal));
  const outcomeCounts = new Map<HistoryCohort, number>();
  for (const [week, batch] of historyWeeks) {
    if (!evaluatedWeeks.has(week)) continue;
    for (const row of batch) {
      const cohort = historyCohort(priorGames.get(playerWeekKey(row))!);
      outcomeCounts.set(cohort, (outcomeCounts.get(cohort) ?? 0) + 1);
    }
  }
  return {
    scoringProfile: input.profile.id,
    comparison: "prior-week-champion-vs-recency-only" as const,
    pointMetrics: "raw-component-centers" as const,
    pairPopulation: "same-week-flex-pairs-with-baseline-at-least-5-and-gap-at-most-5" as const,
    overall: metrics(rows),
    byPosition: Object.fromEntries(
      ["RB", "WR", "TE"].map((position) => [
        position,
        metrics(rows.filter((row) => row.position === position)),
      ]),
    ),
    byWeek: Object.fromEntries(
      [...evaluatedWeeks]
        .sort((a, b) => a - b)
        .map((week) => {
          const batch = rows.filter((row) => ordinal(row) === week);
          return [`${Math.floor(week / 25)}:${week % 25}`, metrics(batch)];
        }),
    ),
    historyCohorts: Object.fromEntries(
      HISTORY_COHORTS.map((cohort) => {
        const selected = rows.filter((row) => row.cohort === cohort);
        const observedOutcomeRows = outcomeCounts.get(cohort) ?? 0;
        return [
          cohort,
          {
            observedOutcomeRows,
            predictedRows: selected.length,
            omittedOutcomeRows: observedOutcomeRows - selected.length,
            ...metrics(selected),
          },
        ];
      }),
    ),
    rollingPointCalibration: { byPosition: rolling.byPosition, overall: rolling.overall },
    finalLivePolicy: champion.policy.byPosition,
    limitations: [
      "History-cohort coverage uses supplied historical outcomes in evaluated weeks; it is not a pre-kickoff roster reconstruction.",
      "A cohort without locked predictions has no measured accuracy; the existing backtest excludes players without recent prior fantasy relevance.",
      "Pair rank and regret use raw component centers, not calibrated live fantasy-point centers or user roster choices.",
    ],
  };
}
