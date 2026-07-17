import { type Database, sessions, users } from "@fantasy/db";

import type { RegisteredUserRecord, RegistrationRepository } from "./registration.js";

export class DrizzleRegistrationRepository implements RegistrationRepository {
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
        })
        .onConflictDoNothing()
        .returning({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          role: users.role,
        });
      if (!user) return undefined;

      await transaction.insert(sessions).values({
        userId: user.id,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      });
      return user;
    });
  }
}
