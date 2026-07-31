import { and, eq, gt, ilike, lt, ne } from "drizzle-orm";
import { browserHandoffTokens, type Database, sessions, users } from "@fantasy/db";

import {
  type AuthRepository,
  type AuthUserRecord,
  type SessionRecord,
  verifyOwnerPassword,
} from "./auth.js";

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

  async createSessionForPassword(input: {
    readonly userId: string;
    readonly expectedPasswordHash: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<AuthUserRecord | undefined> {
    return this.#database.transaction(async (transaction) => {
      const [user] = await transaction
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          passwordHash: users.passwordHash,
          role: users.role,
        })
        .from(users)
        .where(and(eq(users.id, input.userId), eq(users.passwordHash, input.expectedPasswordHash)))
        .limit(1)
        .for("key share");
      if (!user) return undefined;
      await transaction.insert(sessions).values({
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      });
      return user;
    });
  }

  async createSessionForUser(input: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<AuthUserRecord | undefined> {
    return this.#database.transaction(async (transaction) => {
      const [user] = await transaction
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          passwordHash: users.passwordHash,
          role: users.role,
        })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1)
        .for("key share");
      if (!user) return undefined;
      await transaction.insert(sessions).values(input);
      return user;
    });
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

  async replacePasswordIfCurrent(input: {
    readonly userId: string;
    readonly currentPassword: string;
    readonly newPasswordHash: string;
    readonly exceptTokenHash: string;
    readonly now: Date;
  }): Promise<"changed" | "invalid-current-password"> {
    return this.#database.transaction(async (transaction) => {
      const [user] = await transaction
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1)
        .for("update");
      const valid = await verifyOwnerPassword(user?.passwordHash, input.currentPassword);
      if (!user || !valid) return "invalid-current-password";

      await transaction
        .update(users)
        .set({ passwordHash: input.newPasswordHash, updatedAt: input.now })
        .where(eq(users.id, input.userId));
      // A handoff bound to the retained current session would otherwise survive password rotation.
      await transaction
        .delete(browserHandoffTokens)
        .where(eq(browserHandoffTokens.userId, input.userId));
      await transaction
        .delete(sessions)
        .where(
          and(eq(sessions.userId, input.userId), ne(sessions.tokenHash, input.exceptTokenHash)),
        );
      return "changed";
    });
  }
}
