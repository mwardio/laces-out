import { createHash } from "node:crypto";

import { parse } from "csv-parse/sync";

export const NFLVERSE_PLAYERS_URL =
  "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv" as const;
export const NFLVERSE_ATTRIBUTION = "Player data provided by nflverse (CC BY 4.0)" as const;
export const NFLVERSE_ATTRIBUTION_URL = "https://github.com/nflverse/nflverse-data" as const;

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const ALLOWED_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface NflverseSourceState {
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly checksumSha256: string | null;
}

export interface NflversePlayer {
  readonly gsisId: string;
  readonly displayName: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly espnId: string | null;
  readonly pfrId: string | null;
  readonly position: string;
  readonly positionGroup: string | null;
  readonly latestTeam: string | null;
  readonly status: string | null;
  readonly birthDate: string | null;
  readonly rookieSeason: number | null;
  readonly lastSeason: number | null;
}

interface ChangedResult {
  readonly state: "changed";
  readonly checkedAt: string;
  readonly sourceUrl: typeof NFLVERSE_PLAYERS_URL;
  readonly attribution: typeof NFLVERSE_ATTRIBUTION;
  readonly attributionUrl: typeof NFLVERSE_ATTRIBUTION_URL;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly checksumSha256: string;
  readonly players: readonly NflversePlayer[];
  readonly rowsRead: number;
  readonly rowsRejected: number;
}

interface UnchangedResult {
  readonly state: "unchanged";
  readonly checkedAt: string;
  readonly sourceUrl: typeof NFLVERSE_PLAYERS_URL;
  readonly attribution: typeof NFLVERSE_ATTRIBUTION;
  readonly attributionUrl: typeof NFLVERSE_ATTRIBUTION_URL;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly checksumSha256: string | null;
}

export type NflversePlayersCheckResult = ChangedResult | UnchangedResult;

export class NflverseSourceError extends Error {
  readonly code: "NETWORK" | "REDIRECT" | "UPSTREAM" | "TOO_LARGE" | "INVALID_CSV";
  readonly retryable: boolean;

  constructor(code: NflverseSourceError["code"], message: string, retryable = false) {
    super(message);
    this.name = "NflverseSourceError";
    this.code = code;
    this.retryable = retryable;
  }
}

function safeHeader(value: string | null): string | null {
  if (!value) return null;
  return /^[\x20-\x7E]{1,512}$/u.test(value) ? value : null;
}

function redirectTarget(current: URL, location: string | null): URL {
  if (!location) throw new NflverseSourceError("REDIRECT", "nflverse redirect omitted Location");
  const target = new URL(location, current);
  if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname)) {
    throw new NflverseSourceError("REDIRECT", "nflverse redirected to an unapproved host");
  }
  return target;
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new NflverseSourceError("TOO_LARGE", "nflverse player catalog exceeds 32 MiB");
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
      throw new NflverseSourceError("TOO_LARGE", "nflverse player catalog exceeds 32 MiB");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function nullable(value: unknown, maximum = 160): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed !== "" && trimmed.length <= maximum ? trimmed : null;
}

function season(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}$/u.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1900 && parsed <= 2200 ? parsed : null;
}

function parsePlayers(csv: string): {
  readonly players: readonly NflversePlayer[];
  readonly rowsRead: number;
  readonly rowsRejected: number;
} {
  let rows: Record<string, string>[];
  try {
    rows = parse(csv, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      relax_column_count: false,
      max_record_size: 128 * 1024,
    });
  } catch {
    throw new NflverseSourceError("INVALID_CSV", "nflverse player catalog is malformed CSV");
  }
  if (rows.length === 0 || rows.length > 100_000) {
    throw new NflverseSourceError("INVALID_CSV", "nflverse player row count is invalid");
  }
  const headers = new Set(Object.keys(rows[0] ?? {}));
  for (const required of [
    "gsis_id",
    "pfr_id",
    "display_name",
    "position",
    "latest_team",
    "status",
  ]) {
    if (!headers.has(required)) {
      throw new NflverseSourceError(
        "INVALID_CSV",
        `nflverse player catalog omitted required column ${required}`,
      );
    }
  }

  const players: NflversePlayer[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const row of rows) {
    const gsisId = nullable(row.gsis_id, 20);
    const displayName = nullable(row.display_name);
    const position = nullable(row.position, 16);
    if (!gsisId || !/^00-\d{7}$/u.test(gsisId) || !displayName || !position || seen.has(gsisId)) {
      rejected += 1;
      continue;
    }
    seen.add(gsisId);
    const rawEspnId = nullable(row.espn_id, 20);
    const rawPfrId = nullable(row.pfr_id, 20);
    players.push({
      gsisId,
      displayName,
      firstName: nullable(row.first_name),
      lastName: nullable(row.last_name),
      espnId: rawEspnId && /^\d{1,20}$/u.test(rawEspnId) ? rawEspnId : null,
      pfrId: rawPfrId && /^[A-Za-z0-9.-]{1,20}$/u.test(rawPfrId) ? rawPfrId : null,
      position,
      positionGroup: nullable(row.position_group, 16),
      latestTeam: nullable(row.latest_team, 8),
      status: nullable(row.status, 32),
      birthDate: nullable(row.birth_date, 10),
      rookieSeason: season(row.rookie_season),
      lastSeason: season(row.last_season),
    });
  }
  if (players.length === 0) {
    throw new NflverseSourceError("INVALID_CSV", "nflverse player catalog had no valid players");
  }
  return { players, rowsRead: rows.length, rowsRejected: rejected };
}

export class NflversePlayersSource {
  readonly #fetch: FetchLike;
  readonly #now: () => Date;

  constructor(options: { readonly fetch?: FetchLike; readonly now?: () => Date } = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async check(previous: NflverseSourceState): Promise<NflversePlayersCheckResult> {
    const headers: Record<string, string> = { Accept: "text/csv, application/octet-stream;q=0.9" };
    if (previous.etag) headers["If-None-Match"] = previous.etag;
    if (previous.lastModified) headers["If-Modified-Since"] = previous.lastModified;

    let endpoint = new URL(NFLVERSE_PLAYERS_URL);
    let response: Response | undefined;
    for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
      try {
        response = await this.#fetch(endpoint, {
          method: "GET",
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new NflverseSourceError("NETWORK", "nflverse player check failed", true);
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      if (attempt === MAX_REDIRECTS) {
        throw new NflverseSourceError("REDIRECT", "nflverse exceeded redirect limit");
      }
      endpoint = redirectTarget(endpoint, response.headers.get("location"));
    }
    if (!response) throw new NflverseSourceError("NETWORK", "nflverse returned no response", true);
    const checkedAt = this.#now().toISOString();
    const etag = safeHeader(response.headers.get("etag")) ?? previous.etag;
    const lastModified = safeHeader(response.headers.get("last-modified")) ?? previous.lastModified;
    if (response.status === 304) {
      return {
        state: "unchanged",
        checkedAt,
        sourceUrl: NFLVERSE_PLAYERS_URL,
        attribution: NFLVERSE_ATTRIBUTION,
        attributionUrl: NFLVERSE_ATTRIBUTION_URL,
        etag,
        lastModified,
        checksumSha256: previous.checksumSha256,
      };
    }
    if (!response.ok) {
      throw new NflverseSourceError(
        "UPSTREAM",
        `nflverse player check returned status ${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }
    const csv = await readBounded(response);
    const checksumSha256 = createHash("sha256").update(csv, "utf8").digest("hex");
    if (previous.checksumSha256 === checksumSha256) {
      return {
        state: "unchanged",
        checkedAt,
        sourceUrl: NFLVERSE_PLAYERS_URL,
        attribution: NFLVERSE_ATTRIBUTION,
        attributionUrl: NFLVERSE_ATTRIBUTION_URL,
        etag,
        lastModified,
        checksumSha256,
      };
    }
    const parsed = parsePlayers(csv);
    return {
      state: "changed",
      checkedAt,
      sourceUrl: NFLVERSE_PLAYERS_URL,
      attribution: NFLVERSE_ATTRIBUTION,
      attributionUrl: NFLVERSE_ATTRIBUTION_URL,
      etag,
      lastModified,
      checksumSha256,
      ...parsed,
    };
  }
}
