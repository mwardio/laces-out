import { changeEventDeduplicationKey, type ChangeEventDraft } from "@laces-out/change-events";
import { CHANGE_EVENT_PAYLOAD_VERSION, type ChangeEventSeverity } from "@laces-out/contracts";
import {
  fantasyTeams,
  leagueMemberships,
  playerInjuryReportObservations,
  rosterEntries,
  rosterSnapshots,
  type Database,
} from "@laces-out/db";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";

/**
 * The injury half of the change-event producers.
 *
 * The ingestion's insert already uses `.onConflictDoNothing().returning(...)`, so the rows it
 * returns *are* the genuinely new observations. That is not the same as a genuine change: the
 * unique index includes `input_checksum`, so a refreshed artifact can readmit an identical report.
 * The comparison that decides whether anything actually moved is `stateKey` against the newest
 * prior `state_key` for the same `(player, season, week)`.
 *
 * An injury event is `private`, not `league`: it names one member's rostered player and nothing
 * else. One draft is built per rostering member, each with its own league and its own key, so two
 * managers rostering the same player in two leagues each get an event.
 */

export const MAX_INJURY_FANOUT = 200;

export type InjuryReportStatus = "out" | "doubtful" | "questionable" | "probable" | "note";

export interface InjuryObservation {
  readonly playerId: string | null;
  readonly playerName: string;
  readonly season: number;
  readonly week: number;
  readonly stateKey: string;
  readonly reportStatus: InjuryReportStatus | null;
  readonly practiceStatus: string | null;
  readonly fetchedAt: Date;
}

export interface RosteringMember {
  readonly userId: string;
  readonly leagueId: string;
  readonly teamName: string;
}

export interface InjuryChangeDraftInput {
  readonly observations: readonly InjuryObservation[];
  /** Keyed `${playerId}:${season}:${week}`. */
  readonly priorStateKeyByPlayerWeek: ReadonlyMap<string, string>;
  readonly rosteringByPlayer: ReadonlyMap<string, readonly RosteringMember[]>;
}

export function playerWeekKey(playerId: string, season: number, week: number): string {
  return `${playerId}:${season}:${week}`;
}

/** `out` and `doubtful` mean a lineup must change; anything softer is a decision to revisit. */
function severityFor(status: InjuryReportStatus | null): ChangeEventSeverity {
  return status === "out" || status === "doubtful" ? "warning" : "action";
}

export function buildInjuryChangeDrafts(
  input: InjuryChangeDraftInput,
): readonly ChangeEventDraft[] {
  const drafts: ChangeEventDraft[] = [];
  for (const observation of input.observations) {
    // Never guess an unresolved identity; that could attach an injury to the wrong player on
    // someone's roster.
    if (observation.playerId === null) continue;
    const rostering = input.rosteringByPlayer.get(observation.playerId);
    if (!rostering || rostering.length === 0) continue;

    const priorStateKey =
      input.priorStateKeyByPlayerWeek.get(
        playerWeekKey(observation.playerId, observation.season, observation.week),
      ) ?? null;
    // The early return that keeps a readmitted identical report silent.
    if (priorStateKey === observation.stateKey) continue;

    for (const member of rostering) {
      drafts.push({
        source: "injury-report",
        eventType: "player.injury.changed",
        deduplicationKey: changeEventDeduplicationKey({
          kind: "player.injury.changed",
          playerId: observation.playerId,
          leagueId: member.leagueId,
          season: observation.season,
          week: observation.week,
          priorStateKey,
          nextStateKey: observation.stateKey,
        }),
        aggregateType: "player",
        aggregateId: observation.playerId,
        leagueId: member.leagueId,
        // Nobody performed this.
        actorUserId: null,
        visibility: "private",
        severity: severityFor(observation.reportStatus),
        payload: {
          v: CHANGE_EVENT_PAYLOAD_VERSION,
          playerId: observation.playerId,
          playerName: observation.playerName,
          teamName: member.teamName,
          season: observation.season,
          week: observation.week,
          reportStatus: observation.reportStatus,
          practiceStatus: observation.practiceStatus,
        },
        occurredAt: observation.fetchedAt,
        recipientUserIds: [member.userId],
      });
    }
  }
  return drafts;
}

export interface InjuryChangeEventRepository {
  listPriorStateKeys(
    playerIds: readonly string[],
    season: number,
    week: number,
    excludeSyncRunId: string,
  ): Promise<ReadonlyMap<string, string>>;
  listRosteringMembers(
    playerIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly RosteringMember[]>>;
}

export class DrizzleInjuryChangeEventRepository implements InjuryChangeEventRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async listPriorStateKeys(
    playerIds: readonly string[],
    season: number,
    week: number,
    excludeSyncRunId: string,
  ): Promise<ReadonlyMap<string, string>> {
    if (playerIds.length === 0) return new Map();
    // The newest state key per player for this week, *excluding* the run just written — otherwise
    // the row we are reacting to would be its own prior state and nothing would ever fire.
    const rows = await this.#database
      .selectDistinctOn([playerInjuryReportObservations.playerId], {
        playerId: playerInjuryReportObservations.playerId,
        stateKey: playerInjuryReportObservations.stateKey,
      })
      .from(playerInjuryReportObservations)
      .where(
        and(
          inArray(playerInjuryReportObservations.playerId, [...playerIds]),
          eq(playerInjuryReportObservations.season, season),
          eq(playerInjuryReportObservations.week, week),
          ne(playerInjuryReportObservations.sourceSyncRunId, excludeSyncRunId),
        ),
      )
      .orderBy(
        playerInjuryReportObservations.playerId,
        desc(playerInjuryReportObservations.fetchedAt),
        desc(playerInjuryReportObservations.id),
      )
      .limit(MAX_INJURY_FANOUT);
    return new Map(
      rows.flatMap((row) => (row.playerId ? ([[row.playerId, row.stateKey]] as const) : [])),
    );
  }

  async listRosteringMembers(
    playerIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly RosteringMember[]>> {
    if (playerIds.length === 0) return new Map();
    // Only the *latest* snapshot per team counts: a player dropped last week is not on a roster now.
    const latest = this.#database
      .select({
        teamId: rosterSnapshots.teamId,
        snapshotId: sql<string>`
          first_value(${rosterSnapshots.id}) over (
            partition by ${rosterSnapshots.teamId}
            order by ${rosterSnapshots.effectiveAt} desc, ${rosterSnapshots.id} desc
          )
        `.as("snapshot_id"),
      })
      .from(rosterSnapshots)
      .as("latest");

    const rows = await this.#database
      .selectDistinct({
        playerId: rosterEntries.playerId,
        userId: leagueMemberships.userId,
        leagueId: leagueMemberships.leagueId,
        teamName: fantasyTeams.name,
      })
      .from(rosterEntries)
      .innerJoin(latest, eq(latest.snapshotId, rosterEntries.snapshotId))
      .innerJoin(fantasyTeams, eq(fantasyTeams.id, latest.teamId))
      .innerJoin(leagueMemberships, eq(leagueMemberships.claimedFantasyTeamId, fantasyTeams.id))
      .where(inArray(rosterEntries.playerId, [...playerIds]))
      .limit(MAX_INJURY_FANOUT + 1);

    // A truncated fan-out is not a partial answer worth sending: it would silently tell some
    // members and not others, with no way to tell which.
    if (rows.length > MAX_INJURY_FANOUT) return new Map();

    const byPlayer = new Map<string, RosteringMember[]>();
    for (const row of rows) {
      const list = byPlayer.get(row.playerId) ?? [];
      list.push({ userId: row.userId, leagueId: row.leagueId, teamName: row.teamName });
      byPlayer.set(row.playerId, list);
    }
    return byPlayer;
  }
}
