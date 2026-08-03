import type { EspnArtifactFamily, EspnArtifactFreshness } from "@fantasy/db";

export const ESPN_ARTIFACT_FAMILIES = [
  "core",
  "available-players",
  "weekly-box-scores",
  "transactions",
  "completed-draft",
] as const satisfies readonly EspnArtifactFamily[];

function advanceTimestamp(
  freshness: EspnArtifactFreshness,
  component: keyof EspnArtifactFreshness,
  effectiveAt: Date,
): void {
  const previous = Date.parse(freshness[component] ?? "");
  if (!Number.isFinite(previous) || previous < effectiveAt.getTime()) {
    freshness[component] = effectiveAt.toISOString();
  }
}

/**
 * Advances one admitted artifact monotonically. The available-player family is complete only when
 * both the free-agent and waiver components have been observed; its public timestamp is the older
 * of those component captures so a partial upload can never fulfill a shared refresh intent.
 */
export function advanceEspnArtifactFreshness(input: {
  readonly current: EspnArtifactFreshness;
  readonly artifact: EspnArtifactFamily;
  readonly availability?: "free-agent" | "waivers";
  readonly effectiveAt: Date;
}): EspnArtifactFreshness {
  if (!Number.isFinite(input.effectiveAt.getTime())) {
    throw new TypeError("ESPN artifact freshness requires a valid capture time");
  }
  const freshness: EspnArtifactFreshness = { ...input.current };
  if (input.artifact !== "available-players") {
    advanceTimestamp(freshness, input.artifact, input.effectiveAt);
    return freshness;
  }
  if (!input.availability) {
    throw new TypeError("Available-player freshness requires an admitted availability scope");
  }
  const component =
    input.availability === "free-agent" ? "available-free-agents" : "available-waivers";
  advanceTimestamp(freshness, component, input.effectiveAt);
  const freeAgentsAt = Date.parse(freshness["available-free-agents"] ?? "");
  const waiversAt = Date.parse(freshness["available-waivers"] ?? "");
  if (Number.isFinite(freeAgentsAt) && Number.isFinite(waiversAt)) {
    advanceTimestamp(freshness, "available-players", new Date(Math.min(freeAgentsAt, waiversAt)));
  }
  return freshness;
}

export type EspnFreshnessContext = "active" | "near-lock" | "offseason";

export interface EspnFreshnessPolicy {
  readonly staleAfterMs: number;
  readonly minimumRefreshIntervalMs: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const ESPN_FRESHNESS_POLICIES: Readonly<Record<EspnFreshnessContext, EspnFreshnessPolicy>> =
  {
    active: { staleAfterMs: 30 * MINUTE_MS, minimumRefreshIntervalMs: 15 * MINUTE_MS },
    "near-lock": { staleAfterMs: 15 * MINUTE_MS, minimumRefreshIntervalMs: 10 * MINUTE_MS },
    offseason: { staleAfterMs: 6 * HOUR_MS, minimumRefreshIntervalMs: HOUR_MS },
  };

export function espnFreshnessContext(input: {
  readonly seasonStatus: string;
  readonly hasActiveMatchup: boolean;
}): EspnFreshnessContext {
  if (input.seasonStatus !== "active") return "offseason";
  return input.hasActiveMatchup ? "near-lock" : "active";
}

/**
 * Supplemental families are requested only when the season makes them meaningful. A preseason
 * league cannot have a completed draft or weekly box score inferred from absence, and live-draft
 * observation remains an independent feed.
 */
export function relevantEspnArtifactFamilies(input: {
  readonly seasonStatus: string;
  readonly currentWeek: number | null;
}): readonly EspnArtifactFamily[] {
  if (input.seasonStatus === "active") {
    return input.currentWeek !== null && input.currentWeek >= 1
      ? ESPN_ARTIFACT_FAMILIES
      : ["core", "available-players", "transactions", "completed-draft"];
  }
  if (input.seasonStatus === "complete" || input.seasonStatus === "offseason") {
    return ["core", "completed-draft"];
  }
  return ["core"];
}

function timestamp(value: string | Date | null | undefined): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface EspnRefreshEvaluation {
  readonly context: EspnFreshnessContext;
  readonly policy: EspnFreshnessPolicy;
  readonly relevantArtifacts: readonly EspnArtifactFamily[];
  readonly staleArtifacts: readonly EspnArtifactFamily[];
  readonly current: boolean;
}

export function evaluateEspnRefresh(input: {
  readonly seasonStatus: string;
  readonly currentWeek: number | null;
  readonly hasActiveMatchup: boolean;
  readonly artifactFreshness: Readonly<
    Partial<Record<EspnArtifactFamily, string | Date | null | undefined>>
  >;
  readonly now: Date;
}): EspnRefreshEvaluation {
  const context = espnFreshnessContext(input);
  const policy = ESPN_FRESHNESS_POLICIES[context];
  const relevantArtifacts = relevantEspnArtifactFamilies(input);
  const staleArtifacts = relevantArtifacts.filter((artifact) => {
    const observedAt = timestamp(input.artifactFreshness[artifact]);
    return observedAt === null || input.now.getTime() - observedAt >= policy.staleAfterMs;
  });
  return {
    context,
    policy,
    relevantArtifacts,
    staleArtifacts,
    current: staleArtifacts.length === 0,
  };
}

export function espnRefreshBucket(input: {
  readonly leagueSeasonId: string;
  readonly now: Date;
  readonly minimumRefreshIntervalMs: number;
}): string {
  if (
    input.minimumRefreshIntervalMs <= 0 ||
    !Number.isSafeInteger(input.minimumRefreshIntervalMs)
  ) {
    throw new TypeError("ESPN minimum refresh interval must be a positive integer");
  }
  const bucket = Math.floor(input.now.getTime() / input.minimumRefreshIntervalMs);
  return `espn-league:${input.leagueSeasonId}:${bucket}`;
}

export const ESPN_DIRECT_FAILURE_THRESHOLD = 5;
const DIRECT_BASE_COOLDOWN_MS = 5 * MINUTE_MS;
const DIRECT_MAX_COOLDOWN_MS = 6 * HOUR_MS;

export function nextEspnDirectCircuitOpenUntil(input: {
  readonly consecutiveFailures: number;
  readonly now: Date;
  readonly rateLimited?: boolean;
}): Date | null {
  if (input.consecutiveFailures < ESPN_DIRECT_FAILURE_THRESHOLD && !input.rateLimited) return null;
  const excess = Math.max(0, input.consecutiveFailures - ESPN_DIRECT_FAILURE_THRESHOLD);
  const delay = Math.min(
    DIRECT_BASE_COOLDOWN_MS * 2 ** Math.min(excess, 12),
    DIRECT_MAX_COOLDOWN_MS,
  );
  return new Date(input.now.getTime() + delay);
}

export interface EspnDirectSyncInput {
  readonly leagueSeasonId: string;
  readonly refreshRequestId?: string;
  readonly probe: boolean;
}

export type EspnDirectSyncOutcome =
  | {
      readonly state: "accepted" | "unchanged";
      readonly leagueSeasonId: string;
      readonly leagueId: string;
      readonly syncRunId: string;
      readonly season: number;
      readonly checksumSha256: string;
      readonly recordsWritten: number;
    }
  | {
      readonly state:
        "not-public" | "evidence-required" | "assisted-required" | "disabled" | "target-missing";
    }
  | { readonly state: "circuit-open"; readonly retryAfterSeconds: number };

export interface EspnDirectSyncPort {
  syncLeague(input: EspnDirectSyncInput, signal: AbortSignal): Promise<EspnDirectSyncOutcome>;
}
