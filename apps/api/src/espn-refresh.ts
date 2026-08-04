import { createHash } from "node:crypto";

import type { EspnLeagueRefreshStatus, EspnRefreshAgentPollResponse } from "@fantasy/contracts";
import {
  bridgeDeviceLeagues,
  bridgeDevices,
  espnLeagueSyncStates,
  espnRefreshAttempts,
  leagueMemberships,
  leagueSeasons,
  leagueSupplementalSnapshots,
  matchupSnapshots,
  refreshRequests,
  weeklyMatchups,
  type BridgeClientKind,
  type Database,
  type EspnArtifactFamily,
  type EspnArtifactFreshness,
  type EspnDirectCapabilityState,
  type EspnPreferredSyncMode,
  type EspnRefreshAttemptState,
  type EspnRefreshFulfillmentMode,
  type RefreshRequestState,
} from "@fantasy/db";
import {
  advanceEspnArtifactFreshness,
  espnRefreshBucket,
  evaluateEspnRefresh,
  type EspnRefreshEvaluation,
} from "@fantasy/league-sync";
import { and, desc, eq, gt, gte, inArray, isNull, lte, notExists, or, sql } from "drizzle-orm";

const ASSISTED_REQUEST_LIFETIME_MS = 24 * 60 * 60 * 1000;
const ACTIVE_AGENT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_REQUIRED_BACKOFF_MS = 30 * 60 * 1000;
const RETRYABLE_AGENT_BACKOFF_MS = 15 * 60 * 1000;
const REJECTED_AGENT_BACKOFF_MS = 30 * 60 * 1000;
const MAX_AGENT_REQUESTS = 8;

type LiveRequestState = Extract<RefreshRequestState, "queued" | "processing">;

export interface StoredRefreshRequest {
  readonly id: string;
  readonly state: RefreshRequestState;
  readonly fulfillmentMode: EspnRefreshFulfillmentMode | null;
  readonly requiredArtifacts: readonly EspnArtifactFamily[];
  readonly minimumCaptureAt: Date;
  readonly expiresAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
}

interface StoredRefreshRequestCandidate {
  readonly id: string;
  readonly state: RefreshRequestState;
  readonly fulfillmentMode: EspnRefreshFulfillmentMode | null;
  readonly requiredArtifacts: readonly EspnArtifactFamily[] | null;
  readonly minimumCaptureAt: Date | null;
  readonly expiresAt: Date | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
}

function storedRefreshRequest(
  row: StoredRefreshRequestCandidate | undefined,
): StoredRefreshRequest | null {
  if (!row?.requiredArtifacts || !row.minimumCaptureAt || !row.expiresAt) return null;
  return {
    id: row.id,
    state: row.state,
    fulfillmentMode: row.fulfillmentMode,
    requiredArtifacts: [...row.requiredArtifacts],
    minimumCaptureAt: row.minimumCaptureAt,
    expiresAt: row.expiresAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  };
}

export interface StoredAttempt {
  readonly mode: EspnRefreshFulfillmentMode;
  readonly state: EspnRefreshAttemptState;
  readonly deviceName: string | null;
  readonly deviceUserId: string | null;
  readonly clientKind: BridgeClientKind | null;
  readonly errorCode: string | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

export interface RefreshTarget {
  readonly leagueId: string;
  readonly leagueSeasonId: string;
  readonly externalLeagueId: string;
  readonly season: number;
  readonly seasonStatus: string;
  readonly currentWeek: number | null;
  readonly artifactFreshness: EspnArtifactFreshness;
  readonly hasActiveMatchup: boolean;
  readonly directCoreState: EspnDirectCapabilityState;
  readonly preferredMode: EspnPreferredSyncMode;
  readonly lastProbeAt: Date | null;
  readonly nextProbeAt: Date | null;
  readonly lastDirectSuccessAt: Date | null;
  readonly circuitOpenUntil: Date | null;
  readonly activeAgentCount: number;
  readonly mostRecentAgentSeenAt: Date | null;
  readonly request: StoredRefreshRequest | null;
  readonly latestAttempt: StoredAttempt | null;
}

export class EspnRefreshError extends Error {
  readonly code: "NOT_FOUND" | "UNSUPPORTED" | "UNAUTHORIZED" | "OUT_OF_SCOPE";
  readonly statusCode: number;

  constructor(code: EspnRefreshError["code"], message: string) {
    super(message);
    this.name = "EspnRefreshError";
    this.code = code;
    this.statusCode = code === "UNAUTHORIZED" ? 401 : code === "OUT_OF_SCOPE" ? 403 : 404;
  }
}

export interface EspnRefreshCoordinatorOptions {
  readonly directEnabled: boolean;
  readonly enqueueDirect?: (input: {
    readonly leagueSeasonId: string;
    readonly refreshRequestId: string;
  }) => Promise<string | null>;
}

export interface EspnRefreshRepository {
  inspectMemberTarget(
    userId: string,
    leagueSeasonId: string,
    now: Date,
  ): Promise<RefreshTarget | undefined>;
  createOrGetRequest(input: {
    readonly userId: string;
    readonly leagueSeasonId: string;
    readonly idempotencyKey: string;
    readonly minimumCaptureAt: Date;
    readonly expiresAt: Date;
    readonly requiredArtifacts: readonly EspnArtifactFamily[];
    readonly fulfillmentMode: EspnRefreshFulfillmentMode | null;
    readonly now: Date;
  }): Promise<StoredRefreshRequest>;
  pollAgent(deviceToken: string, now: Date): Promise<EspnRefreshAgentPollResponse>;
  reportAgentAttempt(
    deviceToken: string,
    requestId: string,
    input: {
      readonly state: "started" | "login-required" | "retryable-error" | "rejected";
      readonly errorCode?: string;
      readonly detail?: string;
    },
    now: Date,
  ): Promise<{ readonly attemptId: string; readonly state: EspnRefreshAttemptState }>;
}

function laterIso(left: string | undefined, right: Date | null): string | undefined {
  if (!right) return left;
  if (!left) return right.toISOString();
  return Date.parse(left) >= right.getTime() ? left : right.toISOString();
}

function freshnessState(
  observedAt: string | undefined,
  staleAfterMs: number,
  now: Date,
): "fresh" | "aging" | "stale" | "missing" {
  if (!observedAt || !Number.isFinite(Date.parse(observedAt))) return "missing";
  const age = Math.max(0, now.getTime() - Date.parse(observedAt));
  if (age >= staleAfterMs) return "stale";
  return age >= staleAfterMs * 0.75 ? "aging" : "fresh";
}

function displayStatus(input: {
  readonly target: RefreshTarget;
  readonly evaluation: EspnRefreshEvaluation;
  readonly requestingUserId: string;
  readonly directEnabled: boolean;
}): EspnLeagueRefreshStatus["display"] {
  const { target } = input;
  if (
    input.evaluation.current &&
    target.request?.state !== "queued" &&
    target.request?.state !== "processing"
  ) {
    return { code: "up-to-date", label: "Up to date", actionRequired: false };
  }

  const live = target.request?.state === "queued" || target.request?.state === "processing";
  if (live) {
    const attempt = target.latestAttempt;
    if (attempt?.state === "login-required") {
      return {
        code: "login-required",
        label: "Open the paired browser and sign in to ESPN",
        actionRequired: true,
      };
    }
    const directCoreChecked =
      attempt?.mode === "server-direct" &&
      (attempt.state === "accepted" || attempt.state === "unchanged");
    if (
      attempt?.state === "not-public" ||
      attempt?.state === "retryable-error" ||
      attempt?.state === "rejected" ||
      directCoreChecked
    ) {
      return {
        code: "queued-no-agent",
        label: directCoreChecked
          ? "Core checked · waiting for an authorized sync device"
          : target.activeAgentCount > 0
            ? "Refresh queued · waiting for another authorized sync device"
            : "Showing saved data · waiting for an authorized sync device",
        actionRequired: target.activeAgentCount === 0,
      };
    }
    if (target.request?.fulfillmentMode === "server-direct" && input.directEnabled) {
      return {
        code: "refreshing-direct",
        label: "Refreshing directly from ESPN",
        actionRequired: false,
      };
    }
    if (attempt && (attempt.state === "offered" || attempt.state === "started")) {
      const ownDevice = attempt.deviceUserId === input.requestingUserId ? attempt.deviceName : null;
      const deviceLabel =
        ownDevice ?? (attempt.clientKind === "ios-app" ? "a paired iOS app" : "a paired device");
      return {
        code: "refreshing-agent",
        label:
          attempt.state === "started"
            ? `Refreshing through ${deviceLabel}`
            : `Refresh offered to ${deviceLabel}`,
        actionRequired: false,
      };
    }
    return {
      code: "queued-no-agent",
      label: "Refresh queued · waiting for a paired device",
      actionRequired: target.activeAgentCount === 0,
    };
  }

  const core = target.artifactFreshness.core;
  return {
    code: "last-good",
    label: core
      ? `Showing the last good sync from ${new Date(core).toLocaleString("en-US", { timeZone: "UTC" })} UTC`
      : "No accepted ESPN sync is available yet",
    actionRequired: true,
  };
}

export class EspnRefreshCoordinator {
  readonly #repository: EspnRefreshRepository;
  readonly #directEnabled: boolean;
  readonly #enqueueDirect: EspnRefreshCoordinatorOptions["enqueueDirect"];
  readonly #now: () => Date;

  constructor(
    repository: EspnRefreshRepository,
    options: EspnRefreshCoordinatorOptions,
    now: () => Date = () => new Date(),
  ) {
    this.#repository = repository;
    this.#directEnabled = options.directEnabled;
    this.#enqueueDirect = options.enqueueDirect;
    this.#now = now;
  }

  async requestRefresh(userId: string, leagueSeasonId: string): Promise<EspnLeagueRefreshStatus> {
    const now = this.#now();
    const target = await this.#repository.inspectMemberTarget(userId, leagueSeasonId, now);
    if (!target) throw new EspnRefreshError("NOT_FOUND", "ESPN league season was not found");
    const evaluation = evaluateEspnRefresh({
      seasonStatus: target.seasonStatus,
      currentWeek: target.currentWeek,
      hasActiveMatchup: target.hasActiveMatchup,
      artifactFreshness: target.artifactFreshness,
      now,
    });
    if (evaluation.current) return this.#status(userId, target, evaluation, now);

    const directAvailable =
      this.#directEnabled &&
      target.directCoreState === "available" &&
      target.preferredMode !== "assisted" &&
      (!target.circuitOpenUntil || target.circuitOpenUntil <= now) &&
      evaluation.staleArtifacts.includes("core");
    const request = await this.#repository.createOrGetRequest({
      userId,
      leagueSeasonId,
      idempotencyKey: espnRefreshBucket({
        leagueSeasonId,
        now,
        minimumRefreshIntervalMs: evaluation.policy.minimumRefreshIntervalMs,
      }),
      minimumCaptureAt: now,
      expiresAt: new Date(now.getTime() + ASSISTED_REQUEST_LIFETIME_MS),
      requiredArtifacts: evaluation.staleArtifacts,
      fulfillmentMode: directAvailable ? "server-direct" : null,
      now,
    });
    if (directAvailable && this.#enqueueDirect) {
      await this.#enqueueDirect({ leagueSeasonId, refreshRequestId: request.id });
    }
    const refreshed = await this.#repository.inspectMemberTarget(userId, leagueSeasonId, now);
    if (!refreshed) throw new EspnRefreshError("NOT_FOUND", "ESPN league season was not found");
    return this.#status(
      userId,
      refreshed,
      evaluateEspnRefresh({
        seasonStatus: refreshed.seasonStatus,
        currentWeek: refreshed.currentWeek,
        hasActiveMatchup: refreshed.hasActiveMatchup,
        artifactFreshness: refreshed.artifactFreshness,
        now,
      }),
      now,
    );
  }

  async getStatus(userId: string, leagueSeasonId: string): Promise<EspnLeagueRefreshStatus> {
    const now = this.#now();
    const target = await this.#repository.inspectMemberTarget(userId, leagueSeasonId, now);
    if (!target) throw new EspnRefreshError("NOT_FOUND", "ESPN league season was not found");
    const evaluation = evaluateEspnRefresh({
      seasonStatus: target.seasonStatus,
      currentWeek: target.currentWeek,
      hasActiveMatchup: target.hasActiveMatchup,
      artifactFreshness: target.artifactFreshness,
      now,
    });
    return this.#status(userId, target, evaluation, now);
  }

  pollAgent(deviceToken: string): Promise<EspnRefreshAgentPollResponse> {
    return this.#repository.pollAgent(deviceToken, this.#now());
  }

  async reportAgentAttempt(
    deviceToken: string,
    requestId: string,
    input: {
      readonly state: "started" | "login-required" | "retryable-error" | "rejected";
      readonly errorCode?: string;
      readonly detail?: string;
    },
  ): Promise<{
    readonly attemptId: string;
    readonly state: EspnRefreshAttemptState;
    readonly recordedAt: string;
  }> {
    const now = this.#now();
    const result = await this.#repository.reportAgentAttempt(deviceToken, requestId, input, now);
    return { ...result, recordedAt: now.toISOString() };
  }

  #status(
    userId: string,
    target: RefreshTarget,
    evaluation: EspnRefreshEvaluation,
    now: Date,
  ): EspnLeagueRefreshStatus {
    const latestAttempt = target.latestAttempt;
    return {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      leagueSeasonId: target.leagueSeasonId,
      provider: "espn",
      current: evaluation.current,
      context: evaluation.context,
      artifacts: evaluation.relevantArtifacts.map((family) => ({
        family,
        state: freshnessState(
          target.artifactFreshness[family],
          evaluation.policy.staleAfterMs,
          now,
        ),
        observedAt: target.artifactFreshness[family] ?? null,
      })),
      direct: {
        enabled: this.#directEnabled,
        coreState: this.#directEnabled ? target.directCoreState : "disabled",
        preferredMode: target.preferredMode,
        lastProbeAt: target.lastProbeAt?.toISOString() ?? null,
        nextProbeAt: target.nextProbeAt?.toISOString() ?? null,
        lastSuccessAt: target.lastDirectSuccessAt?.toISOString() ?? null,
        circuitOpenUntil: target.circuitOpenUntil?.toISOString() ?? null,
      },
      agents: {
        activeCount: target.activeAgentCount,
        mostRecentSeenAt: target.mostRecentAgentSeenAt?.toISOString() ?? null,
      },
      request: target.request
        ? {
            id: target.request.id,
            state: target.request.state,
            fulfillmentMode: target.request.fulfillmentMode,
            requiredArtifacts: [...target.request.requiredArtifacts],
            minimumCaptureAt: target.request.minimumCaptureAt.toISOString(),
            requestedAt: target.request.createdAt.toISOString(),
            expiresAt: target.request.expiresAt.toISOString(),
            finishedAt: target.request.finishedAt?.toISOString() ?? null,
            latestAttempt: latestAttempt
              ? {
                  mode: latestAttempt.mode,
                  state: latestAttempt.state,
                  deviceName:
                    latestAttempt.deviceUserId === userId ? latestAttempt.deviceName : null,
                  errorCode: latestAttempt.errorCode,
                  startedAt: latestAttempt.startedAt.toISOString(),
                  finishedAt: latestAttempt.finishedAt?.toISOString() ?? null,
                }
              : null,
          }
        : null,
      display: displayStatus({
        target,
        evaluation,
        requestingUserId: userId,
        directEnabled: this.#directEnabled,
      }),
    };
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function modeForClient(clientKind: BridgeClientKind): EspnRefreshFulfillmentMode {
  return clientKind === "ios-app" ? "native-agent" : "chrome-agent";
}

function boundedErrorCode(value: string | undefined, fallback: string): string {
  const normalized = (value ?? fallback)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/gu, "_");
  return (normalized || fallback).slice(0, 64);
}

function sanitizedAttemptDetail(
  state: "started" | "login-required" | "retryable-error" | "rejected",
): string | null {
  if (state === "started") return null;
  if (state === "login-required")
    return "The sync agent could not read ESPN without a renewed local session.";
  if (state === "retryable-error")
    return "The sync agent reported a temporary provider or parser failure.";
  return "The sync agent rejected the requested league artifact.";
}

export class DrizzleEspnRefreshRepository implements EspnRefreshRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async inspectMemberTarget(
    userId: string,
    leagueSeasonId: string,
    now: Date,
  ): Promise<RefreshTarget | undefined> {
    await this.#expireRequests(leagueSeasonId, now);
    const [row] = await this.#database
      .select({
        leagueId: leagueSeasons.leagueId,
        leagueSeasonId: leagueSeasons.id,
        externalLeagueId: leagueSeasons.externalKey,
        season: leagueSeasons.season,
        seasonStatus: leagueSeasons.status,
        currentWeek: leagueSeasons.currentWeek,
        lastSyncedAt: leagueSeasons.lastSyncedAt,
        directCoreState: espnLeagueSyncStates.directCoreState,
        preferredMode: espnLeagueSyncStates.preferredMode,
        artifactFreshness: espnLeagueSyncStates.artifactFreshness,
        lastProbeAt: espnLeagueSyncStates.lastProbeAt,
        nextProbeAt: espnLeagueSyncStates.nextProbeAt,
        lastDirectSuccessAt: espnLeagueSyncStates.lastDirectSuccessAt,
        circuitOpenUntil: espnLeagueSyncStates.circuitOpenUntil,
      })
      .from(leagueSeasons)
      .innerJoin(
        leagueMemberships,
        and(
          eq(leagueMemberships.leagueId, leagueSeasons.leagueId),
          eq(leagueMemberships.userId, userId),
        ),
      )
      .leftJoin(espnLeagueSyncStates, eq(espnLeagueSyncStates.leagueSeasonId, leagueSeasons.id))
      .where(and(eq(leagueSeasons.id, leagueSeasonId), eq(leagueSeasons.provider, "espn")))
      .limit(1);
    if (!row) return undefined;

    let artifactFreshness: EspnArtifactFreshness = { ...(row.artifactFreshness ?? {}) };
    const coreFreshness = laterIso(artifactFreshness.core, row.lastSyncedAt);
    if (coreFreshness) artifactFreshness.core = coreFreshness;
    const supplements = await this.#database
      .select({
        kind: leagueSupplementalSnapshots.kind,
        availability: leagueSupplementalSnapshots.availability,
        effectiveAt: leagueSupplementalSnapshots.effectiveAt,
      })
      .from(leagueSupplementalSnapshots)
      .where(eq(leagueSupplementalSnapshots.leagueSeasonId, leagueSeasonId))
      .orderBy(desc(leagueSupplementalSnapshots.effectiveAt));
    for (const supplement of supplements) {
      artifactFreshness = advanceEspnArtifactFreshness({
        current: artifactFreshness,
        artifact: supplement.kind,
        ...(supplement.kind === "available-players" && supplement.availability
          ? { availability: supplement.availability }
          : {}),
        effectiveAt: supplement.effectiveAt,
      });
    }

    const [latestMatchupSnapshot] = await this.#database
      .select({ id: matchupSnapshots.id })
      .from(matchupSnapshots)
      .where(eq(matchupSnapshots.leagueSeasonId, leagueSeasonId))
      .orderBy(desc(matchupSnapshots.effectiveAt), desc(matchupSnapshots.createdAt))
      .limit(1);
    let hasActiveMatchup = false;
    if (latestMatchupSnapshot) {
      const [active] = await this.#database
        .select({ id: weeklyMatchups.id })
        .from(weeklyMatchups)
        .where(
          and(
            eq(weeklyMatchups.snapshotId, latestMatchupSnapshot.id),
            eq(weeklyMatchups.status, "in-progress"),
          ),
        )
        .limit(1);
      hasActiveMatchup = Boolean(active);
    }

    const deviceRows = await this.#database
      .select({ lastSeenAt: bridgeDevices.lastSeenAt })
      .from(bridgeDevices)
      .innerJoin(bridgeDeviceLeagues, eq(bridgeDeviceLeagues.bridgeDeviceId, bridgeDevices.id))
      .where(
        and(
          eq(bridgeDeviceLeagues.externalLeagueId, row.externalLeagueId),
          eq(bridgeDeviceLeagues.leagueId, row.leagueId),
          eq(bridgeDevices.agentCapable, true),
          or(isNull(bridgeDeviceLeagues.season), eq(bridgeDeviceLeagues.season, row.season)),
          isNull(bridgeDevices.revokedAt),
          or(isNull(bridgeDevices.expiresAt), gt(bridgeDevices.expiresAt, now)),
        ),
      )
      .orderBy(desc(bridgeDevices.lastSeenAt))
      .limit(64);
    const mostRecentAgentSeenAt =
      deviceRows.find((device) => device.lastSeenAt)?.lastSeenAt ?? null;
    const activeThreshold = now.getTime() - ACTIVE_AGENT_WINDOW_MS;
    const activeAgentCount = deviceRows.filter(
      (device) => device.lastSeenAt && device.lastSeenAt.getTime() >= activeThreshold,
    ).length;

    const [requestRow] = await this.#database
      .select({
        id: refreshRequests.id,
        state: refreshRequests.state,
        fulfillmentMode: refreshRequests.fulfillmentMode,
        requiredArtifacts: refreshRequests.requiredArtifacts,
        minimumCaptureAt: refreshRequests.minimumCaptureAt,
        expiresAt: refreshRequests.expiresAt,
        startedAt: refreshRequests.startedAt,
        finishedAt: refreshRequests.finishedAt,
        createdAt: refreshRequests.createdAt,
      })
      .from(refreshRequests)
      .where(
        and(
          eq(refreshRequests.kind, "league"),
          eq(refreshRequests.leagueSeasonId, leagueSeasonId),
          gt(refreshRequests.expiresAt, now),
        ),
      )
      .orderBy(desc(refreshRequests.createdAt))
      .limit(1);
    const request = storedRefreshRequest(requestRow);

    let latestAttempt: StoredAttempt | null = null;
    if (request) {
      const [attempt] = await this.#database
        .select({
          mode: espnRefreshAttempts.mode,
          state: espnRefreshAttempts.state,
          deviceName: bridgeDevices.name,
          deviceUserId: bridgeDevices.userId,
          clientKind: bridgeDevices.clientKind,
          errorCode: espnRefreshAttempts.errorCode,
          startedAt: espnRefreshAttempts.startedAt,
          finishedAt: espnRefreshAttempts.finishedAt,
        })
        .from(espnRefreshAttempts)
        .leftJoin(bridgeDevices, eq(bridgeDevices.id, espnRefreshAttempts.bridgeDeviceId))
        .where(eq(espnRefreshAttempts.refreshRequestId, request.id))
        .orderBy(desc(espnRefreshAttempts.startedAt), desc(espnRefreshAttempts.id))
        .limit(1);
      latestAttempt = attempt ?? null;
    }

    return {
      leagueId: row.leagueId,
      leagueSeasonId: row.leagueSeasonId,
      externalLeagueId: row.externalLeagueId,
      season: row.season,
      seasonStatus: row.seasonStatus,
      currentWeek: row.currentWeek,
      artifactFreshness,
      hasActiveMatchup,
      directCoreState: row.directCoreState ?? "unknown",
      preferredMode: row.preferredMode ?? "automatic",
      lastProbeAt: row.lastProbeAt,
      nextProbeAt: row.nextProbeAt,
      lastDirectSuccessAt: row.lastDirectSuccessAt,
      circuitOpenUntil: row.circuitOpenUntil,
      activeAgentCount,
      mostRecentAgentSeenAt,
      request,
      latestAttempt,
    };
  }

  async createOrGetRequest(input: {
    readonly userId: string;
    readonly leagueSeasonId: string;
    readonly idempotencyKey: string;
    readonly minimumCaptureAt: Date;
    readonly expiresAt: Date;
    readonly requiredArtifacts: readonly EspnArtifactFamily[];
    readonly fulfillmentMode: EspnRefreshFulfillmentMode | null;
    readonly now: Date;
  }): Promise<StoredRefreshRequest> {
    return this.#database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`espn-refresh:${input.leagueSeasonId}`}, 0))`,
      );
      // The partial unique index intentionally permits only one live request per league, regardless
      // of its expiry timestamp. Retire an expired row while holding the same league lock before
      // inserting its replacement; otherwise a request that expires between five-minute sweeps can
      // turn a perfectly valid stale-on-view refresh into a unique-constraint failure.
      await transaction
        .update(refreshRequests)
        .set({
          state: "cancelled",
          startedAt: sql`coalesce(${refreshRequests.startedAt}, ${refreshRequests.createdAt})`,
          finishedAt: input.now,
          errorCode: "EXPIRED",
          errorDetail: "No authorized sync path fulfilled this request before it expired.",
        })
        .where(
          and(
            eq(refreshRequests.kind, "league"),
            eq(refreshRequests.leagueSeasonId, input.leagueSeasonId),
            inArray(refreshRequests.state, ["queued", "processing"] satisfies LiveRequestState[]),
            lte(refreshRequests.expiresAt, input.now),
          ),
        );
      const [existing] = await transaction
        .select({
          id: refreshRequests.id,
          state: refreshRequests.state,
          fulfillmentMode: refreshRequests.fulfillmentMode,
          requiredArtifacts: refreshRequests.requiredArtifacts,
          minimumCaptureAt: refreshRequests.minimumCaptureAt,
          expiresAt: refreshRequests.expiresAt,
          startedAt: refreshRequests.startedAt,
          finishedAt: refreshRequests.finishedAt,
          createdAt: refreshRequests.createdAt,
        })
        .from(refreshRequests)
        .where(
          and(
            eq(refreshRequests.kind, "league"),
            eq(refreshRequests.leagueSeasonId, input.leagueSeasonId),
            inArray(refreshRequests.state, ["queued", "processing"] satisfies LiveRequestState[]),
            gt(refreshRequests.expiresAt, input.now),
          ),
        )
        .limit(1);
      const storedExisting = storedRefreshRequest(existing);
      if (storedExisting) return storedExisting;

      const [created] = await transaction
        .insert(refreshRequests)
        .values({
          requestedByUserId: input.userId,
          leagueSeasonId: input.leagueSeasonId,
          kind: "league",
          state: "queued",
          idempotencyKey: input.idempotencyKey,
          force: false,
          notBefore: input.now,
          expiresAt: input.expiresAt,
          minimumCaptureAt: input.minimumCaptureAt,
          requiredArtifacts: [...new Set(input.requiredArtifacts)],
          fulfillmentMode: input.fulfillmentMode,
          createdAt: input.now,
        })
        .returning({
          id: refreshRequests.id,
          state: refreshRequests.state,
          fulfillmentMode: refreshRequests.fulfillmentMode,
          requiredArtifacts: refreshRequests.requiredArtifacts,
          minimumCaptureAt: refreshRequests.minimumCaptureAt,
          expiresAt: refreshRequests.expiresAt,
          startedAt: refreshRequests.startedAt,
          finishedAt: refreshRequests.finishedAt,
          createdAt: refreshRequests.createdAt,
        });
      const storedCreated = storedRefreshRequest(created);
      if (!storedCreated) throw new Error("ESPN refresh request could not be created");
      return storedCreated;
    });
  }

  async pollAgent(deviceToken: string, now: Date): Promise<EspnRefreshAgentPollResponse> {
    return this.#database.transaction(async (transaction) => {
      const [device] = await transaction
        .select({ id: bridgeDevices.id, clientKind: bridgeDevices.clientKind })
        .from(bridgeDevices)
        .where(
          and(
            eq(bridgeDevices.tokenHash, tokenHash(deviceToken)),
            eq(bridgeDevices.provider, "espn"),
            eq(bridgeDevices.agentCapable, true),
            isNull(bridgeDevices.revokedAt),
            or(isNull(bridgeDevices.expiresAt), gt(bridgeDevices.expiresAt, now)),
          ),
        )
        .limit(1);
      if (!device) throw new EspnRefreshError("UNAUTHORIZED", "ESPN sync device is not active");
      await transaction
        .update(bridgeDevices)
        .set({ lastSeenAt: now })
        .where(eq(bridgeDevices.id, device.id));

      const recentLoginBackoff = new Date(now.getTime() - LOGIN_REQUIRED_BACKOFF_MS);
      const recentRetryableBackoff = new Date(now.getTime() - RETRYABLE_AGENT_BACKOFF_MS);
      const recentRejectedBackoff = new Date(now.getTime() - REJECTED_AGENT_BACKOFF_MS);
      const rows = await transaction
        .select({
          requestId: refreshRequests.id,
          externalLeagueId: leagueSeasons.externalKey,
          season: leagueSeasons.season,
          minimumCaptureAt: refreshRequests.minimumCaptureAt,
          expiresAt: refreshRequests.expiresAt,
          requiredArtifacts: refreshRequests.requiredArtifacts,
        })
        .from(refreshRequests)
        .innerJoin(leagueSeasons, eq(leagueSeasons.id, refreshRequests.leagueSeasonId))
        .innerJoin(
          bridgeDeviceLeagues,
          and(
            eq(bridgeDeviceLeagues.bridgeDeviceId, device.id),
            eq(bridgeDeviceLeagues.leagueId, leagueSeasons.leagueId),
            eq(bridgeDeviceLeagues.externalLeagueId, leagueSeasons.externalKey),
            or(
              isNull(bridgeDeviceLeagues.season),
              eq(bridgeDeviceLeagues.season, leagueSeasons.season),
            ),
          ),
        )
        .where(
          and(
            eq(refreshRequests.kind, "league"),
            inArray(refreshRequests.state, ["queued", "processing"] satisfies LiveRequestState[]),
            gt(refreshRequests.expiresAt, now),
            eq(leagueSeasons.provider, "espn"),
            notExists(
              transaction
                .select({ id: espnRefreshAttempts.id })
                .from(espnRefreshAttempts)
                .where(
                  and(
                    eq(espnRefreshAttempts.refreshRequestId, refreshRequests.id),
                    eq(espnRefreshAttempts.bridgeDeviceId, device.id),
                    or(
                      and(
                        eq(espnRefreshAttempts.state, "login-required"),
                        gte(espnRefreshAttempts.finishedAt, recentLoginBackoff),
                      ),
                      and(
                        eq(espnRefreshAttempts.state, "retryable-error"),
                        gte(espnRefreshAttempts.finishedAt, recentRetryableBackoff),
                      ),
                      and(
                        eq(espnRefreshAttempts.state, "rejected"),
                        gte(espnRefreshAttempts.finishedAt, recentRejectedBackoff),
                      ),
                    ),
                  ),
                ),
            ),
          ),
        )
        .orderBy(desc(refreshRequests.priority), refreshRequests.createdAt)
        .limit(MAX_AGENT_REQUESTS);

      const mode = modeForClient(device.clientKind);
      const requests: EspnRefreshAgentPollResponse["requests"] = [];
      for (const row of rows) {
        if (!row.minimumCaptureAt || !row.expiresAt || !row.requiredArtifacts) continue;
        const [recentOffer] = await transaction
          .select({ id: espnRefreshAttempts.id })
          .from(espnRefreshAttempts)
          .where(
            and(
              eq(espnRefreshAttempts.refreshRequestId, row.requestId),
              eq(espnRefreshAttempts.bridgeDeviceId, device.id),
              inArray(espnRefreshAttempts.state, ["offered", "started"]),
            ),
          )
          .limit(1);
        if (!recentOffer) {
          await transaction.insert(espnRefreshAttempts).values({
            refreshRequestId: row.requestId,
            mode,
            bridgeDeviceId: device.id,
            state: "offered",
            startedAt: now,
          });
        }
        requests.push({
          requestId: row.requestId,
          externalLeagueId: row.externalLeagueId,
          season: row.season,
          minimumCaptureAt: row.minimumCaptureAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
          requiredArtifacts: [...row.requiredArtifacts],
        });
      }
      return {
        schemaVersion: 1,
        generatedAt: now.toISOString(),
        pollAfterSeconds: 300,
        requests,
      };
    });
  }

  async reportAgentAttempt(
    deviceToken: string,
    requestId: string,
    input: {
      readonly state: "started" | "login-required" | "retryable-error" | "rejected";
      readonly errorCode?: string;
      readonly detail?: string;
    },
    now: Date,
  ): Promise<{ readonly attemptId: string; readonly state: EspnRefreshAttemptState }> {
    return this.#database.transaction(async (transaction) => {
      const [scope] = await transaction
        .select({
          deviceId: bridgeDevices.id,
          clientKind: bridgeDevices.clientKind,
          requestState: refreshRequests.state,
        })
        .from(bridgeDevices)
        .innerJoin(bridgeDeviceLeagues, eq(bridgeDeviceLeagues.bridgeDeviceId, bridgeDevices.id))
        .innerJoin(
          leagueSeasons,
          and(
            eq(leagueSeasons.leagueId, bridgeDeviceLeagues.leagueId),
            eq(leagueSeasons.externalKey, bridgeDeviceLeagues.externalLeagueId),
            or(
              isNull(bridgeDeviceLeagues.season),
              eq(bridgeDeviceLeagues.season, leagueSeasons.season),
            ),
          ),
        )
        .innerJoin(refreshRequests, eq(refreshRequests.leagueSeasonId, leagueSeasons.id))
        .where(
          and(
            eq(bridgeDevices.tokenHash, tokenHash(deviceToken)),
            eq(bridgeDevices.provider, "espn"),
            eq(bridgeDevices.agentCapable, true),
            isNull(bridgeDevices.revokedAt),
            or(isNull(bridgeDevices.expiresAt), gt(bridgeDevices.expiresAt, now)),
            eq(refreshRequests.id, requestId),
            eq(refreshRequests.kind, "league"),
            inArray(refreshRequests.state, ["queued", "processing"] satisfies LiveRequestState[]),
            gt(refreshRequests.expiresAt, now),
          ),
        )
        .limit(1);
      if (!scope)
        throw new EspnRefreshError("OUT_OF_SCOPE", "Refresh request is outside this device scope");

      const terminal = input.state !== "started";
      const mode = modeForClient(scope.clientKind);
      const [transitioned] = await transaction
        .update(espnRefreshAttempts)
        .set({
          mode,
          state: input.state,
          errorCode: terminal ? boundedErrorCode(input.errorCode, "AGENT_ERROR") : null,
          errorDetail: terminal ? sanitizedAttemptDetail(input.state) : null,
          finishedAt: terminal ? now : null,
        })
        .where(
          and(
            eq(espnRefreshAttempts.refreshRequestId, requestId),
            eq(espnRefreshAttempts.bridgeDeviceId, scope.deviceId),
            inArray(espnRefreshAttempts.state, ["offered", "started"]),
          ),
        )
        .returning({ id: espnRefreshAttempts.id, state: espnRefreshAttempts.state });
      const [attempt] = transitioned
        ? [transitioned]
        : await transaction
            .insert(espnRefreshAttempts)
            .values({
              refreshRequestId: requestId,
              mode,
              bridgeDeviceId: scope.deviceId,
              state: input.state,
              errorCode: terminal ? boundedErrorCode(input.errorCode, "AGENT_ERROR") : null,
              errorDetail: terminal ? sanitizedAttemptDetail(input.state) : null,
              startedAt: now,
              finishedAt: terminal ? now : null,
            })
            .returning({ id: espnRefreshAttempts.id, state: espnRefreshAttempts.state });
      if (!attempt) throw new Error("ESPN refresh attempt could not be recorded");
      await transaction
        .update(bridgeDevices)
        .set({ lastSeenAt: now })
        .where(eq(bridgeDevices.id, scope.deviceId));
      if (input.state === "started") {
        await transaction
          .update(refreshRequests)
          .set({ startedAt: now })
          .where(and(eq(refreshRequests.id, requestId), isNull(refreshRequests.startedAt)));
        await transaction
          .update(refreshRequests)
          .set({
            state: "processing",
            fulfillmentMode: modeForClient(scope.clientKind),
          })
          .where(eq(refreshRequests.id, requestId));
      }
      return { attemptId: attempt.id, state: attempt.state };
    });
  }

  async #expireRequests(leagueSeasonId: string, now: Date): Promise<void> {
    await this.#database
      .update(refreshRequests)
      .set({
        state: "cancelled",
        startedAt: sql`coalesce(${refreshRequests.startedAt}, ${refreshRequests.createdAt})`,
        finishedAt: now,
        errorCode: "EXPIRED",
        errorDetail: "No authorized sync path fulfilled this request before it expired.",
      })
      .where(
        and(
          eq(refreshRequests.kind, "league"),
          eq(refreshRequests.leagueSeasonId, leagueSeasonId),
          inArray(refreshRequests.state, ["queued", "processing"] satisfies LiveRequestState[]),
          lte(refreshRequests.expiresAt, now),
        ),
      );
  }
}
