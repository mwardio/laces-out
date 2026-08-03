import {
  EspnPublicReadClient,
  EspnPublicReadError,
  canonicalEspnPayloadChecksumV1,
  normalizeEspnWebClientSnapshot,
  type EspnPublicLeagueArtifact,
  type EspnPublicLeagueRequest,
} from "@fantasy/connector-espn";
import {
  espnLeagueSyncStates,
  espnRefreshAttempts,
  leagueSeasons,
  refreshRequests,
  type Database,
  type EspnDirectCapabilityState,
  type EspnPreferredSyncMode,
} from "@fantasy/db";
import {
  DrizzleEspnSyncPersistence,
  nextEspnDirectCircuitOpenUntil,
  type EspnDirectSyncInput,
  type EspnDirectSyncOutcome,
  type EspnDirectSyncPort,
  type PersistEspnSyncReceipt,
} from "@fantasy/league-sync";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

const ACTIVE_PROBE_INTERVAL_MS = 30 * 60 * 1000;
const OFFSEASON_PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UNVERIFIED_PROBE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_PROBE_INTERVAL_MS = 15 * 60 * 1000;

export interface EspnDirectTarget {
  readonly leagueSeasonId: string;
  readonly leagueId: string;
  readonly externalLeagueId: string;
  readonly season: number;
  readonly seasonStatus: string;
  readonly directCoreState: EspnDirectCapabilityState;
  readonly preferredMode: EspnPreferredSyncMode;
  readonly circuitOpenUntil: Date | null;
  readonly consecutiveFailures: number;
}

export interface EspnDirectStateRepository {
  findTarget(leagueSeasonId: string): Promise<EspnDirectTarget | undefined>;
  recordAttempt(input: {
    readonly refreshRequestId: string | undefined;
    readonly leagueSeasonId: string;
    readonly state:
      "started" | "accepted" | "unchanged" | "not-public" | "retryable-error" | "rejected";
    readonly errorCode?: string;
    readonly errorDetail?: string;
    readonly now: Date;
  }): Promise<void>;
  recordEvidenceRequired(input: {
    readonly leagueSeasonId: string;
    readonly now: Date;
  }): Promise<void>;
  recordSuccess(input: {
    readonly leagueSeasonId: string;
    readonly seasonStatus: string;
    readonly now: Date;
  }): Promise<void>;
  recordNotPublic(input: { readonly leagueSeasonId: string; readonly now: Date }): Promise<void>;
  recordFailure(input: {
    readonly target: EspnDirectTarget;
    readonly errorCode: string;
    readonly errorDetail: string;
    readonly rateLimited: boolean;
    readonly now: Date;
  }): Promise<void>;
}

export interface EspnPublicReadPort {
  fetchLeague(request: EspnPublicLeagueRequest): Promise<EspnPublicLeagueArtifact>;
}

export interface EspnDirectPersistencePort {
  persist(input: {
    readonly authority: { readonly mode: "server-direct"; readonly leagueSeasonId: string };
    readonly bundle: ReturnType<typeof normalizeEspnWebClientSnapshot>;
    readonly checksumSha256: string;
    readonly checksumAliases?: readonly string[];
    readonly effectiveAt: Date;
    readonly idempotencyKey: string;
    readonly kind: "espn-direct";
    readonly now: Date;
  }): Promise<PersistEspnSyncReceipt>;
}

export interface EspnDirectSyncServiceOptions {
  readonly enabled: boolean;
  readonly repository: EspnDirectStateRepository;
  readonly persistence: EspnDirectPersistencePort;
  readonly client?: EspnPublicReadPort;
  readonly now?: () => Date;
  readonly afterCommit?: (input: {
    readonly receipt: PersistEspnSyncReceipt;
    readonly season: number;
    readonly checksumSha256: string;
    readonly occurredAt: Date;
  }) => Promise<void>;
}

function fixedFailureDetail(error: unknown): string {
  if (error instanceof EspnPublicReadError) {
    if (error.code === "RESPONSE_TOO_LARGE")
      return "ESPN public response exceeded the admission limit.";
    if (error.code === "INVALID_RESPONSE") return "ESPN public response failed JSON admission.";
    return "ESPN public read failed before admission.";
  }
  return "ESPN public artifact failed normalized contract admission.";
}

function errorCode(error: unknown): string {
  if (error instanceof EspnPublicReadError) return error.code;
  if (error !== null && typeof error === "object" && "code" in error) {
    const code: unknown = error.code;
    if (typeof code === "string" && code.length > 0) {
      return code
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_-]+/gu, "_")
        .slice(0, 64);
    }
  }
  return "SCHEMA_REJECTED";
}

export class EspnDirectSyncService implements EspnDirectSyncPort {
  readonly #enabled: boolean;
  readonly #repository: EspnDirectStateRepository;
  readonly #persistence: EspnDirectPersistencePort;
  readonly #client: EspnPublicReadPort;
  readonly #now: () => Date;
  readonly #afterCommit: EspnDirectSyncServiceOptions["afterCommit"];

  constructor(options: EspnDirectSyncServiceOptions) {
    this.#enabled = options.enabled;
    this.#repository = options.repository;
    this.#persistence = options.persistence;
    this.#client = options.client ?? new EspnPublicReadClient();
    this.#now = options.now ?? (() => new Date());
    this.#afterCommit = options.afterCommit;
  }

  async syncLeague(
    input: EspnDirectSyncInput,
    signal: AbortSignal,
  ): Promise<EspnDirectSyncOutcome> {
    if (!this.#enabled) return { state: "disabled" };
    const target = await this.#repository.findTarget(input.leagueSeasonId);
    if (!target) return { state: "target-missing" };
    if (target.directCoreState === "disabled" || target.preferredMode === "assisted") {
      return { state: "assisted-required" };
    }
    const startedAt = this.#now();
    if (target.circuitOpenUntil && target.circuitOpenUntil > startedAt) {
      return {
        state: "circuit-open",
        retryAfterSeconds: Math.ceil(
          (target.circuitOpenUntil.getTime() - startedAt.getTime()) / 1000,
        ),
      };
    }
    if (
      !input.probe &&
      target.directCoreState !== "available" &&
      target.directCoreState !== "degraded"
    ) {
      return { state: "evidence-required" };
    }

    await this.#repository.recordAttempt({
      refreshRequestId: input.refreshRequestId,
      leagueSeasonId: target.leagueSeasonId,
      state: "started",
      now: startedAt,
    });

    let artifact: EspnPublicLeagueArtifact;
    let bundle: ReturnType<typeof normalizeEspnWebClientSnapshot>;
    let canonicalChecksumSha256: string;
    try {
      artifact = await this.#client.fetchLeague({
        leagueId: target.externalLeagueId,
        season: target.season,
        views: ["mSettings", "mTeam", "mRoster", "mStandings", "mMatchup"],
        signal,
      });
      canonicalChecksumSha256 = canonicalEspnPayloadChecksumV1(artifact.payload);
      bundle = normalizeEspnWebClientSnapshot(artifact.payload, {
        capturedAt: artifact.fetchedAt,
        endpoint: artifact.endpoint,
        checksumSha256: canonicalChecksumSha256,
      });
      if (
        bundle.league.providerLeagueId !== target.externalLeagueId ||
        bundle.league.season !== target.season
      ) {
        throw Object.assign(new Error("ESPN direct artifact identity mismatch"), {
          code: "IDENTITY_MISMATCH",
        });
      }
    } catch (error) {
      const failedAt = this.#now();
      if (error instanceof EspnPublicReadError && error.code === "NOT_PUBLIC") {
        await this.#repository.recordNotPublic({
          leagueSeasonId: target.leagueSeasonId,
          now: failedAt,
        });
        await this.#repository.recordAttempt({
          refreshRequestId: input.refreshRequestId,
          leagueSeasonId: target.leagueSeasonId,
          state: "not-public",
          errorCode: "NOT_PUBLIC",
          errorDetail: "ESPN did not permit an anonymous read for this league.",
          now: failedAt,
        });
        return { state: "not-public" };
      }
      const code = errorCode(error);
      const detail = fixedFailureDetail(error);
      await this.#repository.recordFailure({
        target,
        errorCode: code,
        errorDetail: detail,
        rateLimited: error instanceof EspnPublicReadError && error.status === 429,
        now: failedAt,
      });
      await this.#repository.recordAttempt({
        refreshRequestId: input.refreshRequestId,
        leagueSeasonId: target.leagueSeasonId,
        state:
          error instanceof EspnPublicReadError && error.retryable ? "retryable-error" : "rejected",
        errorCode: code,
        errorDetail: detail,
        now: failedAt,
      });
      throw error;
    }

    // A successful anonymous response proves only that this probe worked. Unknown/not-public
    // capability still needs operator-reviewed evidence before canonical production reads begin.
    if (target.directCoreState === "unknown" || target.directCoreState === "not-public") {
      const completedAt = this.#now();
      await this.#repository.recordEvidenceRequired({
        leagueSeasonId: target.leagueSeasonId,
        now: completedAt,
      });
      await this.#repository.recordAttempt({
        refreshRequestId: input.refreshRequestId,
        leagueSeasonId: target.leagueSeasonId,
        state: "rejected",
        errorCode: "EVIDENCE_REQUIRED",
        errorDetail:
          "Anonymous core data passed admission but direct capability is not operator-verified.",
        now: completedAt,
      });
      return { state: "evidence-required" };
    }

    const effectiveAt = new Date(artifact.fetchedAt);
    const completedAt = this.#now();
    const receipt = await this.#persistence.persist({
      authority: { mode: "server-direct", leagueSeasonId: target.leagueSeasonId },
      bundle,
      checksumSha256: canonicalChecksumSha256,
      ...(artifact.checksumSha256 === canonicalChecksumSha256
        ? {}
        : { checksumAliases: [artifact.checksumSha256] }),
      effectiveAt,
      idempotencyKey: `espn-direct:${target.leagueSeasonId}:${canonicalChecksumSha256}:${artifact.fetchedAt}`,
      kind: "espn-direct",
      now: completedAt,
    });
    await this.#repository.recordSuccess({
      leagueSeasonId: target.leagueSeasonId,
      seasonStatus: target.seasonStatus,
      now: completedAt,
    });
    await this.#afterCommit?.({
      receipt,
      season: target.season,
      checksumSha256: canonicalChecksumSha256,
      occurredAt: completedAt,
    });
    return {
      state: receipt.state,
      leagueSeasonId: receipt.leagueSeasonId,
      leagueId: receipt.leagueId,
      syncRunId: receipt.receiptId,
      season: target.season,
      checksumSha256: canonicalChecksumSha256,
      recordsWritten: receipt.recordsWritten,
    };
  }
}

export class DrizzleEspnDirectStateRepository implements EspnDirectStateRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async findTarget(leagueSeasonId: string): Promise<EspnDirectTarget | undefined> {
    const [row] = await this.#database
      .select({
        leagueSeasonId: leagueSeasons.id,
        leagueId: leagueSeasons.leagueId,
        externalLeagueId: leagueSeasons.externalKey,
        season: leagueSeasons.season,
        seasonStatus: leagueSeasons.status,
        directCoreState: espnLeagueSyncStates.directCoreState,
        preferredMode: espnLeagueSyncStates.preferredMode,
        circuitOpenUntil: espnLeagueSyncStates.circuitOpenUntil,
        consecutiveFailures: espnLeagueSyncStates.consecutiveFailures,
      })
      .from(leagueSeasons)
      .leftJoin(espnLeagueSyncStates, eq(espnLeagueSyncStates.leagueSeasonId, leagueSeasons.id))
      .where(and(eq(leagueSeasons.id, leagueSeasonId), eq(leagueSeasons.provider, "espn")))
      .limit(1);
    if (!row) return undefined;
    return {
      ...row,
      directCoreState: row.directCoreState ?? "unknown",
      preferredMode: row.preferredMode ?? "automatic",
      circuitOpenUntil: row.circuitOpenUntil,
      consecutiveFailures: row.consecutiveFailures ?? 0,
    };
  }

  async recordAttempt(input: {
    readonly refreshRequestId: string | undefined;
    readonly leagueSeasonId: string;
    readonly state:
      "started" | "accepted" | "unchanged" | "not-public" | "retryable-error" | "rejected";
    readonly errorCode?: string;
    readonly errorDetail?: string;
    readonly now: Date;
  }): Promise<void> {
    if (!input.refreshRequestId || input.state === "accepted" || input.state === "unchanged")
      return;
    const [request] = await this.#database
      .select({ id: refreshRequests.id })
      .from(refreshRequests)
      .where(
        and(
          eq(refreshRequests.id, input.refreshRequestId),
          eq(refreshRequests.leagueSeasonId, input.leagueSeasonId),
          eq(refreshRequests.kind, "league"),
          inArray(refreshRequests.state, ["queued", "processing"]),
        ),
      )
      .limit(1);
    if (!request) return;
    if (input.state === "started") {
      await this.#database.insert(espnRefreshAttempts).values({
        refreshRequestId: request.id,
        mode: "server-direct",
        state: input.state,
        startedAt: input.now,
      });
    } else {
      const completedAttempts = await this.#database
        .update(espnRefreshAttempts)
        .set({
          state: input.state,
          errorCode: input.errorCode?.slice(0, 64) ?? null,
          errorDetail: input.errorDetail?.slice(0, 500) ?? null,
          finishedAt: input.now,
        })
        .where(
          and(
            eq(espnRefreshAttempts.refreshRequestId, request.id),
            eq(espnRefreshAttempts.mode, "server-direct"),
            isNull(espnRefreshAttempts.bridgeDeviceId),
            inArray(espnRefreshAttempts.state, ["offered", "started"]),
          ),
        )
        .returning({ id: espnRefreshAttempts.id });
      if (completedAttempts.length === 0) {
        await this.#database.insert(espnRefreshAttempts).values({
          refreshRequestId: request.id,
          mode: "server-direct",
          state: input.state,
          errorCode: input.errorCode?.slice(0, 64) ?? null,
          errorDetail: input.errorDetail?.slice(0, 500) ?? null,
          startedAt: input.now,
          finishedAt: input.now,
        });
      }
    }
    if (input.state === "started") {
      await this.#database
        .update(refreshRequests)
        .set({
          state: "processing",
          fulfillmentMode: "server-direct",
          startedAt: sql`coalesce(${refreshRequests.startedAt}, ${input.now})`,
        })
        .where(eq(refreshRequests.id, request.id));
    }
  }

  async recordEvidenceRequired(input: {
    readonly leagueSeasonId: string;
    readonly now: Date;
  }): Promise<void> {
    await this.#upsertState(input.leagueSeasonId, {
      directCoreState: "unknown",
      lastProbeAt: input.now,
      nextProbeAt: new Date(input.now.getTime() + UNVERIFIED_PROBE_INTERVAL_MS),
      lastErrorCode: "EVIDENCE_REQUIRED",
      lastErrorAt: input.now,
      lastErrorDetail:
        "Anonymous core admission succeeded; operator evidence approval is still required.",
      consecutiveFailures: 0,
      circuitOpenUntil: null,
      updatedAt: input.now,
    });
  }

  async recordSuccess(input: {
    readonly leagueSeasonId: string;
    readonly seasonStatus: string;
    readonly now: Date;
  }): Promise<void> {
    const interval =
      input.seasonStatus === "active" ? ACTIVE_PROBE_INTERVAL_MS : OFFSEASON_PROBE_INTERVAL_MS;
    await this.#upsertState(input.leagueSeasonId, {
      directCoreState: "available",
      lastProbeAt: input.now,
      nextProbeAt: new Date(input.now.getTime() + interval),
      lastDirectSuccessAt: input.now,
      lastErrorCode: null,
      lastErrorAt: null,
      lastErrorDetail: null,
      consecutiveFailures: 0,
      circuitOpenUntil: null,
      updatedAt: input.now,
    });
  }

  async recordNotPublic(input: {
    readonly leagueSeasonId: string;
    readonly now: Date;
  }): Promise<void> {
    await this.#upsertState(input.leagueSeasonId, {
      directCoreState: "not-public",
      lastProbeAt: input.now,
      nextProbeAt: new Date(input.now.getTime() + UNVERIFIED_PROBE_INTERVAL_MS),
      lastErrorCode: "NOT_PUBLIC",
      lastErrorAt: input.now,
      lastErrorDetail: "ESPN did not permit an anonymous read for this league.",
      consecutiveFailures: 0,
      circuitOpenUntil: null,
      updatedAt: input.now,
    });
  }

  async recordFailure(input: {
    readonly target: EspnDirectTarget;
    readonly errorCode: string;
    readonly errorDetail: string;
    readonly rateLimited: boolean;
    readonly now: Date;
  }): Promise<void> {
    const consecutiveFailures = input.target.consecutiveFailures + 1;
    const circuitOpenUntil = nextEspnDirectCircuitOpenUntil({
      consecutiveFailures,
      now: input.now,
      rateLimited: input.rateLimited,
    });
    await this.#upsertState(input.target.leagueSeasonId, {
      directCoreState:
        input.target.directCoreState === "available" || input.target.directCoreState === "degraded"
          ? "degraded"
          : input.target.directCoreState,
      lastProbeAt: input.now,
      nextProbeAt: circuitOpenUntil ?? new Date(input.now.getTime() + RETRY_PROBE_INTERVAL_MS),
      lastErrorCode: input.errorCode.slice(0, 64),
      lastErrorAt: input.now,
      lastErrorDetail: input.errorDetail.slice(0, 500),
      consecutiveFailures,
      circuitOpenUntil,
      updatedAt: input.now,
    });
  }

  async #upsertState(
    leagueSeasonId: string,
    values: Omit<typeof espnLeagueSyncStates.$inferInsert, "leagueSeasonId">,
  ): Promise<void> {
    await this.#database
      .insert(espnLeagueSyncStates)
      .values({ leagueSeasonId, ...values })
      .onConflictDoUpdate({
        target: espnLeagueSyncStates.leagueSeasonId,
        set: values,
      });
  }
}

export function createEspnDirectSyncService(input: {
  readonly database: Database;
  readonly enabled: boolean;
  readonly afterCommit?: EspnDirectSyncServiceOptions["afterCommit"];
}): EspnDirectSyncService {
  return new EspnDirectSyncService({
    enabled: input.enabled,
    repository: new DrizzleEspnDirectStateRepository(input.database),
    persistence: new DrizzleEspnSyncPersistence(input.database),
    ...(input.afterCommit ? { afterCommit: input.afterCommit } : {}),
  });
}
