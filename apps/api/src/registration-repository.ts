import { emailVerificationTokens, sessions, users, type Database } from "@laces-out/db";
import { and, eq, isNull, sql } from "drizzle-orm";

import type {
  PendingRegistrationRepository,
  RegisteredUserRecord,
  RegistrationRepository,
} from "./registration.js";

const registeredUserColumns = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  role: users.role,
} as const;

export class DrizzleRegistrationRepository
  implements RegistrationRepository, PendingRegistrationRepository
{
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async createMemberWithSession(input: {
    readonly email: string;
    readonly displayName: string;
    readonly passwordHash: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<RegisteredUserRecord | undefined> {
    return this.#database.transaction(async (transaction) => {
      const [user] = await transaction
        .insert(users)
        .values({
          email: input.email,
          displayName: input.displayName,
          passwordHash: input.passwordHash,
          role: "member",
          // Created live, without a confirmation step, so it must never read as pending.
          emailVerifiedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning(registeredUserColumns);
      if (!user) return undefined;

      await transaction.insert(sessions).values({
        userId: user.id,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      });
      return user;
    });
  }

  async createOrRotatePendingMember(input: {
    readonly email: string;
    readonly displayName: string;
    readonly passwordHash: string;
    readonly verificationTokenHash: string;
    readonly verificationExpiresAt: Date;
    readonly now: Date;
  }): Promise<RegisteredUserRecord | undefined> {
    return this.#database.transaction(async (transaction) => {
      const [existing] = await transaction
        .select({ ...registeredUserColumns, emailVerifiedAt: users.emailVerifiedAt })
        .from(users)
        .where(sql`lower(${users.email}) = ${input.email}`)
        .limit(1)
        .for("update");
      if (existing && existing.emailVerifiedAt !== null) return undefined;

      let user: RegisteredUserRecord | undefined;
      if (existing) {
        // Preserve the original credentials and any invitation membership. Inbox access can
        // rotate the confirmation link; password recovery remains a separate bounded flow.
        user = existing;
        await transaction
          .delete(emailVerificationTokens)
          .where(
            and(
              eq(emailVerificationTokens.userId, existing.id),
              isNull(emailVerificationTokens.usedAt),
            ),
          );
      } else {
        const [inserted] = await transaction
          .insert(users)
          .values({
            email: input.email,
            displayName: input.displayName,
            passwordHash: input.passwordHash,
            role: "member",
          })
          .onConflictDoNothing()
          .returning(registeredUserColumns);
        user = inserted;
      }
      if (!user) return undefined;

      await transaction.insert(emailVerificationTokens).values({
        userId: user.id,
        tokenHash: input.verificationTokenHash,
        expiresAt: input.verificationExpiresAt,
        createdAt: input.now,
      });
      return user;
    });
  }
}
