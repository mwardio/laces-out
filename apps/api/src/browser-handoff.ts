import { createHash, randomBytes } from "node:crypto";

import type { BrowserHandoffDestination } from "@laces-out/contracts";
import { browserHandoffTokens, type Database, sessions, users } from "@laces-out/db";
import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";

import { sessionLifetimeSeconds } from "./auth.js";

const CREATION_LIFETIME_MS = 2 * 60 * 1000;
const STAGED_LIFETIME_MS = 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/**
 * The browser session cookie is host-only. Ports may differ during local development, but a
 * different scheme or hostname would strand the cookie away from the web application's API calls.
 */
export function browserHandoffOriginsCompatible(apiUrl: string, webUrl: string): boolean {
  try {
    const api = new URL(apiUrl);
    const web = new URL(webUrl);
    return api.protocol === web.protocol && api.hostname === web.hostname;
  } catch {
    return false;
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function validSessionToken(token: string | undefined): token is string {
  return typeof token === "string" && token.length >= 32 && token.length <= 128;
}

/** Reveals enough to catch a wrong-account handoff without returning the target's full address. */
export function maskBrowserHandoffAccount(email: string): string {
  const separator = email.lastIndexOf("@");
  if (separator <= 0 || separator === email.length - 1) return "your Laces Out account";
  return `${email.slice(0, 1)}***${email.slice(separator)}`;
}

export type BrowserHandoffStoreConsumption =
  | {
      readonly outcome: "session-created";
      readonly userId: string;
      readonly destination: BrowserHandoffDestination;
    }
  | {
      readonly outcome: "session-reused";
      readonly userId: string;
      readonly destination: BrowserHandoffDestination;
    }
  | { readonly outcome: "account-mismatch" };

export type BrowserHandoffConsumption =
  | {
      readonly outcome: "session-created";
      readonly userId: string;
      readonly destination: BrowserHandoffDestination;
      readonly session: { readonly token: string; readonly expiresAt: Date };
    }
  | {
      readonly outcome: "session-reused";
      readonly userId: string;
      readonly destination: BrowserHandoffDestination;
    }
  | { readonly outcome: "account-mismatch" };

export interface BrowserHandoffStore {
  create(input: {
    readonly userId: string;
    readonly sourceSessionTokenHash: string;
    readonly tokenHash: string;
    readonly destination: BrowserHandoffDestination;
    readonly expiresAt: Date;
    readonly createdAt: Date;
  }): Promise<boolean>;
  stage(input: {
    readonly tokenHash: string;
    readonly replacementTokenHash: string;
    readonly stagedAt: Date;
    readonly expiresAt: Date;
  }): Promise<{ readonly accountEmail: string } | undefined>;
  confirm(input: { readonly tokenHash: string; readonly confirmedAt: Date }): Promise<boolean>;
  consume(input: {
    readonly tokenHash: string;
    readonly ambientSessionTokenHash?: string;
    readonly newSessionTokenHash: string;
    readonly newSessionExpiresAt: Date;
    readonly now: Date;
  }): Promise<BrowserHandoffStoreConsumption | undefined>;
}

export interface BrowserHandoffPort {
  create(
    userId: string,
    sourceSessionToken: string | undefined,
    destination: BrowserHandoffDestination,
  ): Promise<{ readonly handoffUrl: string; readonly expiresAt: Date } | undefined>;
  stage(token: string): Promise<
    | {
        readonly redemptionToken: string;
        readonly expiresAt: Date;
        readonly accountHint: string;
      }
    | undefined
  >;
  confirm(redemptionToken: string): Promise<boolean>;
  consume(
    redemptionToken: string,
    ambientSessionToken?: string,
  ): Promise<BrowserHandoffConsumption | undefined>;
}

/**
 * Owns raw bearer generation and hashing. The store boundary can receive digests only, making an
 * accidental database persistence of a URL-fragment, cookie, or ordinary session token impossible.
 */
export class BrowserHandoffService implements BrowserHandoffPort {
  readonly #store: BrowserHandoffStore;
  readonly #apiUrl: string;
  readonly #now: () => Date;
  readonly #randomToken: () => string;

  constructor(
    store: BrowserHandoffStore,
    apiUrl: string,
    now: () => Date = () => new Date(),
    randomToken: () => string = () => randomBytes(32).toString("base64url"),
  ) {
    this.#store = store;
    this.#apiUrl = apiUrl;
    this.#now = now;
    this.#randomToken = randomToken;
  }

  async create(
    userId: string,
    sourceSessionToken: string | undefined,
    destination: BrowserHandoffDestination,
  ): Promise<{ readonly handoffUrl: string; readonly expiresAt: Date } | undefined> {
    if (!validSessionToken(sourceSessionToken)) return undefined;
    const token = this.#randomToken();
    if (!TOKEN_PATTERN.test(token)) throw new Error("Browser handoff token generator failed");
    const createdAt = this.#now();
    const expiresAt = new Date(createdAt.getTime() + CREATION_LIFETIME_MS);
    const created = await this.#store.create({
      userId,
      sourceSessionTokenHash: tokenHash(sourceSessionToken),
      tokenHash: tokenHash(token),
      destination,
      expiresAt,
      createdAt,
    });
    if (!created) return undefined;
    const handoffUrl = new URL("/v1/auth/browser-handoff", this.#apiUrl);
    // Fragments are not included in HTTP requests or Referer headers. The landing document removes
    // this value from browser history before sending it in a redacted request body.
    handoffUrl.hash = token;
    return { handoffUrl: handoffUrl.toString(), expiresAt };
  }

  async stage(token: string): Promise<
    | {
        readonly redemptionToken: string;
        readonly expiresAt: Date;
        readonly accountHint: string;
      }
    | undefined
  > {
    if (!TOKEN_PATTERN.test(token)) return undefined;
    const redemptionToken = this.#randomToken();
    if (!TOKEN_PATTERN.test(redemptionToken)) {
      throw new Error("Browser handoff token generator failed");
    }
    const stagedAt = this.#now();
    const expiresAt = new Date(stagedAt.getTime() + STAGED_LIFETIME_MS);
    const staged = await this.#store.stage({
      tokenHash: tokenHash(token),
      replacementTokenHash: tokenHash(redemptionToken),
      stagedAt,
      expiresAt,
    });
    return staged
      ? {
          redemptionToken,
          expiresAt,
          accountHint: maskBrowserHandoffAccount(staged.accountEmail),
        }
      : undefined;
  }

  async confirm(redemptionToken: string): Promise<boolean> {
    if (!TOKEN_PATTERN.test(redemptionToken)) return false;
    return this.#store.confirm({
      tokenHash: tokenHash(redemptionToken),
      confirmedAt: this.#now(),
    });
  }

  async consume(
    redemptionToken: string,
    ambientSessionToken?: string,
  ): Promise<BrowserHandoffConsumption | undefined> {
    if (!TOKEN_PATTERN.test(redemptionToken)) return undefined;
    const newSessionToken = this.#randomToken();
    if (!TOKEN_PATTERN.test(newSessionToken)) {
      throw new Error("Browser handoff token generator failed");
    }
    const now = this.#now();
    const newSessionExpiresAt = new Date(now.getTime() + sessionLifetimeSeconds * 1000);
    const consumed = await this.#store.consume({
      tokenHash: tokenHash(redemptionToken),
      ...(validSessionToken(ambientSessionToken)
        ? { ambientSessionTokenHash: tokenHash(ambientSessionToken) }
        : {}),
      newSessionTokenHash: tokenHash(newSessionToken),
      newSessionExpiresAt,
      now,
    });
    if (!consumed || consumed.outcome !== "session-created") return consumed;
    return {
      ...consumed,
      session: { token: newSessionToken, expiresAt: newSessionExpiresAt },
    };
  }
}

export class DrizzleBrowserHandoffStore implements BrowserHandoffStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async create(input: {
    readonly userId: string;
    readonly sourceSessionTokenHash: string;
    readonly tokenHash: string;
    readonly destination: BrowserHandoffDestination;
    readonly expiresAt: Date;
    readonly createdAt: Date;
  }): Promise<boolean> {
    return this.#database.transaction(async (transaction) => {
      // User-first lock ordering matches password change and account deletion. Once held, those
      // operations either precede this creation or wait and invalidate the newly-created handoff.
      const [user] = await transaction
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1)
        .for("key share");
      if (!user) return false;

      const [sourceSession] = await transaction
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            eq(sessions.userId, input.userId),
            eq(sessions.tokenHash, input.sourceSessionTokenHash),
            gt(sessions.expiresAt, input.createdAt),
          ),
        )
        .limit(1)
        .for("key share");
      if (!sourceSession) return false;

      await transaction
        .insert(browserHandoffTokens)
        .values({
          userId: input.userId,
          sourceSessionId: sourceSession.id,
          tokenHash: input.tokenHash,
          destination: input.destination,
          expiresAt: input.expiresAt,
          stagedAt: null,
          confirmedAt: null,
          createdAt: input.createdAt,
        })
        .onConflictDoUpdate({
          target: browserHandoffTokens.userId,
          set: {
            sourceSessionId: sourceSession.id,
            tokenHash: input.tokenHash,
            destination: input.destination,
            expiresAt: input.expiresAt,
            stagedAt: null,
            confirmedAt: null,
            createdAt: input.createdAt,
          },
        });
      return true;
    });
  }

  async stage(input: {
    readonly tokenHash: string;
    readonly replacementTokenHash: string;
    readonly stagedAt: Date;
    readonly expiresAt: Date;
  }): Promise<{ readonly accountEmail: string } | undefined> {
    return this.#database.transaction(async (transaction) => {
      const [candidate] = await transaction
        .select({
          id: browserHandoffTokens.id,
          userId: browserHandoffTokens.userId,
          sourceSessionId: browserHandoffTokens.sourceSessionId,
        })
        .from(browserHandoffTokens)
        .where(
          and(
            eq(browserHandoffTokens.tokenHash, input.tokenHash),
            isNull(browserHandoffTokens.stagedAt),
            gt(browserHandoffTokens.expiresAt, input.stagedAt),
          ),
        )
        .limit(1);
      if (!candidate) return undefined;

      const [user] = await transaction
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.id, candidate.userId))
        .limit(1)
        .for("key share");
      if (!user) return undefined;

      const [sourceSession] = await transaction
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            eq(sessions.id, candidate.sourceSessionId),
            eq(sessions.userId, candidate.userId),
            gt(sessions.expiresAt, input.stagedAt),
          ),
        )
        .limit(1)
        .for("key share");
      if (!sourceSession) return undefined;

      const rows = await transaction
        .update(browserHandoffTokens)
        .set({
          tokenHash: input.replacementTokenHash,
          stagedAt: input.stagedAt,
          confirmedAt: null,
          expiresAt: input.expiresAt,
        })
        .where(
          and(
            eq(browserHandoffTokens.id, candidate.id),
            eq(browserHandoffTokens.tokenHash, input.tokenHash),
            isNull(browserHandoffTokens.stagedAt),
            gt(browserHandoffTokens.expiresAt, input.stagedAt),
          ),
        )
        .returning({ id: browserHandoffTokens.id });
      return rows.length === 1 ? { accountEmail: user.email } : undefined;
    });
  }

  async confirm(input: {
    readonly tokenHash: string;
    readonly confirmedAt: Date;
  }): Promise<boolean> {
    return this.#database.transaction(async (transaction) => {
      const [candidate] = await transaction
        .select({
          id: browserHandoffTokens.id,
          userId: browserHandoffTokens.userId,
          sourceSessionId: browserHandoffTokens.sourceSessionId,
        })
        .from(browserHandoffTokens)
        .where(
          and(
            eq(browserHandoffTokens.tokenHash, input.tokenHash),
            isNotNull(browserHandoffTokens.stagedAt),
            gt(browserHandoffTokens.expiresAt, input.confirmedAt),
          ),
        )
        .limit(1);
      if (!candidate) return false;

      const [user] = await transaction
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, candidate.userId))
        .limit(1)
        .for("key share");
      if (!user) return false;

      const [sourceSession] = await transaction
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            eq(sessions.id, candidate.sourceSessionId),
            eq(sessions.userId, candidate.userId),
            gt(sessions.expiresAt, input.confirmedAt),
          ),
        )
        .limit(1)
        .for("key share");
      if (!sourceSession) return false;

      const [handoff] = await transaction
        .select({ confirmedAt: browserHandoffTokens.confirmedAt })
        .from(browserHandoffTokens)
        .where(
          and(
            eq(browserHandoffTokens.id, candidate.id),
            eq(browserHandoffTokens.tokenHash, input.tokenHash),
            isNotNull(browserHandoffTokens.stagedAt),
            gt(browserHandoffTokens.expiresAt, input.confirmedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (!handoff) return false;
      if (handoff.confirmedAt) return true;

      const rows = await transaction
        .update(browserHandoffTokens)
        .set({ confirmedAt: input.confirmedAt })
        .where(
          and(
            eq(browserHandoffTokens.id, candidate.id),
            eq(browserHandoffTokens.tokenHash, input.tokenHash),
            isNull(browserHandoffTokens.confirmedAt),
          ),
        )
        .returning({ id: browserHandoffTokens.id });
      return rows.length === 1;
    });
  }

  async consume(input: {
    readonly tokenHash: string;
    readonly ambientSessionTokenHash?: string;
    readonly newSessionTokenHash: string;
    readonly newSessionExpiresAt: Date;
    readonly now: Date;
  }): Promise<BrowserHandoffStoreConsumption | undefined> {
    return this.#database.transaction(async (transaction) => {
      const [candidate] = await transaction
        .select({
          id: browserHandoffTokens.id,
          userId: browserHandoffTokens.userId,
          sourceSessionId: browserHandoffTokens.sourceSessionId,
        })
        .from(browserHandoffTokens)
        .where(
          and(
            eq(browserHandoffTokens.tokenHash, input.tokenHash),
            isNotNull(browserHandoffTokens.stagedAt),
            isNotNull(browserHandoffTokens.confirmedAt),
            gt(browserHandoffTokens.expiresAt, input.now),
          ),
        )
        .limit(1);
      if (!candidate) return undefined;

      const [user] = await transaction
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, candidate.userId))
        .limit(1)
        .for("key share");
      if (!user) return undefined;

      const [sourceSession] = await transaction
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            eq(sessions.id, candidate.sourceSessionId),
            eq(sessions.userId, candidate.userId),
            gt(sessions.expiresAt, input.now),
          ),
        )
        .limit(1)
        .for("key share");
      if (!sourceSession) {
        await transaction
          .delete(browserHandoffTokens)
          .where(eq(browserHandoffTokens.id, candidate.id));
        return undefined;
      }

      const [handoff] = await transaction
        .delete(browserHandoffTokens)
        .where(
          and(
            eq(browserHandoffTokens.id, candidate.id),
            eq(browserHandoffTokens.tokenHash, input.tokenHash),
            isNotNull(browserHandoffTokens.stagedAt),
            isNotNull(browserHandoffTokens.confirmedAt),
            gt(browserHandoffTokens.expiresAt, input.now),
          ),
        )
        .returning({
          userId: browserHandoffTokens.userId,
          destination: browserHandoffTokens.destination,
        });
      if (!handoff) return undefined;

      if (input.ambientSessionTokenHash) {
        const [ambientSession] = await transaction
          .select({ userId: sessions.userId })
          .from(sessions)
          .where(
            and(
              eq(sessions.tokenHash, input.ambientSessionTokenHash),
              gt(sessions.expiresAt, input.now),
            ),
          )
          .limit(1)
          .for("key share");
        if (ambientSession) {
          return ambientSession.userId === handoff.userId
            ? {
                outcome: "session-reused",
                userId: handoff.userId,
                destination: handoff.destination as BrowserHandoffDestination,
              }
            : { outcome: "account-mismatch" };
        }
      }

      await transaction.insert(sessions).values({
        userId: handoff.userId,
        tokenHash: input.newSessionTokenHash,
        expiresAt: input.newSessionExpiresAt,
      });
      return {
        outcome: "session-created",
        userId: handoff.userId,
        destination: handoff.destination as BrowserHandoffDestination,
      };
    });
  }
}
