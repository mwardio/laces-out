import { passwordResetTokens, sessions, users, type Database } from "@laces-out/db";
import { and, eq, isNull, ne, sql } from "drizzle-orm";

import type { PasswordResetRepository, PasswordResetUserRecord } from "./password-reset.js";

export class DrizzlePasswordResetRepository implements PasswordResetRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async findUserByEmail(email: string): Promise<PasswordResetUserRecord | undefined> {
    const [user] = await this.#database
      .select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
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
      // A newer request supersedes any older link, so only one emailed link can ever redeem.
      await transaction
        .delete(passwordResetTokens)
        .where(
          and(eq(passwordResetTokens.userId, input.userId), isNull(passwordResetTokens.usedAt)),
        );
      await transaction.insert(passwordResetTokens).values({
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        createdAt: input.createdAt,
      });
    });
  }

  async redeemToken(input: {
    readonly tokenHash: string;
    readonly newPasswordHash: string;
    readonly now: Date;
  }): Promise<"reset" | "invalid"> {
    return this.#database.transaction(async (transaction) => {
      const [token] = await transaction
        .select({
          id: passwordResetTokens.id,
          userId: passwordResetTokens.userId,
          expiresAt: passwordResetTokens.expiresAt,
          usedAt: passwordResetTokens.usedAt,
        })
        .from(passwordResetTokens)
        .where(eq(passwordResetTokens.tokenHash, input.tokenHash))
        .for("update")
        .limit(1);
      if (!token || token.usedAt !== null || token.expiresAt.getTime() <= input.now.getTime()) {
        return "invalid";
      }

      await transaction
        .update(users)
        .set({
          passwordHash: input.newPasswordHash,
          updatedAt: input.now,
        })
        .where(eq(users.id, token.userId));
      // The redeemed row stays, marked used, as the record of when the reset happened.
      await transaction
        .update(passwordResetTokens)
        .set({ usedAt: input.now })
        .where(eq(passwordResetTokens.id, token.id));
      // A password reset is a security boundary: every existing device must authenticate again.
      await transaction.delete(sessions).where(eq(sessions.userId, token.userId));
      await transaction
        .delete(passwordResetTokens)
        .where(
          and(
            eq(passwordResetTokens.userId, token.userId),
            isNull(passwordResetTokens.usedAt),
            ne(passwordResetTokens.id, token.id),
          ),
        );
      return "reset";
    });
  }
}
