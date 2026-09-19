import { createHash } from "node:crypto";
import { canonicalNflTeamCode, NFL_TEAMS } from "@laces-out/domain";
import {
  projectionScoringProfileKey,
  type ProjectionScoringProfile,
} from "../../../packages/projections/src/scoring.js";
import { scoreObservedWeeklyComponents } from "../../../packages/projections/src/weekly-observed-outcome.js";
import { verifyNflGameFinality, type NflGameFinalitySource } from "./nfl-game-finality.js";

export const WEEKLY_PROSPECTIVE_EVALUATION_VERSION = "frozen-managed-weekly-outcome-evaluation-v1";
const MAX_ROWS = 25_000;
interface CapturedGame {
  readonly gameId: string;
  readonly home: string;
  readonly away: string;
  readonly kickoffAt: string;
}
export interface WeeklyProspectiveCandidate {
  readonly leagueSeasonId: string;
  readonly projectionSetId: string;
  readonly playerId: string;
  readonly scoringProfileSha256: string;
  readonly gsisId: string | null;
  readonly captureTeam: string | null;
  readonly identityBasis: "captured-gsis" | "canonical-app-defense" | "captured-team-defense-alias";
  readonly forecast: {
    readonly mean: string | number | null;
    readonly floor: string | number | null;
    readonly ceiling: string | number | null;
    readonly confidence: string | number | null;
  };
  readonly captureGame: CapturedGame | null;
  readonly generationGame: CapturedGame | null;
  readonly pointCandidate: boolean;
  readonly pointReasons: readonly string[];
  readonly nominalIntervalCandidate: boolean;
  readonly nominalCoverage: 0.7 | null;
  readonly intervalEndpointsValid: boolean;
  readonly intervalReasons: readonly string[];
}
/** Current immutable observation selection; checkedAt may re-confirm unchanged bytes after finality. */
export interface WeeklyOutcomeSourceBinding {
  readonly sourceId: string;
  readonly sourceKey: string;
  readonly inputChecksum: string;
  readonly checkedAt: string;
}
interface StoredObservation {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceSyncRunId: string;
  readonly inputChecksum: string;
  readonly fetchedAt: string;
  readonly season: number;
  readonly week: number;
  readonly seasonType: "REG";
}
/** Exact relevant columns of nfl_schedule_observations; its status alone cannot establish finality. */
export interface WeeklyOutcomeScheduleObservation extends StoredObservation {
  readonly externalGameId: string;
  readonly kickoffAt: string | null;
  readonly homeTeam: string;
  readonly awayTeam: string;
  readonly status: "scheduled" | "in-progress" | "final" | "postponed" | "cancelled";
}
/** Exact relevant columns of player_weekly_stat_observations, without sourceFantasyPoints. */
export interface WeeklyOutcomePlayerObservation extends StoredObservation {
  readonly externalPlayerId: string;
  readonly playerId: string | null;
  readonly gameId: string;
  readonly team: string;
  readonly opponentTeam: string;
  readonly components: Readonly<Record<string, number>>;
}
/** Exact relevant columns of team_weekly_stat_observations. */
export interface WeeklyOutcomeTeamObservation extends StoredObservation {
  readonly externalTeamId: string;
  readonly gameId: string;
  readonly team: string;
  readonly opponentTeam: string;
  readonly components: Readonly<Record<string, number>>;
}
export interface WeeklyOutcomeObservationSnapshot {
  readonly capturedAt: string;
  readonly sources: readonly WeeklyOutcomeSourceBinding[];
  readonly schedules: readonly WeeklyOutcomeScheduleObservation[];
  readonly players: readonly WeeklyOutcomePlayerObservation[];
  readonly teams: readonly WeeklyOutcomeTeamObservation[];
}
function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/u.test(value))
    return NaN;
  return Date.parse(value);
}
function finite(value: unknown): number | null {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value))
  )
    return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function list(value: unknown, limit: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > limit || Object.keys(value).length !== value.length)
    throw new TypeError("Invalid bounded weekly evidence array");
}
function team(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = canonicalNflTeamCode(value);
  return (NFL_TEAMS as readonly string[]).includes(normalized) ? normalized : null;
}
function candidateIdentity(row: WeeklyProspectiveCandidate): string {
  return `${row.leagueSeasonId}/${row.projectionSetId}/${row.playerId}`;
}
function validGame(value: unknown): value is CapturedGame {
  return (
    record(value) &&
    text(value.gameId) &&
    team(value.home) !== null &&
    team(value.away) !== null &&
    team(value.home) !== team(value.away) &&
    Number.isFinite(timestamp(value.kickoffAt))
  );
}
function sameGame(left: CapturedGame, right: CapturedGame): boolean {
  return (
    left.gameId === right.gameId &&
    team(left.home) === team(right.home) &&
    team(left.away) === team(right.away) &&
    timestamp(left.kickoffAt) === timestamp(right.kickoffAt)
  );
}
function parseLedger(
  payload: string,
  checksum: string,
  expectedRows: number,
): WeeklyProspectiveCandidate[] {
  if (
    !digest(checksum) ||
    typeof payload !== "string" ||
    Buffer.byteLength(payload) > 96 * 1024 * 1024 ||
    hash(payload) !== checksum ||
    !payload.endsWith("\n") ||
    !Number.isSafeInteger(expectedRows) ||
    expectedRows < 1 ||
    expectedRows > MAX_ROWS
  )
    throw new TypeError("Frozen weekly ledger binding mismatch");
  const lines = payload.slice(0, -1).split("\n");
  if (lines.length !== expectedRows) throw new TypeError("Frozen weekly population was changed");
  const rows = lines.map((line) => {
    if (Buffer.byteLength(line) > 1024 * 1024)
      throw new RangeError("Weekly ledger row exceeds bound");
    const row: unknown = JSON.parse(line);
    if (
      !record(row) ||
      !text(row.leagueSeasonId) ||
      !text(row.projectionSetId) ||
      !text(row.playerId) ||
      !digest(row.scoringProfileSha256) ||
      !record(row.forecast) ||
      typeof row.pointCandidate !== "boolean" ||
      typeof row.nominalIntervalCandidate !== "boolean" ||
      typeof row.intervalEndpointsValid !== "boolean" ||
      !["captured-gsis", "canonical-app-defense", "captured-team-defense-alias"].includes(
        String(row.identityBasis),
      ) ||
      (row.nominalCoverage !== null && row.nominalCoverage !== 0.7)
    )
      throw new TypeError("Malformed frozen weekly candidate");
    for (const reasons of [row.pointReasons, row.intervalReasons]) {
      list(reasons, 100);
      if (!reasons.every(text)) throw new TypeError("Malformed frozen reasons");
    }
    const candidate = row as unknown as WeeklyProspectiveCandidate;
    if (
      candidate.pointCandidate &&
      (candidate.pointReasons.length !== 0 ||
        finite(candidate.forecast.mean) === null ||
        !validGame(candidate.captureGame) ||
        !validGame(candidate.generationGame) ||
        !sameGame(candidate.captureGame, candidate.generationGame) ||
        !team(candidate.captureTeam) ||
        (candidate.identityBasis === "captured-gsis" &&
          !/^00-\d{7}$/u.test(candidate.gsisId ?? "")))
    )
      throw new TypeError("Inconsistent frozen point candidacy");
    if (
      candidate.nominalIntervalCandidate &&
      (!candidate.pointCandidate ||
        candidate.intervalReasons.length > 0 ||
        candidate.nominalCoverage !== 0.7 ||
        !candidate.intervalEndpointsValid ||
        finite(candidate.forecast.floor) === null ||
        finite(candidate.forecast.ceiling) === null ||
        Number(candidate.forecast.floor) > Number(candidate.forecast.ceiling))
    )
      throw new TypeError("Inconsistent frozen nominal candidacy");
    return candidate; // Preserve every original field, including unknown role/policy metadata.
  });
  if (new Set(rows.map(candidateIdentity)).size !== rows.length)
    throw new TypeError("Duplicate frozen forecast identity");
  return rows;
}
function parseSnapshot(
  payload: string,
  checksum: string,
  season: number,
  week: number,
): WeeklyOutcomeObservationSnapshot {
  if (
    !digest(checksum) ||
    typeof payload !== "string" ||
    Buffer.byteLength(payload) > 64 * 1024 * 1024 ||
    hash(payload) !== checksum
  )
    throw new TypeError("Weekly outcome source bytes mismatch");
  const raw: unknown = JSON.parse(payload);
  if (!record(raw) || !Number.isFinite(timestamp(raw.capturedAt)))
    throw new TypeError("Invalid weekly observation capture");
  list(raw.sources, 64);
  list(raw.schedules, 64);
  list(raw.players, MAX_ROWS);
  list(raw.teams, 64);
  const snapshot = raw as unknown as WeeklyOutcomeObservationSnapshot;
  if (new Set(snapshot.sources.map((source) => source.sourceId)).size !== snapshot.sources.length)
    throw new TypeError("Ambiguous weekly source selection");
  for (const source of snapshot.sources)
    if (
      !text(source.sourceId) ||
      !text(source.sourceKey) ||
      !digest(source.inputChecksum) ||
      !Number.isFinite(timestamp(source.checkedAt)) ||
      timestamp(source.checkedAt) > timestamp(snapshot.capturedAt)
    )
      throw new TypeError("Invalid weekly source binding");
  const all = [...snapshot.schedules, ...snapshot.players, ...snapshot.teams];
  if (new Set(all.map((row) => row.id)).size !== all.length)
    throw new TypeError("Duplicate weekly observation row");
  for (const row of all)
    if (
      !text(row.id) ||
      !text(row.sourceId) ||
      !text(row.sourceSyncRunId) ||
      !digest(row.inputChecksum) ||
      row.season !== season ||
      row.week !== week ||
      row.seasonType !== "REG" ||
      !Number.isFinite(timestamp(row.fetchedAt)) ||
      timestamp(row.fetchedAt) > timestamp(snapshot.capturedAt)
    )
      throw new TypeError("Invalid weekly observation scope or provenance");
  return snapshot;
}
function grouped<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const output = new Map<string, T[]>();
  for (const row of rows) {
    const identity = key(row);
    const found = output.get(identity) ?? [];
    found.push(row);
    output.set(identity, found);
  }
  return output;
}

/**
 * The actual frozen-ledger evaluation boundary. Inputs are raw captured bytes plus externally
 * pinned digests, not claimed completion/coverage flags. This performs no reads or fitting and
 * cannot authenticate the origin of caller-supplied hashes: the capture operator owns provenance.
 * Current nflverse schedule finals need independently reconstructed ESPN terminal evidence.
 */
export function evaluateWeeklyProspectiveLedger(input: {
  readonly ledgerNdjson: string;
  readonly ledgerChecksum: string;
  readonly expectedRows: number;
  readonly season: number;
  readonly week: number;
  readonly profiles: readonly ProjectionScoringProfile[];
  readonly observationJson: string;
  readonly observationChecksum: string;
  readonly finalitySource: NflGameFinalitySource | null;
}) {
  if (
    !Number.isSafeInteger(input.season) ||
    input.season < 2000 ||
    input.season > 2100 ||
    !Number.isSafeInteger(input.week) ||
    input.week < 1 ||
    input.week > 18
  )
    throw new TypeError("Invalid weekly evaluation scope");
  const ledger = parseLedger(input.ledgerNdjson, input.ledgerChecksum, input.expectedRows);
  const snapshot = parseSnapshot(
    input.observationJson,
    input.observationChecksum,
    input.season,
    input.week,
  );
  list(input.profiles, 64);
  const profiles = new Map(
    input.profiles.map((profile) => [hash(projectionScoringProfileKey(profile)), profile]),
  );
  // Multiple leagues may share the same semantic profile; identical keys are one scorer.
  const sources = new Map(snapshot.sources.map((source) => [source.sourceId, source]));
  const schedules = grouped(snapshot.schedules, (row) => row.externalGameId);
  const players = grouped(snapshot.players, (row) => row.externalPlayerId);
  const teams = grouped(snapshot.teams, (row) => team(row.team) ?? "invalid");
  const sourceReason = (
    row: StoredObservation,
    expectedKey: string,
    after: number,
  ): string | null => {
    const source = sources.get(row.sourceId);
    if (!source || source.inputChecksum !== row.inputChecksum || source.sourceKey !== expectedKey)
      return "observation-source-binding-mismatch";
    if (timestamp(source.checkedAt) < timestamp(row.fetchedAt))
      return "source-check-precedes-observation";
    return timestamp(source.checkedAt) < after ? "stats-not-checked-after-finality" : null;
  };
  const finalityByGame = new Map<string, ReturnType<typeof verifyNflGameFinality>>();
  const rows = ledger.map((candidate) => {
    const unavailable = (
      reasons: readonly string[],
      componentEvidence: ReturnType<typeof scoreObservedWeeklyComponents> | null = null,
    ) => ({
      candidate,
      actual: { state: "unavailable" as const, points: null, reasons, componentEvidence },
    });
    if (!candidate.pointCandidate)
      return {
        candidate,
        actual: {
          state: "ineligible" as const,
          points: null,
          reasons: candidate.pointReasons,
          componentEvidence: null,
        },
      };
    const profile = profiles.get(candidate.scoringProfileSha256);
    if (!profile) return unavailable(["captured-profile-unavailable"]);
    const game = candidate.captureGame!;
    const scheduleRows = schedules.get(game.gameId) ?? [];
    if (scheduleRows.length !== 1)
      return unavailable([scheduleRows.length ? "outcome-game-ambiguous" : "outcome-game-missing"]);
    const schedule = scheduleRows[0]!;
    const scheduleReason = sourceReason(schedule, `nflverse.schedules.${input.season}`, -Infinity);
    if (scheduleReason) return unavailable([scheduleReason]);
    const scheduleGame = {
      gameId: schedule.externalGameId,
      home: schedule.homeTeam,
      away: schedule.awayTeam,
      kickoffAt: schedule.kickoffAt,
    };
    if (!validGame(scheduleGame) || !sameGame(game, scheduleGame))
      return unavailable(["captured-outcome-game-conflict"]);
    if (schedule.status !== "final") return unavailable(["persisted-game-not-final"]);
    if (input.finalitySource === null) return unavailable(["score-derived-finality-unproven"]);
    let finality = finalityByGame.get(game.gameId);
    if (finality === undefined) {
      finality = verifyNflGameFinality({
        source: input.finalitySource,
        schedule: {
          nflverseGameId: game.gameId,
          season: input.season,
          week: input.week,
          seasonType: "REG",
          homeTeam: game.home,
          awayTeam: game.away,
          kickoffAt: game.kickoffAt,
        },
      });
      finalityByGame.set(game.gameId, finality);
    }
    if (finality.state !== "verified") return unavailable([`explicit-finality:${finality.reason}`]);
    const terminalAt = timestamp(finality.observedAt);
    if (terminalAt > timestamp(snapshot.capturedAt))
      return unavailable(["capture-precedes-finality"]);
    const capturedTeam = team(candidate.captureTeam)!;
    const opponent =
      capturedTeam === team(game.home)
        ? team(game.away)!
        : capturedTeam === team(game.away)
          ? team(game.home)!
          : null;
    if (opponent === null) return unavailable(["captured-team-game-conflict"]);
    const kind = candidate.identityBasis === "captured-gsis" ? "player" : "team-defense";
    const observed: (WeeklyOutcomePlayerObservation | WeeklyOutcomeTeamObservation)[] =
      kind === "player" ? (players.get(candidate.gsisId!) ?? []) : (teams.get(capturedTeam) ?? []);
    if (observed.length !== 1)
      return unavailable([
        observed.length ? "actual-identity-ambiguous" : "actual-observation-missing-not-dnp",
      ]);
    const observation = observed[0]!;
    if (
      observation.gameId !== game.gameId ||
      team(observation.team) !== capturedTeam ||
      team(observation.opponentTeam) !== opponent
    )
      return unavailable(["actual-player-team-game-conflict"]);
    const observationReason = sourceReason(
      observation,
      `nflverse.stats-${kind === "player" ? "player" : "team"}-week.${input.season}`,
      terminalAt,
    );
    if (observationReason) return unavailable([observationReason]);
    let components = observation.components;
    const usedObservations: StoredObservation[] = [observation];
    if (kind === "team-defense") {
      const opponents = teams.get(opponent) ?? [];
      if (opponents.length !== 1) return unavailable(["reciprocal-team-observation-unavailable"]);
      const other = opponents[0]!;
      if (other.gameId !== game.gameId || team(other.opponentTeam) !== capturedTeam)
        return unavailable(["reciprocal-team-game-conflict"]);
      const otherReason = sourceReason(
        other,
        `nflverse.stats-team-week.${input.season}`,
        terminalAt,
      );
      if (otherReason) return unavailable([otherReason]);
      usedObservations.push(other);
      // Preserve only observed canonical defense facts and complete exact aggregates. Do not use
      // buildFirstPartyDefenseHistory: it fills missing stats/de-minimis events with zero, and
      // its points-allowed definition includes unverified provider adjustments. Those actuals
      // remain unavailable unless a future source adapter establishes the exact components.
      const own = observation.components,
        opposing = other.components;
      const defense: Record<string, number> = {};
      for (const name of [
        "defensive_sacks",
        "defensive_interceptions",
        "defensive_safeties",
        "defensive_touchdowns",
        "fourth_down_stops",
        "special_teams_touchdowns",
        "defensive_two_point_returns",
        "one_point_safeties",
      ])
        if (Object.hasOwn(own, name)) defense[name] = own[name]!;
      if (Object.hasOwn(own, "defensive_fumbles_recovered"))
        defense.defensive_fumble_recoveries = own.defensive_fumbles_recovered!;
      const blocked = ["field_goals_blocked", "extra_points_blocked", "punts_blocked"];
      if (blocked.every((name) => Object.hasOwn(opposing, name)))
        defense.defensive_blocked_kicks = blocked.reduce((sum, name) => sum + opposing[name]!, 0);
      components = defense;
    }
    const scoring = scoreObservedWeeklyComponents({ kind, profile, components });
    if (scoring.state !== "scored")
      return unavailable(["actual-scoring-components-incomplete-or-conflicting"], scoring);
    return {
      candidate,
      actual: {
        state: "available" as const,
        points: scoring.points,
        reasons: [] as string[],
        componentEvidence: scoring,
        finality,
        sourceObservations: usedObservations.map((row) => ({
          id: row.id,
          sourceId: row.sourceId,
          sourceSyncRunId: row.sourceSyncRunId,
          inputChecksum: row.inputChecksum,
          fetchedAt: row.fetchedAt,
          checkedAt: sources.get(row.sourceId)!.checkedAt,
        })),
      },
    };
  });
  type Row = (typeof rows)[number];
  const reasonCounts = (values: readonly string[]) => {
    const counts: Record<string, number> = {};
    for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
    return Object.fromEntries(
      Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
    );
  };
  const summary = (group: readonly Row[]) => {
    const available = group.filter((row) => row.actual.state === "available");
    const errors = available.map((row) => row.actual.points! - Number(row.candidate.forecast.mean));
    const nominal = available.filter((row) => row.candidate.nominalIntervalCandidate);
    const average = (values: readonly number[]) => {
      if (values.length === 0) return null;
      const value = values.reduce((sum, entry) => sum + entry, 0) / values.length;
      if (!Number.isFinite(value)) throw new RangeError("Weekly evaluation metric overflow");
      return value;
    };
    const widths = nominal.map(
      (row) => Number(row.candidate.forecast.ceiling) - Number(row.candidate.forecast.floor),
    );
    return {
      capturedRows: group.length,
      pointCandidates: group.filter((row) => row.candidate.pointCandidate).length,
      actualAvailable: available.length,
      actualUnavailable: group.filter((row) => row.actual.state === "unavailable").length,
      ineligible: group.filter((row) => row.actual.state === "ineligible").length,
      nominalIntervalCandidates: group.filter((row) => row.candidate.nominalIntervalCandidate)
        .length,
      point: {
        samples: available.length,
        biasActualMinusForecast: average(errors),
        mae: average(errors.map(Math.abs)),
        rmse: errors.length ? Math.sqrt(average(errors.map((value) => value ** 2))!) : null,
      },
      nominal70: {
        samples: nominal.length,
        coverage: average(
          nominal.map((row) =>
            Number(
              row.actual.points! >= Number(row.candidate.forecast.floor) &&
                row.actual.points! <= Number(row.candidate.forecast.ceiling),
            ),
          ),
        ),
        below: average(
          nominal.map((row) => Number(row.actual.points! < Number(row.candidate.forecast.floor))),
        ),
        above: average(
          nominal.map((row) => Number(row.actual.points! > Number(row.candidate.forecast.ceiling))),
        ),
        width: average(widths),
        intervalScore: average(
          nominal.map(
            (row, index) =>
              widths[index]! +
              (2 / 0.3) *
                (Math.max(Number(row.candidate.forecast.floor) - row.actual.points!, 0) +
                  Math.max(row.actual.points! - Number(row.candidate.forecast.ceiling), 0)),
          ),
        ),
      },
      pointReasonCounts: reasonCounts(group.flatMap((row) => row.candidate.pointReasons)),
      intervalReasonCounts: reasonCounts(group.flatMap((row) => row.candidate.intervalReasons)),
      actualReasonCounts: reasonCounts(group.flatMap((row) => row.actual.reasons)),
    };
  };
  return {
    version: WEEKLY_PROSPECTIVE_EVALUATION_VERSION,
    state: rows.some((row) => row.actual.state === "unavailable")
      ? ("partially-observed" as const)
      : ("evaluation-complete" as const),
    canAuthorizeRelease: false as const,
    ledgerChecksum: input.ledgerChecksum,
    observationChecksum: input.observationChecksum,
    season: input.season,
    week: input.week,
    capturedAt: snapshot.capturedAt,
    interpretation:
      "prospective-managed-captured-mapping-diagnostic-not-api-selection-or-independent-qualification" as const,
    rows,
    overall: summary(rows),
    byLeague: [...grouped(rows, (row) => row.candidate.leagueSeasonId)].map(
      ([leagueSeasonId, group]) => ({ leagueSeasonId, ...summary(group) }),
    ),
    byScoringProfile: [...grouped(rows, (row) => row.candidate.scoringProfileSha256)].map(
      ([scoringProfileSha256, group]) => ({ scoringProfileSha256, ...summary(group) }),
    ),
    byIdentityBasis: [...grouped(rows, (row) => row.candidate.identityBasis)].map(
      ([identityBasis, group]) => ({ identityBasis, ...summary(group) }),
    ),
  };
}
