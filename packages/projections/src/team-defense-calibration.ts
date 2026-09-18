import { canonicalNflTeamCode, NFL_TEAMS } from "@laces-out/domain";
import type { FirstPartyTeamDefenseWeeklyStatLine } from "./first-party.js";
import {
  DEFENSE_COPULA_COMPONENTS,
  DEFENSE_EVENT_COMPONENTS,
  defenseGameRankDependence,
  type DefenseEventComponent,
  type DefenseGameDependence,
} from "./team-defense-game.js";

/** Prior-season NB2 dispersion and centered empirical checkerboard dependence semantics. */
export const FIRST_PARTY_DEFENSE_GAME_CALIBRATION_VERSION =
  "defense-prior-team-season-nb2-rank-copula-v1";

const MAX_HISTORY_ROWS = 20_000;
const teams = new Set<string>(NFL_TEAMS);
type CopulaComponent = (typeof DEFENSE_COPULA_COMPONENTS)[number];

export interface DefenseEventDispersionEvidence {
  /** Sum of (n - 1) * (unbiased within-team-season variance - group mean). */
  readonly numerator: number;
  /** Sum of (n - 1) * group mean squared. */
  readonly denominator: number;
  readonly groups: number;
  /** Rows in groups with at least two observations; singletons do not estimate variance. */
  readonly rows: number;
  readonly degreesOfFreedom: number;
  readonly zeroMeanGroups: number;
}

interface DefenseCalibrationEvidence {
  readonly forecastSeason: number;
  readonly throughSeason: number | null;
  readonly rows: number;
  readonly groups: number;
  readonly singletonGroups: number;
  readonly componentEvidence: Readonly<
    Record<DefenseEventComponent, DefenseEventDispersionEvidence>
  >;
  readonly assumptions: readonly string[];
}

export type FirstPartyDefenseGameCalibration =
  | (DefenseCalibrationEvidence & {
      readonly state: "insufficient-history";
      readonly reason: "no-prior-played-games" | "no-repeated-team-season-group";
    })
  | (DefenseCalibrationEvidence & {
      readonly state: "fitted";
      readonly throughSeason: number;
      readonly overdispersion: Readonly<Record<DefenseEventComponent, number>>;
      readonly dependence: DefenseGameDependence;
    });

interface EvidenceRow {
  readonly team: string;
  readonly season: number;
  readonly week: number;
  readonly components: Readonly<Record<CopulaComponent, number>>;
}

const assumptions = [
  "Only played rows from seasons strictly before forecastSeason are fitted; undefined played retains the existing played-row convention.",
  "Event NB2 alpha is a nonnegative pooled within-team-season moment estimate, not historical validation or publication admission.",
  "Dependence uses complete game residuals centered retrospectively by their own prior team-season means; this is valid prior-season information for the forecast, not conditional forecast calibration.",
  "Singleton team-season groups contribute their centered zero residual to dependence but cannot estimate event variance.",
  "All-zero event means use alpha zero; rare-event and dependence uncertainty still require separate historical evidence.",
] as const;

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`Defense calibration ${label} must be a positive safe integer`);
  }
}

function nonnegativeInteger(value: number | undefined, label: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Defense calibration ${label} must be a nonnegative safe integer`);
  }
  return value;
}

/**
 * Fits physical defense-game dispersion and dependence from completed prior seasons only.
 * The mathematical minimum is one repeated team-season group. Publication gates, not this
 * estimator, decide whether the resulting historical evidence is sufficient for forecasts.
 */
export function fitFirstPartyDefenseGameCalibration(
  history: readonly FirstPartyTeamDefenseWeeklyStatLine[],
  forecastSeason: number,
): FirstPartyDefenseGameCalibration {
  positiveInteger(forecastSeason, "forecast season");
  if (history.length > MAX_HISTORY_ROWS) {
    throw new RangeError("Defense calibration history exceeds 20000 rows");
  }
  const identities = new Set<string>();
  const rows: EvidenceRow[] = [];
  for (const row of history) {
    positiveInteger(row.season, "history season");
    if (row.season >= forecastSeason || row.played === false) continue;
    if (row.played !== undefined && row.played !== true) {
      throw new TypeError("Defense calibration played must be boolean when present");
    }
    positiveInteger(row.week, "history week");
    if (row.week > 25) throw new RangeError("Defense calibration week exceeds the NFL calendar");
    const team = canonicalNflTeamCode(row.team);
    if (!teams.has(team)) throw new RangeError("Defense calibration requires a known NFL team");
    const identity = `${row.season}:${row.week}:${team}`;
    if (identities.has(identity)) {
      throw new RangeError(`Duplicate defense calibration team/week: ${identity}`);
    }
    identities.add(identity);
    const components = Object.fromEntries(
      DEFENSE_COPULA_COMPONENTS.map((component) => [
        component,
        nonnegativeInteger(row.components[component], component),
      ]),
    ) as Record<CopulaComponent, number>;
    const touchdowns = nonnegativeInteger(
      row.components.defensive_touchdowns,
      "defensive_touchdowns",
    );
    if (touchdowns > components.defensive_interceptions + components.defensive_fumble_recoveries) {
      throw new RangeError(
        "Defense calibration touchdowns exceed interception/recovery opportunities",
      );
    }
    rows.push({ team, season: row.season, week: row.week, components });
  }
  rows.sort((a, b) => a.season - b.season || a.week - b.week || a.team.localeCompare(b.team));
  const groups = new Map<string, EvidenceRow[]>();
  for (const row of rows) {
    const key = `${row.season}:${row.team}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const evidence = Object.fromEntries(
    DEFENSE_EVENT_COMPONENTS.map((component) => [
      component,
      { numerator: 0, denominator: 0, groups: 0, rows: 0, degreesOfFreedom: 0, zeroMeanGroups: 0 },
    ]),
  ) as Record<
    DefenseEventComponent,
    {
      numerator: number;
      denominator: number;
      groups: number;
      rows: number;
      degreesOfFreedom: number;
      zeroMeanGroups: number;
    }
  >;
  const groupMeans = new Map<string, Readonly<Record<CopulaComponent, number>>>();
  for (const [key, group] of groups) {
    const means = {} as Record<CopulaComponent, number>;
    for (const component of DEFENSE_COPULA_COMPONENTS) {
      let mean = 0;
      let squaredDeviations = 0;
      for (const [index, row] of group.entries()) {
        const delta = row.components[component] - mean;
        mean += delta / (index + 1);
        squaredDeviations += delta * (row.components[component] - mean);
      }
      if (!Number.isFinite(mean) || !Number.isFinite(squaredDeviations)) {
        throw new RangeError("Defense calibration moments exceed the finite numerical domain");
      }
      means[component] = mean;
      if (group.length >= 2 && component in evidence) {
        const entry = evidence[component as DefenseEventComponent];
        const degreesOfFreedom = group.length - 1;
        entry.numerator += squaredDeviations - degreesOfFreedom * mean;
        entry.denominator += degreesOfFreedom * mean ** 2;
        entry.groups += 1;
        entry.rows += group.length;
        entry.degreesOfFreedom += degreesOfFreedom;
        entry.zeroMeanGroups += Number(mean === 0);
        if (!Number.isFinite(entry.numerator) || !Number.isFinite(entry.denominator)) {
          throw new RangeError(
            "Defense calibration pooled moments exceed the finite numerical domain",
          );
        }
      }
    }
    groupMeans.set(key, means);
  }
  const throughSeason = rows.at(-1)?.season ?? null;
  const common = {
    forecastSeason,
    throughSeason,
    rows: rows.length,
    groups: groups.size,
    singletonGroups: [...groups.values()].filter((group) => group.length === 1).length,
    componentEvidence: evidence,
    assumptions,
  };
  if (throughSeason === null || evidence.defensive_sacks.groups === 0) {
    return {
      ...common,
      state: "insufficient-history",
      reason: throughSeason === null ? "no-prior-played-games" : "no-repeated-team-season-group",
    };
  }
  const overdispersion = Object.fromEntries(
    DEFENSE_EVENT_COMPONENTS.map((component) => {
      const { numerator, denominator } = evidence[component];
      const alpha = denominator === 0 ? 0 : Math.max(0, numerator / denominator);
      if (!Number.isFinite(alpha)) {
        throw new RangeError("Defense calibration overdispersion must be finite");
      }
      return [component, alpha];
    }),
  ) as Record<DefenseEventComponent, number>;
  const residuals = rows.map((row) => {
    const means = groupMeans.get(`${row.season}:${row.team}`)!;
    return DEFENSE_COPULA_COMPONENTS.map(
      (component) => row.components[component] - means[component],
    );
  });
  return {
    ...common,
    state: "fitted",
    throughSeason,
    overdispersion,
    dependence: defenseGameRankDependence(residuals),
  };
}
