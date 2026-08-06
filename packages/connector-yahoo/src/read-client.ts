import { createHash } from "node:crypto";

import type { LeagueSyncBundle } from "@laces-out/connectors";
import { redactText } from "@laces-out/security";

import { MAX_YAHOO_XML_BYTES, parseYahooLeagueXml, parseYahooXml, YahooXmlError } from "./xml.js";

export const YAHOO_FANTASY_API_ORIGIN = "https://fantasysports.yahooapis.com" as const;
export const YAHOO_FANTASY_API_PREFIX = "/fantasy/v2" as const;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;
const DEFAULT_COLLECTION_PAGE_SIZE = 25;
const MAX_COLLECTION_PAGE_SIZE = 100;

export type YahooReadClientErrorCode =
  | "ABORTED"
  | "FORBIDDEN"
  | "HTTP_ERROR"
  | "INVALID_RESPONSE"
  | "NETWORK"
  | "RATE_LIMITED"
  | "REDIRECT"
  | "TIMEOUT"
  | "TOO_LARGE"
  | "UNAUTHORIZED"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "UPSTREAM_ERROR";

export class YahooReadClientError extends Error {
  public readonly code: YahooReadClientErrorCode;
  public readonly status: number | null;
  public readonly retryable: boolean;
  public readonly retryAfterMs: number | null;
  public readonly refreshAccessToken: boolean;

  public constructor(input: {
    readonly code: YahooReadClientErrorCode;
    readonly message: string;
    readonly status?: number;
    readonly retryable?: boolean;
    readonly retryAfterMs?: number | null;
    readonly refreshAccessToken?: boolean;
  }) {
    super(redactText(input.message));
    this.name = "YahooReadClientError";
    this.code = input.code;
    this.status = input.status ?? null;
    this.retryable = input.retryable ?? false;
    this.retryAfterMs = input.retryAfterMs ?? null;
    this.refreshAccessToken = input.refreshAccessToken ?? false;
  }
}

export type YahooFetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface YahooFantasyReadClientOptions {
  readonly fetch?: YahooFetchLike;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxConcurrentRequests?: number;
}

export interface YahooReadRequest {
  /** A decrypted server-side OAuth access token. It is never returned or placed in an error. */
  readonly accessToken: string;
  readonly signal?: AbortSignal;
}

/** A validated, UTF-8, bounded XML artifact from the fixed Yahoo Fantasy origin. */
export interface YahooXmlArtifact {
  readonly xml: string;
  readonly endpoint: string;
  readonly fetchedAt: string;
  readonly contentType: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export interface YahooUserGamesOptions {
  /** Defaults to football only. */
  readonly gameCodes?: readonly string[];
  readonly seasons?: readonly number[];
  readonly availableOnly?: boolean;
}

export interface YahooUserLeaguesOptions {
  /** Use exact numeric season game keys when historical leagues are required. */
  readonly gameKeys?: readonly string[];
  readonly start?: number;
  readonly count?: number;
}

export interface YahooWeekOptions {
  readonly week?: number;
}

export type YahooTransactionType =
  "add" | "drop" | "commish" | "trade" | "waiver" | "pending_trade";

const YAHOO_TRANSACTION_TYPES = new Set<YahooTransactionType>([
  "add",
  "drop",
  "commish",
  "trade",
  "waiver",
  "pending_trade",
]);

export interface YahooLeagueTransactionsOptions {
  readonly types?: readonly YahooTransactionType[];
  readonly teamKey?: string;
  readonly count?: number;
}

export type YahooPlayerStatus = "A" | "FA" | "K" | "T" | "W";
export type YahooPlayerSort = "AR" | "NAME" | "OR" | "PTS" | `${number}`;

const YAHOO_PLAYER_STATUSES = new Set<YahooPlayerStatus>(["A", "FA", "K", "T", "W"]);
const YAHOO_PLAYER_SORT_TYPES = new Set(["season", "week"] as const);

export interface YahooLeaguePlayersOptions {
  readonly status?: YahooPlayerStatus;
  readonly position?: string;
  readonly search?: string;
  readonly sort?: YahooPlayerSort;
  readonly sortType?: "season" | "week";
  readonly sortSeason?: number;
  readonly sortWeek?: number;
  readonly start?: number;
  readonly count?: number;
}

interface GateWaiter {
  readonly signal: AbortSignal;
  readonly resolve: (release: () => void) => void;
  readonly reject: (reason: unknown) => void;
  readonly abort: () => void;
}

class RequestGate {
  readonly #limit: number;
  readonly #waiters: GateWaiter[] = [];
  #active = 0;

  public constructor(limit: number) {
    this.#limit = limit;
  }

  public acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(abortError(signal));
    if (this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve(this.#releaseOnce());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: GateWaiter = {
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(abortError(signal));
        },
      };
      this.#waiters.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
    });
  }

  #releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#release();
    };
  }

  #release(): void {
    this.#active -= 1;
    for (;;) {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) return;
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted) continue;
      this.#active += 1;
      waiter.resolve(this.#releaseOnce());
      return;
    }
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Yahoo request aborted");
}

function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function collectionStart(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new TypeError("Yahoo collection start must be an integer between 0 and 1000000");
  }
  return value;
}

function season(value: number, label = "Yahoo season"): number {
  if (!Number.isSafeInteger(value) || value < 2000 || value > 2100) {
    throw new TypeError(`${label} must be an integer between 2000 and 2100`);
  }
  return value;
}

function week(value: number): number {
  return positiveInteger(value, "Yahoo football week", 30);
}

function uniqueList<T>(values: readonly T[], label: string, maximum = 32): readonly T[] {
  if (values.length < 1 || values.length > maximum) {
    throw new TypeError(`${label} must contain between 1 and ${maximum} values`);
  }
  if (new Set(values).size !== values.length)
    throw new TypeError(`${label} cannot contain duplicates`);
  return values;
}

function gameCode(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,15}$/u.test(value)) throw new TypeError("Invalid Yahoo game code");
  return value;
}

function gameKey(value: string): string {
  if (!/^(?:[a-z][a-z0-9-]{0,15}|[0-9]{1,10})$/u.test(value)) {
    throw new TypeError("Invalid Yahoo game key");
  }
  return value;
}

function leagueKey(value: string): string {
  if (!/^(?:[a-z][a-z0-9-]{0,15}|[0-9]{1,10})\.l\.[0-9]{1,20}$/u.test(value)) {
    throw new TypeError("Invalid Yahoo league key");
  }
  return value;
}

function teamKey(value: string): string {
  if (!/^(?:[a-z][a-z0-9-]{0,15}|[0-9]{1,10})\.l\.[0-9]{1,20}\.t\.[0-9]{1,20}$/u.test(value)) {
    throw new TypeError("Invalid Yahoo team key");
  }
  return value;
}

function encoded(value: string | number): string {
  return encodeURIComponent(String(value));
}

function listValue(values: readonly (string | number)[]): string {
  return values.map(encoded).join(",");
}

function withParameters(path: string, parameters: readonly (readonly [string, string])[]): string {
  return `${path}${parameters.map(([name, value]) => `;${name}=${value}`).join("")}`;
}

function hasAsciiControl(value: string, includeSpace: boolean): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0x7f || codePoint < 0x20 || (includeSpace && codePoint === 0x20)) return true;
  }
  return false;
}

function validateAccessToken(value: string): void {
  if (value.length < 8 || value.length > 16_384 || hasAsciiControl(value, true)) {
    throw new TypeError("A valid Yahoo access token is required");
  }
}

function assertFixedYahooUrl(url: URL): void {
  if (
    url.protocol !== "https:" ||
    url.hostname !== "fantasysports.yahooapis.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    !url.pathname.startsWith(`${YAHOO_FANTASY_API_PREFIX}/`)
  ) {
    throw new YahooReadClientError({
      code: "INVALID_RESPONSE",
      message: "Yahoo Fantasy request escaped the fixed HTTPS API origin",
    });
  }
}

function xmlContentType(header: string | null): string | null {
  if (header === null) return null;
  const [rawMediaType, ...rawParameters] = header.split(";");
  const mediaType = rawMediaType?.trim().toLowerCase() ?? "";
  const supported =
    mediaType === "application/xml" ||
    mediaType === "text/xml" ||
    /^(?:application|text)\/[a-z0-9!#$&^_.+-]+\+xml$/u.test(mediaType);
  if (!supported) return null;

  for (const rawParameter of rawParameters) {
    const [rawName, rawValue] = rawParameter.split("=", 2);
    if (rawName?.trim().toLowerCase() !== "charset") continue;
    const charset = rawValue?.trim().replaceAll('"', "").toLowerCase();
    if (charset !== "utf-8" && charset !== "utf8" && charset !== "us-ascii") return null;
  }
  return mediaType;
}

function retryAfterMs(value: string | null, now: Date): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^[0-9]+$/u.test(trimmed)) {
    const seconds = Number(trimmed);
    const milliseconds = seconds * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
  }
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now.getTime()) : null;
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readBoundedXml(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await discardBody(response);
    throw new YahooReadClientError({
      code: "TOO_LARGE",
      message: "Yahoo Fantasy response exceeded the configured size limit",
      status: response.status,
    });
  }

  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new YahooReadClientError({
          code: "TOO_LARGE",
          message: "Yahoo Fantasy response exceeded the configured size limit",
          status: response.status,
        });
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof YahooReadClientError) throw error;
    throw new YahooReadClientError({
      code: "NETWORK",
      message: "Yahoo Fantasy response body could not be read",
      status: response.status,
      retryable: true,
    });
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new YahooReadClientError({
      code: "INVALID_RESPONSE",
      message: "Yahoo Fantasy response was not valid UTF-8 XML",
      status: response.status,
    });
  }
}

function statusError(response: Response, now: Date): YahooReadClientError {
  if (response.status === 401) {
    return new YahooReadClientError({
      code: "UNAUTHORIZED",
      message: "Yahoo rejected the access token; refresh it before reconnecting the account",
      status: 401,
      refreshAccessToken: true,
    });
  }
  if (response.status === 403) {
    return new YahooReadClientError({
      code: "FORBIDDEN",
      message: "Yahoo denied access to this Fantasy resource",
      status: 403,
    });
  }
  if (response.status === 429) {
    return new YahooReadClientError({
      code: "RATE_LIMITED",
      message: "Yahoo Fantasy rate limited the request",
      status: 429,
      retryable: true,
      retryAfterMs: retryAfterMs(response.headers.get("retry-after"), now),
    });
  }
  if (response.status >= 500) {
    return new YahooReadClientError({
      code: "UPSTREAM_ERROR",
      message: "Yahoo Fantasy returned a server error",
      status: response.status,
      retryable: true,
      retryAfterMs: retryAfterMs(response.headers.get("retry-after"), now),
    });
  }
  return new YahooReadClientError({
    code: "HTTP_ERROR",
    message: "Yahoo Fantasy rejected the request",
    status: response.status,
  });
}

export class YahooFantasyReadClient {
  readonly #fetch: YahooFetchLike;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #gate: RequestGate;
  readonly #inflight = new Map<string, Promise<YahooXmlArtifact>>();

  public constructor(options: YahooFantasyReadClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? MAX_YAHOO_XML_BYTES;
    const maxConcurrentRequests = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;

    positiveInteger(this.#timeoutMs, "Yahoo read timeout in milliseconds", 60_000);
    if (this.#timeoutMs < 500) throw new TypeError("Yahoo read timeout must be at least 500 ms");
    positiveInteger(this.#maxResponseBytes, "Yahoo XML size limit in bytes", MAX_YAHOO_XML_BYTES);
    positiveInteger(maxConcurrentRequests, "Yahoo maximum concurrent requests", 16);
    this.#gate = new RequestGate(maxConcurrentRequests);
  }

  public getUserGames(
    request: YahooReadRequest,
    options: YahooUserGamesOptions = {},
  ): Promise<YahooXmlArtifact> {
    const gameCodes = uniqueList(options.gameCodes ?? ["nfl"], "Yahoo game codes").map(gameCode);
    const parameters: [string, string][] = [["game_codes", listValue(gameCodes)]];
    if (options.seasons !== undefined) {
      const seasons = uniqueList(options.seasons, "Yahoo seasons").map((value) => season(value));
      parameters.push(["seasons", listValue(seasons)]);
    }
    if (options.availableOnly === true) parameters.push(["is_available", "1"]);
    return this.#read(withParameters("/users;use_login=1/games", parameters), request);
  }

  public getUserLeagues(
    request: YahooReadRequest,
    options: YahooUserLeaguesOptions = {},
  ): Promise<YahooXmlArtifact> {
    const gameKeys = uniqueList(options.gameKeys ?? ["nfl"], "Yahoo game keys").map(gameKey);
    const leagues = withParameters("leagues", [
      ["start", encoded(collectionStart(options.start ?? 0))],
      [
        "count",
        encoded(
          positiveInteger(
            options.count ?? DEFAULT_COLLECTION_PAGE_SIZE,
            "Yahoo league count",
            MAX_COLLECTION_PAGE_SIZE,
          ),
        ),
      ],
    ]);
    return this.#read(
      `${withParameters("/users;use_login=1/games", [["game_keys", listValue(gameKeys)]])}/${leagues}`,
      request,
    );
  }

  public getLeagueSettings(
    request: YahooReadRequest,
    yahooLeagueKey: string,
  ): Promise<YahooXmlArtifact> {
    return this.#leagueResource(request, yahooLeagueKey, "settings");
  }

  public getLeagueTeams(
    request: YahooReadRequest,
    yahooLeagueKey: string,
  ): Promise<YahooXmlArtifact> {
    return this.#leagueResource(request, yahooLeagueKey, "teams");
  }

  public getLeagueRosters(
    request: YahooReadRequest,
    yahooLeagueKey: string,
    options: YahooWeekOptions = {},
  ): Promise<YahooXmlArtifact> {
    const roster =
      options.week === undefined
        ? "roster"
        : withParameters("roster", [["week", encoded(week(options.week))]]);
    return this.#read(`/league/${leagueKey(yahooLeagueKey)}/teams/${roster}/players`, request);
  }

  /** Yahoo calls the league-level matchup resource `scoreboard`. */
  public getLeagueMatchups(
    request: YahooReadRequest,
    yahooLeagueKey: string,
    options: YahooWeekOptions = {},
  ): Promise<YahooXmlArtifact> {
    const scoreboard =
      options.week === undefined
        ? "scoreboard"
        : withParameters("scoreboard", [["week", encoded(week(options.week))]]);
    return this.#leagueResource(request, yahooLeagueKey, scoreboard);
  }

  public getLeagueStandings(
    request: YahooReadRequest,
    yahooLeagueKey: string,
  ): Promise<YahooXmlArtifact> {
    return this.#leagueResource(request, yahooLeagueKey, "standings");
  }

  public getLeagueTransactions(
    request: YahooReadRequest,
    yahooLeagueKey: string,
    options: YahooLeagueTransactionsOptions = {},
  ): Promise<YahooXmlArtifact> {
    const parameters: [string, string][] = [];
    if (options.types !== undefined) {
      const types = uniqueList(options.types, "Yahoo transaction types", 6);
      if (types.some((type) => !YAHOO_TRANSACTION_TYPES.has(type))) {
        throw new TypeError("Invalid Yahoo transaction type");
      }
      const pendingType = types.find((type) => type === "waiver" || type === "pending_trade");
      if (pendingType !== undefined) {
        if (types.length !== 1 || options.teamKey === undefined) {
          throw new TypeError(
            "Yahoo pending waiver or trade reads require one type and a team key",
          );
        }
        parameters.push(["type", pendingType]);
      } else {
        parameters.push(["types", listValue(types)]);
      }
    }
    if (options.teamKey !== undefined)
      parameters.push(["team_key", encoded(teamKey(options.teamKey))]);
    const count = positiveInteger(
      options.count ?? DEFAULT_COLLECTION_PAGE_SIZE,
      "Yahoo transaction count",
      MAX_COLLECTION_PAGE_SIZE,
    );
    parameters.push(["count", encoded(count)]);
    return this.#leagueResource(
      request,
      yahooLeagueKey,
      withParameters("transactions", parameters),
    );
  }

  public getLeaguePlayers(
    request: YahooReadRequest,
    yahooLeagueKey: string,
    options: YahooLeaguePlayersOptions = {},
  ): Promise<YahooXmlArtifact> {
    const parameters: [string, string][] = [];
    if (options.status !== undefined) {
      if (!YAHOO_PLAYER_STATUSES.has(options.status)) {
        throw new TypeError("Invalid Yahoo player status");
      }
      parameters.push(["status", encoded(options.status)]);
    }
    if (options.position !== undefined) {
      if (!/^[A-Za-z0-9+/-]{1,16}$/u.test(options.position)) {
        throw new TypeError("Invalid Yahoo player position");
      }
      parameters.push(["position", encoded(options.position)]);
    }
    if (options.search !== undefined) {
      const search = options.search.trim();
      if (search.length < 1 || search.length > 64 || hasAsciiControl(search, false)) {
        throw new TypeError("Yahoo player search must contain between 1 and 64 safe characters");
      }
      parameters.push(["search", encoded(search)]);
    }
    if (options.sort !== undefined) {
      if (!/^(?:AR|NAME|OR|PTS|[0-9]{1,6})$/u.test(options.sort)) {
        throw new TypeError("Invalid Yahoo player sort");
      }
      parameters.push(["sort", encoded(options.sort)]);
    }
    if (options.sortType !== undefined) {
      if (!YAHOO_PLAYER_SORT_TYPES.has(options.sortType)) {
        throw new TypeError("Invalid Yahoo player sort type");
      }
      parameters.push(["sort_type", encoded(options.sortType)]);
    }
    if (options.sortSeason !== undefined) {
      parameters.push([
        "sort_season",
        encoded(season(options.sortSeason, "Yahoo player sort season")),
      ]);
    }
    if (options.sortWeek !== undefined) {
      parameters.push(["sort_week", encoded(week(options.sortWeek))]);
    }
    parameters.push(["start", encoded(collectionStart(options.start ?? 0))]);
    parameters.push([
      "count",
      encoded(
        positiveInteger(
          options.count ?? DEFAULT_COLLECTION_PAGE_SIZE,
          "Yahoo player count",
          MAX_COLLECTION_PAGE_SIZE,
        ),
      ),
    ]);
    return this.#leagueResource(request, yahooLeagueKey, withParameters("players", parameters));
  }

  public getLeagueDraftResults(
    request: YahooReadRequest,
    yahooLeagueKey: string,
  ): Promise<YahooXmlArtifact> {
    return this.#leagueResource(request, yahooLeagueKey, "draftresults");
  }

  /** Normalize only a response shape already supported by the strict league XML parser. */
  public normalizeLeagueArtifact(
    artifact: YahooXmlArtifact,
    options: { readonly fallbackSeason?: number } = {},
  ): LeagueSyncBundle {
    let endpoint: URL;
    try {
      endpoint = new URL(artifact.endpoint);
    } catch {
      throw new TypeError("Yahoo league artifact endpoint must be an absolute URL");
    }
    assertFixedYahooUrl(endpoint);
    const fetchedAt = new Date(artifact.fetchedAt);
    if (!Number.isFinite(fetchedAt.getTime())) {
      throw new TypeError("Yahoo league artifact fetchedAt must be a valid timestamp");
    }
    const parsedOptions: Parameters<typeof parseYahooLeagueXml>[1] = {
      fetchedAt,
      endpoint: endpoint.href,
      ...(options.fallbackSeason === undefined
        ? {}
        : { fallbackSeason: season(options.fallbackSeason) }),
    };
    return parseYahooLeagueXml(artifact.xml, parsedOptions);
  }

  #leagueResource(
    request: YahooReadRequest,
    yahooLeagueKey: string,
    resource: string,
  ): Promise<YahooXmlArtifact> {
    return this.#read(`/league/${leagueKey(yahooLeagueKey)}/${resource}`, request);
  }

  #read(path: string, request: YahooReadRequest): Promise<YahooXmlArtifact> {
    validateAccessToken(request.accessToken);
    const url = new URL(`${YAHOO_FANTASY_API_PREFIX}${path}`, YAHOO_FANTASY_API_ORIGIN);
    assertFixedYahooUrl(url);
    if (request.signal !== undefined) return this.#perform(url, request);

    // Token fingerprinting prevents coalescing identical private URLs across Yahoo accounts.
    const tokenFingerprint = createHash("sha256").update(request.accessToken, "utf8").digest("hex");
    const key = `${tokenFingerprint}:${url.href}`;
    const existing = this.#inflight.get(key);
    if (existing !== undefined) return existing;

    const pending = this.#perform(url, request);
    this.#inflight.set(key, pending);
    const cleanup = (): void => {
      if (this.#inflight.get(key) === pending) this.#inflight.delete(key);
    };
    void pending.then(cleanup, cleanup);
    return pending;
  }

  async #perform(url: URL, request: YahooReadRequest): Promise<YahooXmlArtifact> {
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const signal =
      request.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([request.signal, timeoutSignal]);
    let release: (() => void) | undefined;
    try {
      release = await this.#gate.acquire(signal);
      const response = await this.#fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/xml, text/xml;q=0.9",
          Authorization: `Bearer ${request.accessToken}`,
        },
        redirect: "error",
        signal,
      });

      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        await discardBody(response);
        throw new YahooReadClientError({
          code: "REDIRECT",
          message: "Yahoo Fantasy response attempted a redirect",
          status: response.status,
        });
      }
      if (response.url !== "") {
        let finalUrl: URL;
        try {
          finalUrl = new URL(response.url);
        } catch {
          await discardBody(response);
          throw new YahooReadClientError({
            code: "INVALID_RESPONSE",
            message: "Yahoo Fantasy response URL was invalid",
            status: response.status,
          });
        }
        try {
          assertFixedYahooUrl(finalUrl);
        } catch (error) {
          await discardBody(response);
          throw error;
        }
        if (finalUrl.href !== url.href) {
          await discardBody(response);
          throw new YahooReadClientError({
            code: "REDIRECT",
            message: "Yahoo Fantasy response URL did not match the requested URL",
            status: response.status,
          });
        }
      }
      if (!response.ok) {
        await discardBody(response);
        throw statusError(response, this.#now());
      }

      const contentType = xmlContentType(response.headers.get("content-type"));
      if (contentType === null) {
        await discardBody(response);
        throw new YahooReadClientError({
          code: "UNSUPPORTED_CONTENT_TYPE",
          message: "Yahoo Fantasy response did not declare a supported XML content type",
          status: response.status,
        });
      }
      const xml = await readBoundedXml(response, this.#maxResponseBytes);
      try {
        parseYahooXml(xml);
      } catch (error) {
        if (error instanceof YahooXmlError) {
          throw new YahooReadClientError({
            code: error.code === "TOO_LARGE" ? "TOO_LARGE" : "INVALID_RESPONSE",
            message: "Yahoo Fantasy response failed secure XML validation",
            status: response.status,
          });
        }
        throw error;
      }
      return {
        xml,
        endpoint: url.href,
        fetchedAt: this.#now().toISOString(),
        contentType,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
      };
    } catch (error) {
      if (error instanceof YahooReadClientError) throw error;
      if (request.signal?.aborted === true) {
        throw new YahooReadClientError({
          code: "ABORTED",
          message: "Yahoo Fantasy request was aborted",
        });
      }
      if (timeoutSignal.aborted) {
        throw new YahooReadClientError({
          code: "TIMEOUT",
          message: "Yahoo Fantasy request timed out",
          retryable: true,
        });
      }
      throw new YahooReadClientError({
        code: "NETWORK",
        message: "Yahoo Fantasy request failed",
        retryable: true,
      });
    } finally {
      release?.();
    }
  }
}
