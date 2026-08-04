export const maintenancePollIntervalMinutes = 5;
export const baselineSyncIntervalMs = 6 * 60 * 60 * 1000;
export const loginRequiredBackoffMs = 30 * 60 * 1000;
export const retryableLeagueBackoffMs = 15 * 60 * 1000;

export const espnArtifactFamilies = [
  "core",
  "available-players",
  "weekly-box-scores",
  "transactions",
  "completed-draft",
] as const;
export type EspnArtifactFamily = (typeof espnArtifactFamilies)[number];

export interface AgentRefreshRequest {
  readonly requestId: string;
  readonly externalLeagueId: string;
  readonly season: number;
  readonly minimumCaptureAt: string;
  readonly expiresAt: string;
  readonly requiredArtifacts: readonly EspnArtifactFamily[];
}

export interface AgentPollResponse {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly pollAfterSeconds: number;
  readonly requests: readonly AgentRefreshRequest[];
}

export interface MaintenanceState {
  readonly schemaVersion: 1;
  readonly lastPollAt: string | null;
  readonly lastBaselineAt: string | null;
  readonly consecutivePollFailures: number;
  readonly pollBackoffUntil: string | null;
  readonly leagueBackoffUntil: Readonly<Record<string, string>>;
  readonly leagueResults: Readonly<Record<string, { readonly state: string; readonly at: string }>>;
}

export const defaultMaintenanceState: MaintenanceState = {
  schemaVersion: 1,
  lastPollAt: null,
  lastBaselineAt: null,
  consecutivePollFailures: 0,
  pollBackoffUntil: null,
  leagueBackoffUntil: {},
  leagueResults: {},
};

export type MaintenancePlan =
  | { readonly kind: "requested"; readonly requests: readonly AgentRefreshRequest[] }
  | { readonly kind: "baseline"; readonly leagueIds: readonly string[] }
  | { readonly kind: "none" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

export function validateAgentPollResponse(value: unknown): AgentPollResponse {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.requests)) {
    throw new TypeError("Laces Out refresh poll response is invalid");
  }
  if (
    !validIso(value.generatedAt) ||
    typeof value.pollAfterSeconds !== "number" ||
    !Number.isInteger(value.pollAfterSeconds) ||
    value.pollAfterSeconds < 60 ||
    value.pollAfterSeconds > 3600 ||
    value.requests.length > 8
  ) {
    throw new TypeError("Laces Out refresh poll metadata is invalid");
  }
  const requests = value.requests.map((candidate): AgentRefreshRequest => {
    if (!isRecord(candidate) || !Array.isArray(candidate.requiredArtifacts)) {
      throw new TypeError("Laces Out refresh request is invalid");
    }
    const requiredArtifacts = candidate.requiredArtifacts;
    if (
      !validUuid(candidate.requestId) ||
      typeof candidate.externalLeagueId !== "string" ||
      !/^\d{1,20}$/u.test(candidate.externalLeagueId) ||
      typeof candidate.season !== "number" ||
      !Number.isInteger(candidate.season) ||
      candidate.season < 2000 ||
      candidate.season > 2100 ||
      !validIso(candidate.minimumCaptureAt) ||
      !validIso(candidate.expiresAt) ||
      requiredArtifacts.length < 1 ||
      requiredArtifacts.length > espnArtifactFamilies.length ||
      requiredArtifacts.some(
        (artifact) =>
          typeof artifact !== "string" ||
          !(espnArtifactFamilies as readonly string[]).includes(artifact),
      ) ||
      new Set(requiredArtifacts).size !== requiredArtifacts.length
    ) {
      throw new TypeError("Laces Out refresh request fields are invalid");
    }
    return {
      requestId: candidate.requestId,
      externalLeagueId: candidate.externalLeagueId,
      season: candidate.season,
      minimumCaptureAt: candidate.minimumCaptureAt,
      expiresAt: candidate.expiresAt,
      requiredArtifacts: requiredArtifacts as EspnArtifactFamily[],
    };
  });
  if (new Set(requests.map((request) => request.requestId)).size !== requests.length) {
    throw new TypeError("Laces Out refresh poll returned duplicate requests");
  }
  return {
    schemaVersion: 1,
    generatedAt: value.generatedAt,
    pollAfterSeconds: value.pollAfterSeconds,
    requests,
  };
}

export function validateMaintenanceState(value: unknown): MaintenanceState {
  if (!isRecord(value) || value.schemaVersion !== 1) return defaultMaintenanceState;
  if (
    (value.lastPollAt !== null && !validIso(value.lastPollAt)) ||
    (value.lastBaselineAt !== null && !validIso(value.lastBaselineAt)) ||
    (value.pollBackoffUntil !== null && !validIso(value.pollBackoffUntil)) ||
    typeof value.consecutivePollFailures !== "number" ||
    !Number.isInteger(value.consecutivePollFailures) ||
    value.consecutivePollFailures < 0 ||
    value.consecutivePollFailures > 100 ||
    !isRecord(value.leagueBackoffUntil) ||
    !isRecord(value.leagueResults)
  ) {
    return defaultMaintenanceState;
  }
  const leagueBackoffUntil: Record<string, string> = {};
  for (const [leagueId, until] of Object.entries(value.leagueBackoffUntil).slice(0, 32)) {
    if (/^\d{1,20}$/u.test(leagueId) && validIso(until)) leagueBackoffUntil[leagueId] = until;
  }
  const leagueResults: Record<string, { state: string; at: string }> = {};
  for (const [leagueId, result] of Object.entries(value.leagueResults).slice(0, 32)) {
    if (
      /^\d{1,20}$/u.test(leagueId) &&
      isRecord(result) &&
      typeof result.state === "string" &&
      result.state.length <= 64 &&
      validIso(result.at)
    ) {
      leagueResults[leagueId] = { state: result.state, at: result.at };
    }
  }
  return {
    schemaVersion: 1,
    lastPollAt: value.lastPollAt,
    lastBaselineAt: value.lastBaselineAt,
    consecutivePollFailures: value.consecutivePollFailures,
    pollBackoffUntil: value.pollBackoffUntil,
    leagueBackoffUntil,
    leagueResults,
  };
}

export function maintenancePlan(input: {
  readonly configuration: {
    readonly automaticSync: boolean;
    readonly leagueIds: readonly string[];
    readonly season: number;
  };
  readonly state: MaintenanceState;
  readonly poll: AgentPollResponse | null;
  readonly now: Date;
}): MaintenancePlan {
  if (!input.configuration.automaticSync) return { kind: "none" };
  const now = input.now.getTime();
  if (input.poll) {
    const requests = input.poll.requests.filter((request) => {
      const backoffUntil = input.state.leagueBackoffUntil[request.externalLeagueId];
      return (
        input.configuration.leagueIds.includes(request.externalLeagueId) &&
        request.season === input.configuration.season &&
        Date.parse(request.expiresAt) > now &&
        (!backoffUntil || Date.parse(backoffUntil) <= now)
      );
    });
    if (requests.length > 0) return { kind: "requested", requests };
  }
  const lastBaselineAt = input.state.lastBaselineAt
    ? Date.parse(input.state.lastBaselineAt)
    : Number.NEGATIVE_INFINITY;
  if (now - lastBaselineAt < baselineSyncIntervalMs) return { kind: "none" };
  const leagueIds = input.configuration.leagueIds.filter((leagueId) => {
    const backoffUntil = input.state.leagueBackoffUntil[leagueId];
    return !backoffUntil || Date.parse(backoffUntil) <= now;
  });
  return leagueIds.length > 0 ? { kind: "baseline", leagueIds } : { kind: "none" };
}

export function pollFailureBackoffUntil(consecutiveFailures: number, now: Date): string {
  const delayMs = Math.min(
    30_000 * 2 ** Math.min(Math.max(consecutiveFailures - 1, 0), 7),
    60 * 60 * 1000,
  );
  return new Date(now.getTime() + delayMs).toISOString();
}
