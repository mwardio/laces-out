import { hash, verify, type Options as ArgonOptions } from "@node-rs/argon2";
import { createHash, randomBytes } from "node:crypto";

import type { ApplicationRole } from "@laces-out/db";

export const sessionCookieName = "fantasy_session";
export const sessionLifetimeSeconds = 60 * 60 * 24 * 30;

const passwordHashOptions: Readonly<ArgonOptions> = {
  // Argon2id. The package exposes this as an ambient const enum, which cannot
  // be referenced directly under isolatedModules.
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
};

export interface AuthUserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string | null;
  readonly role: ApplicationRole;
  /**
   * Explicit null means the account was created pending email confirmation and never activated.
   * Absent (legacy repositories, fakes) reads as verified, matching the migration backfill.
   */
  readonly emailVerifiedAt?: Date | null;
}

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: ApplicationRole;
}

export interface SessionRecord {
  readonly user: SessionUser;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
}

export interface AuthRepository {
  findUserByEmail(email: string): Promise<AuthUserRecord | undefined>;
  createSession(input: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<void>;
  /**
   * Creates a password-authenticated session only while the verified password hash is still
   * current. Production repositories lock the account row so password replacement either revokes
   * this session or makes this insert fail closed.
   */
  createSessionForPassword?(input: {
    readonly userId: string;
    readonly expectedPasswordHash: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<AuthUserRecord | undefined>;
  /** Atomically locks a still-existing account and creates a session for a trusted handoff. */
  createSessionForUser?(input: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<AuthUserRecord | undefined>;
  findSession(tokenHash: string, now: Date): Promise<SessionRecord | undefined>;
  touchSession(tokenHash: string, now: Date): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteExpiredSessions(now: Date): Promise<void>;
  findUserById?(userId: string): Promise<AuthUserRecord | undefined>;
  /** Locks, reauthenticates, replaces the password, and revokes other sessions atomically. */
  replacePasswordIfCurrent?(input: {
    readonly userId: string;
    readonly currentPassword: string;
    readonly newPasswordHash: string;
    readonly exceptTokenHash: string;
    readonly now: Date;
  }): Promise<"changed" | "invalid-current-password">;
}

export type ChangePasswordResult =
  | { readonly outcome: "changed"; readonly revokedOtherSessions: true }
  | { readonly outcome: "invalid-current-password" }
  | { readonly outcome: "unsupported" };

export interface LoginResult {
  readonly token: string;
  readonly expiresAt: Date;
  readonly user: SessionUser;
}

export async function hashOwnerPassword(password: string): Promise<string> {
  if (
    password.length < 12 ||
    password.length > 128 ||
    password.trim().length === 0 ||
    password.includes("\u0000")
  ) {
    throw new RangeError(
      "Password must be between 12 and 128 characters and contain non-whitespace text",
    );
  }
  return hash(password, passwordHashOptions);
}

const dummyPasswordHash = hash("not-the-owner-password", passwordHashOptions);

/**
 * Performs one Argon2 verification even when an account or password hash is absent. Repositories
 * call this only after taking the account lock for a sensitive mutation.
 */
export async function verifyOwnerPassword(
  passwordHash: string | null | undefined,
  candidatePassword: string,
): Promise<boolean> {
  const hasPasswordHash = typeof passwordHash === "string" && passwordHash.length > 0;
  const valid = await verify(
    hasPasswordHash ? passwordHash : await dummyPasswordHash,
    candidatePassword,
  );
  return hasPasswordHash && valid;
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function publicUser(user: AuthUserRecord): SessionUser {
  return { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
}

export class AuthService {
  readonly #repository: AuthRepository;
  readonly #now: () => Date;

  constructor(repository: AuthRepository, now: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#now = now;
  }

  async #createSession(
    user: AuthUserRecord,
    expectedPasswordHash?: string,
  ): Promise<LoginResult | undefined> {
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + sessionLifetimeSeconds * 1000);
    const token = randomBytes(32).toString("base64url");
    const sessionInput = { userId: user.id, tokenHash: hashSessionToken(token), expiresAt };
    if (expectedPasswordHash && this.#repository.createSessionForPassword) {
      const currentUser = await this.#repository.createSessionForPassword({
        ...sessionInput,
        expectedPasswordHash,
      });
      return currentUser ? { token, expiresAt, user: publicUser(currentUser) } : undefined;
    }
    await this.#repository.createSession(sessionInput);
    return { token, expiresAt, user: publicUser(user) };
  }

  async login(email: string, password: string): Promise<LoginResult | "unverified" | undefined> {
    const user = await this.#repository.findUserByEmail(email.trim().toLowerCase());
    const valid = await verifyOwnerPassword(user?.passwordHash, password);
    if (!user || !user.passwordHash || !valid) return undefined;
    // Only revealed behind a correct password: a dormant account stays indistinguishable from a
    // missing one to anyone who cannot already authenticate as it.
    if (user.emailVerifiedAt === null) return "unverified";
    return this.#createSession(user, user.passwordHash);
  }

  /** Issues a normal revocable session after another trusted, one-time authentication exchange. */
  async issueSession(userId: string): Promise<LoginResult | undefined> {
    if (this.#repository.createSessionForUser) {
      const now = this.#now();
      const expiresAt = new Date(now.getTime() + sessionLifetimeSeconds * 1000);
      const token = randomBytes(32).toString("base64url");
      const user = await this.#repository.createSessionForUser({
        userId,
        tokenHash: hashSessionToken(token),
        expiresAt,
      });
      return user ? { token, expiresAt, user: publicUser(user) } : undefined;
    }
    if (!this.#repository.findUserById) return undefined;
    const user = await this.#repository.findUserById(userId);
    return user ? this.#createSession(user) : undefined;
  }

  async validate(token: string | undefined): Promise<SessionUser | undefined> {
    if (!token || token.length < 32 || token.length > 128) return undefined;
    const now = this.#now();
    const tokenHash = hashSessionToken(token);
    const session = await this.#repository.findSession(tokenHash, now);
    if (!session) return undefined;

    if (now.getTime() - session.lastSeenAt.getTime() >= 5 * 60 * 1000) {
      await this.#repository.touchSession(tokenHash, now);
    }
    return session.user;
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token || token.length > 128) return;
    await this.#repository.deleteSession(hashSessionToken(token));
  }

  /**
   * Verifies the current password before rehashing, then revokes every *other* session for the
   * account. The operator CLI revokes all sessions because it runs without one; a member
   * changing their own password should not be signed out of the tab they are standing in.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    currentToken: string | undefined,
  ): Promise<ChangePasswordResult> {
    const repository = this.#repository;
    if (!repository.replacePasswordIfCurrent) {
      return { outcome: "unsupported" };
    }

    const passwordHash = await hashOwnerPassword(newPassword);
    // An empty hash matches no stored session, so a caller without a cookie revokes them all.
    const currentTokenHash = currentToken ? hashSessionToken(currentToken) : "";
    const now = this.#now();
    const outcome = await repository.replacePasswordIfCurrent({
      userId,
      currentPassword,
      newPasswordHash: passwordHash,
      exceptTokenHash: currentTokenHash,
      now,
    });
    if (outcome === "invalid-current-password") return { outcome };
    return { outcome: "changed", revokedOtherSessions: true };
  }

  async purgeExpiredSessions(): Promise<void> {
    await this.#repository.deleteExpiredSessions(this.#now());
  }
}
