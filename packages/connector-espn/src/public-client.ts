import { createHash } from "node:crypto";

const ESPN_PUBLIC_API_ORIGIN = "https://lm-api-reads.fantasy.espn.com" as const;
const MAX_PUBLIC_RESPONSE_BYTES = 5 * 1024 * 1024;

export type EspnPublicView = "mSettings" | "mTeam" | "mRoster" | "mStandings" | "mMatchup";

const ALLOWED_VIEWS = new Set<EspnPublicView>([
  "mSettings",
  "mTeam",
  "mRoster",
  "mStandings",
  "mMatchup",
]);

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface EspnPublicReadClientOptions {
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

export interface EspnPublicLeagueRequest {
  readonly leagueId: string;
  readonly season: number;
  readonly views?: readonly EspnPublicView[];
  readonly signal?: AbortSignal;
}

export interface EspnPublicLeagueArtifact {
  readonly provider: "espn";
  readonly authority: "unofficial";
  readonly readOnly: true;
  readonly leagueId: string;
  readonly season: number;
  readonly endpoint: string;
  readonly fetchedAt: string;
  readonly checksumSha256: string;
  readonly payload: unknown;
}

export class EspnPublicReadError extends Error {
  public readonly code:
    "INVALID_REQUEST" | "NOT_PUBLIC" | "UPSTREAM_ERROR" | "INVALID_RESPONSE" | "RESPONSE_TOO_LARGE";
  public readonly status: number | null;
  public readonly retryable: boolean;

  public constructor(input: {
    code:
      | "INVALID_REQUEST"
      | "NOT_PUBLIC"
      | "UPSTREAM_ERROR"
      | "INVALID_RESPONSE"
      | "RESPONSE_TOO_LARGE";
    message: string;
    status?: number;
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = "EspnPublicReadError";
    this.code = input.code;
    this.status = input.status ?? null;
    this.retryable = input.retryable ?? false;
  }
}

function validateRequest(request: EspnPublicLeagueRequest): readonly EspnPublicView[] {
  if (!/^\d{1,20}$/u.test(request.leagueId)) {
    throw new EspnPublicReadError({
      code: "INVALID_REQUEST",
      message: "ESPN public league ID must be numeric",
    });
  }
  if (!Number.isSafeInteger(request.season) || request.season < 2000 || request.season > 2100) {
    throw new EspnPublicReadError({
      code: "INVALID_REQUEST",
      message: "ESPN season is outside the accepted range",
    });
  }
  const views = request.views ?? ["mSettings", "mTeam", "mRoster"];
  if (views.length < 1 || views.length > ALLOWED_VIEWS.size) {
    throw new EspnPublicReadError({
      code: "INVALID_REQUEST",
      message: "ESPN public read requires one to five supported views",
    });
  }
  if (views.some((view) => !ALLOWED_VIEWS.has(view))) {
    throw new EspnPublicReadError({
      code: "INVALID_REQUEST",
      message: "ESPN public read requested an unsupported view",
    });
  }
  return [...new Set(views)];
}

async function readBoundedPublicBody(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PUBLIC_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new EspnPublicReadError({
          code: "RESPONSE_TOO_LARGE",
          message: "ESPN public response exceeded the size limit",
          status: response.status,
        });
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof EspnPublicReadError) throw error;
    throw new EspnPublicReadError({
      code: "UPSTREAM_ERROR",
      message: "ESPN public response body could not be read",
      status: response.status,
      retryable: true,
    });
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

/**
 * Anonymous read boundary for ESPN's undocumented web-client endpoint.
 * It has no credential/cookie parameters, forces `credentials: omit`, and
 * returns an untrusted artifact for a separately versioned normalizer.
 */
export class EspnPublicReadClient {
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #now: () => Date;

  public constructor(options: EspnPublicReadClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#now = options.now ?? (() => new Date());
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 500 ||
      this.#timeoutMs > 60_000
    ) {
      throw new TypeError("ESPN public read timeout must be between 500 and 60000 ms");
    }
  }

  public async fetchLeague(request: EspnPublicLeagueRequest): Promise<EspnPublicLeagueArtifact> {
    const views = validateRequest(request);
    const endpoint = new URL(
      `/apis/v3/games/ffl/seasons/${request.season}/segments/0/leagues/${request.leagueId}`,
      ESPN_PUBLIC_API_ORIGIN,
    );
    for (const view of views) endpoint.searchParams.append("view", view);

    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const requestSignal =
      request.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([request.signal, timeoutSignal]);

    let response: Response;
    try {
      response = await this.#fetch(endpoint, {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: requestSignal,
      });
    } catch (error) {
      throw new EspnPublicReadError({
        code: "UPSTREAM_ERROR",
        message: `ESPN public read failed: ${error instanceof Error ? error.message : "network error"}`,
        retryable: true,
      });
    }

    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new EspnPublicReadError({
        code: "NOT_PUBLIC",
        message: "ESPN league was not anonymously readable; use the browser bridge",
        status: response.status,
      });
    }
    if (!response.ok) {
      throw new EspnPublicReadError({
        code: "UPSTREAM_ERROR",
        message: "ESPN public endpoint returned an error",
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PUBLIC_RESPONSE_BYTES) {
      throw new EspnPublicReadError({
        code: "RESPONSE_TOO_LARGE",
        message: "ESPN public response exceeded the size limit",
        status: response.status,
      });
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("json")) {
      throw new EspnPublicReadError({
        code: "INVALID_RESPONSE",
        message: "ESPN public endpoint did not return JSON",
        status: response.status,
      });
    }
    const text = await readBoundedPublicBody(response);
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new EspnPublicReadError({
        code: "INVALID_RESPONSE",
        message: "ESPN public endpoint returned malformed JSON",
        status: response.status,
      });
    }

    return {
      provider: "espn",
      authority: "unofficial",
      readOnly: true,
      leagueId: request.leagueId,
      season: request.season,
      endpoint: endpoint.toString(),
      fetchedAt: this.#now().toISOString(),
      checksumSha256: createHash("sha256").update(text, "utf8").digest("hex"),
      payload,
    };
  }
}
