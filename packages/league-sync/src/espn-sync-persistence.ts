import type {
  LeagueSupplementalBundle,
  LeagueSyncBundle,
  NormalizedRosterPlayer,
} from "@laces-out/connectors";
import {
  auditEvents,
  bridgeDeviceLeagues,
  bridgeDevices,
  espnLeagueSyncStates,
  espnRefreshAttempts,
  fantasyTeams,
  leagueSupplementalSnapshots,
  leagueMemberships,
  leagues,
  leagueSeasons,
  leagueSyncExclusions,
  matchupSnapshots,
  playerExternalIds,
  players,
  providerConnections,
  providerLeagueLinks,
  rosterEntries,
  rosterSlotRules,
  rosterSnapshots,
  refreshRequests,
  scoringRules,
  standingsEntries,
  standingsSnapshots,
  syncRuns,
  weeklyMatchups,
  type BridgeClientKind,
  type Database,
  type EspnArtifactFamily,
  type EspnArtifactFreshness,
  type EspnRefreshFulfillmentMode,
  type LeagueMembershipRole,
} from "@laces-out/db";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import { advanceEspnArtifactFreshness } from "./espn-refresh.js";

export type EspnSyncAuthority =
  | {
      readonly mode: "bridge";
      readonly actorUserId: string;
      readonly bridgeDeviceId: string;
      readonly bridgeScopeId: string;
      readonly clientKind: BridgeClientKind;
    }
  | {
      readonly mode: "server-direct";
      readonly leagueSeasonId: string;
    }
  | {
      readonly mode: "server-session";
      readonly actorUserId: string;
      readonly connectionId: string;
      readonly leagueSeasonId: string;
    };

export interface PersistEspnSyncInput {
  readonly authority: EspnSyncAuthority;
  readonly bundle: LeagueSyncBundle;
  readonly checksumSha256: string;
  readonly checksumAliases?: readonly string[];
  readonly effectiveAt: Date;
  readonly idempotencyKey: string;
  readonly kind: "espn-bridge" | "espn-direct" | "espn-session";
  readonly now: Date;
}

export interface PersistEspnSyncReceipt {
  readonly receiptId: string;
  readonly leagueId: string;
  readonly leagueSeasonId: string;
  readonly recordsWritten: number;
  readonly state: "accepted" | "unchanged";
}

export interface PersistEspnSupplementalInput {
  readonly authority: EspnSyncAuthority;
  readonly bundle: LeagueSupplementalBundle;
  readonly checksumSha256: string;
  readonly checksumAliases?: readonly string[];
  readonly effectiveAt: Date;
  readonly idempotencyKey: string;
  readonly now: Date;
}

export interface PersistEspnSupplementalReceipt {
  readonly receiptId: string;
  readonly leagueSeasonId: string;
  readonly recordsWritten: number;
  readonly state: "accepted" | "unchanged";
}

export const ESPN_SELF_ASSERTED_PLAYER_SOURCE = "espn-self-asserted";

export class EspnSyncPersistenceError extends Error {
  readonly code = "STALE_SNAPSHOT";
  readonly statusCode = 409;

  constructor() {
    super("A newer ESPN snapshot is already stored for this league");
    this.name = "EspnSyncPersistenceError";
  }
}

export class EspnLeagueRemovedError extends Error {
  readonly code = "LEAGUE_REMOVED";
  readonly statusCode = 403;

  constructor() {
    super("This ESPN league was removed. Pair it again to restore access.");
    this.name = "EspnLeagueRemovedError";
  }
}

async function rejectRemovedActorLeague(
  transaction: EspnPersistenceTransaction,
  authority: EspnSyncAuthority,
  externalKey: string,
  season: number,
): Promise<void> {
  if (authority.mode === "server-direct") return;
  const actorUserId = authority.actorUserId;
  const [excluded] = await transaction
    .select({ userId: leagueSyncExclusions.userId })
    .from(leagueSyncExclusions)
    .where(
      and(
        eq(leagueSyncExclusions.userId, actorUserId),
        eq(leagueSyncExclusions.provider, "espn"),
        eq(leagueSyncExclusions.externalKey, externalKey),
        eq(leagueSyncExclusions.season, season),
      ),
    )
    .limit(1);
  if (excluded) throw new EspnLeagueRemovedError();
}

/** Deduplication is relative to the current canonical artifact, never lifetime checksum history. */
export function espnArtifactReceiptState(input: {
  readonly currentChecksum: string | null | undefined;
  readonly incomingChecksum: string;
  readonly incomingChecksumAliases?: readonly string[];
}): "accepted" | "unchanged" {
  if (!input.currentChecksum) return "accepted";
  return new Set([input.incomingChecksum, ...(input.incomingChecksumAliases ?? [])]).has(
    input.currentChecksum,
  )
    ? "unchanged"
    : "accepted";
}

/** A verified legacy-browser alias may be replaced with the portable checksum in place. */
export function espnArtifactChecksumNeedsCanonicalization(input: {
  readonly currentChecksum: string | null | undefined;
  readonly incomingChecksum: string;
  readonly incomingChecksumAliases?: readonly string[];
}): boolean {
  return Boolean(
    input.currentChecksum &&
    input.currentChecksum !== input.incomingChecksum &&
    input.incomingChecksumAliases?.includes(input.currentChecksum),
  );
}

/**
 * A successful provider connection is the league-join mechanism. The first bridge import
 * bootstraps an owner membership, a later connector joins as a member, and existing members keep
 * their role. Merely configuring a league ID grants nothing; this policy runs only after the bridge
 * token, scope, freshness, checksum, and strict ESPN payload have all been validated.
 */
export function espnRefreshPolicy(input: {
  readonly createdLeague: boolean;
  readonly actorIsAnchoredOwner: boolean;
  readonly existingMembershipRole: LeagueMembershipRole | null;
}): { readonly membershipGrant: "owner" | "member" | null } {
  if (input.createdLeague || input.actorIsAnchoredOwner) {
    return { membershipGrant: "owner" };
  }
  return { membershipGrant: input.existingMembershipRole === null ? "member" : null };
}

/** Self-asserted provider observations are isolated to one internal league season. */
export function espnSelfAssertedPlayerKey(
  leagueSeasonId: string,
  providerPlayerId: string,
): string {
  return `${leagueSeasonId}:${providerPlayerId}`;
}

/** A global ESPN crosswalk is canonical only after a trusted catalog source verifies it. */
export function trustedEspnPlayerId(
  mapping:
    | { readonly playerId: string; readonly verified: boolean; readonly gsisId: string | null }
    | undefined,
): string | undefined {
  return mapping?.verified && mapping.gsisId ? mapping.playerId : undefined;
}

/**
 * Only an encrypted server session supplies authenticated ESPN member context to the normalizer.
 * Browser and public snapshots must never turn a payload-level team marker into account identity.
 */
export function espnServerSessionCurrentTeamExternalKey(input: {
  readonly authority: EspnSyncAuthority;
  readonly bundle: LeagueSyncBundle;
  readonly kind: PersistEspnSyncInput["kind"];
}): string | null {
  return espnServerSessionCurrentIdentity(input).teamExternalKey;
}

export interface EspnServerSessionCurrentIdentity {
  readonly teamExternalKey: string | null;
  readonly isCommissioner: boolean | null;
}

/**
 * Returns only identity derived from the authenticated server-session path. The commissioner bit is
 * attached to the exact active ESPN member by the connector; it must never be inferred from a
 * co-manager on the same team.
 */
export function espnServerSessionCurrentIdentity(input: {
  readonly authority: EspnSyncAuthority;
  readonly bundle: LeagueSyncBundle;
  readonly kind: PersistEspnSyncInput["kind"];
}): EspnServerSessionCurrentIdentity {
  if (
    input.authority.mode !== "server-session" ||
    input.kind !== "espn-session" ||
    input.bundle.provenance.mode !== "server-session"
  ) {
    return { teamExternalKey: null, isCommissioner: null };
  }
  const currentUserTeams = input.bundle.teams.filter((team) => team.isCurrentUser);
  if (currentUserTeams.length > 1) {
    throw new Error("ESPN server-session snapshot identified multiple current-user teams");
  }
  const currentUserTeam = currentUserTeams[0];
  return {
    teamExternalKey: currentUserTeam?.externalId ?? null,
    isCommissioner:
      currentUserTeam?.currentUserIsCommissioner === true
        ? true
        : currentUserTeam?.currentUserIsCommissioner === false
          ? false
          : null,
  };
}

/**
 * The shared player table currently backs roster foreign keys. Self-asserted fields are retained
 * only on a league-season-scoped observation row, which catalog queries must exclude.
 */
export function espnSelfAssertedPlayerIdentity(player: NormalizedRosterPlayer): {
  readonly fullName: string;
  readonly nflTeam: string | null;
  readonly primaryPosition: string;
  readonly eligiblePositions: string[];
  readonly status: string | null;
} {
  return {
    fullName: player.fullName,
    nflTeam: player.proTeamAbbreviation,
    primaryPosition: player.primaryPosition,
    eligiblePositions: [...new Set(player.eligiblePositions)],
    status: player.status,
  };
}

/** Exclude league-scoped ESPN observations from every unscoped player catalog. */
export function unscopedPlayerCatalogFilter() {
  return sql<boolean>`not exists (
    select 1
    from ${playerExternalIds}
    where ${playerExternalIds.playerId} = ${players.id}
      and ${playerExternalIds.source} = ${ESPN_SELF_ASSERTED_PLAYER_SOURCE}
  )`;
}

/** Include self-asserted ESPN observations only inside their own league-season workflow. */
export function leagueScopedPlayerCatalogFilter(leagueSeasonId: string) {
  const observationPrefix = `${leagueSeasonId}:%`;
  return sql<boolean>`(
    ${unscopedPlayerCatalogFilter()}
    or exists (
      select 1
      from ${playerExternalIds}
      where ${playerExternalIds.playerId} = ${players.id}
        and ${playerExternalIds.source} = ${ESPN_SELF_ASSERTED_PLAYER_SOURCE}
        and ${playerExternalIds.externalId} like ${observationPrefix}
    )
  )`;
}

function plainRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function slotEligibility(slotCode: string): string[] {
  const normalized = slotCode.toUpperCase();
  if (["FLEX", "RB/WR/TE"].includes(normalized)) return ["RB", "WR", "TE"];
  if (["OP", "SUPER_FLEX", "QB/RB/WR/TE"].includes(normalized)) {
    return ["QB", "RB", "WR", "TE"];
  }
  if (normalized === "RB/WR") return ["RB", "WR"];
  if (normalized === "WR/TE") return ["WR", "TE"];
  return [slotCode];
}

type EspnPersistenceTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function databaseErrorCode(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 6 && cursor && typeof cursor === "object"; depth += 1) {
    if ("code" in cursor && typeof cursor.code === "string") return cursor.code;
    cursor = "cause" in cursor ? cursor.cause : undefined;
  }
  return undefined;
}

function fulfillmentMode(authority: EspnSyncAuthority): EspnRefreshFulfillmentMode {
  if (authority.mode === "server-direct") return "server-direct";
  if (authority.mode === "server-session") return "server-session";
  return authority.clientKind === "ios-app" ? "native-agent" : "chrome-agent";
}

/**
 * A session grant can precede the bridge's first accepted league snapshot. Once that snapshot has
 * established the canonical season, attach the already encrypted account connection without
 * granting any additional membership or scope.
 */
async function linkCapturedBridgeConnection(
  transaction: EspnPersistenceTransaction,
  authority: EspnSyncAuthority,
  leagueSeasonId: string,
  now: Date,
): Promise<void> {
  if (authority.mode !== "bridge") return;
  const [device] = await transaction
    .select({ connectionId: bridgeDevices.connectionId })
    .from(bridgeDevices)
    .where(eq(bridgeDevices.id, authority.bridgeDeviceId))
    .limit(1);
  if (!device?.connectionId) return;
  await transaction
    .insert(providerLeagueLinks)
    .values({
      connectionId: device.connectionId,
      leagueSeasonId,
      discoveredAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  await transaction
    .update(leagueSeasons)
    .set({ connectionId: device.connectionId, updatedAt: now })
    .where(and(eq(leagueSeasons.id, leagueSeasonId), isNull(leagueSeasons.connectionId)));
}

/**
 * Persists only the connector's exact active-member/team match. The authorization link and mapped
 * team must already exist for this actor and season; provider data can never create new scope here.
 * A concurrent or historical claim wins without invalidating the otherwise valid read sync.
 */
async function persistServerSessionTeamIdentity(
  transaction: EspnPersistenceTransaction,
  input: PersistEspnSyncInput,
  leagueId: string,
  leagueSeasonId: string,
): Promise<void> {
  const currentUserIdentity = espnServerSessionCurrentIdentity(input);
  const currentUserTeamExternalKey = currentUserIdentity.teamExternalKey;
  if (input.authority.mode !== "server-session") return;
  const { actorUserId, connectionId } = input.authority;

  const [authorizedLink] = await transaction
    .select({ connectionId: providerLeagueLinks.connectionId })
    .from(providerLeagueLinks)
    .innerJoin(providerConnections, eq(providerConnections.id, providerLeagueLinks.connectionId))
    .where(
      and(
        eq(providerLeagueLinks.connectionId, connectionId),
        eq(providerLeagueLinks.leagueSeasonId, leagueSeasonId),
        eq(providerConnections.userId, actorUserId),
        eq(providerConnections.provider, "espn"),
      ),
    )
    .limit(1);
  if (!authorizedLink) {
    throw new Error("ESPN server-session identity did not match an authorized provider link");
  }

  const [mappedTeam] = currentUserTeamExternalKey
    ? await transaction
        .select({ id: fantasyTeams.id })
        .from(fantasyTeams)
        .where(
          and(
            eq(fantasyTeams.leagueSeasonId, leagueSeasonId),
            eq(fantasyTeams.externalKey, currentUserTeamExternalKey),
          ),
        )
        .limit(1)
    : [];
  // A missing or unmatched active-member result clears stale provider identity. The existing
  // membership claim is deliberately left alone; provider refreshes never overwrite a claim.
  const verifiedExternalKey = mappedTeam ? currentUserTeamExternalKey : null;

  const updatedLinks = await transaction
    .update(providerLeagueLinks)
    .set({
      currentUserTeamExternalKey: verifiedExternalKey,
      lastSyncedAt: input.effectiveAt,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(providerLeagueLinks.connectionId, connectionId),
        eq(providerLeagueLinks.leagueSeasonId, leagueSeasonId),
      ),
    )
    .returning({ connectionId: providerLeagueLinks.connectionId });
  if (updatedLinks.length !== 1) {
    throw new Error("ESPN server-session provider link changed during identity persistence");
  }
  if (!mappedTeam) return;

  // Provider authority may only add commissioner capability. A false or missing flag never
  // demotes a member, and the canonical owner role is never replaced.
  if (currentUserIdentity.isCommissioner) {
    const promotedMemberships = await transaction
      .update(leagueMemberships)
      .set({ role: "commissioner", updatedAt: input.now })
      .where(
        and(
          eq(leagueMemberships.leagueId, leagueId),
          eq(leagueMemberships.userId, actorUserId),
          eq(leagueMemberships.role, "member"),
        ),
      )
      .returning({ id: leagueMemberships.id });
    if (promotedMemberships.length > 1) {
      throw new Error("ESPN League Manager promotion matched multiple memberships");
    }
    const promotedMembership = promotedMemberships[0];
    if (promotedMembership) {
      await transaction.insert(auditEvents).values({
        userId: actorUserId,
        action: "espn.membership.commissioner_promoted",
        targetType: "league_membership",
        targetId: promotedMembership.id,
        correlationId: input.idempotencyKey.slice(0, 128) || "espn-session-commissioner-promotion",
        metadata: {
          provider: "espn",
          signal: "league-manager",
          previousRole: "member",
          role: "commissioner",
        },
        occurredAt: input.now,
      });
    }
  }

  try {
    await transaction.transaction(async (savepoint) => {
      await savepoint
        .update(leagueMemberships)
        .set({
          claimedFantasyTeamId: mappedTeam.id,
          claimedAt: input.now,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(leagueMemberships.leagueId, leagueId),
            eq(leagueMemberships.userId, actorUserId),
            isNull(leagueMemberships.claimedFantasyTeamId),
          ),
        );
    });
  } catch (error) {
    if (databaseErrorCode(error) !== "23505") throw error;
  }
}

/**
 * Advances one artifact independently and completes the one live intent only when every required
 * artifact was captured at or after the server-owned minimum. This runs inside the same transaction
 * as canonical persistence, so a request cannot report success before its data is durable.
 */
async function recordAcceptedArtifact(
  transaction: EspnPersistenceTransaction,
  input: {
    readonly authority: EspnSyncAuthority;
    readonly artifact: EspnArtifactFamily;
    readonly availability?: "free-agent" | "waivers";
    readonly effectiveAt: Date;
    readonly leagueSeasonId: string;
    readonly now: Date;
    readonly receiptId: string;
    readonly receiptState: "accepted" | "unchanged";
  },
): Promise<void> {
  const [storedState] = await transaction
    .select({ artifactFreshness: espnLeagueSyncStates.artifactFreshness })
    .from(espnLeagueSyncStates)
    .where(eq(espnLeagueSyncStates.leagueSeasonId, input.leagueSeasonId))
    .limit(1);
  const artifactFreshness: EspnArtifactFreshness = advanceEspnArtifactFreshness({
    current: storedState?.artifactFreshness ?? {},
    artifact: input.artifact,
    ...(input.availability ? { availability: input.availability } : {}),
    effectiveAt: input.effectiveAt,
  });
  await transaction
    .insert(espnLeagueSyncStates)
    .values({
      leagueSeasonId: input.leagueSeasonId,
      artifactFreshness,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: espnLeagueSyncStates.leagueSeasonId,
      set: { artifactFreshness, updatedAt: input.now },
    });

  const liveRequests = await transaction
    .select({
      id: refreshRequests.id,
      minimumCaptureAt: refreshRequests.minimumCaptureAt,
      requiredArtifacts: refreshRequests.requiredArtifacts,
    })
    .from(refreshRequests)
    .where(
      and(
        eq(refreshRequests.kind, "league"),
        eq(refreshRequests.leagueSeasonId, input.leagueSeasonId),
        inArray(refreshRequests.state, ["queued", "processing"]),
        gt(refreshRequests.expiresAt, input.now),
      ),
    )
    .limit(1);
  const mode = fulfillmentMode(input.authority);
  for (const request of liveRequests) {
    if (!request.minimumCaptureAt || !request.requiredArtifacts) continue;
    const devicePredicate =
      input.authority.mode === "bridge"
        ? eq(espnRefreshAttempts.bridgeDeviceId, input.authority.bridgeDeviceId)
        : isNull(espnRefreshAttempts.bridgeDeviceId);
    const completedAttempts = await transaction
      .update(espnRefreshAttempts)
      .set({
        state: input.receiptState,
        errorCode: null,
        errorDetail: null,
        finishedAt: input.now,
      })
      .where(
        and(
          eq(espnRefreshAttempts.refreshRequestId, request.id),
          eq(espnRefreshAttempts.mode, mode),
          devicePredicate,
          inArray(espnRefreshAttempts.state, ["offered", "started"]),
        ),
      )
      .returning({ id: espnRefreshAttempts.id });
    if (completedAttempts.length === 0) {
      await transaction.insert(espnRefreshAttempts).values({
        refreshRequestId: request.id,
        mode,
        bridgeDeviceId: input.authority.mode === "bridge" ? input.authority.bridgeDeviceId : null,
        state: input.receiptState,
        startedAt: input.now,
        finishedAt: input.now,
      });
    }
    const ready = request.requiredArtifacts.every((artifact) => {
      const capturedAt = artifactFreshness[artifact];
      return Boolean(
        capturedAt &&
        Number.isFinite(Date.parse(capturedAt)) &&
        Date.parse(capturedAt) >= request.minimumCaptureAt!.getTime(),
      );
    });
    if (!ready) continue;

    const [completed] = await transaction
      .update(refreshRequests)
      .set({
        state: "succeeded",
        fulfillmentMode: mode,
        fulfilledByBridgeDeviceId:
          input.authority.mode === "bridge" ? input.authority.bridgeDeviceId : null,
        startedAt: sql`coalesce(${refreshRequests.startedAt}, ${input.now})`,
        finishedAt: input.now,
        resultSyncRunId: input.receiptId,
        errorCode: null,
        errorDetail: null,
        resultSummary: {
          artifactsSatisfied: request.requiredArtifacts.length,
          receiptState: input.receiptState,
        },
      })
      .where(
        and(
          eq(refreshRequests.id, request.id),
          inArray(refreshRequests.state, ["queued", "processing"]),
        ),
      )
      .returning({ id: refreshRequests.id });
    if (!completed) continue;
  }
}

/**
 * Canonical ESPN persistence for every accepted capture. Every mutation for one snapshot is
 * deliberately enclosed in one database transaction. Server-direct authority can only update a
 * pre-existing, exact ESPN season; it can never bootstrap a league, membership, provider claim,
 * or bridge scope.
 */
export class DrizzleEspnSyncPersistence {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async persistSupplemental(
    input: PersistEspnSupplementalInput,
  ): Promise<PersistEspnSupplementalReceipt> {
    const { authority, bundle, effectiveAt, now } = input;
    if (bundle.provider !== "espn") {
      throw new Error("Canonical ESPN supplemental persistence received another provider");
    }

    return this.#database.transaction(async (transaction) => {
      const lockKey = `espn:${bundle.providerLeagueId}:${bundle.season}`;
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      await rejectRemovedActorLeague(
        transaction,
        authority,
        bundle.providerLeagueId,
        bundle.season,
      );

      const [season] = await transaction
        .select({ id: leagueSeasons.id, leagueId: leagueSeasons.leagueId })
        .from(leagueSeasons)
        .where(
          and(
            eq(leagueSeasons.provider, "espn"),
            eq(leagueSeasons.externalKey, bundle.providerLeagueId),
            eq(leagueSeasons.season, bundle.season),
          ),
        )
        .limit(1);
      if (!season) {
        throw new Error("The core ESPN league snapshot must be stored before supplemental data");
      }

      if (authority.mode !== "bridge") {
        if (authority.leagueSeasonId !== season.id) {
          throw new Error("ESPN supplemental data did not match the server sync target");
        }
      } else {
        const [scope] = await transaction
          .select({ leagueId: bridgeDeviceLeagues.leagueId })
          .from(bridgeDeviceLeagues)
          .where(eq(bridgeDeviceLeagues.id, authority.bridgeScopeId))
          .limit(1);
        if (scope?.leagueId !== season.leagueId) {
          throw new Error("ESPN supplemental data did not match the bridge league scope");
        }
      }

      const [latestArtifact] = await transaction
        .select({
          id: leagueSupplementalSnapshots.id,
          effectiveAt: leagueSupplementalSnapshots.effectiveAt,
          sourceSyncRunId: leagueSupplementalSnapshots.sourceSyncRunId,
          artifactChecksum: leagueSupplementalSnapshots.artifactChecksum,
        })
        .from(leagueSupplementalSnapshots)
        .where(
          and(
            eq(leagueSupplementalSnapshots.leagueSeasonId, season.id),
            eq(leagueSupplementalSnapshots.kind, bundle.kind),
            bundle.kind === "available-players"
              ? eq(leagueSupplementalSnapshots.availability, bundle.availability)
              : isNull(leagueSupplementalSnapshots.availability),
          ),
        )
        .orderBy(
          desc(leagueSupplementalSnapshots.effectiveAt),
          desc(leagueSupplementalSnapshots.createdAt),
          desc(leagueSupplementalSnapshots.id),
        )
        .limit(1);
      if (latestArtifact && effectiveAt < latestArtifact.effectiveAt) {
        throw new EspnSyncPersistenceError();
      }
      const [storedSyncState] = await transaction
        .select({ artifactFreshness: espnLeagueSyncStates.artifactFreshness })
        .from(espnLeagueSyncStates)
        .where(eq(espnLeagueSyncStates.leagueSeasonId, season.id))
        .limit(1);
      const freshnessComponent =
        bundle.kind === "available-players"
          ? bundle.availability === "free-agent"
            ? "available-free-agents"
            : "available-waivers"
          : bundle.kind;
      const latestAcceptedAt = Date.parse(
        storedSyncState?.artifactFreshness[freshnessComponent] ?? "",
      );
      if (Number.isFinite(latestAcceptedAt) && effectiveAt.getTime() < latestAcceptedAt) {
        throw new EspnSyncPersistenceError();
      }

      const receiptState = latestArtifact
        ? espnArtifactReceiptState({
            currentChecksum: latestArtifact.artifactChecksum,
            incomingChecksum: input.checksumSha256,
            ...(input.checksumAliases ? { incomingChecksumAliases: input.checksumAliases } : {}),
          })
        : "accepted";
      const [prior] =
        latestArtifact && receiptState === "unchanged"
          ? await transaction
              .select({
                id: syncRuns.id,
                leagueSeasonId: syncRuns.leagueSeasonId,
                recordsWritten: syncRuns.recordsWritten,
                state: syncRuns.state,
              })
              .from(syncRuns)
              .where(eq(syncRuns.id, latestArtifact.sourceSyncRunId))
              .limit(1)
          : [];
      if (
        !prior &&
        ((latestArtifact && effectiveAt.getTime() === latestArtifact.effectiveAt.getTime()) ||
          (Number.isFinite(latestAcceptedAt) && effectiveAt.getTime() === latestAcceptedAt))
      ) {
        throw new EspnSyncPersistenceError();
      }
      if (prior) {
        if (prior.leagueSeasonId !== season.id || prior.state !== "succeeded") {
          throw new Error("Idempotent ESPN supplemental receipt is not a completed artifact");
        }
        if (
          latestArtifact &&
          espnArtifactChecksumNeedsCanonicalization({
            currentChecksum: latestArtifact.artifactChecksum,
            incomingChecksum: input.checksumSha256,
            ...(input.checksumAliases ? { incomingChecksumAliases: input.checksumAliases } : {}),
          })
        ) {
          await transaction
            .update(leagueSupplementalSnapshots)
            .set({ artifactChecksum: input.checksumSha256 })
            .where(eq(leagueSupplementalSnapshots.id, latestArtifact.id));
          await transaction
            .update(syncRuns)
            .set({ artifactChecksum: input.checksumSha256 })
            .where(eq(syncRuns.id, prior.id));
        }
        if (authority.mode === "bridge") {
          await transaction
            .update(bridgeDevices)
            .set({ lastSeenAt: now })
            .where(eq(bridgeDevices.id, authority.bridgeDeviceId));
        }
        await linkCapturedBridgeConnection(transaction, authority, season.id, now);
        await recordAcceptedArtifact(transaction, {
          authority,
          artifact: bundle.kind,
          ...(bundle.kind === "available-players" ? { availability: bundle.availability } : {}),
          effectiveAt,
          leagueSeasonId: season.id,
          now,
          receiptId: prior.id,
          receiptState: "unchanged",
        });
        return {
          receiptId: prior.id,
          leagueSeasonId: season.id,
          recordsWritten: prior.recordsWritten,
          state: "unchanged",
        };
      }

      const recordsRead =
        bundle.kind === "available-players"
          ? bundle.players.length
          : bundle.kind === "weekly-box-scores"
            ? bundle.matchups.length + bundle.playerScores.length
            : bundle.kind === "transactions"
              ? bundle.transactions.length +
                bundle.transactions.reduce(
                  (count, transaction) => count + transaction.items.length,
                  0,
                )
              : bundle.picks.length;
      const [run] = await transaction
        .insert(syncRuns)
        .values({
          connectionId: authority.mode === "server-session" ? authority.connectionId : null,
          leagueSeasonId: season.id,
          kind: `espn-supplemental:${bundle.kind}`,
          state: "processing",
          idempotencyKey: input.idempotencyKey,
          startedAt: now,
          recordsRead,
          artifactChecksum: input.checksumSha256,
        })
        .returning({ id: syncRuns.id });
      if (!run) throw new Error("ESPN supplemental sync receipt could not be created");

      const asOfWeek =
        bundle.kind === "available-players"
          ? bundle.asOfWeek
          : bundle.kind === "completed-draft"
            ? null
            : bundle.week;
      await transaction.insert(leagueSupplementalSnapshots).values({
        leagueSeasonId: season.id,
        kind: bundle.kind,
        asOfWeek,
        availability: bundle.kind === "available-players" ? bundle.availability : null,
        effectiveAt,
        sourceSyncRunId: run.id,
        bridgeDeviceId: authority.mode === "bridge" ? authority.bridgeDeviceId : null,
        endpoint: bundle.provenance.endpoint ?? "https://lm-api-reads.fantasy.espn.com",
        artifactChecksum: input.checksumSha256,
        artifact: plainRecord(bundle),
        warnings: [...bundle.warnings],
      });

      const recordsWritten = 2;
      await transaction
        .update(syncRuns)
        .set({
          state: "succeeded",
          finishedAt: now,
          recordsWritten,
        })
        .where(eq(syncRuns.id, run.id));
      if (authority.mode === "bridge") {
        await transaction
          .update(bridgeDevices)
          .set({ lastSeenAt: now })
          .where(eq(bridgeDevices.id, authority.bridgeDeviceId));
      }
      await linkCapturedBridgeConnection(transaction, authority, season.id, now);
      await recordAcceptedArtifact(transaction, {
        authority,
        artifact: bundle.kind,
        ...(bundle.kind === "available-players" ? { availability: bundle.availability } : {}),
        effectiveAt,
        leagueSeasonId: season.id,
        now,
        receiptId: run.id,
        receiptState: "accepted",
      });
      return {
        receiptId: run.id,
        leagueSeasonId: season.id,
        recordsWritten,
        state: "accepted",
      };
    });
  }

  async persist(input: PersistEspnSyncInput): Promise<PersistEspnSyncReceipt> {
    const { authority, bundle, effectiveAt, now } = input;
    if (bundle.provider !== "espn" || bundle.league.provider !== "espn") {
      throw new Error("Canonical ESPN persistence received another provider's bundle");
    }

    return this.#database.transaction(async (transaction) => {
      // Serialize all write paths for one provider league/season. This closes the race where
      // two first imports could otherwise both try to create the globally unique season row.
      const lockKey = `espn:${bundle.league.providerLeagueId}:${bundle.league.season}`;
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      await rejectRemovedActorLeague(
        transaction,
        authority,
        bundle.league.providerLeagueId,
        bundle.league.season,
      );

      const [existingSeason] = await transaction
        .select()
        .from(leagueSeasons)
        .where(
          and(
            eq(leagueSeasons.provider, "espn"),
            eq(leagueSeasons.externalKey, bundle.league.providerLeagueId),
            eq(leagueSeasons.season, bundle.league.season),
          ),
        )
        .limit(1);

      let actorIsAnchoredOwner = false;
      let actorExistingMembershipRole: LeagueMembershipRole | null = null;
      if (existingSeason) {
        if (authority.mode !== "bridge" && authority.leagueSeasonId !== existingSeason.id) {
          throw new Error("ESPN snapshot did not match the server sync target");
        }
        if (authority.mode === "server-direct" && input.kind !== "espn-direct") {
          throw new Error("Server-direct authority requires an ESPN direct sync kind");
        }
        if (authority.mode === "server-session" && input.kind !== "espn-session") {
          throw new Error("Server-session authority requires an ESPN session sync kind");
        }
        if (authority.mode === "bridge") {
          const [access] = await transaction
            .select({
              ownerUserId: leagues.ownerUserId,
              membershipRole: leagueMemberships.role,
            })
            .from(leagues)
            .leftJoin(
              leagueMemberships,
              and(
                eq(leagueMemberships.leagueId, leagues.id),
                eq(leagueMemberships.userId, authority.actorUserId),
              ),
            )
            .where(eq(leagues.id, existingSeason.leagueId))
            .limit(1);
          actorIsAnchoredOwner = access?.ownerUserId === authority.actorUserId;
          actorExistingMembershipRole = access?.membershipRole ?? null;
        }
        if (existingSeason.lastSyncedAt && effectiveAt < existingSeason.lastSyncedAt) {
          throw new EspnSyncPersistenceError();
        }
      }

      const grantBridgeMembership = async (
        leagueId: string,
        createdLeague: boolean,
      ): Promise<void> => {
        if (authority.mode !== "bridge") return;
        const membershipGrant = espnRefreshPolicy({
          createdLeague,
          actorIsAnchoredOwner,
          existingMembershipRole: actorExistingMembershipRole,
        }).membershipGrant;
        if (membershipGrant === null) return;
        await transaction
          .insert(leagueMemberships)
          .values({
            leagueId,
            userId: authority.actorUserId,
            role: membershipGrant,
          })
          .onConflictDoNothing({
            target: [leagueMemberships.leagueId, leagueMemberships.userId],
          });
      };

      const [latestCore] = existingSeason
        ? await transaction
            .select({
              id: syncRuns.id,
              leagueSeasonId: syncRuns.leagueSeasonId,
              recordsWritten: syncRuns.recordsWritten,
              state: syncRuns.state,
              artifactChecksum: syncRuns.artifactChecksum,
            })
            .from(rosterSnapshots)
            .innerJoin(fantasyTeams, eq(fantasyTeams.id, rosterSnapshots.teamId))
            .innerJoin(syncRuns, eq(syncRuns.id, rosterSnapshots.sourceSyncRunId))
            .where(
              and(
                eq(fantasyTeams.leagueSeasonId, existingSeason.id),
                inArray(syncRuns.kind, ["espn-bridge", "espn-direct", "espn-session"]),
                eq(syncRuns.state, "succeeded"),
              ),
            )
            .orderBy(
              desc(rosterSnapshots.effectiveAt),
              desc(rosterSnapshots.createdAt),
              desc(rosterSnapshots.id),
            )
            .limit(1)
        : [];
      const prior =
        latestCore &&
        espnArtifactReceiptState({
          currentChecksum: latestCore.artifactChecksum,
          incomingChecksum: input.checksumSha256,
          ...(input.checksumAliases ? { incomingChecksumAliases: input.checksumAliases } : {}),
        }) === "unchanged"
          ? latestCore
          : undefined;
      if (
        existingSeason?.lastSyncedAt &&
        effectiveAt.getTime() === existingSeason.lastSyncedAt.getTime() &&
        !prior
      ) {
        throw new EspnSyncPersistenceError();
      }
      if (prior) {
        if (!prior.leagueSeasonId || prior.state !== "succeeded") {
          throw new Error("Idempotent ESPN sync receipt is not a completed league snapshot");
        }
        if (
          espnArtifactChecksumNeedsCanonicalization({
            currentChecksum: prior.artifactChecksum,
            incomingChecksum: input.checksumSha256,
            ...(input.checksumAliases ? { incomingChecksumAliases: input.checksumAliases } : {}),
          })
        ) {
          await transaction
            .update(syncRuns)
            .set({ artifactChecksum: input.checksumSha256 })
            .where(eq(syncRuns.id, prior.id));
        }
        const [season] = await transaction
          .select({ id: leagueSeasons.id, leagueId: leagueSeasons.leagueId })
          .from(leagueSeasons)
          .where(eq(leagueSeasons.id, prior.leagueSeasonId))
          .limit(1);
        if (!season) throw new Error("Idempotent ESPN sync referenced a missing league season");

        // The freshness guard above makes this monotonic. An unchanged recapture still proves that
        // the stored provider data was checked again, so advance freshness without duplicating rows.
        await transaction
          .update(leagueSeasons)
          .set({ lastSyncedAt: effectiveAt, updatedAt: now })
          .where(eq(leagueSeasons.id, season.id));
        await persistServerSessionTeamIdentity(transaction, input, season.leagueId, season.id);
        if (authority.mode === "bridge") {
          // An unchanged provider artifact is still proof of league access. Grant membership before
          // linking the device so the database ownership trigger can enforce the same ordering used
          // by a newly persisted snapshot.
          await grantBridgeMembership(season.leagueId, false);
          await transaction
            .update(bridgeDeviceLeagues)
            .set({ leagueId: season.leagueId, season: bundle.league.season })
            .where(eq(bridgeDeviceLeagues.id, authority.bridgeScopeId));
          await transaction
            .update(bridgeDevices)
            .set({ lastSeenAt: now })
            .where(eq(bridgeDevices.id, authority.bridgeDeviceId));
        }
        await linkCapturedBridgeConnection(transaction, authority, season.id, now);
        await recordAcceptedArtifact(transaction, {
          authority,
          artifact: "core",
          effectiveAt,
          leagueSeasonId: season.id,
          now,
          receiptId: prior.id,
          receiptState: "unchanged",
        });
        return {
          receiptId: prior.id,
          leagueId: season.leagueId,
          leagueSeasonId: season.id,
          recordsWritten: prior.recordsWritten,
          state: "unchanged",
        };
      }

      const recordsRead =
        bundle.teams.length +
        bundle.teams.reduce((count, team) => count + team.roster.length, 0) +
        (bundle.standings?.entries.length ?? 0) +
        (bundle.matchups?.matchups.length ?? 0);
      const [run] = await transaction
        .insert(syncRuns)
        .values({
          connectionId: authority.mode === "server-session" ? authority.connectionId : null,
          kind: input.kind,
          state: "processing",
          idempotencyKey: input.idempotencyKey,
          startedAt: now,
          recordsRead,
          artifactChecksum: input.checksumSha256,
        })
        .returning({ id: syncRuns.id });
      if (!run) throw new Error("ESPN sync receipt could not be created");

      let leagueId: string;
      let leagueSeasonId: string;
      let createdLeague = false;
      if (existingSeason) {
        leagueId = existingSeason.leagueId;
        leagueSeasonId = existingSeason.id;
        await transaction
          .update(leagues)
          .set({ name: bundle.league.name, updatedAt: now })
          .where(eq(leagues.id, leagueId));
        await transaction
          .update(leagueSeasons)
          .set({
            status: bundle.league.currentWeek ? "active" : "preseason",
            teamCount: bundle.league.settings.teamCount,
            draftType: bundle.league.settings.draftType,
            waiverType: bundle.league.settings.waiverType,
            currentWeek: bundle.league.currentWeek,
            settings: plainRecord(bundle.league.settings),
            lastSyncedAt: effectiveAt,
            updatedAt: now,
          })
          .where(eq(leagueSeasons.id, leagueSeasonId));
      } else {
        if (authority.mode !== "bridge") {
          throw new Error("Server ESPN sync cannot create a league season");
        }
        const [created] = await transaction
          .insert(leagues)
          .values({ ownerUserId: authority.actorUserId, name: bundle.league.name })
          .returning({ id: leagues.id });
        if (!created) throw new Error("ESPN league could not be created");
        leagueId = created.id;
        createdLeague = true;
        const [season] = await transaction
          .insert(leagueSeasons)
          .values({
            leagueId,
            provider: "espn",
            externalKey: bundle.league.providerLeagueId,
            season: bundle.league.season,
            status: bundle.league.currentWeek ? "active" : "preseason",
            teamCount: bundle.league.settings.teamCount,
            draftType: bundle.league.settings.draftType,
            waiverType: bundle.league.settings.waiverType,
            currentWeek: bundle.league.currentWeek,
            settings: plainRecord(bundle.league.settings),
            lastSyncedAt: effectiveAt,
          })
          .returning({ id: leagueSeasons.id });
        if (!season) throw new Error("ESPN league season could not be created");
        leagueSeasonId = season.id;
      }

      if (authority.mode === "bridge") {
        await grantBridgeMembership(leagueId, createdLeague);
        await transaction
          .update(bridgeDeviceLeagues)
          .set({ leagueId, season: bundle.league.season })
          .where(eq(bridgeDeviceLeagues.id, authority.bridgeScopeId));
      }
      // League settings are a complete snapshot. Delete-and-reinsert is safe because the
      // surrounding transaction preserves the prior rules if any later write fails.
      await transaction.delete(scoringRules).where(eq(scoringRules.leagueSeasonId, leagueSeasonId));
      if (bundle.league.settings.scoringRules.length > 0) {
        await transaction.insert(scoringRules).values(
          bundle.league.settings.scoringRules.map((rule) => ({
            leagueSeasonId,
            statKey: rule.name ?? rule.statId,
            operation: "multiply",
            points: String(rule.points),
            providerStatId: rule.statId,
          })),
        );
      }
      await transaction
        .delete(rosterSlotRules)
        .where(eq(rosterSlotRules.leagueSeasonId, leagueSeasonId));
      if (bundle.league.settings.rosterSlots.length > 0) {
        await transaction.insert(rosterSlotRules).values(
          bundle.league.settings.rosterSlots.map((slot) => ({
            leagueSeasonId,
            slotCode: slot.position,
            count: slot.count,
            eligiblePositions: slotEligibility(slot.position),
            isStarter: slot.starting,
          })),
        );
      }

      let recordsWritten = 2;
      const storedTeamIds = new Map<string, string>();
      for (const team of bundle.teams) {
        const manager = team.managers[0];
        const managerDisplayName = manager ? (manager.fullName ?? manager.displayName) : null;
        const [storedTeam] = await transaction
          .insert(fantasyTeams)
          .values({
            leagueSeasonId,
            externalKey: team.externalId,
            name: team.name,
            abbreviation: team.abbreviation,
            logoUrl: team.logoUrl ?? null,
            isUserTeam: false,
            managerDisplayName,
            faabRemaining: team.faabRemaining ?? null,
            waiverPriority: team.waiverPriority ?? null,
          })
          .onConflictDoUpdate({
            target: [fantasyTeams.leagueSeasonId, fantasyTeams.externalKey],
            set: {
              name: team.name,
              abbreviation: team.abbreviation,
              logoUrl: team.logoUrl ?? null,
              managerDisplayName,
              faabRemaining: team.faabRemaining ?? null,
              waiverPriority: team.waiverPriority ?? null,
              updatedAt: now,
            },
          })
          .returning({ id: fantasyTeams.id });
        if (!storedTeam) throw new Error("ESPN fantasy team could not be stored");
        storedTeamIds.set(team.externalId, storedTeam.id);
        const [roster] = await transaction
          .insert(rosterSnapshots)
          .values({
            teamId: storedTeam.id,
            season: bundle.league.season,
            week: bundle.league.currentWeek,
            effectiveAt,
            sourceSyncRunId: run.id,
          })
          .returning({ id: rosterSnapshots.id });
        if (!roster) throw new Error("ESPN roster snapshot could not be stored");

        const entries: Array<{
          snapshotId: string;
          playerId: string;
          slotCode: string;
          isStarter: boolean;
        }> = [];
        for (const player of team.roster) {
          const [external] = await transaction
            .select({
              playerId: playerExternalIds.playerId,
              verified: playerExternalIds.verified,
              gsisId: players.gsisId,
            })
            .from(playerExternalIds)
            .innerJoin(players, eq(playerExternalIds.playerId, players.id))
            .where(
              and(
                eq(playerExternalIds.source, "espn"),
                eq(playerExternalIds.externalId, player.providerPlayerId),
              ),
            )
            .limit(1);
          let playerId = trustedEspnPlayerId(external);
          if (!playerId) {
            const observationKey = espnSelfAssertedPlayerKey(
              leagueSeasonId,
              player.providerPlayerId,
            );
            const [observation] = await transaction
              .select({ playerId: playerExternalIds.playerId })
              .from(playerExternalIds)
              .where(
                and(
                  eq(playerExternalIds.source, ESPN_SELF_ASSERTED_PLAYER_SOURCE),
                  eq(playerExternalIds.externalId, observationKey),
                ),
              )
              .limit(1);
            playerId = observation?.playerId;
            if (playerId) {
              await transaction
                .update(players)
                .set({ ...espnSelfAssertedPlayerIdentity(player), updatedAt: now })
                .where(eq(players.id, playerId));
            } else {
              const [storedPlayer] = await transaction
                .insert(players)
                .values(espnSelfAssertedPlayerIdentity(player))
                .returning({ id: players.id });
              if (!storedPlayer) throw new Error("ESPN player could not be stored");
              playerId = storedPlayer.id;
              await transaction.insert(playerExternalIds).values({
                playerId,
                source: ESPN_SELF_ASSERTED_PLAYER_SOURCE,
                externalId: observationKey,
                season: bundle.league.season,
                confidence: "0",
                verified: false,
              });
            }
          }
          entries.push({
            snapshotId: roster.id,
            playerId,
            slotCode: player.lineupSlot,
            isStarter: !["BE", "BN", "IR", "RES", "TAXI"].includes(player.lineupSlot.toUpperCase()),
          });
        }
        if (entries.length > 0) await transaction.insert(rosterEntries).values(entries);
        recordsWritten += 2 + entries.length;
      }

      if (bundle.standings !== undefined) {
        const [standingsSnapshot] = await transaction
          .insert(standingsSnapshots)
          .values({
            leagueSeasonId,
            asOfWeek: bundle.standings.asOfWeek,
            effectiveAt,
            sourceSyncRunId: run.id,
          })
          .returning({ id: standingsSnapshots.id });
        if (!standingsSnapshot) throw new Error("ESPN standings snapshot could not be stored");
        const rows = bundle.standings.entries.map((entry) => {
          const teamId = storedTeamIds.get(entry.teamExternalId);
          if (!teamId) throw new Error("ESPN standings referenced an unstored fantasy team");
          return {
            snapshotId: standingsSnapshot.id,
            teamId,
            providerTeamId: entry.providerTeamId,
            rank: entry.rank,
            playoffSeed: entry.playoffSeed,
            wins: entry.wins,
            losses: entry.losses,
            ties: entry.ties,
            pointsFor: String(entry.pointsFor),
            pointsAgainst: String(entry.pointsAgainst),
            streakType: entry.streakType,
            streakLength: entry.streakLength,
          };
        });
        if (rows.length > 0) await transaction.insert(standingsEntries).values(rows);
        recordsWritten += 1 + rows.length;
      }

      if (bundle.matchups !== undefined) {
        const [matchupSnapshot] = await transaction
          .insert(matchupSnapshots)
          .values({
            leagueSeasonId,
            asOfWeek: bundle.matchups.asOfWeek,
            effectiveAt,
            sourceSyncRunId: run.id,
          })
          .returning({ id: matchupSnapshots.id });
        if (!matchupSnapshot) throw new Error("ESPN matchup snapshot could not be stored");
        const rows = bundle.matchups.matchups.map((matchup) => {
          const homeTeamId = storedTeamIds.get(matchup.home.teamExternalId);
          const awayTeamId = storedTeamIds.get(matchup.away.teamExternalId);
          const winnerTeamId =
            matchup.winnerTeamExternalId === null
              ? null
              : storedTeamIds.get(matchup.winnerTeamExternalId);
          if (!homeTeamId || !awayTeamId) {
            throw new Error("ESPN matchup referenced an unstored fantasy team");
          }
          if (matchup.winnerTeamExternalId !== null && !winnerTeamId) {
            throw new Error("ESPN matchup winner referenced an unstored fantasy team");
          }
          return {
            snapshotId: matchupSnapshot.id,
            externalKey: matchup.externalId,
            providerMatchupId: matchup.providerMatchupId,
            week: matchup.week,
            status: matchup.status,
            homeTeamId,
            awayTeamId,
            homeProviderTeamId: matchup.home.providerTeamId,
            awayProviderTeamId: matchup.away.providerTeamId,
            homeScore: matchup.home.score === null ? null : String(matchup.home.score),
            awayScore: matchup.away.score === null ? null : String(matchup.away.score),
            winnerTeamId: winnerTeamId ?? null,
            tied: matchup.tied,
          };
        });
        if (rows.length > 0) await transaction.insert(weeklyMatchups).values(rows);
        recordsWritten += 1 + rows.length;
      }

      await persistServerSessionTeamIdentity(transaction, input, leagueId, leagueSeasonId);

      await transaction
        .update(syncRuns)
        .set({
          leagueSeasonId,
          state: "succeeded",
          finishedAt: now,
          recordsWritten,
        })
        .where(eq(syncRuns.id, run.id));
      if (authority.mode === "bridge") {
        await transaction
          .update(bridgeDevices)
          .set({ lastSeenAt: now })
          .where(eq(bridgeDevices.id, authority.bridgeDeviceId));
      }
      await linkCapturedBridgeConnection(transaction, authority, leagueSeasonId, now);
      await recordAcceptedArtifact(transaction, {
        authority,
        artifact: "core",
        effectiveAt,
        leagueSeasonId,
        now,
        receiptId: run.id,
        receiptState: "accepted",
      });

      return {
        receiptId: run.id,
        leagueId,
        leagueSeasonId,
        recordsWritten,
        state: "accepted" as const,
      };
    });
  }
}
