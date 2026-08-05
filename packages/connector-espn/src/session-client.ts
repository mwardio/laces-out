import { canonicalEspnPayloadChecksumV1 } from "./payload-checksum.js";

const ESPN_READ_ORIGIN = "https://lm-api-reads.fantasy.espn.com" as const;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const transactionTypes = [
  "DRAFT",
  "TRADE_ACCEPT",
  "WAIVER",
  "TRADE_VETO",
  "FUTURE_ROSTER",
  "ROSTER",
  "RETRO_ROSTER",
  "TRADE_PROPOSAL",
  "TRADE_UPHOLD",
  "FREEAGENT",
  "TRADE_DECLINE",
  "WAIVER_ERROR",
  "TRADE_ERROR",
] as const;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface EspnSessionCredential {
  readonly swid: string;
  readonly espnS2: string;
}

export type EspnSessionSupplementalKind =
  | "available-free-agents"
  | "available-waivers"
  | "weekly-box-scores"
  | "structured-transactions"
  | "completed-draft";

export interface EspnSessionArtifact {
  readonly leagueId: string;
  readonly season: number;
  readonly endpoint: string;
  readonly capturedAt: string;
  readonly checksumSha256: string;
  readonly payload: unknown;
}

export interface EspnSessionSupplementalArtifact extends EspnSessionArtifact {
  readonly kind: EspnSessionSupplementalKind;
  readonly week: number | null;
  readonly matchupPeriodId?: number;
}

export interface EspnSessionLeagueArtifacts {
  readonly core: EspnSessionArtifact;
  readonly supplemental: readonly EspnSessionSupplementalArtifact[];
  readonly supplementalFailures: readonly {
    readonly kind: EspnSessionSupplementalKind;
    readonly code: EspnSessionReadError["code"];
  }[];
}

export class EspnSessionReadError extends Error {
  readonly code:
    | "INVALID_REQUEST"
    | "AUTHORIZATION_EXPIRED"
    | "ACCESS_DENIED"
    | "UPSTREAM_ERROR"
    | "INVALID_RESPONSE"
    | "RESPONSE_TOO_LARGE";
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(input: {
    readonly code: EspnSessionReadError["code"];
    readonly message: string;
    readonly status?: number;
    readonly retryable?: boolean;
  }) {
    super(input.message);
    this.name = "EspnSessionReadError";
    this.code = input.code;
    this.status = input.status ?? null;
    this.retryable = input.retryable ?? false;
  }
}

function normalizedCredential(value: EspnSessionCredential): EspnSessionCredential {
  const swid = value.swid.trim().toLowerCase();
  const espnS2 = value.espnS2.trim();
  if (
    !/^\{[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}$/u.test(swid)
  ) {
    throw new EspnSessionReadError({
      code: "INVALID_REQUEST",
      message: "ESPN SWID is invalid",
    });
  }
  if (espnS2.length < 32 || espnS2.length > 4096 || !/^[^\s;\p{Cc}]+$/u.test(espnS2)) {
    throw new EspnSessionReadError({
      code: "INVALID_REQUEST",
      message: "ESPN session credential is invalid",
    });
  }
  return { swid, espnS2 };
}

export function normalizeEspnSessionCredential(
  value: EspnSessionCredential,
): EspnSessionCredential {
  return normalizedCredential(value);
}

function requestEndpoint(season: number, leagueId: string, views: readonly string[]): URL {
  const endpoint = new URL(
    `/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`,
    ESPN_READ_ORIGIN,
  );
  for (const view of views) endpoint.searchParams.append("view", view);
  return endpoint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function currentScoringPeriod(payload: unknown): number {
  if (!isRecord(payload)) return 0;
  const value = payload.scoringPeriodId;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 30
    ? value
    : 0;
}

function matchupPeriodForWeek(payload: unknown, week: number): number {
  if (!isRecord(payload) || !isRecord(payload.settings)) return week;
  const scheduleSettings = payload.settings.scheduleSettings;
  if (!isRecord(scheduleSettings) || !isRecord(scheduleSettings.matchupPeriods)) return week;
  for (const [period, weeks] of Object.entries(scheduleSettings.matchupPeriods)) {
    if (
      Array.isArray(weeks) &&
      weeks.includes(week) &&
      /^\d+$/u.test(period) &&
      Number(period) >= 1 &&
      Number(period) <= 30
    ) {
      return Number(period);
    }
  }
  return week;
}

interface SupplementalRequest {
  readonly kind: EspnSessionSupplementalKind;
  readonly week: number | null;
  readonly matchupPeriodId?: number;
  readonly views: readonly string[];
  readonly filter: Record<string, unknown> | null;
}

function supplementalRequests(core: unknown): readonly SupplementalRequest[] {
  const week = currentScoringPeriod(core);
  const requests: SupplementalRequest[] = [
    {
      kind: "available-free-agents",
      week,
      views: ["kona_player_info"],
      filter: {
        players: {
          filterStatus: { value: ["FREEAGENT"] },
          limit: 250,
          sortPercOwned: { sortPriority: 1, sortAsc: false },
          sortDraftRanks: { sortPriority: 100, sortAsc: true, value: "STANDARD" },
        },
      },
    },
    {
      kind: "available-waivers",
      week,
      views: ["kona_player_info"],
      filter: {
        players: {
          filterStatus: { value: ["WAIVERS"] },
          limit: 250,
          sortPercOwned: { sortPriority: 1, sortAsc: false },
          sortDraftRanks: { sortPriority: 100, sortAsc: true, value: "STANDARD" },
        },
      },
    },
    {
      kind: "structured-transactions",
      week,
      views: ["mTransactions2"],
      filter: { transactions: { filterType: { value: [...transactionTypes] } } },
    },
    { kind: "completed-draft", week: null, views: ["mDraftDetail"], filter: null },
  ];
  if (week >= 1) {
    const matchupPeriodId = matchupPeriodForWeek(core, week);
    requests.splice(2, 0, {
      kind: "weekly-box-scores",
      week,
      matchupPeriodId,
      views: ["mMatchupScore", "mScoreboard"],
      filter: { schedule: { filterMatchupPeriodIds: { value: [matchupPeriodId] } } },
    });
  }
  return requests;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new EspnSessionReadError({
      code: "RESPONSE_TOO_LARGE",
      message: "ESPN response exceeded the size limit",
      status: response.status,
    });
  }
  if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("json")) {
    throw new EspnSessionReadError({
      code: "INVALID_RESPONSE",
      message: "ESPN did not return JSON",
      status: response.status,
    });
  }
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new EspnSessionReadError({
        code: "RESPONSE_TOO_LARGE",
        message: "ESPN response exceeded the size limit",
        status: response.status,
      });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new EspnSessionReadError({
      code: "INVALID_RESPONSE",
      message: "ESPN returned malformed JSON",
      status: response.status,
    });
  }
}

export class EspnSessionReadClient {
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #now: () => Date;

  constructor(
    input: {
      readonly fetch?: FetchLike;
      readonly timeoutMs?: number;
      readonly now?: () => Date;
    } = {},
  ) {
    this.#fetch = input.fetch ?? globalThis.fetch;
    this.#timeoutMs = input.timeoutMs ?? 15_000;
    this.#now = input.now ?? (() => new Date());
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 500 ||
      this.#timeoutMs > 60_000
    ) {
      throw new TypeError("ESPN session read timeout must be between 500 and 60000 ms");
    }
  }

  async #read(
    endpoint: URL,
    credential: EspnSessionCredential,
    filter: Record<string, unknown> | null,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.#fetch(endpoint, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Cookie: `SWID=${credential.swid}; espn_s2=${credential.espnS2}`,
          ...(filter ? { "x-fantasy-filter": JSON.stringify(filter) } : {}),
        },
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: requestSignal,
      });
    } catch {
      throw new EspnSessionReadError({
        code: "UPSTREAM_ERROR",
        message: "ESPN could not be reached",
        retryable: true,
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new EspnSessionReadError({
        code: "AUTHORIZATION_EXPIRED",
        message: "ESPN sign-in must be renewed",
        status: response.status,
      });
    }
    if (response.status === 404) {
      throw new EspnSessionReadError({
        code: "ACCESS_DENIED",
        message: "The ESPN league was not available to this account",
        status: response.status,
      });
    }
    if (!response.ok) {
      throw new EspnSessionReadError({
        code: "UPSTREAM_ERROR",
        message: "ESPN returned an error",
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    return readBoundedJson(response);
  }

  async fetchLeague(input: {
    readonly credential: EspnSessionCredential;
    readonly leagueId: string;
    readonly season: number;
    readonly signal?: AbortSignal;
  }): Promise<EspnSessionLeagueArtifacts> {
    if (!/^\d{1,20}$/u.test(input.leagueId) || input.season < 2000 || input.season > 2100) {
      throw new EspnSessionReadError({
        code: "INVALID_REQUEST",
        message: "ESPN league scope is invalid",
      });
    }
    const credential = normalizedCredential(input.credential);
    const coreEndpoint = requestEndpoint(input.season, input.leagueId, [
      "mSettings",
      "mTeam",
      "mRoster",
      "mStandings",
      "mMatchup",
    ]);
    const corePayload = await this.#read(coreEndpoint, credential, null, input.signal);
    const capturedAt = this.#now().toISOString();
    const core: EspnSessionArtifact = {
      leagueId: input.leagueId,
      season: input.season,
      endpoint: coreEndpoint.toString(),
      capturedAt,
      checksumSha256: canonicalEspnPayloadChecksumV1(corePayload),
      payload: corePayload,
    };

    const supplemental: EspnSessionSupplementalArtifact[] = [];
    const supplementalFailures: Array<{
      kind: EspnSessionSupplementalKind;
      code: EspnSessionReadError["code"];
    }> = [];
    for (const request of supplementalRequests(corePayload)) {
      const endpoint = requestEndpoint(input.season, input.leagueId, request.views);
      if (request.week !== null) endpoint.searchParams.set("scoringPeriodId", String(request.week));
      try {
        const payload = await this.#read(endpoint, credential, request.filter, input.signal);
        supplemental.push({
          leagueId: input.leagueId,
          season: input.season,
          endpoint: endpoint.toString(),
          capturedAt: this.#now().toISOString(),
          checksumSha256: canonicalEspnPayloadChecksumV1(payload),
          payload,
          kind: request.kind,
          week: request.week,
          ...(request.matchupPeriodId === undefined
            ? {}
            : { matchupPeriodId: request.matchupPeriodId }),
        });
      } catch (error) {
        if (error instanceof EspnSessionReadError && error.code === "AUTHORIZATION_EXPIRED") {
          throw error;
        }
        supplementalFailures.push({
          kind: request.kind,
          code: error instanceof EspnSessionReadError ? error.code : "UPSTREAM_ERROR",
        });
      }
    }
    return { core, supplemental, supplementalFailures };
  }
}
