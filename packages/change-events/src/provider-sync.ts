import { CHANGE_EVENT_PAYLOAD_VERSION } from "@laces-out/contracts";
import {
  fantasyTeams,
  leagueMemberships,
  leagueSeasons,
  players,
  rosterEntries,
  rosterSnapshots,
  type Database,
} from "@laces-out/db";
import { asc, desc, eq } from "drizzle-orm";

import { changeEventDeduplicationKey } from "./deduplication.js";
import { diffRoster, isEmptyRosterDiff, rosterChecksum, type RosterMember } from "./diff.js";
import { resolveRecipients, type RecipientMember } from "./recipients.js";
import { emitChangeEvents, type ChangeEventDraft, type ChangeEventEmitResult } from "./writer.js";

/**
 * Change-event producer for material roster changes discovered by a provider sync.
 *
 * It runs *after* the persister's transaction has committed, so the new roster snapshot and its
 * predecessor are both visible, and it is called inside a `try/catch` at the seam. A change event
 * is an observability surface; it must never turn a good sync into a 500.
 *
 * Routine sync completion is already represented by provider freshness and is not member activity.
 * This producer compares the new snapshot's checksum with its predecessor's and returns early when
 * they match, enforcing the prior-run comparison before emitting a change.
 */

const MAX_LEAGUE_MEMBERS = 64;
const MAX_SEASON_TEAMS = 64;
/** Matches the bound `apps/worker/src/lineup-lock-alerts.ts` already applies to one roster. */
const MAX_ROSTER_ENTRIES = 256;
/** Named players per bucket in the payload; the remainder is counted, never listed. */
const MAX_NAMED_PLAYERS = 8;

export interface LeagueSeasonDescriptor {
  readonly season: number;
  readonly week: number | null;
}

export interface SeasonTeam {
  readonly teamId: string;
  readonly teamName: string;
}

export interface ChangeEventProducerRepository {
  listLeagueMembers(leagueId: string, limit: number): Promise<readonly RecipientMember[]>;
  describeLeagueSeason(leagueSeasonId: string): Promise<LeagueSeasonDescriptor | undefined>;
  listSeasonTeams(leagueSeasonId: string, limit: number): Promise<readonly SeasonTeam[]>;
  /** Newest first. Fewer than two rows is the first-ever-snapshot case. */
  listLatestRosterSnapshotPair(teamId: string): Promise<readonly { readonly id: string }[]>;
  listRosterEntries(
    snapshotId: string,
    limit: number,
  ): Promise<readonly (RosterMember & { readonly name: string })[]>;
}

export interface ChangeEventProducerDependencies {
  readonly repository: ChangeEventProducerRepository;
  readonly emit: (drafts: readonly ChangeEventDraft[], now: Date) => Promise<ChangeEventEmitResult>;
}

export interface ProviderSyncChangeEventInput {
  readonly provider: "espn" | "yahoo" | "sleeper";
  readonly state: "accepted" | "unchanged";
  readonly leagueId: string;
  readonly leagueSeasonId: string;
  readonly actorUserId: string | null;
  /**
   * The identity of the admitted artifact: a content checksum where the producer holds one, and the
   * `sync_runs.id` otherwise. Both are one-to-one with an accepted snapshot.
   */
  readonly artifactId: string;
  readonly occurredAt: Date;
}

export class DrizzleChangeEventProducerRepository implements ChangeEventProducerRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async listLeagueMembers(leagueId: string, limit: number): Promise<readonly RecipientMember[]> {
    return this.#database
      .select({
        userId: leagueMemberships.userId,
        claimedFantasyTeamId: leagueMemberships.claimedFantasyTeamId,
      })
      .from(leagueMemberships)
      .where(eq(leagueMemberships.leagueId, leagueId))
      .orderBy(asc(leagueMemberships.joinedAt), asc(leagueMemberships.userId))
      .limit(limit);
  }

  async describeLeagueSeason(leagueSeasonId: string): Promise<LeagueSeasonDescriptor | undefined> {
    const [row] = await this.#database
      .select({ season: leagueSeasons.season, week: leagueSeasons.currentWeek })
      .from(leagueSeasons)
      .where(eq(leagueSeasons.id, leagueSeasonId))
      .limit(1);
    return row;
  }

  async listSeasonTeams(leagueSeasonId: string, limit: number): Promise<readonly SeasonTeam[]> {
    return this.#database
      .select({ teamId: fantasyTeams.id, teamName: fantasyTeams.name })
      .from(fantasyTeams)
      .where(eq(fantasyTeams.leagueSeasonId, leagueSeasonId))
      .orderBy(asc(fantasyTeams.externalKey))
      .limit(limit);
  }

  async listLatestRosterSnapshotPair(teamId: string): Promise<readonly { readonly id: string }[]> {
    // Exactly what `roster_snapshots_team_effective_idx` covers.
    return this.#database
      .select({ id: rosterSnapshots.id })
      .from(rosterSnapshots)
      .where(eq(rosterSnapshots.teamId, teamId))
      .orderBy(desc(rosterSnapshots.effectiveAt), desc(rosterSnapshots.id))
      .limit(2);
  }

  async listRosterEntries(
    snapshotId: string,
    limit: number,
  ): Promise<readonly (RosterMember & { readonly name: string })[]> {
    return this.#database
      .select({
        playerId: rosterEntries.playerId,
        slotCode: rosterEntries.slotCode,
        isStarter: rosterEntries.isStarter,
        name: players.fullName,
      })
      .from(rosterEntries)
      .innerJoin(players, eq(players.id, rosterEntries.playerId))
      .where(eq(rosterEntries.snapshotId, snapshotId))
      .orderBy(asc(rosterEntries.playerId))
      .limit(limit);
  }
}

export function drizzleChangeEventProducers(database: Database): ChangeEventProducerDependencies {
  return {
    repository: new DrizzleChangeEventProducerRepository(database),
    emit: (drafts, now) => emitChangeEvents(database, drafts, now),
  };
}

function namedPlayers(
  ids: readonly string[],
  namesById: ReadonlyMap<string, string>,
): readonly { readonly playerId: string; readonly name: string }[] {
  return ids
    .slice(0, MAX_NAMED_PLAYERS)
    .map((playerId) => ({ playerId, name: namesById.get(playerId) ?? "Unknown player" }));
}

export async function emitRosterChangeEvents(
  dependencies: ChangeEventProducerDependencies,
  input: ProviderSyncChangeEventInput,
): Promise<void> {
  if (input.state !== "accepted") return;
  const members = await dependencies.repository.listLeagueMembers(
    input.leagueId,
    MAX_LEAGUE_MEMBERS,
  );
  if (members.length === 0) return;
  const descriptor = await dependencies.repository.describeLeagueSeason(input.leagueSeasonId);
  if (!descriptor) return;
  const teams = await dependencies.repository.listSeasonTeams(
    input.leagueSeasonId,
    MAX_SEASON_TEAMS,
  );
  const recipients = resolveRecipients({
    visibility: "league",
    members,
    affectedTeamId: null,
    actorUserId: input.actorUserId,
  });
  if (recipients.length === 0) return;

  const drafts: ChangeEventDraft[] = [];
  for (const team of teams) {
    const pair = await dependencies.repository.listLatestRosterSnapshotPair(team.teamId);
    const next = pair[0];
    const prior = pair[1];
    // A first-ever snapshot is a baseline, not fifteen additions.
    if (!next || !prior) continue;

    const nextEntries = await dependencies.repository.listRosterEntries(
      next.id,
      MAX_ROSTER_ENTRIES,
    );
    const priorEntries = await dependencies.repository.listRosterEntries(
      prior.id,
      MAX_ROSTER_ENTRIES,
    );
    const nextRosterChecksum = rosterChecksum(nextEntries);
    const priorRosterChecksum = rosterChecksum(priorEntries);
    // The early return that makes "emit on every write" impossible.
    if (nextRosterChecksum === priorRosterChecksum) continue;

    const diff = diffRoster(priorEntries, nextEntries);
    if (!diff || isEmptyRosterDiff(diff)) continue;

    const namesById = new Map(
      [...priorEntries, ...nextEntries].map((entry) => [entry.playerId, entry.name] as const),
    );
    const total =
      diff.added.length + diff.removed.length + diff.promoted.length + diff.benched.length;
    const named =
      Math.min(diff.added.length, MAX_NAMED_PLAYERS) +
      Math.min(diff.removed.length, MAX_NAMED_PLAYERS) +
      Math.min(diff.promoted.length, MAX_NAMED_PLAYERS) +
      Math.min(diff.benched.length, MAX_NAMED_PLAYERS);

    drafts.push({
      source: "roster-diff",
      eventType: "roster.changed",
      deduplicationKey: changeEventDeduplicationKey({
        kind: "roster.changed",
        teamId: team.teamId,
        season: descriptor.season,
        week: descriptor.week,
        priorRosterChecksum,
        nextRosterChecksum,
        artifactId: input.artifactId,
      }),
      aggregateType: "fantasy-team",
      aggregateId: team.teamId,
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      visibility: "league",
      severity: "info",
      payload: {
        v: CHANGE_EVENT_PAYLOAD_VERSION,
        teamId: team.teamId,
        teamName: team.teamName,
        season: descriptor.season,
        week: descriptor.week,
        added: namedPlayers(diff.added, namesById),
        removed: namedPlayers(diff.removed, namesById),
        promoted: namedPlayers(diff.promoted, namesById),
        benched: namedPlayers(diff.benched, namesById),
        moreCount: Math.max(total - named, 0),
      },
      occurredAt: input.occurredAt,
      recipientUserIds: recipients,
    });
  }

  if (drafts.length === 0) return;
  await dependencies.emit(drafts, input.occurredAt);
}

/**
 * The material-change producer at the provider-sync seam. Failures are logged and swallowed so an
 * ingestion that already committed still reports success.
 */
export async function emitProviderSyncChangeEvents(
  dependencies: ChangeEventProducerDependencies,
  input: ProviderSyncChangeEventInput,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    await emitRosterChangeEvents(dependencies, input);
  } catch (error) {
    onError(error);
  }
}
