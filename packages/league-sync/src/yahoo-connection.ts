import {
  createYahooAuthorizationRequest,
  hashOAuthState,
  verifyOAuthState,
  YahooTokenClient,
  YahooTokenClientError,
  YAHOO_CAPABILITIES,
  type YahooTokenSet,
} from "@fantasy/connector-yahoo";
import type { YahooReturnMode } from "@fantasy/contracts";
import { oauthStates, providerConnections, type Database } from "@fantasy/db";
import { decryptCredential, encryptCredential, type CredentialKey } from "@fantasy/security";
import { and, eq, gt, isNull } from "drizzle-orm";

interface StoredPkce {
  readonly codeVerifier: string;
}

interface StoredYahooCredential {
  readonly credentialVersion: number;
  readonly tokenSet: YahooTokenSet;
}

export interface StartYahooConnectionResult {
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}

export interface YahooConnectionCompletionTarget {
  readonly returnMode: YahooReturnMode;
  readonly returnTo: string;
}

export interface CompleteYahooConnectionResult extends YahooConnectionCompletionTarget {
  readonly connectionId: string;
}

export class YahooConnectionError extends Error {
  readonly code:
    | "INVALID_RETURN"
    | "INVALID_RETURN_MODE"
    | "INVALID_STATE"
    | "STATE_EXPIRED"
    | "STATE_REPLAYED"
    | "MISSING_ACCOUNT_ID"
    | "CONNECTION_NOT_FOUND"
    | "CREDENTIAL_CONFLICT"
    | "REAUTHORIZATION_REQUIRED";

  constructor(code: YahooConnectionError["code"], message: string) {
    super(message);
    this.name = "YahooConnectionError";
    this.code = code;
  }
}

/**
 * Raised only after a state was authenticated and atomically consumed. Its completion target is
 * therefore safe to use for a fixed native callback; state failures never receive this context.
 */
export class YahooConnectionCallbackError extends Error {
  readonly outcome: "unavailable" | "failed";
  readonly completion: YahooConnectionCompletionTarget;

  constructor(
    outcome: YahooConnectionCallbackError["outcome"],
    completion: YahooConnectionCompletionTarget,
  ) {
    super(
      outcome === "unavailable"
        ? "Yahoo authorization is temporarily unavailable"
        : "Yahoo authorization could not be completed",
    );
    this.name = "YahooConnectionCallbackError";
    this.outcome = outcome;
    this.completion = completion;
  }
}

function assertReturnTo(returnTo: string): void {
  if (!/^\/(?!\/)[\x20-\x7E]*$/u.test(returnTo) || returnTo.includes("\\")) {
    throw new YahooConnectionError("INVALID_RETURN", "Yahoo return path is invalid");
  }
}

function assertReturnMode(returnMode: string): asserts returnMode is YahooReturnMode {
  if (returnMode !== "browser" && returnMode !== "ios-app") {
    throw new YahooConnectionError("INVALID_RETURN_MODE", "Yahoo return mode is invalid");
  }
}

function callbackFailureOutcome(error: unknown): YahooConnectionCallbackError["outcome"] {
  return error instanceof YahooTokenClientError && error.retryable ? "unavailable" : "failed";
}

function pkcePurpose(userId: string, stateHash: string): string {
  return `yahoo-pkce:${userId}:${stateHash}`;
}

function tokenPurpose(userId: string, yahooGuid: string): string {
  return `yahoo-token:${userId}:${yahooGuid}`;
}

export class YahooConnectionService {
  readonly #database: Database;
  readonly #key: CredentialKey;
  readonly #clientId: string;
  readonly #redirectUri: string;
  readonly #tokenClient: YahooTokenClient;
  readonly #now: () => Date;

  constructor(input: {
    readonly database: Database;
    readonly credentialKey: CredentialKey;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
    readonly now?: () => Date;
    readonly fetch?: typeof fetch;
  }) {
    this.#database = input.database;
    this.#key = input.credentialKey;
    this.#clientId = input.clientId;
    this.#redirectUri = input.redirectUri;
    this.#now = input.now ?? (() => new Date());
    this.#tokenClient = new YahooTokenClient({
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      redirectUri: input.redirectUri,
      now: this.#now,
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });
  }

  async start(
    userId: string,
    input: { readonly returnMode: YahooReturnMode; readonly returnTo: string },
  ): Promise<StartYahooConnectionResult> {
    assertReturnMode(input.returnMode);
    assertReturnTo(input.returnTo);
    const request = createYahooAuthorizationRequest({
      clientId: this.#clientId,
      redirectUri: this.#redirectUri,
      now: this.#now,
    });
    const encryptedPkceVerifier = encryptCredential(
      { codeVerifier: request.codeVerifier } satisfies StoredPkce,
      this.#key,
      { purpose: pkcePurpose(userId, request.stateHash), now: this.#now },
    );
    await this.#database.insert(oauthStates).values({
      stateHash: request.stateHash,
      userId,
      provider: "yahoo",
      encryptedPkceVerifier: encryptedPkceVerifier as unknown as Record<string, unknown>,
      returnTo: input.returnTo,
      returnMode: input.returnMode,
      expiresAt: new Date(request.expiresAt),
    });
    return { authorizationUrl: request.authorizationUrl, expiresAt: request.expiresAt };
  }

  async #claimState(userId: string, returnedState: string) {
    let stateHash: string;
    try {
      stateHash = hashOAuthState(returnedState);
    } catch {
      throw new YahooConnectionError("INVALID_STATE", "Yahoo OAuth state is invalid");
    }
    const now = this.#now();
    return this.#database.transaction(async (transaction) => {
      const [state] = await transaction
        .select()
        .from(oauthStates)
        .where(
          and(
            eq(oauthStates.stateHash, stateHash),
            eq(oauthStates.userId, userId),
            eq(oauthStates.provider, "yahoo"),
          ),
        )
        .limit(1)
        .for("update");
      if (!state) {
        throw new YahooConnectionError(
          "INVALID_STATE",
          "Yahoo OAuth state is invalid or belongs to another member",
        );
      }
      if (state.consumedAt) {
        throw new YahooConnectionError("STATE_REPLAYED", "Yahoo OAuth state was already consumed");
      }
      if (state.expiresAt.getTime() <= now.getTime()) {
        throw new YahooConnectionError("STATE_EXPIRED", "Yahoo OAuth state expired");
      }
      const verification = verifyOAuthState({
        returnedState,
        expectedStateHash: state.stateHash,
        expiresAt: state.expiresAt.toISOString(),
        now: () => now,
      });
      if (!verification.valid) {
        throw new YahooConnectionError("INVALID_STATE", "Yahoo OAuth state verification failed");
      }

      const consumed = await transaction
        .update(oauthStates)
        .set({ consumedAt: now })
        .where(
          and(
            eq(oauthStates.stateHash, state.stateHash),
            eq(oauthStates.userId, userId),
            eq(oauthStates.provider, "yahoo"),
            isNull(oauthStates.consumedAt),
            gt(oauthStates.expiresAt, now),
          ),
        )
        .returning({ stateHash: oauthStates.stateHash });
      if (consumed.length !== 1) {
        throw new YahooConnectionError("STATE_REPLAYED", "Yahoo OAuth state was already consumed");
      }
      return state;
    });
  }

  #completionTarget(state: {
    readonly returnMode: string;
    readonly returnTo: string;
  }): YahooConnectionCompletionTarget {
    assertReturnMode(state.returnMode);
    assertReturnTo(state.returnTo);
    return { returnMode: state.returnMode, returnTo: state.returnTo };
  }

  /** Consume a provider denial/error exactly once before choosing browser or native completion. */
  async deny(userId: string, state: string): Promise<YahooConnectionCompletionTarget> {
    return this.#completionTarget(await this.#claimState(userId, state));
  }

  async complete(
    userId: string,
    input: { readonly code: string; readonly state: string },
  ): Promise<CompleteYahooConnectionResult> {
    const state = await this.#claimState(userId, input.state);
    const completion = this.#completionTarget(state);
    try {
      const pkce = decryptCredential<StoredPkce>(state.encryptedPkceVerifier, this.#key, {
        expectedPurpose: pkcePurpose(userId, state.stateHash),
      });
      const grant = await this.#tokenClient.exchangeAuthorizationCode({
        code: input.code,
        codeVerifier: pkce.codeVerifier,
      });
      const yahooGuid = grant.tokenSet.yahooGuid;
      if (!yahooGuid) {
        throw new YahooConnectionError(
          "MISSING_ACCOUNT_ID",
          "Yahoo authorization did not return an account identifier",
        );
      }
      const encryptedCredential = encryptCredential(
        {
          credentialVersion: grant.credentialVersion,
          tokenSet: grant.tokenSet,
        } satisfies StoredYahooCredential,
        this.#key,
        { purpose: tokenPurpose(userId, yahooGuid), now: this.#now },
      );
      const capabilities = JSON.parse(JSON.stringify(YAHOO_CAPABILITIES)) as Record<
        string,
        string | boolean
      >;
      const now = this.#now();
      const [connection] = await this.#database
        .insert(providerConnections)
        .values({
          userId,
          provider: "yahoo",
          externalAccountId: yahooGuid,
          displayName: "Yahoo Fantasy",
          encryptedCredential: encryptedCredential as unknown as Record<string, unknown>,
          credentialVersion: grant.credentialVersion,
          credentialExpiresAt: new Date(grant.tokenSet.expiresAt),
          capabilities,
          health: "healthy",
          lastSuccessfulAt: now,
        })
        .onConflictDoUpdate({
          target: [
            providerConnections.userId,
            providerConnections.provider,
            providerConnections.externalAccountId,
          ],
          set: {
            encryptedCredential: encryptedCredential as unknown as Record<string, unknown>,
            credentialVersion: grant.credentialVersion,
            credentialExpiresAt: new Date(grant.tokenSet.expiresAt),
            capabilities,
            health: "healthy",
            lastSuccessfulAt: now,
            lastErrorCode: null,
            lastErrorAt: null,
            updatedAt: now,
          },
        })
        .returning({ id: providerConnections.id });
      if (!connection) throw new Error("Yahoo connection could not be stored");
      return { connectionId: connection.id, ...completion };
    } catch (error) {
      throw new YahooConnectionCallbackError(callbackFailureOutcome(error), completion);
    }
  }

  async refresh(
    userId: string,
    connectionId: string,
    expectedCredentialVersion?: number,
  ): Promise<YahooTokenSet> {
    if (
      expectedCredentialVersion !== undefined &&
      (!Number.isSafeInteger(expectedCredentialVersion) || expectedCredentialVersion < 1)
    ) {
      throw new TypeError("Expected Yahoo credential version must be a positive integer");
    }
    try {
      return await this.#database.transaction(async (transaction) => {
        // Yahoo may rotate refresh tokens. The row lock intentionally spans the upstream token
        // exchange so only one process can spend the current refresh token for this connection.
        const [connection] = await transaction
          .select()
          .from(providerConnections)
          .where(
            and(
              eq(providerConnections.id, connectionId),
              eq(providerConnections.userId, userId),
              eq(providerConnections.provider, "yahoo"),
            ),
          )
          .limit(1)
          .for("update");
        if (!connection?.encryptedCredential) {
          throw new YahooConnectionError("CONNECTION_NOT_FOUND", "Yahoo connection was not found");
        }
        const stored = decryptCredential<StoredYahooCredential>(
          connection.encryptedCredential,
          this.#key,
          { expectedPurpose: tokenPurpose(userId, connection.externalAccountId) },
        );
        if (stored.credentialVersion !== connection.credentialVersion) {
          throw new YahooConnectionError(
            "CREDENTIAL_CONFLICT",
            "Yahoo credential metadata is inconsistent",
          );
        }
        // A concurrent caller may have refreshed while this caller waited on the row lock.
        // Reuse the winning token instead of spending the newly rotated refresh token again.
        if (
          expectedCredentialVersion !== undefined &&
          connection.credentialVersion !== expectedCredentialVersion
        ) {
          return stored.tokenSet;
        }

        const refreshed = await this.#tokenClient.refresh({
          refreshToken: stored.tokenSet.refreshToken,
          expectedCredentialVersion: connection.credentialVersion,
        });
        const tokenSet: YahooTokenSet = {
          ...refreshed.tokenSet,
          yahooGuid: refreshed.tokenSet.yahooGuid ?? stored.tokenSet.yahooGuid,
          scope: refreshed.tokenSet.scope ?? stored.tokenSet.scope,
        };
        if (tokenSet.yahooGuid !== connection.externalAccountId) {
          throw new YahooConnectionError(
            "MISSING_ACCOUNT_ID",
            "Yahoo refreshed credential belongs to an unexpected account",
          );
        }
        const encryptedCredential = encryptCredential(
          {
            credentialVersion: refreshed.atomicRotation.nextCredentialVersion,
            tokenSet,
          } satisfies StoredYahooCredential,
          this.#key,
          { purpose: tokenPurpose(userId, connection.externalAccountId), now: this.#now },
        );
        const now = this.#now();
        const updated = await transaction
          .update(providerConnections)
          .set({
            encryptedCredential: encryptedCredential as unknown as Record<string, unknown>,
            credentialVersion: refreshed.atomicRotation.nextCredentialVersion,
            credentialExpiresAt: new Date(tokenSet.expiresAt),
            health: "healthy",
            lastSuccessfulAt: now,
            lastErrorCode: null,
            lastErrorAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(providerConnections.id, connection.id),
              eq(
                providerConnections.credentialVersion,
                refreshed.atomicRotation.expectedCredentialVersion,
              ),
            ),
          )
          .returning({ id: providerConnections.id });
        if (updated.length !== 1) {
          throw new YahooConnectionError(
            "CREDENTIAL_CONFLICT",
            "Yahoo credential rotation could not be committed",
          );
        }
        return tokenSet;
      });
    } catch (error) {
      if (error instanceof YahooTokenClientError && error.oauthCode === "invalid_grant") {
        const failedAt = this.#now();
        await this.#database
          .update(providerConnections)
          .set({
            health: "reauthorize",
            lastErrorCode: "invalid_grant",
            lastErrorAt: failedAt,
            updatedAt: failedAt,
          })
          .where(
            and(
              eq(providerConnections.id, connectionId),
              eq(providerConnections.userId, userId),
              eq(providerConnections.provider, "yahoo"),
            ),
          );
      }
      throw error;
    }
  }

  async getAccessToken(
    userId: string,
    connectionId: string,
    options: { readonly forceRefresh?: boolean; readonly minimumValiditySeconds?: number } = {},
  ): Promise<string> {
    const minimumValiditySeconds = options.minimumValiditySeconds ?? 120;
    if (
      !Number.isSafeInteger(minimumValiditySeconds) ||
      minimumValiditySeconds < 0 ||
      minimumValiditySeconds > 900
    ) {
      throw new TypeError("Yahoo token validity margin must be between 0 and 900 seconds");
    }
    const [connection] = await this.#database
      .select()
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.id, connectionId),
          eq(providerConnections.userId, userId),
          eq(providerConnections.provider, "yahoo"),
        ),
      )
      .limit(1);
    if (!connection?.encryptedCredential) {
      throw new YahooConnectionError("CONNECTION_NOT_FOUND", "Yahoo connection was not found");
    }
    if (connection.health === "reauthorize" || connection.health === "disabled") {
      throw new YahooConnectionError(
        "REAUTHORIZATION_REQUIRED",
        "Yahoo connection must be authorized again",
      );
    }
    const stored = decryptCredential<StoredYahooCredential>(
      connection.encryptedCredential,
      this.#key,
      {
        expectedPurpose: tokenPurpose(userId, connection.externalAccountId),
      },
    );
    if (stored.credentialVersion !== connection.credentialVersion) {
      throw new YahooConnectionError(
        "CREDENTIAL_CONFLICT",
        "Yahoo credential metadata is inconsistent",
      );
    }
    const expiresAt = Date.parse(stored.tokenSet.expiresAt);
    const needsRefresh =
      options.forceRefresh === true ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= this.#now().getTime() + minimumValiditySeconds * 1000;
    if (!needsRefresh) return stored.tokenSet.accessToken;
    return (await this.refresh(userId, connectionId, connection.credentialVersion)).accessToken;
  }
}
