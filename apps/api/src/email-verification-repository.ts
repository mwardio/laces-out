import { emailVerificationTokens, users, type Database } from "@laces-out/db";
import { and, eq, isNull, ne, sql } from "drizzle-orm";

import type {
  EmailVerificationRepository,
  PendingVerificationUserRecord,
} from "./email-verification.js";

export class DrizzleEmailVerificationRepository implements EmailVerificationRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async redeemToken(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<{ readonly userId: string } | undefined> {
    return this.#database.transaction(async (transaction) => {
      const [token] = await transaction
        .select({
          id: emailVerificationTokens.id,
          userId: emailVerificationTokens.userId,
          expiresAt: emailVerificationTokens.expiresAt,
          usedAt: emailVerificationTokens.usedAt,
        })
        .from(emailVerificationTokens)
        .where(eq(emailVerificationTokens.tokenHash, input.tokenHash))
        .for("update")
        .limit(1);
      if (!token || token.usedAt !== null || token.expiresAt.getTime() <= input.now.getTime()) {
        return undefined;
      }

      // Bind through the timestamp columns so Drizzle serializes Date values for postgres-js.
      // Restricting the update to a pending account also keeps the first confirmation timestamp.
      await transaction
        .update(users)
        .set({
          emailVerifiedAt: input.now,
          updatedAt: input.now,
        })
        .where(and(eq(users.id, token.userId), isNull(users.emailVerifiedAt)));
      await transaction
        .update(emailVerificationTokens)
        .set({ usedAt: input.now })
        .where(eq(emailVerificationTokens.id, token.id));
      await transaction
        .delete(emailVerificationTokens)
        .where(
          and(
            eq(emailVerificationTokens.userId, token.userId),
            isNull(emailVerificationTokens.usedAt),
            ne(emailVerificationTokens.id, token.id),
          ),
        );
      return { userId: token.userId };
    });
  }

  async findUnverifiedUserByEmail(
    email: string,
  ): Promise<PendingVerificationUserRecord | undefined> {
    const [user] = await this.#database
      .select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(users)
      .where(and(sql`lower(${users.email}) = ${email}`, isNull(users.emailVerifiedAt)))
      .limit(1);
    return user;
  }

  async replaceOutstandingToken(input: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
    readonly createdAt: Date;
  }): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      await transaction
        .delete(emailVerificationTokens)
        .where(
          and(
            eq(emailVerificationTokens.userId, input.userId),
            isNull(emailVerificationTokens.usedAt),
          ),
        );
      await transaction.insert(emailVerificationTokens).values({
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        createdAt: input.createdAt,
      });
    });
  }
}
