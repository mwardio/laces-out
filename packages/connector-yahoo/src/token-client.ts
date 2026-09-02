import { redactText } from "@laces-out/security";
import { createRemoteJWKSet, jwtVerify } from "jose";

export const YAHOO_TOKEN_ENDPOINT = "https://api.login.yahoo.com/oauth2/get_token" as const;
export const YAHOO_OPENID_USERINFO_ENDPOINT =
  "https://api.login.yahoo.com/openid/v1/userinfo" as const;
export const YAHOO_OPENID_JWKS_ENDPOINT = "https://api.login.yahoo.com/openid/v1/certs" as const;
const YAHOO_OPENID_ISSUER = "https://api.login.yahoo.com" as const;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const OAUTH_NONCE_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;
const YAHOO_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._~-]{1,255}$/u;

const yahooOpenIdKeys = createRemoteJWKSet(new URL(YAHOO_OPENID_JWKS_ENDPOINT), {
  timeoutDuration: 10_000,
  cooldownDuration: 30_000,
  cacheMaxAge: 10 * 60 * 1000,
});

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface YahooTokenClientOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  /** Test seam for the otherwise network-backed Yahoo OpenID signature verifier. */
  readonly idTokenVerifier?: YahooIdTokenVerifier;
}

export interface YahooIdTokenVerificationInput {
  readonly idToken: string;
  readonly clientId: string;
  readonly expectedNonce: string;
}

export type YahooIdTokenVerifier = (input: YahooIdTokenVerificationInput) => Promise<string>;

export interface YahooTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: string;
  readonly expiresInSeconds: number;
  readonly expiresAt: string;
  readonly yahooGuid: string | null;
  readonly scope: string | null;
}

export interface YahooInitialGrantResult {
  readonly tokenSet: YahooTokenSet;
  /** Initial encrypted credential row/version to insert transactionally. */
  readonly credentialVersion: 1;
}

export interface YahooRefreshResult {
  readonly tokenSet: YahooTokenSet;
  readonly atomicRotation: {
    /** Use in the persistence UPDATE's compare-and-swap WHERE clause. */
    readonly expectedCredentialVersion: number;
    readonly nextCredentialVersion: number;
    readonly refreshTokenRotated: boolean;
  };
}

export class YahooTokenClientError extends Error {
  public readonly status: number | null;
  public readonly oauthCode: string | null;
  public readonly retryable: boolean;

  public constructor(input: {
    message: string;
    status?: number;
    oauthCode?: string;
    retryable?: boolean;
  }) {
    super(redactText(input.message));
    this.name = "YahooTokenClientError";
    this.status = input.status ?? null;
    this.oauthCode = input.oauthCode ?? null;
    this.retryable = input.retryable ?? false;
  }
}

interface TokenResponseShape {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly token_type: string;
  readonly expires_in: number;
  readonly id_token?: string;
  readonly xoauth_yahoo_guid?: string;
  readonly scope?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseTokenResponse(value: unknown): TokenResponseShape {
  const record = asRecord(value);
  if (record === null) {
    throw new YahooTokenClientError({ message: "Yahoo token response was not an object" });
  }
  if (
    typeof record.access_token !== "string" ||
    record.access_token.length < 8 ||
    (record.refresh_token !== undefined &&
      (typeof record.refresh_token !== "string" || record.refresh_token.length < 8)) ||
    typeof record.token_type !== "string" ||
    record.token_type.trim() === "" ||
    typeof record.expires_in !== "number" ||
    !Number.isSafeInteger(record.expires_in) ||
    record.expires_in <= 0 ||
    record.expires_in > 24 * 60 * 60 ||
    (record.id_token !== undefined &&
      (typeof record.id_token !== "string" || record.id_token.length > 16 * 1024)) ||
    (record.xoauth_yahoo_guid !== undefined && typeof record.xoauth_yahoo_guid !== "string") ||
    (record.scope !== undefined && typeof record.scope !== "string")
  ) {
    throw new YahooTokenClientError({ message: "Yahoo token response did not match its contract" });
  }
  return record as unknown as TokenResponseShape;
}

function parseOpenIdIdentityResponse(text: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new YahooTokenClientError({ message: "Yahoo user identity response was not JSON" });
  }
  const subject = asRecord(value)?.sub;
  if (typeof subject !== "string" || !YAHOO_ACCOUNT_ID_PATTERN.test(subject)) {
    throw new YahooTokenClientError({
      message: "Yahoo user identity response did not contain a valid account identifier",
    });
  }
  return subject;
}

async function verifyYahooIdToken(input: YahooIdTokenVerificationInput): Promise<string> {
  try {
    const { payload } = await jwtVerify(input.idToken, yahooOpenIdKeys, {
      algorithms: ["ES256"],
      issuer: YAHOO_OPENID_ISSUER,
      audience: input.clientId,
    });
    if (
      typeof payload.exp !== "number" ||
      typeof payload.iat !== "number" ||
      typeof payload.nonce !== "string" ||
      payload.nonce !== input.expectedNonce ||
      typeof payload.sub !== "string" ||
      !YAHOO_ACCOUNT_ID_PATTERN.test(payload.sub)
    ) {
      throw new YahooTokenClientError({
        message: "Yahoo ID token claims did not match the authorization request",
        oauthCode: "id_token_claims_invalid",
      });
    }
    return payload.sub;
  } catch (error) {
    if (error instanceof YahooTokenClientError) throw error;
    const errorCode = asRecord(error)?.code;
    throw new YahooTokenClientError({
      message: "Yahoo ID token could not be verified",
      oauthCode: "id_token_invalid",
      retryable: errorCode === "ERR_JWKS_TIMEOUT",
    });
  }
}

function validateClientOptions(options: YahooTokenClientOptions): void {
  if (options.clientId.trim() === "" || options.clientSecret.trim() === "") {
    throw new TypeError("Yahoo client ID and client secret are required");
  }
  const redirect = new URL(options.redirectUri);
  const loopback =
    redirect.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname);
  if (redirect.protocol !== "https:" && !loopback) {
    throw new TypeError("Yahoo redirect URI must use HTTPS or a loopback host");
  }
  if (redirect.username !== "" || redirect.password !== "" || redirect.hash !== "") {
    throw new TypeError("Yahoo redirect URI cannot include credentials or a fragment");
  }
}

async function readBoundedTokenBody(response: Response): Promise<string> {
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
      if (totalBytes > MAX_TOKEN_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new YahooTokenClientError({
          message: "Yahoo token response exceeded the size limit",
          status: response.status,
        });
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof YahooTokenClientError) throw error;
    throw new YahooTokenClientError({
      message: "Yahoo token response body could not be read",
      status: response.status,
      retryable: true,
    });
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

export class YahooTokenClient {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #redirectUri: string;
  readonly #fetch: FetchLike;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  readonly #idTokenVerifier: YahooIdTokenVerifier;

  public constructor(options: YahooTokenClientOptions) {
    validateClientOptions(options);
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#redirectUri = options.redirectUri;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#idTokenVerifier = options.idTokenVerifier ?? verifyYahooIdToken;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 500 ||
      this.#timeoutMs > 60_000
    ) {
      throw new TypeError("Yahoo token timeout must be between 500 and 60000 ms");
    }
  }

  public async exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly expectedNonce: string;
    readonly signal?: AbortSignal;
  }): Promise<YahooInitialGrantResult> {
    if (input.code.trim() === "" || input.code.length > 4096) {
      throw new TypeError("Yahoo authorization code is required");
    }
    if (!OAUTH_NONCE_PATTERN.test(input.expectedNonce)) {
      throw new TypeError("Yahoo authorization nonce is invalid");
    }
    const response = await this.#requestToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        redirect_uri: this.#redirectUri,
        code: input.code,
      }),
      input.signal,
    );
    if (response.refresh_token === undefined) {
      throw new YahooTokenClientError({
        message: "Yahoo authorization response omitted the required refresh token",
      });
    }
    const tokenSet = this.#toTokenSet(response, response.refresh_token);
    const yahooGuid =
      tokenSet.yahooGuid ??
      (response.id_token !== undefined
        ? await this.#idTokenVerifier({
            idToken: response.id_token,
            clientId: this.#clientId,
            expectedNonce: input.expectedNonce,
          })
        : await this.#resolveYahooOpenIdSubject(tokenSet.accessToken, input.signal));
    return {
      tokenSet: { ...tokenSet, yahooGuid },
      credentialVersion: 1,
    };
  }

  public async refresh(input: {
    readonly refreshToken: string;
    readonly expectedCredentialVersion: number;
    readonly signal?: AbortSignal;
  }): Promise<YahooRefreshResult> {
    if (input.refreshToken.trim() === "") throw new TypeError("Yahoo refresh token is required");
    if (
      !Number.isSafeInteger(input.expectedCredentialVersion) ||
      input.expectedCredentialVersion < 1
    ) {
      throw new TypeError("Expected credential version must be a positive integer");
    }
    const response = await this.#requestToken(
      new URLSearchParams({
        grant_type: "refresh_token",
        redirect_uri: this.#redirectUri,
        refresh_token: input.refreshToken,
      }),
      input.signal,
    );
    const nextRefreshToken = response.refresh_token ?? input.refreshToken;
    return {
      tokenSet: this.#toTokenSet(response, nextRefreshToken),
      atomicRotation: {
        expectedCredentialVersion: input.expectedCredentialVersion,
        nextCredentialVersion: input.expectedCredentialVersion + 1,
        refreshTokenRotated: nextRefreshToken !== input.refreshToken,
      },
    };
  }

  #toTokenSet(response: TokenResponseShape, refreshToken: string): YahooTokenSet {
    const now = this.#now();
    return {
      accessToken: response.access_token,
      refreshToken,
      tokenType: response.token_type.toLowerCase(),
      expiresInSeconds: response.expires_in,
      expiresAt: new Date(now.getTime() + response.expires_in * 1000).toISOString(),
      yahooGuid: response.xoauth_yahoo_guid ?? null,
      scope: response.scope ?? null,
    };
  }

  async #resolveYahooOpenIdSubject(accessToken: string, signal?: AbortSignal): Promise<string> {
    let response: Response;
    try {
      const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
      const requestSignal =
        signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
      response = await this.#fetch(YAHOO_OPENID_USERINFO_ENDPOINT, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
        redirect: "error",
        signal: requestSignal,
      });
    } catch {
      throw new YahooTokenClientError({
        message: "Yahoo OpenID identity request failed",
        retryable: true,
      });
    }

    const text = await readBoundedTokenBody(response);
    if (!response.ok) {
      throw new YahooTokenClientError({
        message: "Yahoo rejected the OpenID identity request",
        status: response.status,
        oauthCode: "userinfo_failed",
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    return parseOpenIdIdentityResponse(text);
  }

  async #requestToken(body: URLSearchParams, signal?: AbortSignal): Promise<TokenResponseShape> {
    let response: Response;
    try {
      const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
      const requestSignal =
        signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
      const requestInit: RequestInit = {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from(`${this.#clientId}:${this.#clientSecret}`, "utf8").toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        redirect: "error",
        signal: requestSignal,
      };
      response = await this.#fetch(YAHOO_TOKEN_ENDPOINT, requestInit);
    } catch {
      throw new YahooTokenClientError({
        message: "Yahoo token request failed",
        retryable: true,
      });
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_TOKEN_RESPONSE_BYTES) {
      throw new YahooTokenClientError({
        message: "Yahoo token response exceeded the size limit",
        status: response.status,
      });
    }
    const text = await readBoundedTokenBody(response);

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new YahooTokenClientError({
        message: "Yahoo token endpoint returned invalid JSON",
        status: response.status,
        retryable: response.status >= 500,
      });
    }

    if (!response.ok) {
      const error = asRecord(payload);
      const rawOauthCode = typeof error?.error === "string" ? error.error : "token_request_failed";
      const oauthCode = /^[A-Za-z0-9._-]{1,64}$/u.test(rawOauthCode)
        ? rawOauthCode
        : "token_request_failed";
      const description =
        typeof error?.error_description === "string"
          ? redactText(error.error_description).slice(0, 256)
          : "Yahoo rejected the token request";
      throw new YahooTokenClientError({
        message: description,
        status: response.status,
        oauthCode,
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    return parseTokenResponse(payload);
  }
}
