import { createHash } from "node:crypto";

import {
  firstPartyRecentRoleContext,
  normalizeHistoricalPlayerStatComponents,
  type FirstPartyPlayerStatus,
  type FirstPartyRoleContext,
  type FirstPartyTeamDefenseWeeklyStatLine,
  type FirstPartyWeeklyStatLine,
  type ProjectionStatComponents,
} from "@laces-out/projections";

export interface ProjectionWeeklyFact {
  readonly playerId: string;
  readonly position: string;
  readonly season: number;
  readonly week: number;
  readonly gameId: string;
  readonly team: string;
  readonly opponentTeam: string;
  readonly components: ProjectionStatComponents;
  readonly advanced: Readonly<Record<string, number | null>>;
}

export interface ProjectionSnapFact {
  readonly playerId: string;
  readonly position: string;
  readonly season: number;
  readonly week: number;
  readonly gameId: string;
  readonly team: string;
  readonly opponentTeam: string;
  readonly offenseShare: number;
  readonly specialTeamsShare: number;
}

export interface ProjectionTeamWeekFact {
  readonly season: number;
  readonly week: number;
  readonly gameId: string;
  readonly team: string;
  readonly opponentTeam: string;
  readonly components: ProjectionStatComponents;
}

export interface ProjectionRosterFact {
  readonly playerId: string;
  readonly position: string;
  readonly season: number;
  readonly week: number;
  readonly team: string;
  readonly status?: string | null;
}

export interface ProjectionInjuryFact {
  readonly playerId: string;
  readonly season: number;
  readonly week: number;
  readonly reportStatus?: string | null;
  readonly practiceStatus?: string | null;
}

export interface ProjectionScheduleFact {
  readonly season: number;
  readonly week: number;
  readonly gameId: string;
  readonly awayTeam: string;
  readonly homeTeam: string;
  readonly awayScore: number | null;
  readonly homeScore: number | null;
  readonly kickoffAt?: Date | null;
  readonly status?: "scheduled" | "in-progress" | "final" | "postponed" | "cancelled";
}

function finiteNonnegative(value: number | null | undefined): number | undefined {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function component(components: ProjectionStatComponents, key: string): number {
  return finiteNonnegative(components[key]) ?? 0;
}

function factKey(input: {
  readonly playerId: string;
  readonly season: number;
  readonly week: number;
  readonly gameId: string;
}): string {
  return `${input.playerId}:${input.season}:${input.week}:${input.gameId}`;
}

/** Converts immutable source facts into the model vocabulary without introducing current status. */
export function buildFirstPartyPlayerHistory(
  weekly: readonly ProjectionWeeklyFact[],
  snaps: readonly ProjectionSnapFact[],
  rosters: readonly ProjectionRosterFact[] = [],
  schedules: readonly ProjectionScheduleFact[] = [],
  injuries: readonly ProjectionInjuryFact[] = [],
): readonly FirstPartyWeeklyStatLine[] {
  const injuryStatusByPlayerWeek = new Map<string, FirstPartyPlayerStatus>();
  for (const injury of injuries) {
    const key = `${injury.playerId}:${injury.season}:${injury.week}`;
    const status = firstPartyPlayerStatus(injury.reportStatus, injury.practiceStatus);
    const existing = injuryStatusByPlayerWeek.get(key) ?? "unknown";
    if (STATUS_SEVERITY[status] > STATUS_SEVERITY[existing]) {
      injuryStatusByPlayerWeek.set(key, status);
    }
  }
  const snapByFact = new Map(
    snaps.map((row) => [factKey(row), Math.max(0, Math.min(1, row.offenseShare))]),
  );
  const teamTotals = new Map<
    string,
    { targets: number; carries: number; passingAttempts: number }
  >();
  for (const row of weekly) {
    const key = `${row.season}:${row.week}:${row.gameId}:${row.team}`;
    const totals = teamTotals.get(key) ?? { targets: 0, carries: 0, passingAttempts: 0 };
    totals.targets += component(row.components, "targets");
    totals.carries += component(row.components, "carries");
    totals.passingAttempts += component(row.components, "passing_attempts");
    teamTotals.set(key, totals);
  }
  const weeklyHistory = weekly.map((row): FirstPartyWeeklyStatLine => {
    const totals = teamTotals.get(`${row.season}:${row.week}:${row.gameId}:${row.team}`);
    const targets = component(row.components, "targets");
    const carries = component(row.components, "carries");
    const passingAttempts = component(row.components, "passing_attempts");
    const sourceTargetShare = finiteNonnegative(row.advanced.targetShare);
    const injuryStatus = injuryStatusByPlayerWeek.get(`${row.playerId}:${row.season}:${row.week}`);
    return {
      playerId: row.playerId,
      position: row.position,
      season: row.season,
      week: row.week,
      team: row.team,
      opponent: row.opponentTeam,
      components: normalizeHistoricalPlayerStatComponents(row.components),
      played: true,
      ...(injuryStatus === undefined ? {} : { status: injuryStatus }),
      ...(snapByFact.has(factKey(row))
        ? { snapShare: snapByFact.get(factKey(row)) as number }
        : {}),
      ...(sourceTargetShare !== undefined
        ? { targetShare: sourceTargetShare }
        : totals && totals.targets > 0
          ? { targetShare: targets / totals.targets }
          : {}),
      ...(totals && totals.carries > 0 ? { carryShare: carries / totals.carries } : {}),
      ...(totals && totals.passingAttempts > 0
        ? { passAttemptShare: passingAttempts / totals.passingAttempts }
        : {}),
    };
  });
  const weeklyKeys = new Set(weekly.map(factKey));
  const snapOnlyHistory = snaps.flatMap((row): FirstPartyWeeklyStatLine[] => {
    if (weeklyKeys.has(factKey(row))) return [];
    const position = row.position.trim().toUpperCase();
    const participated = position === "K" ? row.specialTeamsShare > 0 : row.offenseShare > 0;
    if (!participated) return [];
    const injuryStatus = injuryStatusByPlayerWeek.get(`${row.playerId}:${row.season}:${row.week}`);
    return [
      {
        playerId: row.playerId,
        position,
        season: row.season,
        week: row.week,
        team: row.team,
        opponent: row.opponentTeam,
        components: normalizeHistoricalPlayerStatComponents({}),
        played: true,
        snapShare: row.offenseShare,
        ...(injuryStatus === undefined ? {} : { status: injuryStatus }),
      },
    ];
  });
  const participatedSnapKeys = new Set(
    snaps.flatMap((row): string[] => {
      const position = row.position.trim().toUpperCase();
      const participated = position === "K" ? row.specialTeamsShare > 0 : row.offenseShare > 0;
      return participated ? [factKey(row)] : [];
    }),
  );
  const observedKeys = new Set([...weeklyKeys, ...participatedSnapKeys]);
  const observedPlayerWeeks = new Set(
    [...weekly, ...snaps.filter((row) => participatedSnapKeys.has(factKey(row)))].map(
      (row) => `${row.playerId}:${row.season}:${row.week}`,
    ),
  );
  const completedGameByTeamWeek = new Map<string, ProjectionScheduleFact>();
  for (const schedule of schedules) {
    if (schedule.awayScore === null || schedule.homeScore === null) continue;
    completedGameByTeamWeek.set(
      `${schedule.season}:${schedule.week}:${schedule.awayTeam}`,
      schedule,
    );
    completedGameByTeamWeek.set(
      `${schedule.season}:${schedule.week}:${schedule.homeTeam}`,
      schedule,
    );
  }
  const rosterOnlyHistory: FirstPartyWeeklyStatLine[] = [];
  const rosterCandidateByPlayerWeek = new Map<
    string,
    { readonly row: ProjectionRosterFact; readonly schedule: ProjectionScheduleFact }
  >();
  for (const row of rosters) {
    const schedule = completedGameByTeamWeek.get(`${row.season}:${row.week}:${row.team}`);
    if (!schedule) continue;
    const key = factKey({ ...row, gameId: schedule.gameId });
    const playerWeek = `${row.playerId}:${row.season}:${row.week}`;
    if (observedKeys.has(key) || observedPlayerWeeks.has(playerWeek)) continue;
    const current = rosterCandidateByPlayerWeek.get(playerWeek);
    const nextStatus = normalizedStatus(row.status);
    const currentStatus = normalizedStatus(current?.row.status);
    if (
      current &&
      (STATUS_SEVERITY[currentStatus] > STATUS_SEVERITY[nextStatus] ||
        (STATUS_SEVERITY[currentStatus] === STATUS_SEVERITY[nextStatus] &&
          `${current.row.team}:${currentStatus}` <= `${row.team}:${nextStatus}`))
    ) {
      continue;
    }
    rosterCandidateByPlayerWeek.set(playerWeek, { row, schedule });
  }
  for (const { row, schedule } of rosterCandidateByPlayerWeek.values()) {
    rosterOnlyHistory.push({
      playerId: row.playerId,
      position: row.position.trim().toUpperCase(),
      season: row.season,
      week: row.week,
      team: row.team,
      opponent: schedule.awayTeam === row.team ? schedule.homeTeam : schedule.awayTeam,
      components: normalizeHistoricalPlayerStatComponents({}),
      played: false,
      snapShare: 0,
      status: firstPartyPlayerStatus(
        row.status,
        injuryStatusByPlayerWeek.get(`${row.playerId}:${row.season}:${row.week}`),
      ),
    });
  }
  return [...weeklyHistory, ...snapOnlyHistory, ...rosterOnlyHistory].sort(
    (left, right) =>
      left.season - right.season ||
      left.week - right.week ||
      left.playerId.localeCompare(right.playerId),
  );
}

export function recentRoleContext(
  history: readonly FirstPartyWeeklyStatLine[],
  playerId: string,
): FirstPartyRoleContext | undefined {
  return firstPartyRecentRoleContext(history, playerId);
}

function normalizedStatus(value: string | null | undefined): FirstPartyPlayerStatus {
  const normalized =
    value
      ?.normalize("NFKC")
      .trim()
      .toLowerCase()
      .replaceAll(/[_ -]+/gu, "") ?? "";
  if (["active", "act", "healthy", "full", "normal", "probable"].includes(normalized)) {
    return "active";
  }
  if (["questionable", "q", "limited", "limitedpractice"].includes(normalized)) {
    return "questionable";
  }
  if (["doubtful", "d"].includes(normalized)) return "doubtful";
  if (["out", "o"].includes(normalized)) return "out";
  if (
    [
      "inactive",
      "ina",
      "res",
      "reserve",
      "dev",
      "exe",
      "cut",
      "nwt",
      "ret",
      "trc",
      "trd",
      "trt",
    ].includes(normalized)
  ) {
    return "inactive";
  }
  if (["suspended", "susp", "sus", "reserve/suspended"].includes(normalized)) {
    return "suspended";
  }
  if (["pup", "reserve/pup"].includes(normalized)) return "pup";
  if (["ir", "injuredreserve", "reserve/injured"].includes(normalized)) return "ir";
  return "unknown";
}

const STATUS_SEVERITY: Readonly<Record<FirstPartyPlayerStatus, number>> = {
  unknown: 0,
  active: 1,
  questionable: 2,
  doubtful: 3,
  out: 4,
  inactive: 5,
  suspended: 6,
  pup: 7,
  ir: 8,
};

/** Uses the most restrictive current signal and never upgrades an unknown injury to active. */
export function firstPartyPlayerStatus(
  ...values: readonly (string | null | undefined)[]
): FirstPartyPlayerStatus {
  return (
    values
      .map(normalizedStatus)
      .sort((left, right) => STATUS_SEVERITY[right] - STATUS_SEVERITY[left])[0] ?? "unknown"
  );
}

function scheduleScoreForTeam(schedule: ProjectionScheduleFact, team: string): number | null {
  if (schedule.awayTeam === team) return schedule.homeScore;
  if (schedule.homeTeam === team) return schedule.awayScore;
  return null;
}

/** Joins reciprocal team rows and final scores into the exact DST component vocabulary. */
export function buildFirstPartyDefenseHistory(
  teams: readonly ProjectionTeamWeekFact[],
  schedules: readonly ProjectionScheduleFact[],
): readonly FirstPartyTeamDefenseWeeklyStatLine[] {
  const byGameTeam = new Map(teams.map((row) => [`${row.gameId}:${row.team}`, row]));
  const scheduleByGame = new Map(schedules.map((row) => [row.gameId, row]));
  return teams
    .flatMap((row): FirstPartyTeamDefenseWeeklyStatLine[] => {
      const opponent = byGameTeam.get(`${row.gameId}:${row.opponentTeam}`);
      const schedule = scheduleByGame.get(row.gameId);
      const opponentScore = schedule ? scheduleScoreForTeam(schedule, row.team) : null;
      if (!opponent || opponentScore === null) return [];
      // Yahoo and ESPN do not charge a D/ST for touchdowns scored by the opposing defense, while
      // subsequent PATs still count. Yahoo also excludes safeties. This provider-neutral baseline
      // therefore removes six points per defensive TD and two per defensive safety. A rare blocked-
      // kick return can be classified differently by a provider and remains a publication warning.
      const pointsAllowed = Math.max(
        0,
        opponentScore -
          component(opponent.components, "defensive_touchdowns") * 6 -
          component(opponent.components, "defensive_safeties") * 2,
      );
      return [
        {
          team: row.team,
          season: row.season,
          week: row.week,
          opponent: row.opponentTeam,
          played: true,
          components: {
            defensive_sacks: component(row.components, "defensive_sacks"),
            defensive_interceptions: component(row.components, "defensive_interceptions"),
            defensive_fumble_recoveries: component(row.components, "defensive_fumbles_recovered"),
            defensive_safeties: component(row.components, "defensive_safeties"),
            defensive_touchdowns: component(row.components, "defensive_touchdowns"),
            special_teams_touchdowns: component(row.components, "special_teams_touchdowns"),
            defensive_blocked_kicks:
              component(opponent.components, "field_goals_blocked") +
              component(opponent.components, "extra_points_blocked") +
              component(opponent.components, "punts_blocked"),
            points_allowed: pointsAllowed,
            yards_allowed: component(opponent.components, "total_offensive_yards"),
          },
        },
      ];
    })
    .sort(
      (left, right) =>
        left.season - right.season || left.week - right.week || left.team.localeCompare(right.team),
    );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function projectionInputChecksum(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** Bumps whenever the epoch's serialized shape or hashing rule changes, not the model itself. */
export const FIRST_PARTY_INPUT_EPOCH_VERSION = "first-party-input-epoch-v1";

export interface ProjectionEpochSource {
  readonly key: string;
  readonly checksum: string;
  readonly asOf: string | Date;
}

/**
 * A versioned, order-independent identity for the exact set of per-source checksums and as-of
 * stamps a weekly refresh assembled its required inputs from (player stats, team stats, rosters,
 * injuries, snaps, schedule, and Sleeper availability). Capturing this once when sources are
 * validated and recomputing it again immediately before the persist transaction proves no required
 * source changed mid-assembly; a mismatch is the explicit, provable "mixed snapshot" signal that
 * per-source checksums pinned into observation rows cannot, by themselves, make auditable. See
 * weekly-production risk #2.
 */
export function firstPartyInputEpoch(sources: readonly ProjectionEpochSource[]): string {
  const canonical = sources
    .map((source) => ({
      key: source.key,
      checksum: source.checksum,
      asOf: source.asOf instanceof Date ? source.asOf.toISOString() : source.asOf,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  return projectionInputChecksum({ version: FIRST_PARTY_INPUT_EPOCH_VERSION, sources: canonical });
}
