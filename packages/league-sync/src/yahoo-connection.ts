import {
  createYahooAuthorizationRequest,
  hashOAuthState,
  verifyOAuthState,
  YahooTokenClient,
  YahooTokenClientError,
  YAHOO_CAPABILITIES,
  type YahooTokenSet,
} from "@fantasy/connector-yahoo";
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

export interface CompleteYahooConnectionResult {
  readonly connectionId: string;
  readonly returnTo: string;
}

export class YahooConnectionError extends Error {
  readonly code:
    | "INVALID_RETURN"
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

function assertReturnTo(returnTo: string): void {
  if (!/^\/(?!\/)[\x20-\x7E]*$/u.test(returnTo) || returnTo.includes("\\")) {
    throw new YahooConnectionError("INVALID_RETURN", "Yahoo return path is invalid");
  }
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

  async start(userId: string, returnTo: string): Promise<StartYahooConnectionResult> {
    assertReturnTo(returnTo);
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
      returnTo,
      expiresAt: new Date(request.expiresAt),
    });
    return { authorizationUrl: request.authorizationUrl, expiresAt: request.expiresAt };
  }

  async complete(
    userId: string,
    input: { readonly code: string; readonly state: string },
  ): Promise<CompleteYahooConnectionResult> {
    let stateHash: string;
    try {
      stateHash = hashOAuthState(input.state);
    } catch {
      throw new YahooConnectionError("INVALID_STATE", "Yahoo OAuth state is invalid");
    }
    const now = this.#now();
    const [state] = await this.#database
      .select()
      .from(oauthStates)
      .where(
        and(
          eq(oauthStates.stateHash, stateHash),
          eq(oauthStates.userId, userId),
          isNull(oauthStates.consumedAt),
          gt(oauthStates.expiresAt, now),
        ),
      )
      .limit(1);
    if (!state) {
      throw new YahooConnectionError(
        "STATE_EXPIRED",
        "Yahoo OAuth state expired, was already used, or belongs to another session",
      );
    }
    const verification = verifyOAuthState({
      returnedState: input.state,
      expectedStateHash: state.stateHash,
      expiresAt: state.expiresAt.toISOString(),
      now: this.#now,
    });
    if (!verification.valid) {
      throw new YahooConnectionError("INVALID_STATE", "Yahoo OAuth state verification failed");
    }
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

    const connection = await this.#database.transaction(async (transaction) => {
      const consumed = await transaction
        .update(oauthStates)
        .set({ consumedAt: now })
        .where(and(eq(oauthStates.stateHash, state.stateHash), isNull(oauthStates.consumedAt)))
        .returning({ stateHash: oauthStates.stateHash });
      if (consumed.length !== 1) {
        throw new YahooConnectionError("STATE_REPLAYED", "Yahoo OAuth state was already consumed");
      }

      const [stored] = await transaction
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
      if (!stored) throw new Error("Yahoo connection could not be stored");
      return stored;
    });

    return { connectionId: connection.id, returnTo: state.returnTo };
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
