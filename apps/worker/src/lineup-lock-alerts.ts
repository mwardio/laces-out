import {
  dataSources,
  fantasyTeams,
  leagueMemberships,
  leagues,
  leagueSeasons,
  nflScheduleObservations,
  players,
  pushSubscriptions,
  rosterEntries,
  rosterSlotRules,
  rosterSnapshots,
  type Database,
  type JsonPrimitive,
} from "@laces-out/db";
import { PLAYER_STATUSES, type PlayerStatus } from "@laces-out/domain";
import {
  deriveTeamScheduleWeeks,
  type ScheduleCoverage,
  type ScheduleGameObservation,
} from "@laces-out/league-analytics";
import { and, asc, desc, eq, exists, isNotNull, sql } from "drizzle-orm";

import type { NotificationPayload, PendingNotification } from "./push-notifications.js";

/**
 * The lineup-lock alarm. It answers one question from stored data only: before this member's first
 * kickoff, is anything obviously wrong with the lineup they last synced?
 *
 * Deliberate narrowness, because an alert that guesses is worse than no alert:
 *
 *  - Availability comes from the same `players.status` field the Decision Desk renders, normalized
 *    through the same shared `PLAYER_STATUSES` vocabulary. Only `OUT`, `IR`, and `DOUBTFUL` fire.
 *    Provider spellings that vocabulary does not recognize (Yahoo's single-letter codes, ESPN's
 *    `INJURY_RESERVE`, nflverse's `RES`) are NOT translated here: a private mapping would let the
 *    alarm assert a status the rest of the app does not show.
 *  - A bye is asserted only where the admitted schedule affirms coverage for both the team and the
 *    week, which is the project-wide rule, reused through `deriveTeamScheduleWeeks` rather than
 *    reimplemented.
 *  - An empty starting slot is a counted shortfall between the season's starter slot rules and the
 *    stored starters, never an inference about which player "should" be there.
 *  - The weekly injury report, projections, and lineup optimality are all out of scope. This job
 *    never reproduces the Decision Desk engine; it points at it.
 */

const MAX_CANDIDATES = 500;
const MAX_ROSTER_ENTRIES = 256;
const MAX_SLOT_RULES = 64;
/** One regular season is a few hundred rows; the bound mirrors the API schedule reader. */
const SCHEDULE_ROW_LIMIT = 1_001;
const MAX_NAMED_ISSUES = 3;

export interface LineupLockCandidateRow {
  readonly userId: string;
  readonly leagueId: string;
  readonly leagueName: string;
  readonly leagueSeasonId: string;
  readonly season: number;
  readonly week: number | null;
  readonly lastSyncedAt: Date | null;
  readonly teamId: string;
}

export interface LineupLockSnapshotRow {
  readonly id: string;
  readonly effectiveAt: Date;
}

export interface LineupLockRosterEntryRow {
  readonly playerId: string;
  readonly playerName: string;
  readonly primaryPosition: string;
  readonly nflTeam: string | null;
  readonly status: string | null;
  readonly slotCode: string;
  readonly isStarter: boolean;
}

export interface LineupLockSlotRuleRow {
  readonly slotCode: string;
  readonly count: number;
}

export interface LineupLockScheduleSourceRow {
  readonly id: string;
  readonly lastChecksum: string | null;
  readonly lastSuccessfulAt: Date | null;
  readonly metadata: Record<string, JsonPrimitive>;
}

export interface LineupLockScheduleGameRow {
  readonly externalGameId: string;
  readonly season: number;
  readonly week: number;
  readonly gameDate: string;
  readonly startTimeEastern: string | null;
  readonly timeTbd: boolean;
  readonly kickoffAt: Date | null;
  readonly awayTeam: string;
  readonly homeTeam: string;
  readonly status: ScheduleGameObservation["status"];
  readonly neutralSite: boolean;
  readonly awayRestDays: number | null;
  readonly homeRestDays: number | null;
  readonly awayScore: number | null;
  readonly homeScore: number | null;
}

export interface LineupLockRepository {
  listCandidates(limit: number): Promise<readonly LineupLockCandidateRow[]>;
  findLatestRosterSnapshot(teamId: string): Promise<LineupLockSnapshotRow | undefined>;
  listRosterEntries(
    snapshotId: string,
    limit: number,
  ): Promise<readonly LineupLockRosterEntryRow[]>;
  listStarterSlotRules(
    leagueSeasonId: string,
    limit: number,
  ): Promise<readonly LineupLockSlotRuleRow[]>;
  findScheduleSource(key: string): Promise<LineupLockScheduleSourceRow | undefined>;
  listScheduleGames(
    sourceId: string,
    checksum: string,
    season: number,
    limit: number,
  ): Promise<readonly LineupLockScheduleGameRow[]>;
}

export class DrizzleLineupLockRepository implements LineupLockRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  /**
   * A claimed team names its own league season, so there is no "latest season" guess here. The
   * push-subscription existence test keeps the sweep proportional to members who opted in.
   */
  listCandidates(limit: number): Promise<readonly LineupLockCandidateRow[]> {
    return this.#database
      .select({
        userId: leagueMemberships.userId,
        leagueId: leagues.id,
        leagueName: leagues.name,
        leagueSeasonId: leagueSeasons.id,
        season: leagueSeasons.season,
        week: leagueSeasons.currentWeek,
        lastSyncedAt: leagueSeasons.lastSyncedAt,
        teamId: fantasyTeams.id,
      })
      .from(leagueMemberships)
      .innerJoin(leagues, eq(leagues.id, leagueMemberships.leagueId))
      .innerJoin(fantasyTeams, eq(fantasyTeams.id, leagueMemberships.claimedFantasyTeamId))
      .innerJoin(leagueSeasons, eq(leagueSeasons.id, fantasyTeams.leagueSeasonId))
      .where(
        and(
          isNotNull(leagueMemberships.claimedFantasyTeamId),
          isNotNull(leagueSeasons.currentWeek),
          exists(
            this.#database
              .select({ present: sql`1` })
              .from(pushSubscriptions)
              .where(eq(pushSubscriptions.userId, leagueMemberships.userId)),
          ),
        ),
      )
      .orderBy(asc(leagueMemberships.userId), asc(leagues.id))
      .limit(limit);
  }

  async findLatestRosterSnapshot(teamId: string): Promise<LineupLockSnapshotRow | undefined> {
    const [row] = await this.#database
      .select({ id: rosterSnapshots.id, effectiveAt: rosterSnapshots.effectiveAt })
      .from(rosterSnapshots)
      .where(eq(rosterSnapshots.teamId, teamId))
      .orderBy(desc(rosterSnapshots.effectiveAt), desc(rosterSnapshots.id))
      .limit(1);
    return row;
  }

  listRosterEntries(
    snapshotId: string,
    limit: number,
  ): Promise<readonly LineupLockRosterEntryRow[]> {
    return this.#database
      .select({
        playerId: players.id,
        playerName: players.fullName,
        primaryPosition: players.primaryPosition,
        nflTeam: players.nflTeam,
        status: players.status,
        slotCode: rosterEntries.slotCode,
        isStarter: rosterEntries.isStarter,
      })
      .from(rosterEntries)
      .innerJoin(players, eq(rosterEntries.playerId, players.id))
      .where(eq(rosterEntries.snapshotId, snapshotId))
      .orderBy(asc(players.fullName), asc(players.id))
      .limit(limit);
  }

  listStarterSlotRules(
    leagueSeasonId: string,
    limit: number,
  ): Promise<readonly LineupLockSlotRuleRow[]> {
    return this.#database
      .select({ slotCode: rosterSlotRules.slotCode, count: rosterSlotRules.count })
      .from(rosterSlotRules)
      .where(
        and(
          eq(rosterSlotRules.leagueSeasonId, leagueSeasonId),
          eq(rosterSlotRules.isStarter, true),
        ),
      )
      .orderBy(asc(rosterSlotRules.slotCode))
      .limit(limit);
  }

  async findScheduleSource(key: string): Promise<LineupLockScheduleSourceRow | undefined> {
    const [row] = await this.#database
      .select({
        id: dataSources.id,
        lastChecksum: dataSources.lastChecksum,
        lastSuccessfulAt: dataSources.lastSuccessfulAt,
        metadata: dataSources.metadata,
      })
      .from(dataSources)
      .where(and(eq(dataSources.key, key), eq(dataSources.enabled, true)))
      .limit(1);
    return row;
  }

  listScheduleGames(
    sourceId: string,
    checksum: string,
    season: number,
    limit: number,
  ): Promise<readonly LineupLockScheduleGameRow[]> {
    return this.#database
      .select({
        externalGameId: nflScheduleObservations.externalGameId,
        season: nflScheduleObservations.season,
        week: nflScheduleObservations.week,
        gameDate: nflScheduleObservations.gameDate,
        startTimeEastern: nflScheduleObservations.startTimeEastern,
        timeTbd: nflScheduleObservations.timeTbd,
        kickoffAt: nflScheduleObservations.kickoffAt,
        awayTeam: nflScheduleObservations.awayTeam,
        homeTeam: nflScheduleObservations.homeTeam,
        status: nflScheduleObservations.status,
        neutralSite: nflScheduleObservations.neutralSite,
        awayRestDays: nflScheduleObservations.awayRestDays,
        homeRestDays: nflScheduleObservations.homeRestDays,
        awayScore: nflScheduleObservations.awayScore,
        homeScore: nflScheduleObservations.homeScore,
      })
      .from(nflScheduleObservations)
      .where(
        and(
          eq(nflScheduleObservations.sourceId, sourceId),
          eq(nflScheduleObservations.inputChecksum, checksum),
          eq(nflScheduleObservations.season, season),
          eq(nflScheduleObservations.seasonType, "REG"),
        ),
      )
      .orderBy(asc(nflScheduleObservations.week), asc(nflScheduleObservations.externalGameId))
      .limit(limit);
  }
}

/**
 * nflverse still writes the Rams as `LA`. The canonical code is `LAR` everywhere else in Laces
 * Out, so schedule rows and player teams are folded onto one code before they are joined. Twin of
 * `apps/api/src/nfl-team-code.ts`; the worker cannot import from the API process.
 */
function canonicalNflTeamCode(team: string): string {
  const normalized = team.trim().toUpperCase();
  return normalized === "LA" ? "LAR" : normalized;
}

function normalizedSlotCode(code: string): string {
  return code.trim().toUpperCase().replaceAll(" ", "");
}

const playerStatusSet = new Set<string>(PLAYER_STATUSES);

/** The same normalization `in-season-decisions.ts` applies before it shows a status anywhere. */
export function normalizedPlayerStatus(status: string | null): PlayerStatus | null {
  const candidate = status?.trim().toUpperCase();
  return candidate && playerStatusSet.has(candidate) ? (candidate as PlayerStatus) : null;
}

/** Statuses that mean "this starter is very likely not playing", and nothing softer. */
const ALERTING_STATUSES: ReadonlySet<PlayerStatus> = new Set<PlayerStatus>([
  "OUT",
  "IR",
  "DOUBTFUL",
]);

const STATUS_PHRASES: Readonly<Record<"OUT" | "IR" | "DOUBTFUL", string>> = {
  OUT: "is OUT",
  IR: "is on IR",
  DOUBTFUL: "is doubtful",
};

export type LineupLockIssue =
  | {
      readonly kind: "player-unavailable";
      readonly playerName: string;
      readonly status: "OUT" | "IR" | "DOUBTFUL";
    }
  | { readonly kind: "player-bye"; readonly playerName: string; readonly position: string }
  | { readonly kind: "empty-slot"; readonly slotCode: string | null; readonly count: number };

export interface LineupLockStarter {
  readonly playerName: string;
  readonly primaryPosition: string;
  readonly nflTeam: string | null;
  readonly status: string | null;
  readonly slotCode: string;
}

export interface LineupLockEvaluationInput {
  readonly starters: readonly LineupLockStarter[];
  readonly requiredStarterSlots: readonly LineupLockSlotRuleRow[];
  /** Teams the admitted schedule proves are idle in the target week. Absence is never a bye. */
  readonly byeTeams: ReadonlySet<string>;
}

/** Pure condition detection. Every branch is a stored fact; nothing is inferred. */
export function evaluateLineupLockIssues(
  input: LineupLockEvaluationInput,
): readonly LineupLockIssue[] {
  const unavailable: LineupLockIssue[] = [];
  const byes: LineupLockIssue[] = [];
  for (const starter of input.starters) {
    const status = normalizedPlayerStatus(starter.status);
    if (status && ALERTING_STATUSES.has(status)) {
      unavailable.push({
        kind: "player-unavailable",
        playerName: starter.playerName,
        status: status as "OUT" | "IR" | "DOUBTFUL",
      });
      continue;
    }
    const team = starter.nflTeam ? canonicalNflTeamCode(starter.nflTeam) : null;
    if (team && input.byeTeams.has(team)) {
      byes.push({
        kind: "player-bye",
        playerName: starter.playerName,
        position: starter.primaryPosition.trim().toUpperCase(),
      });
    }
  }

  return [...unavailable, ...byes, ...emptyStarterSlots(input)];
}

/**
 * A shortfall is only claimed when the stored starter count is below the season's required starter
 * count. Per-slot naming is used only when the per-code arithmetic accounts for the whole
 * shortfall; otherwise the codes disagree with the rules and only the count is asserted.
 */
function emptyStarterSlots(input: LineupLockEvaluationInput): readonly LineupLockIssue[] {
  const required = input.requiredStarterSlots.reduce((total, rule) => total + rule.count, 0);
  const missingTotal = required - input.starters.length;
  if (missingTotal <= 0) return [];

  const filledByCode = new Map<string, number>();
  for (const starter of input.starters) {
    const code = normalizedSlotCode(starter.slotCode);
    filledByCode.set(code, (filledByCode.get(code) ?? 0) + 1);
  }
  const perCode = input.requiredStarterSlots.flatMap((rule) => {
    const code = normalizedSlotCode(rule.slotCode);
    const missing = rule.count - (filledByCode.get(code) ?? 0);
    return missing > 0 ? [{ slotCode: rule.slotCode.trim(), count: missing }] : [];
  });
  const perCodeTotal = perCode.reduce((total, entry) => total + entry.count, 0);
  if (perCodeTotal !== missingTotal) {
    return [{ kind: "empty-slot", slotCode: null, count: missingTotal }];
  }
  return perCode.map((entry) => ({
    kind: "empty-slot" as const,
    slotCode: entry.slotCode,
    count: entry.count,
  }));
}

export type LineupLockWindow = "t-24h" | "t-2h";

const FINAL_WARNING_MINUTES = 120;
const DIGEST_MINUTES = 1_440;

/**
 * Disjoint bands measured back from kickoff, so exactly one window is live at any moment and the
 * delivery ledger makes each of them fire once. The bands are wide on purpose: a worker that was
 * down for an hour still delivers the final warning, and a digest can never masquerade as one.
 */
export function lineupLockWindow(now: Date, kickoffAt: Date): LineupLockWindow | null {
  const minutes = (kickoffAt.getTime() - now.getTime()) / 60_000;
  if (minutes <= 0) return null;
  if (minutes <= FINAL_WARNING_MINUTES) return "t-2h";
  if (minutes <= DIGEST_MINUTES) return "t-24h";
  return null;
}

export function describeLeadTime(millisecondsToKickoff: number): string {
  const minutes = Math.max(1, Math.round(millisecondsToKickoff / 60_000));
  if (minutes < 90) return `about ${Math.max(5, Math.round(minutes / 5) * 5)} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `about ${hours} hours`;
  return `about ${Math.round(hours / 24)} days`;
}

/** The staleness vocabulary the rest of the app uses: fresh under a day, then hours, then days. */
export function describeRosterStaleness(effectiveAt: Date, now: Date): string | null {
  const ageHours = (now.getTime() - effectiveAt.getTime()) / 3_600_000;
  if (ageHours <= 24) return null;
  return ageHours < 48
    ? `Roster synced ${Math.floor(ageHours)}h ago.`
    : `Roster synced ${Math.floor(ageHours / 24)}d ago.`;
}

function issuePhrase(issue: LineupLockIssue): string {
  if (issue.kind === "player-unavailable") {
    return `${issue.playerName} ${STATUS_PHRASES[issue.status]}`;
  }
  if (issue.kind === "player-bye") return `${issue.playerName} is on bye`;
  if (issue.slotCode === null) {
    return issue.count === 1
      ? "a starting slot is empty"
      : `${issue.count} starting slots are empty`;
  }
  return issue.count === 1
    ? `your ${issue.slotCode} slot is empty`
    : `${issue.count} ${issue.slotCode} slots are empty`;
}

function joinPhrases(phrases: readonly string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? "";
  if (phrases.length === 2) return `${phrases[0]}, and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(", ")}, and ${phrases.at(-1)}`;
}

export interface LineupLockPayloadInput {
  readonly leagueName: string;
  readonly week: number;
  readonly issues: readonly LineupLockIssue[];
  readonly millisecondsToKickoff: number;
  readonly stalenessNote: string | null;
}

/**
 * League facts only. Names, statuses, slot codes, a week, and a kickoff distance — every one of
 * them already visible to this member on the Decision Desk.
 */
export function buildLineupLockPayload(
  input: LineupLockPayloadInput,
  leagueId: string,
): NotificationPayload {
  const named = input.issues.slice(0, MAX_NAMED_ISSUES).map(issuePhrase);
  const remaining = input.issues.length - named.length;
  const phrases = remaining > 0 ? [...named, `${remaining} more`] : named;
  const count = input.issues.reduce(
    (total, issue) => total + (issue.kind === "empty-slot" ? issue.count : 1),
    0,
  );
  const sentence = joinPhrases(phrases);
  const body = [
    `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`,
    `First kickoff in ${describeLeadTime(input.millisecondsToKickoff)}.`,
    ...(input.stalenessNote ? [input.stalenessNote] : []),
    `(${input.leagueName}, Week ${input.week})`,
  ].join(" ");
  return {
    title: count === 1 ? "1 starter needs attention" : `${count} starters need attention`,
    body,
    url: "/decisions",
    tag: `lineup-lock:${leagueId}:${input.week}`,
  };
}

interface SeasonSchedule {
  /** team -> week -> `true` when the admitted schedule affirms an idle week. */
  readonly byeWeeksByTeam: ReadonlyMap<string, ReadonlySet<number>>;
  readonly games: readonly LineupLockScheduleGameRow[];
}

const EMPTY_SEASON_SCHEDULE: SeasonSchedule = { byeWeeksByTeam: new Map(), games: [] };

/** Twin of the API's admitted-source reader; the worker cannot import from the API process. */
function coveredMetadataList(metadata: Record<string, JsonPrimitive>, key: string): string[] {
  const raw = metadata[key];
  return typeof raw === "string"
    ? raw
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    : [];
}

function metadataInteger(metadata: Record<string, JsonPrimitive>, key: string): number | null {
  const value = metadata[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export interface LineupLockSweepResult {
  readonly evaluated: number;
  readonly alerts: number;
}

export interface LineupLockAlertServiceOptions {
  readonly repository: LineupLockRepository;
  readonly now?: () => Date;
}

export class LineupLockAlertService {
  readonly #repository: LineupLockRepository;
  readonly #now: () => Date;

  constructor(options: LineupLockAlertServiceOptions) {
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Builds every notification that is due right now. It sends nothing: the generic sender owns
   * idempotency, delivery, and pruning, so a second notification kind is a second builder.
   */
  async collect(): Promise<readonly PendingNotification[]> {
    const now = this.#now();
    const candidates = await this.#repository.listCandidates(MAX_CANDIDATES);
    const schedules = new Map<number, SeasonSchedule>();
    const slotRules = new Map<string, readonly LineupLockSlotRuleRow[]>();
    const pending: PendingNotification[] = [];

    for (const candidate of candidates) {
      const week = candidate.week;
      if (week === null) continue;

      let schedule = schedules.get(candidate.season);
      if (!schedule) {
        schedule = await this.#loadSeasonSchedule(candidate.season);
        schedules.set(candidate.season, schedule);
      }

      const snapshot = await this.#repository.findLatestRosterSnapshot(candidate.teamId);
      // No stored roster means nothing factual to say about the lineup.
      if (!snapshot) continue;
      const entries = await this.#repository.listRosterEntries(snapshot.id, MAX_ROSTER_ENTRIES + 1);
      if (entries.length > MAX_ROSTER_ENTRIES) continue;

      let rules = slotRules.get(candidate.leagueSeasonId);
      if (!rules) {
        rules = await this.#repository.listStarterSlotRules(
          candidate.leagueSeasonId,
          MAX_SLOT_RULES,
        );
        slotRules.set(candidate.leagueSeasonId, rules);
      }

      const starters: readonly LineupLockStarter[] = entries
        .filter((entry) => entry.isStarter)
        .map((entry) => ({
          playerName: entry.playerName,
          primaryPosition: entry.primaryPosition,
          nflTeam: entry.nflTeam,
          status: entry.status,
          slotCode: entry.slotCode,
        }));

      const kickoffAt = earliestRelevantKickoff(schedule.games, week, starters);
      // Without a trustworthy stored kickoff there is no honest way to say "in two hours", so the
      // member is left alone rather than told something the data does not support.
      if (!kickoffAt) continue;
      const window = lineupLockWindow(now, kickoffAt);
      if (!window) continue;

      const issues = evaluateLineupLockIssues({
        starters,
        requiredStarterSlots: rules,
        byeTeams: byeTeamsForWeek(schedule, week),
      });
      if (issues.length === 0) continue;

      pending.push({
        userId: candidate.userId,
        kind: "lineup-lock",
        idempotencyKey: `lineup-lock:${candidate.userId}:${candidate.leagueId}:${candidate.season}:${week}:${window}`,
        payload: buildLineupLockPayload(
          {
            leagueName: candidate.leagueName,
            week,
            issues,
            millisecondsToKickoff: kickoffAt.getTime() - now.getTime(),
            stalenessNote: describeRosterStaleness(snapshot.effectiveAt, now),
          },
          candidate.leagueId,
        ),
      });
    }

    return pending;
  }

  async #loadSeasonSchedule(season: number): Promise<SeasonSchedule> {
    const source = await this.#repository.findScheduleSource(`nflverse.schedules.${season}`);
    const admitted =
      source?.metadata.publishable === true &&
      source.lastChecksum !== null &&
      source.lastSuccessfulAt !== null;
    if (!source || !admitted || !source.lastChecksum) return EMPTY_SEASON_SCHEDULE;

    const games = await this.#repository.listScheduleGames(
      source.id,
      source.lastChecksum,
      season,
      SCHEDULE_ROW_LIMIT,
    );
    // A truncated read cannot distinguish a missing game from a bye, so it affirms nothing.
    if (games.length >= SCHEDULE_ROW_LIMIT) return EMPTY_SEASON_SCHEDULE;

    const coverage: ScheduleCoverage = {
      publishable: true,
      coveredWeeks: coveredMetadataList(source.metadata, "coveredWeeks")
        .map(Number)
        .filter((week) => Number.isInteger(week) && week >= 1 && week <= 25),
      coveredTeams: [
        ...new Set(
          coveredMetadataList(source.metadata, "coveredTeams")
            .map(canonicalNflTeamCode)
            .filter((team) => /^[A-Z]{2,4}$/u.test(team)),
        ),
      ],
      rowsRejected: metadataInteger(source.metadata, "rowsRejected"),
    };

    // The shared derivation owns the bye rule. Reimplementing it here would let the alarm and the
    // Schedule screen disagree about whether a team is idle.
    const derived = deriveTeamScheduleWeeks({
      season,
      games: games.map((row): ScheduleGameObservation => ({
        ...row,
        awayTeam: canonicalNflTeamCode(row.awayTeam),
        homeTeam: canonicalNflTeamCode(row.homeTeam),
      })),
      coverage,
    });
    const byeWeeksByTeam = new Map<string, ReadonlySet<number>>(
      derived.teams.map((team) => [
        team.team,
        new Set(team.weeks.flatMap((entry) => (entry.state === "bye" ? [entry.week] : []))),
      ]),
    );
    return { byeWeeksByTeam, games };
  }
}

function byeTeamsForWeek(schedule: SeasonSchedule, week: number): ReadonlySet<string> {
  const teams = new Set<string>();
  for (const [team, weeks] of schedule.byeWeeksByTeam) {
    if (weeks.has(week)) teams.add(team);
  }
  return teams;
}

/**
 * The anchor is the first moment this member's lineup starts locking: the earliest stored kickoff,
 * in the target week, of a game involving a team on their starting lineup. A lineup with no
 * resolvable NFL team — every required slot empty, for instance — falls back to the week's earliest
 * kickoff. Games with an unknown or TBD kickoff time are never used as an anchor.
 */
export function earliestRelevantKickoff(
  games: readonly LineupLockScheduleGameRow[],
  week: number,
  starters: readonly LineupLockStarter[],
): Date | undefined {
  const weekGames = games.filter(
    (game) => game.week === week && game.kickoffAt !== null && !game.timeTbd,
  );
  if (weekGames.length === 0) return undefined;
  const starterTeams = new Set(
    starters.flatMap((starter) => (starter.nflTeam ? [canonicalNflTeamCode(starter.nflTeam)] : [])),
  );
  const relevant = weekGames.filter(
    (game) =>
      starterTeams.has(canonicalNflTeamCode(game.awayTeam)) ||
      starterTeams.has(canonicalNflTeamCode(game.homeTeam)),
  );
  const pool = relevant.length > 0 ? relevant : weekGames;
  return pool.reduce<Date | undefined>((earliest, game) => {
    const kickoff = game.kickoffAt!;
    return !earliest || kickoff.getTime() < earliest.getTime() ? kickoff : earliest;
  }, undefined);
}
