import { createHash } from "node:crypto";

export const FFC_ADP_ORIGIN = "https://fantasyfootballcalculator.com" as const;
export const FFC_ADP_PATH_PREFIX = "/api/v1/adp/" as const;
export const FFC_ATTRIBUTION = "ADP data provided by Fantasy Football Calculator" as const;
export const FFC_ATTRIBUTION_URL = "https://fantasyfootballcalculator.com/" as const;
export const FFC_ADP_DOCUMENTATION_URL =
  "https://help.fantasyfootballcalculator.com/article/42-adp-rest-api" as const;

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PLAYER_ROWS = 2_000;
const REQUEST_TIMEOUT_MS = 20_000;
const VALID_TEAM_COUNTS = new Set([8, 10, 12, 14]);
const VALID_POSITIONS = new Set(["QB", "RB", "WR", "TE", "PK", "DEF"]);
const RESPONSE_TYPES = new Set(["application/json", "text/html"]);

export type FfcScoringFormat = "standard" | "half-ppr" | "ppr" | "2qb" | "dynasty" | "rookie";

export type FfcPosition = "QB" | "RB" | "WR" | "TE" | "PK" | "DEF";

export interface FfcAdpContext {
  readonly season: number;
  readonly teams: 8 | 10 | 12 | 14;
  readonly scoringFormat: FfcScoringFormat;
  readonly position: FfcPosition | null;
}

export interface FfcAdpSourceState {
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly checksumSha256: string | null;
  readonly asOfDate: string | null;
}

export interface FfcAdpPlayer {
  readonly ffcPlayerId: string;
  readonly name: string;
  readonly position: FfcPosition;
  readonly nflTeam: string;
  readonly adp: number;
  readonly adpFormatted: string | null;
  readonly standardDeviation: number;
  readonly timesDrafted: number;
  readonly highPick: number | null;
  readonly lowPick: number | null;
  readonly byeWeek: number | null;
}

interface FfcAdpChangedResult {
  readonly state: "changed";
  readonly fetchedAt: string;
  readonly asOfDate: string;
  readonly windowStartDate: string;
  readonly sourceUrl: string;
  readonly attribution: typeof FFC_ATTRIBUTION;
  readonly attributionUrl: typeof FFC_ATTRIBUTION_URL;
  readonly context: FfcAdpContext;
  readonly rounds: number;
  readonly totalDrafts: number;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly checksumSha256: string;
  readonly players: readonly FfcAdpPlayer[];
  readonly rowsRead: number;
  readonly rowsRejected: number;
}

interface FfcAdpUnchangedResult {
  readonly state: "unchanged";
  readonly fetchedAt: string;
  readonly asOfDate: string | null;
  readonly sourceUrl: string;
  readonly attribution: typeof FFC_ATTRIBUTION;
  readonly attributionUrl: typeof FFC_ATTRIBUTION_URL;
  readonly context: FfcAdpContext;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly checksumSha256: string | null;
}

export type FfcAdpCheckResult = FfcAdpChangedResult | FfcAdpUnchangedResult;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class FfcAdpSourceError extends Error {
  readonly code:
    | "INVALID_CONTEXT"
    | "NETWORK"
    | "REDIRECT"
    | "UPSTREAM"
    | "CONTENT_TYPE"
    | "TOO_LARGE"
    | "INVALID_JSON";
  readonly retryable: boolean;

  constructor(code: FfcAdpSourceError["code"], message: string, retryable = false) {
    super(message);
    this.name = "FfcAdpSourceError";
    this.code = code;
    this.retryable = retryable;
  }
}

function assertContext(context: FfcAdpContext): void {
  if (!Number.isInteger(context.season) || context.season < 2007 || context.season > 2200) {
    throw new FfcAdpSourceError("INVALID_CONTEXT", "FFC ADP season must be between 2007 and 2200");
  }
  if (!VALID_TEAM_COUNTS.has(context.teams)) {
    throw new FfcAdpSourceError("INVALID_CONTEXT", "FFC ADP team count is unsupported");
  }
  if (
    !["standard", "half-ppr", "ppr", "2qb", "dynasty", "rookie"].includes(context.scoringFormat)
  ) {
    throw new FfcAdpSourceError("INVALID_CONTEXT", "FFC ADP scoring format is unsupported");
  }
  if (context.position !== null && !VALID_POSITIONS.has(context.position)) {
    throw new FfcAdpSourceError("INVALID_CONTEXT", "FFC ADP position is unsupported");
  }
}

export function buildFfcAdpUrl(context: FfcAdpContext): URL {
  assertContext(context);
  const endpoint = new URL(`${FFC_ADP_PATH_PREFIX}${context.scoringFormat}`, FFC_ADP_ORIGIN);
  endpoint.searchParams.set("teams", String(context.teams));
  endpoint.searchParams.set("year", String(context.season));
  if (context.position) endpoint.searchParams.set("position", context.position);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.origin !== FFC_ADP_ORIGIN ||
    endpoint.pathname !== `${FFC_ADP_PATH_PREFIX}${context.scoringFormat}`
  ) {
    throw new FfcAdpSourceError("INVALID_CONTEXT", "FFC ADP endpoint failed validation");
  }
  return endpoint;
}

function safeHeader(value: string | null): string | null {
  if (!value) return null;
  return /^[\x20-\x7E]{1,512}$/u.test(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown, maximum = 160): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximum ? trimmed : null;
}

function integer(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

function decimal(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : value;
}

function sourceTypeMatches(format: FfcScoringFormat, value: unknown): boolean {
  const expected: Record<FfcScoringFormat, readonly string[]> = {
    standard: ["Non-PPR", "Standard"],
    "half-ppr": ["Half-PPR"],
    ppr: ["PPR"],
    "2qb": ["2 QB", "2-QB"],
    dynasty: ["Dynasty"],
    rookie: ["Rookie", "Dynasty Rookie"],
  };
  const type = string(value, 32);
  return type !== null && expected[format].includes(type);
}

function normalizePlayer(value: unknown): FfcAdpPlayer | null {
  const row = record(value);
  if (!row) return null;
  const rawId = row.player_id;
  const ffcPlayerId =
    typeof rawId === "number" && Number.isSafeInteger(rawId) && rawId >= 0
      ? String(rawId)
      : string(rawId, 20);
  const name = string(row.name);
  const position = string(row.position, 8);
  const nflTeam = string(row.team, 8)?.toUpperCase();
  const adp = decimal(row.adp, 0.01, 10_000);
  const standardDeviation = decimal(row.stdev, 0, 10_000);
  const timesDrafted = integer(row.times_drafted, 0, 10_000_000);
  if (
    !ffcPlayerId ||
    !/^\d{1,20}$/u.test(ffcPlayerId) ||
    !name ||
    !position ||
    !VALID_POSITIONS.has(position) ||
    !nflTeam ||
    !/^[A-Z]{2,4}$/u.test(nflTeam) ||
    adp === null ||
    standardDeviation === null ||
    timesDrafted === null
  ) {
    return null;
  }
  const adpFormatted = string(row.adp_formatted, 12);
  const highPick = integer(row.high, 1, 10_000);
  const lowPick = integer(row.low, 1, 10_000);
  const byeWeek = integer(row.bye, 1, 22);
  return {
    ffcPlayerId,
    name,
    position: position as FfcPosition,
    nflTeam,
    adp,
    adpFormatted: adpFormatted && /^\d{1,4}\.\d{2}$/u.test(adpFormatted) ? adpFormatted : null,
    standardDeviation,
    timesDrafted,
    highPick,
    lowPick,
    byeWeek,
  };
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new FfcAdpSourceError("TOO_LARGE", "FFC ADP response exceeded 2 MiB");
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
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new FfcAdpSourceError("TOO_LARGE", "FFC ADP response exceeded 2 MiB");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function parsePayload(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new FfcAdpSourceError("INVALID_JSON", "FFC ADP returned malformed JSON");
  }
}

function assertContentType(response: Response): void {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  // The official API currently labels its JSON payload as text/html.
  if (!mediaType || !RESPONSE_TYPES.has(mediaType)) {
    throw new FfcAdpSourceError("CONTENT_TYPE", "FFC ADP returned an unexpected content type");
  }
}

async function fetchResponse(fetcher: FetchLike, endpoint: URL, headers: HeadersInit) {
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new FfcAdpSourceError("NETWORK", "FFC ADP data check failed", true);
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    throw new FfcAdpSourceError("REDIRECT", "FFC ADP returned an unexpected redirect");
  }
  if (!response.ok && response.status !== 304) {
    throw new FfcAdpSourceError(
      "UPSTREAM",
      `FFC ADP data check returned status ${response.status}`,
      [408, 425, 429].includes(response.status) || response.status >= 500,
    );
  }
  return response;
}

export class FfcAdpSource {
  readonly #fetch: FetchLike;
  readonly #now: () => Date;

  constructor(options: { readonly fetch?: FetchLike; readonly now?: () => Date } = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async check(context: FfcAdpContext, previous: FfcAdpSourceState): Promise<FfcAdpCheckResult> {
    const endpoint = buildFfcAdpUrl(context);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (previous.etag) headers["If-None-Match"] = previous.etag;
    if (previous.lastModified) headers["If-Modified-Since"] = previous.lastModified;
    const response = await fetchResponse(this.#fetch, endpoint, headers);
    const fetchedAt = this.#now().toISOString();
    const etag = safeHeader(response.headers.get("etag")) ?? previous.etag;
    const lastModified = safeHeader(response.headers.get("last-modified")) ?? previous.lastModified;
    const common = {
      fetchedAt,
      sourceUrl: endpoint.toString(),
      attribution: FFC_ATTRIBUTION,
      attributionUrl: FFC_ATTRIBUTION_URL,
      context,
      etag,
      lastModified,
    } as const;
    if (response.status === 304) {
      return {
        state: "unchanged",
        ...common,
        asOfDate: previous.asOfDate,
        checksumSha256: previous.checksumSha256,
      };
    }
    assertContentType(response);
    const body = await readBounded(response);
    const checksumSha256 = createHash("sha256").update(body, "utf8").digest("hex");
    if (checksumSha256 === previous.checksumSha256) {
      return {
        state: "unchanged",
        ...common,
        asOfDate: previous.asOfDate,
        checksumSha256,
      };
    }

    const payload = record(parsePayload(body));
    const meta = record(payload?.meta);
    const rows = payload?.players;
    const sourceTeams = integer(meta?.teams, 1, 100);
    const rounds = integer(meta?.rounds, 1, 100);
    const totalDrafts = integer(meta?.total_drafts, 0, 100_000_000);
    const windowStartDate = isoDate(meta?.start_date);
    const asOfDate = isoDate(meta?.end_date);
    if (
      string(payload?.status, 32) !== "Success" ||
      !meta ||
      !sourceTypeMatches(context.scoringFormat, meta.type) ||
      sourceTeams !== context.teams ||
      rounds === null ||
      totalDrafts === null ||
      !windowStartDate ||
      !asOfDate ||
      !Array.isArray(rows) ||
      rows.length === 0 ||
      rows.length > MAX_PLAYER_ROWS
    ) {
      throw new FfcAdpSourceError("INVALID_JSON", "FFC ADP response envelope is invalid");
    }

    const players: FfcAdpPlayer[] = [];
    const seen = new Set<string>();
    let rowsRejected = 0;
    for (const row of rows) {
      const player = normalizePlayer(row);
      if (!player || seen.has(player.ffcPlayerId)) {
        rowsRejected += 1;
        continue;
      }
      if (context.position !== null && player.position !== context.position) {
        rowsRejected += 1;
        continue;
      }
      seen.add(player.ffcPlayerId);
      players.push(player);
    }
    if (players.length === 0) {
      throw new FfcAdpSourceError("INVALID_JSON", "FFC ADP response had no valid player rows");
    }
    return {
      state: "changed",
      ...common,
      asOfDate,
      windowStartDate,
      rounds,
      totalDrafts,
      checksumSha256,
      players,
      rowsRead: rows.length,
      rowsRejected,
    };
  }
}
