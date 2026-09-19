import { createHash } from "node:crypto";
import { canonicalNflTeamCode, NFL_TEAMS } from "@laces-out/domain";
import type { FirstPartyTeamDefenseWeeklyStatLine } from "@laces-out/projections";
import {
  HISTORICAL_ROS_COHORT_SELECTION_VERSION,
  HISTORICAL_ROS_PRODUCTION_BASIS_VERSION,
  HISTORICAL_ROS_SCORING_PROFILE,
  selectHistoricalRosDefenses,
} from "./first-party-ros-backtest.js";

export const FIRST_PARTY_ROS_DEFENSE_RANK_VERSION =
  "fixed-reference-last-four-played-dst-full32-ordinal-v1";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = (value: string) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const teamSet = new Set<string>(NFL_TEAMS);

/**
 * A cutoff-safe feature extractor, not a source/finality authenticator or publication approval.
 * Callers must bind the already verified history and finality evidence via the supplied digests.
 * Uses the exact historical selector, including canonical aliases and LA/LAR tie ordering.
 */
export function buildFirstPartyRosDefenseRank(input: {
  readonly history: readonly FirstPartyTeamDefenseWeeklyStatLine[];
  readonly season: number;
  readonly asOfWeek: number;
  readonly sourceHistoryChecksum: string;
  readonly finalityChecksum: string;
}) {
  if (
    !Number.isSafeInteger(input.season) ||
    input.season < 2000 ||
    input.season > 2200 ||
    !Number.isSafeInteger(input.asOfWeek) ||
    input.asOfWeek < 0 ||
    input.asOfWeek > 17 ||
    !digest(input.sourceHistoryChecksum) ||
    !digest(input.finalityChecksum) ||
    !Array.isArray(input.history) ||
    input.history.length > 20_000 ||
    Object.keys(input.history).length !== input.history.length
  )
    throw new TypeError("Invalid ROS defense rank input");
  const base = {
    featureVersion: FIRST_PARTY_ROS_DEFENSE_RANK_VERSION,
    referenceProductionBasis: HISTORICAL_ROS_PRODUCTION_BASIS_VERSION,
    selectionVersion: HISTORICAL_ROS_COHORT_SELECTION_VERSION,
    season: input.season,
    asOfWeek: input.asOfWeek,
    sourceHistoryChecksum: input.sourceHistoryChecksum,
    finalityChecksum: input.finalityChecksum,
    canAuthorizeRelease: false as const,
  };
  const unavailable = (reason: string) => ({ ...base, state: "unavailable" as const, reason });
  if (input.asOfWeek === 0) return unavailable("preseason-reference-rank-unavailable");
  const rows: FirstPartyTeamDefenseWeeklyStatLine[] = [];
  const keys = new Set<string>();
  for (const supplied of input.history as readonly FirstPartyTeamDefenseWeeklyStatLine[]) {
    if (
      !Number.isSafeInteger(supplied.season) ||
      supplied.season < 2000 ||
      supplied.season > 2200 ||
      !Number.isSafeInteger(supplied.week) ||
      supplied.week < 1 ||
      supplied.week > 18
    )
      return unavailable("invalid-history-calendar");
    // Never inspect outcomes after the cutoff, including invalid/unavailable future components.
    if (supplied.season !== input.season || supplied.week > input.asOfWeek) continue;
    if (typeof supplied.team !== "string") return unavailable("unknown-defense-team");
    const team = canonicalNflTeamCode(supplied.team);
    if (!teamSet.has(team)) return unavailable("unknown-defense-team");
    const identity = `${team}/${supplied.week}`;
    if (keys.has(identity)) return unavailable("duplicate-canonical-defense-week");
    keys.add(identity);
    if (supplied.played !== undefined && typeof supplied.played !== "boolean")
      return unavailable("invalid-history-participation");
    const components = supplied.components;
    if (
      components === null ||
      typeof components !== "object" ||
      Array.isArray(components) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(components) as object | null) ||
      Object.keys(components).length > 1024
    )
      return unavailable("invalid-history-components");
    const entries = Object.entries(components).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (
      entries.some(
        ([key, value]) => !/^[a-z][a-z0-9_]{0,127}$/u.test(key) || !Number.isFinite(value),
      )
    )
      return unavailable("invalid-history-components");
    rows.push({
      team,
      season: supplied.season,
      week: supplied.week,
      played: supplied.played !== false,
      components: Object.fromEntries(entries.map(([key, value]) => [key, value === 0 ? 0 : value])),
    });
  }
  rows.sort((a, b) => (a.team < b.team ? -1 : a.team > b.team ? 1 : 0) || a.week - b.week);
  if (new Set(rows.map((row) => row.team)).size !== 32)
    return unavailable("full-defense-universe-unavailable");
  const selected = selectHistoricalRosDefenses({
    history: rows,
    season: input.season,
    asOfWeek: input.asOfWeek,
    scoringProfile: HISTORICAL_ROS_SCORING_PROFILE,
    teams: 32,
  });
  if (selected.length !== 32 || new Set(selected.map((row) => row.team)).size !== 32)
    return unavailable("full-eligible-defense-universe-unavailable");
  if (selected.some((row) => !Number.isFinite(row.recentPoints)))
    return unavailable("reference-production-overflow");
  const orderedTeams = selected.map((row) => row.team);
  const payload = {
    ...base,
    state: "ready" as const,
    cutoffHistoryChecksum: hash(rows),
    orderedUniverseChecksum: hash(orderedTeams),
    ranks: orderedTeams.map((canonicalTeam, index) => ({ canonicalTeam, ordinalRank: index + 1 })),
  };
  return { ...payload, checksum: hash(payload) };
}
