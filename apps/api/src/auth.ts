import { hash, verify, type Options as ArgonOptions } from "@node-rs/argon2";
import { createHash, randomBytes } from "node:crypto";

import type { ApplicationRole } from "@fantasy/db";

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
  findSession(tokenHash: string, now: Date): Promise<SessionRecord | undefined>;
  touchSession(tokenHash: string, now: Date): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteExpiredSessions(now: Date): Promise<void>;
}

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

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function publicUser(user: AuthUserRecord): SessionUser {
  return { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
}

export class AuthService {
  readonly #repository: AuthRepository;
  readonly #dummyHash: Promise<string>;
  readonly #now: () => Date;

  constructor(repository: AuthRepository, now: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#now = now;
    // Login always performs one Argon2 verification, including unknown emails.
    this.#dummyHash = hash("not-the-owner-password", passwordHashOptions);
  }

  async login(email: string, password: string): Promise<LoginResult | undefined> {
    const user = await this.#repository.findUserByEmail(email.trim().toLowerCase());
    const candidateHash = user?.passwordHash ?? (await this.#dummyHash);
    const valid = await verify(candidateHash, password);
    if (!user || !user.passwordHash || !valid) return undefined;

    const now = this.#now();
    const expiresAt = new Date(now.getTime() + sessionLifetimeSeconds * 1000);
    const token = randomBytes(32).toString("base64url");
    await this.#repository.createSession({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt,
    });
    return { token, expiresAt, user: publicUser(user) };
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

  async purgeExpiredSessions(): Promise<void> {
    await this.#repository.deleteExpiredSessions(this.#now());
  }
}
