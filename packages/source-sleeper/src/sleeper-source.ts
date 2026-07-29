import { createHash } from "node:crypto";

export const SLEEPER_PLAYERS_URL = "https://api.sleeper.app/v1/players/nfl" as const;
export const SLEEPER_TRENDS_URL = "https://api.sleeper.app/v1/players/nfl/trending" as const;
export const SLEEPER_ATTRIBUTION = "Player and trending data provided by Sleeper" as const;
export const SLEEPER_ATTRIBUTION_URL = "https://sleeper.com/" as const;

/**
 * A live check on 2026-07-27 measured the catalog at 14,609,548 bytes across 12,201 rows — 87% of
 * a 16 MiB bound. The catalog grows with roster churn, so that headroom would have failed closed
 * mid-season and staled the whole player catalog. The bound exists to stop a runaway response,
 * not to sit just above the normal one.
 */
const MAX_PLAYER_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_TREND_RESPONSE_BYTES = 1024 * 1024;
const MAX_PLAYER_ROWS = 100_000;
const REQUEST_TIMEOUT_MS = 30_000;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SleeperSourceState {
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly checksumSha256: string | null;
}

export interface SleeperPlayer {
  readonly sleeperId: string;
  readonly displayName: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly gsisId: string | null;
  readonly espnId: string | null;
  readonly yahooId: string | null;
  readonly position: string;
  readonly eligiblePositions: readonly string[];
  readonly nflTeam: string | null;
  readonly status: string | null;
  readonly injuryStatus: string | null;
  readonly practiceParticipation: string | null;
  readonly depthChartPosition: string | null;
  readonly depthChartOrder: number | null;
}

interface SleeperChangedResult {
  readonly state: "changed";
  readonly checkedAt: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly checksumSha256: string;
  readonly players: readonly SleeperPlayer[];
  readonly rowsRead: number;
  readonly rowsRejected: number;
}

interface SleeperUnchangedResult {
  readonly state: "unchanged";
  readonly checkedAt: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly checksumSha256: string | null;
}

export type SleeperPlayersCheckResult = SleeperChangedResult | SleeperUnchangedResult;

export interface SleeperTrend {
  readonly sleeperId: string;
  readonly signal: "add" | "drop";
  readonly count: number;
  readonly rank: number;
}

export type SleeperTrendsCheckResult =
  | {
      readonly state: "changed";
      readonly checkedAt: string;
      readonly checksumSha256: string;
      readonly lookbackHours: number;
      readonly trends: readonly SleeperTrend[];
      readonly rowsRead: number;
      readonly rowsRejected: number;
    }
  | {
      readonly state: "unchanged";
      readonly checkedAt: string;
      readonly checksumSha256: string;
      readonly lookbackHours: number;
      readonly trends: readonly SleeperTrend[];
      readonly rowsRead: number;
      readonly rowsRejected: number;
    };

export class SleeperSourceError extends Error {
  readonly code: "NETWORK" | "UPSTREAM" | "TOO_LARGE" | "INVALID_JSON";
  readonly retryable: boolean;

  constructor(code: SleeperSourceError["code"], message: string, retryable = false) {
    super(message);
    this.name = "SleeperSourceError";
    this.code = code;
    this.retryable = retryable;
  }
}

function safeHeader(value: string | null): string | null {
  if (!value) return null;
  return /^[\x20-\x7E]{1,512}$/u.test(value) ? value : null;
}

async function readBounded(response: Response, maximumBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new SleeperSourceError("TOO_LARGE", "Sleeper response exceeded its size limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SleeperSourceError("TOO_LARGE", "Sleeper response exceeded its size limit");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new SleeperSourceError("INVALID_JSON", "Sleeper returned malformed JSON");
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nullableString(value: unknown, maximum = 160): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximum ? trimmed : null;
}

function externalId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  const normalized = nullableString(value, 32);
  return normalized && /^\d{1,32}$/u.test(normalized) ? normalized : null;
}

function position(value: unknown): string | null {
  const normalized = nullableString(value, 16)?.toUpperCase();
  if (!normalized || !/^[A-Z0-9/+-]{1,16}$/u.test(normalized)) return null;
  return normalized === "DEF" ? "DST" : normalized;
}

function positions(value: unknown, primary: string): readonly string[] {
  const supplied = Array.isArray(value) ? value : [];
  const normalized = supplied.flatMap((item) => {
    const parsed = position(item);
    return parsed ? [parsed] : [];
  });
  return [...new Set([primary, ...normalized])].slice(0, 16);
}

function depthChartOrder(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d{1,2}$/u.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed >= 0 && parsed <= 99
    ? parsed
    : null;
}

function normalizePlayer(sleeperId: string, value: unknown): SleeperPlayer | null {
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(sleeperId)) return null;
  const source = record(value);
  if (!source) return null;
  const sourcePlayerId = nullableString(source.player_id, 64);
  if (sourcePlayerId && sourcePlayerId !== sleeperId) return null;
  const firstName = nullableString(source.first_name);
  const lastName = nullableString(source.last_name);
  const displayName =
    nullableString(source.full_name) ??
    nullableString(source.display_name) ??
    nullableString([firstName, lastName].filter(Boolean).join(" "));
  const primaryPosition = position(source.position);
  if (!displayName || !primaryPosition) return null;
  const rawGsisId = nullableString(source.gsis_id, 20);
  return {
    sleeperId,
    displayName,
    firstName,
    lastName,
    gsisId: rawGsisId && /^00-\d{7}$/u.test(rawGsisId) ? rawGsisId : null,
    espnId: externalId(source.espn_id),
    yahooId: externalId(source.yahoo_id),
    position: primaryPosition,
    eligiblePositions: positions(source.fantasy_positions, primaryPosition),
    nflTeam: nullableString(source.team, 8)?.toUpperCase() ?? null,
    status: nullableString(source.status, 64),
    injuryStatus: nullableString(source.injury_status, 64),
    practiceParticipation: nullableString(source.practice_participation, 64),
    depthChartPosition: nullableString(source.depth_chart_position, 32),
    depthChartOrder: depthChartOrder(source.depth_chart_order),
  };
}

async function fetchResponse(fetcher: FetchLike, endpoint: URL, headers?: HeadersInit) {
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "GET",
      ...(headers ? { headers } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new SleeperSourceError("NETWORK", "Sleeper data check failed", true);
  }
  if (!response.ok && response.status !== 304) {
    throw new SleeperSourceError(
      "UPSTREAM",
      `Sleeper data check returned status ${response.status}`,
      response.status === 429 || response.status >= 500,
    );
  }
  return response;
}

export class SleeperPlayersSource {
  readonly #fetch: FetchLike;
  readonly #now: () => Date;

  constructor(options: { readonly fetch?: FetchLike; readonly now?: () => Date } = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async check(previous: SleeperSourceState): Promise<SleeperPlayersCheckResult> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (previous.etag) headers["If-None-Match"] = previous.etag;
    if (previous.lastModified) headers["If-Modified-Since"] = previous.lastModified;
    const response = await fetchResponse(this.#fetch, new URL(SLEEPER_PLAYERS_URL), headers);
    const checkedAt = this.#now().toISOString();
    const etag = safeHeader(response.headers.get("etag")) ?? previous.etag;
    const lastModified = safeHeader(response.headers.get("last-modified")) ?? previous.lastModified;
    if (response.status === 304) {
      return {
        state: "unchanged",
        checkedAt,
        etag,
        lastModified,
        checksumSha256: previous.checksumSha256,
      };
    }
    const body = await readBounded(response, MAX_PLAYER_RESPONSE_BYTES);
    const checksumSha256 = createHash("sha256").update(body, "utf8").digest("hex");
    if (checksumSha256 === previous.checksumSha256) {
      return { state: "unchanged", checkedAt, etag, lastModified, checksumSha256 };
    }
    const payload = record(parseJson(body));
    const entries = payload ? Object.entries(payload) : [];
    if (entries.length === 0 || entries.length > MAX_PLAYER_ROWS) {
      throw new SleeperSourceError("INVALID_JSON", "Sleeper player row count is invalid");
    }
    const players: SleeperPlayer[] = [];
    let rowsRejected = 0;
    for (const [sleeperId, value] of entries) {
      const player = normalizePlayer(sleeperId, value);
      if (player) players.push(player);
      else rowsRejected += 1;
    }
    if (players.length === 0) {
      throw new SleeperSourceError("INVALID_JSON", "Sleeper player catalog had no valid players");
    }
    return {
      state: "changed",
      checkedAt,
      etag,
      lastModified,
      checksumSha256,
      players,
      rowsRead: entries.length,
      rowsRejected,
    };
  }
}

function parseTrends(value: unknown, signal: "add" | "drop") {
  if (!Array.isArray(value) || value.length > 250) {
    throw new SleeperSourceError("INVALID_JSON", `Sleeper ${signal} trends are invalid`);
  }
  const trends: SleeperTrend[] = [];
  let rowsRejected = 0;
  for (const [index, item] of value.entries()) {
    const row = record(item);
    const sleeperId = nullableString(row?.player_id, 64);
    const count = row?.count;
    if (
      !sleeperId ||
      !/^[A-Za-z0-9._-]{1,64}$/u.test(sleeperId) ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      rowsRejected += 1;
      continue;
    }
    trends.push({ sleeperId, signal, count, rank: index + 1 });
  }
  return { trends, rowsRead: value.length, rowsRejected };
}

export class SleeperTrendsSource {
  readonly #fetch: FetchLike;
  readonly #now: () => Date;
  readonly #lookbackHours: number;
  readonly #limit: number;

  constructor(
    options: {
      readonly fetch?: FetchLike;
      readonly now?: () => Date;
      readonly lookbackHours?: number;
      readonly limit?: number;
    } = {},
  ) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#lookbackHours = options.lookbackHours ?? 24;
    this.#limit = options.limit ?? 50;
    if (
      !Number.isSafeInteger(this.#lookbackHours) ||
      this.#lookbackHours < 1 ||
      this.#lookbackHours > 168
    ) {
      throw new RangeError("Sleeper trend lookback must be between 1 and 168 hours");
    }
    if (!Number.isSafeInteger(this.#limit) || this.#limit < 1 || this.#limit > 100) {
      throw new RangeError("Sleeper trend limit must be between 1 and 100");
    }
  }

  async check(previousChecksumSha256: string | null): Promise<SleeperTrendsCheckResult> {
    const payloads = await Promise.all(
      (["add", "drop"] as const).map(async (signal) => {
        const endpoint = new URL(`${SLEEPER_TRENDS_URL}/${signal}`);
        endpoint.searchParams.set("lookback_hours", String(this.#lookbackHours));
        endpoint.searchParams.set("limit", String(this.#limit));
        const response = await fetchResponse(this.#fetch, endpoint, { Accept: "application/json" });
        return { signal, body: await readBounded(response, MAX_TREND_RESPONSE_BYTES) };
      }),
    );
    const checkedAt = this.#now().toISOString();
    const checksumSha256 = createHash("sha256")
      .update(payloads.map((item) => `${item.signal}:${item.body}`).join("\n"), "utf8")
      .digest("hex");
    const parsed = payloads.map((item) => parseTrends(parseJson(item.body), item.signal));
    const trends = parsed.flatMap((item) => item.trends);
    if (trends.length === 0) {
      throw new SleeperSourceError("INVALID_JSON", "Sleeper trends had no valid rows");
    }
    return {
      state: checksumSha256 === previousChecksumSha256 ? "unchanged" : "changed",
      checkedAt,
      checksumSha256,
      lookbackHours: this.#lookbackHours,
      trends,
      rowsRead: parsed.reduce((sum, item) => sum + item.rowsRead, 0),
      rowsRejected: parsed.reduce((sum, item) => sum + item.rowsRejected, 0),
    };
  }
}
