import { leagueMemberships, type Database } from "@laces-out/db";
import { and, eq } from "drizzle-orm";

export interface RefreshAuthorizationPort {
  canAccessLeague(userId: string, leagueId: string): Promise<boolean>;
}

/** Membership-only lookup used before any league-scoped refresh behavior is disclosed. */
export class DrizzleRefreshAuthorization implements RefreshAuthorizationPort {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async canAccessLeague(userId: string, leagueId: string): Promise<boolean> {
    const [membership] = await this.#database
      .select({ id: leagueMemberships.id })
      .from(leagueMemberships)
      .where(and(eq(leagueMemberships.userId, userId), eq(leagueMemberships.leagueId, leagueId)))
      .limit(1);
    return membership !== undefined;
  }
}
