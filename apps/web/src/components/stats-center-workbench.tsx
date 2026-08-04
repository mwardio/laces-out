"use client";

import type {
  StatsCenterAdditiveMetric,
  StatsCenterMetricDescriptor,
  StatsCenterPlayer,
  StatsCenterRatioMetric,
  StatsCenterResponse,
  StatsCenterScoring,
  StatsCenterSort,
  StatsCenterTrendMetric,
} from "@fantasy/contracts";
import {
  ChartSpline,
  Database,
  ExternalLink,
  Info,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
} from "lucide-react";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiBaseUrl, parseStatsCenterResponse } from "../lib/api-client";
import { NFL_TEAM_CHOICES } from "../lib/nfl-teams";
import {
  dateTime,
  emptyBoomBust,
  emptyRatioValues,
  emptyTrendRecord,
  number,
  rate,
  signed,
  statsAdditiveValues,
  weekCoverage,
} from "./stats-formatting";
import styles from "./stats-center-workbench.module.css";

type MetricFamily = "usage" | "production" | "efficiency" | "trend" | "all";

interface FilterState {
  readonly season: number;
  readonly weekFrom: number | null;
  readonly weekTo: number | null;
  readonly position: string;
  readonly team: string;
  readonly search: string;
  readonly sort: StatsCenterSort;
  readonly scoring: StatsCenterScoring;
}

type ViewState =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly data: StatsCenterResponse; readonly demo: boolean };

type Column =
  | {
      readonly kind: "usage";
      readonly short: string;
      readonly label: string;
      readonly format: "int" | "dec" | "rate";
      readonly read: (player: StatsCenterPlayer) => number | null;
      readonly sort: StatsCenterSort | null;
    }
  | {
      readonly kind: "total";
      readonly id: StatsCenterAdditiveMetric;
      readonly short: string;
      readonly format: "int" | "dec";
    }
  | {
      readonly kind: "perGame";
      readonly id: StatsCenterAdditiveMetric;
      readonly short: string;
      readonly format: "int" | "dec";
    }
  | {
      readonly kind: "ratio";
      readonly id: StatsCenterRatioMetric;
      readonly short: string;
      readonly format: "dec" | "rate";
    }
  | {
      readonly kind: "boomBust";
      readonly short: string;
      readonly label: string;
      readonly format: "dec" | "rate";
      readonly read: (player: StatsCenterPlayer) => number | null;
    }
  // Only the "all" view uses these. They read from whichever trend metric is selected, which is
  // why they carry a reader over the resolved trend row rather than a metric id of their own.
  | {
      readonly kind: "trend";
      readonly short: string;
      readonly label: string;
      readonly read: (
        trend: StatsCenterPlayer["trend"][StatsCenterTrendMetric] | undefined,
      ) => string;
    };

const usageColumns: readonly Column[] = [
  {
    kind: "usage",
    short: "TGT",
    label: "Targets",
    format: "int",
    read: (player) => player.targets,
    sort: "targets",
  },
  {
    kind: "usage",
    short: "CAR",
    label: "Carries",
    format: "int",
    read: (player) => player.carries,
    sort: "carries",
  },
  {
    kind: "usage",
    short: "OPP",
    label: "Opportunities",
    format: "int",
    read: (player) => player.opportunities,
    sort: "opportunities",
  },
  {
    kind: "usage",
    short: "OPP/G",
    label: "Opportunities per game",
    format: "dec",
    read: (player) => player.opportunitiesPerGame,
    sort: null,
  },
  {
    kind: "usage",
    short: "TGT%",
    label: "Target share",
    format: "rate",
    read: (player) => player.targetShare,
    sort: "targetShare",
  },
  {
    kind: "usage",
    short: "SNAP%",
    label: "Offensive snap share",
    format: "rate",
    read: (player) => player.offensiveSnapShare,
    sort: "offensiveSnapShare",
  },
];

const productionColumns: readonly Column[] = [
  { kind: "total", id: "passYards", short: "PYD", format: "int" },
  { kind: "total", id: "passTouchdowns", short: "PTD", format: "int" },
  { kind: "total", id: "passInterceptions", short: "INT", format: "int" },
  { kind: "total", id: "rushYards", short: "RUYD", format: "int" },
  { kind: "total", id: "rushTouchdowns", short: "RUTD", format: "int" },
  { kind: "total", id: "receptions", short: "REC", format: "int" },
  { kind: "total", id: "recYards", short: "REYD", format: "int" },
  { kind: "total", id: "recTouchdowns", short: "RETD", format: "int" },
  { kind: "total", id: "fumblesLost", short: "FL", format: "int" },
  { kind: "total", id: "pointsPpr", short: "PTS", format: "dec" },
  { kind: "perGame", id: "pointsPpr", short: "PTS/G", format: "dec" },
  {
    kind: "boomBust",
    short: "BOOM%",
    label: "Boom rate",
    format: "rate",
    read: (player) => player.boomBust.boomRate,
  },
  {
    kind: "boomBust",
    short: "BUST%",
    label: "Bust rate",
    format: "rate",
    read: (player) => player.boomBust.bustRate,
  },
];

const efficiencyColumns: readonly Column[] = [
  { kind: "ratio", id: "airYardsShare", short: "AY%", format: "rate" },
  { kind: "ratio", id: "weightedOpportunityRating", short: "WOPR", format: "dec" },
  { kind: "ratio", id: "passAirConversionRatio", short: "PACR", format: "dec" },
  { kind: "ratio", id: "completionPercentageOverExpected", short: "CPOE", format: "dec" },
  { kind: "total", id: "recAirYards", short: "RAY", format: "int" },
  { kind: "total", id: "recYardsAfterCatch", short: "RYAC", format: "int" },
  { kind: "total", id: "recEpa", short: "REPA", format: "dec" },
  { kind: "total", id: "rushEpa", short: "RUEPA", format: "dec" },
  { kind: "total", id: "passAirYards", short: "PAY", format: "int" },
  { kind: "total", id: "passEpa", short: "PEPA", format: "dec" },
];

const familyOptions: readonly { value: MetricFamily; label: string }[] = [
  { value: "usage", label: "Usage" },
  { value: "production", label: "Production" },
  { value: "efficiency", label: "Efficiency" },
  { value: "trend", label: "Trend" },
  { value: "all", label: "All stats" },
];

// The metric tabs show titles only; the active family's description renders as
// a single muted line below the tab strip instead of wrapping inside each tab.
const familyHints: Readonly<Record<MetricFamily, string>> = {
  usage: "Targets, carries, and time on the field",
  production: "Scored output and boom or bust shape",
  efficiency: "Air yards, EPA, and derived shares",
  trend: "Recent weeks against the full window",
  all: "Every column from the four views above, in one table",
};

const trendOptions: readonly { value: StatsCenterTrendMetric; label: string }[] = [
  { value: "opportunitiesPerGame", label: "Opportunities per game" },
  { value: "targetsPerGame", label: "Targets per game" },
  { value: "carriesPerGame", label: "Carries per game" },
  { value: "targetShare", label: "Target share" },
  { value: "offensiveSnapShare", label: "Snap share" },
  { value: "fantasyPoints", label: "Points" },
];

const familyDefaultSort: Readonly<Record<MetricFamily, StatsCenterSort>> = {
  usage: "opportunities",
  production: "pointsPpr",
  efficiency: "recAirYards",
  trend: "opportunities",
  all: "pointsPpr",
};

const trendColumns: readonly Column[] = [
  {
    kind: "trend",
    short: "WIN AVG",
    label: "Window average",
    read: (trend) => number(trend?.seasonAverage ?? null, 1),
  },
  {
    kind: "trend",
    short: "REC AVG",
    label: "Recent weighted average",
    read: (trend) => number(trend?.recentWeightedAverage ?? null, 1),
  },
  {
    kind: "trend",
    short: "CHG",
    label: "Change against the window",
    read: (trend) => signed(trend?.absoluteChange ?? null),
  },
  {
    kind: "trend",
    short: "WKS",
    label: "Recent weeks over sampled weeks",
    read: (trend) =>
      trend?.status === "available" ? `${trend.recentSampleSize} / ${trend.sampleSize}` : "—",
  },
];

/**
 * "All stats" is the four views concatenated, in tab order, so a column keeps the same short
 * label and meaning it has in its own view. It is wide on purpose — the column picker beside the
 * table is how a reader narrows it.
 */
const allColumns: readonly Column[] = [
  ...usageColumns,
  ...productionColumns,
  ...efficiencyColumns,
  ...trendColumns,
];

/** Stable across renders and unique within a view; used for React keys and picker state. */
function columnKey(column: Column): string {
  return `${column.kind}-${column.short}`;
}

function columnsFor(family: MetricFamily): readonly Column[] {
  if (family === "production") return productionColumns;
  if (family === "efficiency") return efficiencyColumns;
  if (family === "all") return allColumns;
  return usageColumns;
}

function columnSort(column: Column): StatsCenterSort | null {
  switch (column.kind) {
    case "usage":
      return column.sort;
    case "total":
    case "ratio":
      return column.id;
    // Per-game and boom/bust are derived from a total the server already sorts by; trend columns
    // are derived client-side from the selected trend metric and have no server sort at all.
    case "perGame":
    case "boomBust":
    case "trend":
      return null;
  }
}

function columnValue(player: StatsCenterPlayer, column: Column): number | null {
  switch (column.kind) {
    case "usage":
    case "boomBust":
      return column.read(player);
    case "total":
      return player.totals[column.id] ?? null;
    case "perGame":
      return player.perGame[column.id] ?? null;
    case "ratio":
      return player.ratios[column.id] ?? null;
    case "trend":
      return null;
  }
}

function formatted(value: number | null, format: "int" | "dec" | "rate"): string {
  if (format === "rate") return rate(value);
  return number(value, format === "dec" ? 1 : 0);
}

function columnLabel(column: Column, metrics: readonly StatsCenterMetricDescriptor[]): string {
  if (column.kind === "usage" || column.kind === "boomBust" || column.kind === "trend") {
    return column.label;
  }
  const descriptor = metrics.find((metric) => metric.id === column.id);
  const suffix = column.kind === "perGame" ? " per game" : "";
  return `${descriptor?.label ?? column.id}${suffix}`;
}

const samplePlayers: readonly StatsCenterPlayer[] = [
  {
    playerId: "10000000-0000-4000-8000-000000000001",
    name: "Amon-Ra St. Brown",
    position: "WR",
    team: "DET",
    games: 5,
    snapGames: 5,
    targets: 49,
    carries: 1,
    opportunities: 50,
    targetsPerGame: 9.8,
    carriesPerGame: 0.2,
    opportunitiesPerGame: 10,
    targetShare: 0.286,
    offensiveSnaps: 298,
    offensiveSnapShare: 0.91,
    totals: statsAdditiveValues({
      receptions: 38,
      recYards: 452,
      recTouchdowns: 3,
      recAirYards: 391,
      recYardsAfterCatch: 188,
      recEpa: 22.4,
      pointsPpr: 101.2,
      pointsStandard: 63.2,
    }),
    perGame: statsAdditiveValues({
      receptions: 7.6,
      recYards: 90.4,
      recTouchdowns: 0.6,
      pointsPpr: 20.2,
      pointsStandard: 12.6,
    }),
    ratios: { ...emptyRatioValues, airYardsShare: 0.31, weightedOpportunityRating: 0.646 },
    trend: emptyTrendRecord({
      opportunitiesPerGame: {
        status: "available",
        seasonAverage: 10,
        recentWeightedAverage: 11.2,
        absoluteChange: 1.2,
        sampleSize: 5,
        recentSampleSize: 4,
        reason: null,
      },
    }),
    boomBust: {
      ...emptyBoomBust,
      status: "available",
      games: 5,
      missingGames: 0,
      booms: 3,
      busts: 1,
      neutral: 1,
      boomRate: 0.6,
      bustRate: 0.2,
      averagePoints: 20.2,
      standardDeviation: 6.1,
      threshold: { boomAtOrAbove: 20, bustAtOrBelow: 8 },
      reason: null,
    },
  },
  {
    playerId: "10000000-0000-4000-8000-000000000002",
    name: "Breece Hall",
    position: "RB",
    team: "NYJ",
    games: 5,
    snapGames: 5,
    targets: 27,
    carries: 76,
    opportunities: 103,
    targetsPerGame: 5.4,
    carriesPerGame: 15.2,
    opportunitiesPerGame: 20.6,
    targetShare: 0.168,
    offensiveSnaps: 244,
    offensiveSnapShare: 0.72,
    totals: statsAdditiveValues({
      receptions: 21,
      recYards: 174,
      rushYards: 341,
      rushTouchdowns: 2,
      rushEpa: 4.8,
      recAirYards: 62,
      pointsPpr: 94.5,
      pointsStandard: 73.5,
    }),
    perGame: statsAdditiveValues({
      rushYards: 68.2,
      receptions: 4.2,
      pointsPpr: 18.9,
      pointsStandard: 14.7,
    }),
    ratios: { ...emptyRatioValues, airYardsShare: 0.05, weightedOpportunityRating: 0.287 },
    trend: emptyTrendRecord({
      opportunitiesPerGame: {
        status: "available",
        seasonAverage: 20.6,
        recentWeightedAverage: 19.1,
        absoluteChange: -1.5,
        sampleSize: 5,
        recentSampleSize: 4,
        reason: null,
      },
    }),
    boomBust: {
      ...emptyBoomBust,
      status: "available",
      games: 5,
      missingGames: 0,
      booms: 2,
      busts: 1,
      neutral: 2,
      boomRate: 0.4,
      bustRate: 0.2,
      averagePoints: 18.9,
      standardDeviation: 7.4,
      threshold: { boomAtOrAbove: 20, bustAtOrBelow: 8 },
      reason: null,
    },
  },
  {
    playerId: "10000000-0000-4000-8000-000000000003",
    name: "Trey McBride",
    position: "TE",
    team: "ARI",
    games: 5,
    snapGames: 5,
    targets: 42,
    carries: 0,
    opportunities: 42,
    targetsPerGame: 8.4,
    carriesPerGame: 0,
    opportunitiesPerGame: 8.4,
    targetShare: 0.241,
    offensiveSnaps: 281,
    offensiveSnapShare: 0.88,
    totals: statsAdditiveValues({
      receptions: 31,
      recYards: 336,
      recTouchdowns: 1,
      recAirYards: 240,
      recYardsAfterCatch: 151,
      pointsPpr: 70.6,
      pointsStandard: 39.6,
    }),
    perGame: statsAdditiveValues({ receptions: 6.2, recYards: 67.2, pointsPpr: 14.1 }),
    ratios: { ...emptyRatioValues, airYardsShare: 0.22, weightedOpportunityRating: 0.516 },
    trend: emptyTrendRecord({
      opportunitiesPerGame: {
        status: "available",
        seasonAverage: 8.4,
        recentWeightedAverage: 9.3,
        absoluteChange: 0.9,
        sampleSize: 5,
        recentSampleSize: 4,
        reason: null,
      },
    }),
    boomBust: {
      ...emptyBoomBust,
      status: "available",
      games: 5,
      missingGames: 0,
      booms: 2,
      busts: 1,
      neutral: 2,
      boomRate: 0.4,
      bustRate: 0.2,
      averagePoints: 14.1,
      standardDeviation: 4.9,
      threshold: { boomAtOrAbove: 15, bustAtOrBelow: 5 },
      reason: null,
    },
  },
  {
    playerId: "10000000-0000-4000-8000-000000000004",
    name: "Jayden Daniels",
    position: "QB",
    team: "WAS",
    games: 5,
    snapGames: 5,
    targets: 0,
    carries: 41,
    opportunities: 41,
    targetsPerGame: 0,
    carriesPerGame: 8.2,
    opportunitiesPerGame: 8.2,
    targetShare: 0,
    offensiveSnaps: 321,
    offensiveSnapShare: 0.98,
    totals: statsAdditiveValues({
      passCompletions: 108,
      passAttempts: 148,
      passYards: 1_213,
      passTouchdowns: 7,
      passInterceptions: 2,
      rushYards: 264,
      rushTouchdowns: 4,
      passAirYards: 1_026,
      passEpa: 31.7,
      pointsPpr: 118.9,
      pointsStandard: 118.9,
    }),
    perGame: statsAdditiveValues({ passYards: 242.6, rushYards: 52.8, pointsPpr: 23.8 }),
    ratios: {
      ...emptyRatioValues,
      passAirConversionRatio: 1.18,
      completionPercentageOverExpected: 5.4,
    },
    trend: emptyTrendRecord({
      opportunitiesPerGame: {
        status: "available",
        seasonAverage: 8.2,
        recentWeightedAverage: 8.6,
        absoluteChange: 0.4,
        sampleSize: 5,
        recentSampleSize: 4,
        reason: null,
      },
    }),
    boomBust: {
      ...emptyBoomBust,
      status: "available",
      games: 5,
      missingGames: 0,
      booms: 2,
      busts: 0,
      neutral: 3,
      boomRate: 0.4,
      bustRate: 0,
      averagePoints: 23.8,
      standardDeviation: 5.2,
      threshold: { boomAtOrAbove: 25, bustAtOrBelow: 15 },
      reason: null,
    },
  },
];

function defaultSeason(): number {
  const now = new Date();
  return now.getMonth() < 8 ? now.getFullYear() - 1 : now.getFullYear();
}

const initialFilters: FilterState = {
  season: defaultSeason(),
  weekFrom: null,
  weekTo: null,
  position: "",
  team: "",
  search: "",
  sort: "opportunities",
  scoring: "ppr",
};

const SAMPLE_METRIC_DEFINITIONS: readonly StatsCenterMetricDescriptor[] = [
  {
    id: "pointsPpr",
    label: "Points (PPR)",
    family: "production",
    kind: "additive",
    definition: "Illustrative sample of the source dataset's PPR points.",
    state: "available",
    reason: null,
  },
  {
    id: "airYardsShare",
    label: "Air-yards share",
    family: "efficiency",
    kind: "derivedRatio",
    definition: "Illustrative sample of player air yards over team air yards.",
    state: "available",
    reason: null,
  },
];

function sampleResponse(filters: FilterState): StatsCenterResponse {
  const normalizedSearch = filters.search.trim().toLocaleLowerCase();
  const hasSample = filters.season === 2025 && filters.weekFrom === null && filters.weekTo === null;
  const players = hasSample
    ? samplePlayers
        .filter(
          (player) =>
            (!filters.position || player.position === filters.position) &&
            (!filters.team || player.team === filters.team) &&
            (!normalizedSearch || player.name.toLocaleLowerCase().includes(normalizedSearch)),
        )
        .sort((left, right) => {
          const leftValue = sampleSortValue(left, filters.sort);
          const rightValue = sampleSortValue(right, filters.sort);
          return (rightValue ?? -1) - (leftValue ?? -1) || left.name.localeCompare(right.name);
        })
    : [];
  const datasetState = hasSample
    ? { state: "available" as const, reason: null }
    : { state: "no-data" as const, reason: "The tour includes a 2025 all-weeks sample only." };
  return {
    generatedAt: new Date().toISOString(),
    filters: {
      season: filters.season,
      weekFrom: filters.weekFrom,
      weekTo: filters.weekTo,
      position: filters.position || null,
      team: filters.team || null,
      search: filters.search.trim(),
      sort: filters.sort,
      scoring: filters.scoring,
      recentWindow: 4,
      recentWeightDecay: 0.75,
      limit: 50,
    },
    availability: {
      targets: datasetState,
      carries: datasetState,
      opportunities: datasetState,
      targetShare: datasetState,
      offensiveSnapShare: datasetState,
      redZone: {
        state: "unavailable",
        reason: "Red-zone attempts and targets are not present in the admitted weekly datasets.",
      },
      boomBust: datasetState,
      fantasyPointsAllowed: {
        state: "unavailable",
        reason: "Fantasy points allowed waits for verified league scoring and complete coverage.",
      },
    },
    metrics: [...SAMPLE_METRIC_DEFINITIONS],
    sources: [
      {
        dataset: "weekly-stats",
        state: "available",
        key: "tour.weekly-stats.2025",
        name: "Tour weekly stats",
        attribution: "Illustrative sample modeled on nflverse fields",
        attributionUrl: "https://github.com/nflverse/nflverse-data",
        fetchedAt: "2026-01-10T12:00:00.000Z",
        checksumSha256: "1".repeat(64),
        coveredWeeks: [1, 2, 3, 4, 5],
        quality: { rowsRead: 4, rowsRejected: 0, rowsUnmatched: 0, matchRate: 1 },
        reason: null,
      },
      {
        dataset: "snap-counts",
        state: "available",
        key: "tour.snap-counts.2025",
        name: "Tour snap counts",
        attribution: "Illustrative sample modeled on nflverse fields",
        attributionUrl: "https://github.com/nflverse/nflverse-data",
        fetchedAt: "2026-01-10T12:00:00.000Z",
        checksumSha256: "2".repeat(64),
        coveredWeeks: [1, 2, 3, 4, 5],
        quality: { rowsRead: 4, rowsRejected: 0, rowsUnmatched: 0, matchRate: 1 },
        reason: null,
      },
    ],
    players,
    totalMatched: players.length,
    truncated: false,
    definitions: {
      opportunities: "Opportunities equal carries plus targets from weekly stat rows.",
      targetShare:
        "Target share is player targets divided by all player targets for the same team and games.",
      offensiveSnapShare:
        "Season offensive snap share is the unweighted mean of game-level offensive shares.",
      recentTrend:
        "Recent trend compares the full-sample per-game mean with an exponentially weighted mean of the most recent weeks.",
      boomBust:
        "Boom and bust use the source dataset's own PPR points with documented thresholds. They are not scored to any league's rules.",
    },
  };
}

function sampleSortValue(player: StatsCenterPlayer, sort: StatsCenterSort): number | null {
  if (sort === "targets") return player.targets;
  if (sort === "carries") return player.carries;
  if (sort === "opportunities") return player.opportunities;
  if (sort === "targetShare") return player.targetShare;
  if (sort === "offensiveSnapShare") return player.offensiveSnapShare;
  const totals: Partial<Record<string, number | null>> = player.totals;
  const ratios: Partial<Record<string, number | null>> = player.ratios;
  return totals[sort] ?? ratios[sort] ?? null;
}

export function StatsCenterWorkbench() {
  const [filters, setFilters] = useState<FilterState>(initialFilters);
  const [family, setFamily] = useState<MetricFamily>("usage");
  const [trendMetric, setTrendMetric] = useState<StatsCenterTrendMetric>("opportunitiesPerGame");
  const [view, setView] = useState<ViewState>({ state: "loading" });
  // Only the "all" view can hide columns, and it stores what is *hidden* so a column added to a
  // family later shows up by default rather than being silently absent.
  const [hiddenColumns, setHiddenColumns] = useState<ReadonlySet<string>>(() => new Set());
  const requestRef = useRef<AbortController | null>(null);

  const load = useCallback(async (next: FilterState, demo = false) => {
    requestRef.current?.abort();
    if (demo) {
      setView({ state: "ready", data: sampleResponse(next), demo: true });
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    setView({ state: "loading" });
    const query = new URLSearchParams({
      season: String(next.season),
      sort: next.sort,
      scoring: next.scoring,
      limit: "50",
    });
    if (next.weekFrom !== null) query.set("weekFrom", String(next.weekFrom));
    if (next.weekTo !== null) query.set("weekTo", String(next.weekTo));
    if (next.position) query.set("position", next.position);
    if (next.team) query.set("team", next.team);
    if (next.search.trim()) query.set("search", next.search.trim());
    try {
      const response = await fetch(`${apiBaseUrl}/v1/stats/players?${query.toString()}`, {
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (response.status === 401) {
        const tourFilters = { ...next, season: 2025, weekFrom: null, weekTo: null };
        setFilters(tourFilters);
        setView({ state: "ready", data: sampleResponse(tourFilters), demo: true });
        return;
      }
      if (!response.ok) throw new Error("Stats Center could not load its admitted datasets.");
      const parsed = parseStatsCenterResponse(await response.json());
      if (!parsed) throw new Error("The Stats Center response failed its data contract.");
      if (!controller.signal.aborted) setView({ state: "ready", data: parsed, demo: false });
    } catch (error) {
      if (!controller.signal.aborted) {
        setView({
          state: "error",
          message: error instanceof Error ? error.message : "Stats Center could not be loaded.",
        });
      }
    }
  }, []);

  useEffect(() => {
    void load(initialFilters);
    return () => requestRef.current?.abort();
  }, [load]);

  const seasons = useMemo(() => {
    const current = new Date().getFullYear();
    return Array.from({ length: 6 }, (_, index) => current - index);
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void load(filters, view.state === "ready" && view.demo);
  }

  function chooseFamily(next: MetricFamily) {
    setFamily(next);
    const nextFilters = { ...filters, sort: familyDefaultSort[next] };
    setFilters(nextFilters);
    void load(nextFilters, view.state === "ready" && view.demo);
  }

  function chooseSort(sort: StatsCenterSort) {
    const next = { ...filters, sort };
    setFilters(next);
    void load(next, view.state === "ready" && view.demo);
  }

  function toggleColumn(key: string) {
    setHiddenColumns((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  return (
    <div className={styles.page}>
      {view.state === "ready" && view.demo ? (
        <div className={styles.demoNotice} role="status">
          <Info size={17} aria-hidden="true" />
          <span>
            <strong>Locker room tour</strong>
            Illustrative opportunity and participation rows. No live player data is shown.
          </span>
        </div>
      ) : null}

      <header className={styles.hero}>
        <div>
          <p>Usage before points</p>
          <h1>Stats Center</h1>
          <span>
            Every admitted weekly field, one window at a time: volume, scored production, air-yards
            and EPA efficiency, and how the recent weeks compare with the whole range.
          </span>
        </div>
        <ChartSpline size={34} strokeWidth={1.5} aria-hidden="true" />
      </header>

      <form className={styles.filters} onSubmit={submit}>
        <label>
          <span>Season</span>
          <select
            value={filters.season}
            onChange={(event) =>
              setFilters((current) => ({ ...current, season: Number(event.target.value) }))
            }
          >
            {seasons.map((season) => (
              <option value={season} key={season}>
                {season}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>From week</span>
          <select
            value={filters.weekFrom ?? ""}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                weekFrom: event.target.value ? Number(event.target.value) : null,
              }))
            }
          >
            <option value="">Week 1</option>
            {Array.from({ length: 18 }, (_, index) => index + 1).map((week) => (
              <option value={week} key={week}>
                Week {week}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>To week</span>
          <select
            value={filters.weekTo ?? ""}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                weekTo: event.target.value ? Number(event.target.value) : null,
              }))
            }
          >
            <option value="">Latest</option>
            {Array.from({ length: 18 }, (_, index) => index + 1).map((week) => (
              <option value={week} key={week}>
                Week {week}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Position</span>
          <select
            value={filters.position}
            onChange={(event) =>
              setFilters((current) => ({ ...current, position: event.target.value }))
            }
          >
            <option value="">All positions</option>
            {["QB", "RB", "WR", "TE", "K"].map((position) => (
              <option value={position} key={position}>
                {position}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Team</span>
          <select
            value={filters.team}
            onChange={(event) =>
              setFilters((current) => ({ ...current, team: event.target.value }))
            }
          >
            <option value="">All teams</option>
            {NFL_TEAM_CHOICES.map((team) => (
              <option value={team} key={team}>
                {team}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Scoring</span>
          <select
            value={filters.scoring}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                scoring: event.target.value === "standard" ? "standard" : "ppr",
              }))
            }
          >
            <option value="ppr">Source PPR</option>
            <option value="standard">Source standard</option>
          </select>
        </label>
        <label className={styles.search}>
          <span>Player</span>
          <span>
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              maxLength={80}
              placeholder="Search by name"
              value={filters.search}
              onChange={(event) =>
                setFilters((current) => ({ ...current, search: event.target.value }))
              }
            />
          </span>
        </label>
        <button type="submit" disabled={view.state === "loading"}>
          <RefreshCw
            className={view.state === "loading" ? styles.spin : undefined}
            size={15}
            aria-hidden="true"
          />
          Apply
        </button>
      </form>

      <div className={styles.metricTabs} aria-label="Choose a metric family">
        {familyOptions.map((option) => (
          <button
            type="button"
            className={family === option.value ? styles.activeMetric : undefined}
            aria-pressed={family === option.value}
            onClick={() => chooseFamily(option.value)}
            key={option.value}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className={styles.metricHint}>{familyHints[family]}</p>

      {view.state === "loading" ? (
        <div className={styles.stateCard} role="status">
          <LoaderCircle className={styles.spin} size={20} aria-hidden="true" />
          <div>
            <strong>Reading the latest admitted files</strong>
            <span>Resolving players and rebuilding opportunity metrics.</span>
          </div>
        </div>
      ) : view.state === "error" ? (
        <div className={styles.stateCard} role="alert">
          <ShieldAlert size={20} aria-hidden="true" />
          <div>
            <strong>Stats Center is unavailable</strong>
            <span>{view.message}</span>
          </div>
        </div>
      ) : (
        <StatsResult
          data={view.data}
          family={family}
          trendMetric={trendMetric}
          onTrendMetric={setTrendMetric}
          onSort={chooseSort}
          hiddenColumns={hiddenColumns}
          onToggleColumn={toggleColumn}
          onShowAllColumns={() => setHiddenColumns(new Set())}
        />
      )}
    </div>
  );
}

/**
 * Column visibility for the "all" view. A collapsed disclosure rather than an always-open strip:
 * the whole point of the view is the full table, so the control that narrows it should not take
 * a row away from it until someone asks for it.
 */
function ColumnPicker({
  columns,
  hidden,
  metrics,
  onToggle,
  onShowAll,
}: {
  readonly columns: readonly Column[];
  readonly hidden: ReadonlySet<string>;
  readonly metrics: readonly StatsCenterMetricDescriptor[];
  readonly onToggle: (key: string) => void;
  readonly onShowAll: () => void;
}) {
  const shown = columns.length - hidden.size;
  return (
    <details className={styles.columnPicker}>
      <summary>
        <span>
          <SlidersHorizontal size={14} aria-hidden="true" /> Columns
        </span>
        <small>
          {shown} of {columns.length} shown
        </small>
      </summary>
      <div className={styles.columnPickerBody}>
        {columns.map((column) => {
          const key = columnKey(column);
          return (
            <label key={key}>
              <input
                type="checkbox"
                checked={!hidden.has(key)}
                onChange={() => onToggle(key)}
                // The table needs at least one metric column to remain a table.
                disabled={shown === 1 && !hidden.has(key)}
              />
              <span>
                <strong>{column.short}</strong>
                <small>{columnLabel(column, metrics)}</small>
              </span>
            </label>
          );
        })}
      </div>
      <button
        className={styles.columnPickerReset}
        type="button"
        onClick={onShowAll}
        disabled={hidden.size === 0}
      >
        Show every column
      </button>
    </details>
  );
}

/** The withheld notice for the visible view, whether that is a usage metric or a derived one. */
function selectedAvailability(data: StatsCenterResponse): {
  readonly state: "available" | "unavailable" | "no-data";
  readonly reason: string | null;
} {
  const sort = data.filters.sort;
  if (sort in data.availability) {
    return data.availability[sort as keyof StatsCenterResponse["availability"]];
  }
  const descriptor = data.metrics.find((metric) => metric.id === sort);
  return descriptor ?? { state: "available", reason: null };
}

function windowLabel(data: StatsCenterResponse): string {
  const { weekFrom, weekTo } = data.filters;
  if (weekFrom === null && weekTo === null) return "All weeks";
  if (weekFrom !== null && weekTo !== null) {
    return weekFrom === weekTo ? `Week ${weekFrom}` : `Weeks ${weekFrom}–${weekTo}`;
  }
  return weekFrom !== null ? `Week ${weekFrom} onward` : `Through week ${weekTo}`;
}

function StatsResult({
  data,
  family,
  trendMetric,
  onTrendMetric,
  onSort,
  hiddenColumns,
  onToggleColumn,
  onShowAllColumns,
}: {
  readonly data: StatsCenterResponse;
  readonly family: MetricFamily;
  readonly trendMetric: StatsCenterTrendMetric;
  readonly onTrendMetric: (metric: StatsCenterTrendMetric) => void;
  readonly onSort: (sort: StatsCenterSort) => void;
  readonly hiddenColumns: ReadonlySet<string>;
  readonly onToggleColumn: (key: string) => void;
  readonly onShowAllColumns: () => void;
}) {
  const availability = selectedAvailability(data);
  const allViewColumns = columnsFor(family);
  // Hiding applies to the "all" view only; the four focused views are already curated.
  const columns =
    family === "all"
      ? allViewColumns.filter((column) => !hiddenColumns.has(columnKey(column)))
      : allViewColumns;
  const withheldColumns =
    family === "usage"
      ? []
      : columns.flatMap((column) => {
          const id =
            column.kind === "boomBust" || column.kind === "usage" || column.kind === "trend"
              ? null
              : column.id;
          if (!id) return [];
          const descriptor = data.metrics.find((metric) => metric.id === id);
          return descriptor && descriptor.state !== "available" ? [descriptor] : [];
        });
  const familyDefinition =
    family === "trend"
      ? data.definitions.recentTrend
      : family === "production"
        ? data.definitions.boomBust
        : family === "efficiency"
          ? (data.metrics.find((metric) => metric.id === "airYardsShare")?.definition ??
            data.definitions.targetShare)
          : family === "all"
            ? data.definitions.opportunities
            : data.filters.sort === "offensiveSnapShare"
              ? data.definitions.offensiveSnapShare
              : data.filters.sort === "targetShare"
                ? data.definitions.targetShare
                : data.definitions.opportunities;

  return (
    <>
      {availability.state !== "available" ? (
        <div className={styles.warning} role="status">
          <ShieldAlert size={18} aria-hidden="true" />
          <div>
            <strong>
              {availability.state === "no-data"
                ? "No observations for this view"
                : "This metric is withheld"}
            </strong>
            <span>{availability.reason}</span>
          </div>
        </div>
      ) : null}

      <section className={styles.leaderPanel} aria-labelledby="leader-title">
        <div className={styles.panelHeading}>
          <div>
            <p>Regular-season observations</p>
            <h2 id="leader-title">
              {familyOptions.find((option) => option.value === family)?.label} leaders
            </h2>
          </div>
          {/* The API caps `players` at `limit` but reports the uncapped
              `totalMatched`. Printing only the latter claimed the table showed
              every match. */}
          <span>
            {data.truncated
              ? `Top ${data.players.length} of ${data.totalMatched} players`
              : `${data.totalMatched} player${data.totalMatched === 1 ? "" : "s"}`}
            {` · ${windowLabel(data)}`}
          </span>
        </div>

        {/* "All stats" carries the trend columns too, so it needs the same metric selector — the
            four trend columns are meaningless without knowing which metric they describe. */}
        {family === "trend" || family === "all" ? (
          <div className={styles.trendControls}>
            <label>
              <span>Trend metric</span>
              <select
                value={trendMetric}
                onChange={(event) => onTrendMetric(event.target.value as StatsCenterTrendMetric)}
              >
                {trendOptions.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <p>
              Recent weighting uses the last {data.filters.recentWindow} weeks with a{" "}
              {data.filters.recentWeightDecay} decay per preceding week.
            </p>
          </div>
        ) : null}

        {family === "all" ? (
          <ColumnPicker
            columns={allViewColumns}
            hidden={hiddenColumns}
            metrics={data.metrics}
            onToggle={onToggleColumn}
            onShowAll={onShowAllColumns}
          />
        ) : null}

        {data.players.length === 0 ? (
          <div className={styles.emptyState}>
            <Database size={22} aria-hidden="true" />
            <strong>No player rows match this view</strong>
            <span>Try another season, week range, team, position, or player name.</span>
          </div>
        ) : (
          <div
            className={`${styles.tableScroll} has-scroll-cue`}
            role="region"
            aria-label="Player metric leaders; scroll horizontally to view all columns"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Player</th>
                  <th scope="col">G</th>
                  {family === "trend" ? (
                    <>
                      <th scope="col">Window avg</th>
                      <th scope="col">Recent avg</th>
                      <th scope="col">Change</th>
                      <th scope="col">Weeks</th>
                    </>
                  ) : (
                    columns.map((column) => {
                      const sort = columnSort(column);
                      const active = sort !== null && data.filters.sort === sort;
                      return (
                        <th
                          scope="col"
                          key={columnKey(column)}
                          aria-sort={active ? "descending" : undefined}
                        >
                          {sort ? (
                            <button
                              type="button"
                              className={active ? styles.activeSort : undefined}
                              onClick={() => onSort(sort)}
                              title={`Sort by ${columnLabel(column, data.metrics)}`}
                            >
                              {column.short}
                            </button>
                          ) : (
                            column.short
                          )}
                        </th>
                      );
                    })
                  )}
                </tr>
              </thead>
              <tbody>
                {data.players.map((player, index) => {
                  const trend = player.trend[trendMetric];
                  return (
                    <tr key={player.playerId}>
                      <th scope="row">
                        <span className={styles.rank}>{index + 1}</span>
                        <span>
                          <Link
                            href={`/stats/players/${player.playerId}?season=${data.filters.season}`}
                          >
                            {player.name}
                          </Link>
                          <small>
                            {player.position} · {player.team ?? "FA"}
                          </small>
                        </span>
                      </th>
                      <td>{player.games}</td>
                      {family === "trend" ? (
                        <>
                          <td>{number(trend?.seasonAverage ?? null, 1)}</td>
                          <td>{number(trend?.recentWeightedAverage ?? null, 1)}</td>
                          <td>{signed(trend?.absoluteChange ?? null)}</td>
                          <td>
                            {trend?.status === "available"
                              ? `${trend.recentSampleSize} / ${trend.sampleSize}`
                              : "—"}
                          </td>
                        </>
                      ) : (
                        columns.map((column) => (
                          <td key={columnKey(column)}>
                            {column.kind === "trend"
                              ? column.read(trend)
                              : formatted(columnValue(player, column), column.format)}
                          </td>
                        ))
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className={styles.definition}>{familyDefinition}</p>
        {withheldColumns.length > 0 ? (
          <ul className={styles.withheldList}>
            {withheldColumns.map((descriptor) => (
              <li key={descriptor.id}>
                <strong>{descriptor.label}</strong> {descriptor.reason}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className={styles.sourceSection} aria-labelledby="source-title">
        <div className={styles.sectionHeading}>
          <div>
            <p>Audit trail</p>
            <h2 id="source-title">Source health</h2>
          </div>
        </div>
        <div className={styles.sourceGrid}>
          {data.sources.map((source) => (
            <article key={source.dataset}>
              <div>
                <span className={`${styles.sourceState} ${styles[`sourceState--${source.state}`]}`}>
                  {source.state}
                </span>
                <strong>{source.name}</strong>
              </div>
              <dl>
                <div>
                  <dt>Checked</dt>
                  <dd>{dateTime(source.fetchedAt)}</dd>
                </div>
                <div>
                  <dt>Identity match</dt>
                  <dd>{rate(source.quality.matchRate)}</dd>
                </div>
                <div>
                  <dt>Unresolved</dt>
                  <dd>{number(source.quality.rowsUnmatched)}</dd>
                </div>
                <div>
                  <dt>Rejected</dt>
                  <dd>{number(source.quality.rowsRejected)}</dd>
                </div>
                {source.coveredWeeks.length > 0 ? (
                  <div>
                    <dt>Weeks covered</dt>
                    <dd>{weekCoverage(source.coveredWeeks)}</dd>
                  </div>
                ) : null}
              </dl>
              {source.reason ? <p>{source.reason}</p> : null}
              {source.attribution ? (
                source.attributionUrl ? (
                  <a href={source.attributionUrl} target="_blank" rel="noreferrer">
                    {source.attribution}
                    <ExternalLink size={13} aria-hidden="true" />
                  </a>
                ) : (
                  <span className={styles.attribution}>{source.attribution}</span>
                )
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <HonestGaps data={data} />
    </>
  );
}

/** Only genuinely withheld metrics belong here; listing an available one printed a blank row. */
function HonestGaps({ data }: { readonly data: StatsCenterResponse }) {
  const gaps = (
    [
      ["Red-zone usage", data.availability.redZone],
      ["Boom / bust", data.availability.boomBust],
      ["Fantasy points allowed", data.availability.fantasyPointsAllowed],
    ] as const
  ).flatMap(([label, item]) =>
    item.state !== "available" && item.reason ? [{ label, reason: item.reason }] : [],
  );
  if (gaps.length === 0) return null;
  return (
    <section className={styles.withheld} aria-labelledby="withheld-title">
      <div className={styles.sectionHeading}>
        <div>
          <p>Honest gaps</p>
          <h2 id="withheld-title">Not inferred from partial data</h2>
        </div>
      </div>
      <div>
        {gaps.map((gap) => (
          <article key={gap.label}>
            <strong>{gap.label}</strong>
            <span>{gap.reason}</span>
          </article>
        ))}
      </div>
    </section>
  );
}
