import { and, eq, gt, ilike, lt, ne } from "drizzle-orm";
import { type Database, sessions, users } from "@fantasy/db";

import type { AuthRepository, AuthUserRecord, SessionRecord } from "./auth.js";

export class DrizzleAuthRepository implements AuthRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async findUserByEmail(email: string): Promise<AuthUserRecord | undefined> {
    const [user] = await this.#database
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        passwordHash: users.passwordHash,
        role: users.role,
      })
      .from(users)
      .where(ilike(users.email, email))
      .limit(1);
    return user;
  }

  async createSession(input: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<void> {
    await this.#database.insert(sessions).values(input);
  }

  async findSession(tokenHash: string, now: Date): Promise<SessionRecord | undefined> {
    const [record] = await this.#database
      .select({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        expiresAt: sessions.expiresAt,
        lastSeenAt: sessions.lastSeenAt,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
      .limit(1);
    if (!record) return undefined;
    return {
      user: {
        id: record.userId,
        email: record.email,
        displayName: record.displayName,
        role: record.role,
      },
      expiresAt: record.expiresAt,
      lastSeenAt: record.lastSeenAt,
    };
  }

  async touchSession(tokenHash: string, now: Date): Promise<void> {
    await this.#database
      .update(sessions)
      .set({ lastSeenAt: now })
      .where(eq(sessions.tokenHash, tokenHash));
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.#database.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  }

  async deleteExpiredSessions(now: Date): Promise<void> {
    await this.#database.delete(sessions).where(lt(sessions.expiresAt, now));
  }

  async findUserById(userId: string): Promise<AuthUserRecord | undefined> {
    const [user] = await this.#database
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        passwordHash: users.passwordHash,
        role: users.role,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return user;
  }

  async updatePassword(userId: string, passwordHash: string, now: Date): Promise<void> {
    await this.#database
      .update(users)
      .set({ passwordHash, updatedAt: now })
      .where(eq(users.id, userId));
  }

  async deleteOtherSessions(userId: string, exceptTokenHash: string): Promise<void> {
    await this.#database
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, exceptTokenHash)));
  }
}
