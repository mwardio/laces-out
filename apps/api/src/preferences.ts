import { leagueMemberships, userPreferences, type Database } from "@fantasy/db";
import { and, eq } from "drizzle-orm";

/**
 * Member preferences, deliberately narrow. `user_preferences` also stores a theme, a timezone,
 * and digest settings, but the app has no dark mode, formats every date in the viewer's own zone
 * already, and sends no email — exposing those would be three controls that do nothing. Only the
 * default league, which the dashboard and Decision Desk otherwise guess at, is served here.
 */
export interface MemberPreferences {
  readonly defaultLeagueId: string | null;
}

export interface PreferencesRepository {
  find(userId: string): Promise<MemberPreferences | undefined>;
  upsert(userId: string, preferences: MemberPreferences, now: Date): Promise<void>;
  isLeagueMember(userId: string, leagueId: string): Promise<boolean>;
}

export class DrizzlePreferencesRepository implements PreferencesRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async find(userId: string): Promise<MemberPreferences | undefined> {
    const [row] = await this.#database
      .select({ defaultLeagueId: userPreferences.defaultLeagueId })
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);
    return row;
  }

  async upsert(userId: string, preferences: MemberPreferences, now: Date): Promise<void> {
    await this.#database
      .insert(userPreferences)
      .values({ userId, defaultLeagueId: preferences.defaultLeagueId, updatedAt: now })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { defaultLeagueId: preferences.defaultLeagueId, updatedAt: now },
      });
  }

  async isLeagueMember(userId: string, leagueId: string): Promise<boolean> {
    const [row] = await this.#database
      .select({ leagueId: leagueMemberships.leagueId })
      .from(leagueMemberships)
      .where(and(eq(leagueMemberships.userId, userId), eq(leagueMemberships.leagueId, leagueId)))
      .limit(1);
    return row !== undefined;
  }
}

export type SavePreferencesResult =
  | { readonly outcome: "saved"; readonly preferences: MemberPreferences }
  | { readonly outcome: "not-a-member" };

export class PreferencesService {
  readonly #repository: PreferencesRepository;
  readonly #now: () => Date;

  constructor(repository: PreferencesRepository, now: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#now = now;
  }

  async get(userId: string): Promise<MemberPreferences> {
    return (await this.#repository.find(userId)) ?? { defaultLeagueId: null };
  }

  /** A default the member does not belong to would silently fail every read that used it. */
  async save(userId: string, preferences: MemberPreferences): Promise<SavePreferencesResult> {
    if (preferences.defaultLeagueId !== null) {
      const member = await this.#repository.isLeagueMember(userId, preferences.defaultLeagueId);
      if (!member) return { outcome: "not-a-member" };
    }
    await this.#repository.upsert(userId, preferences, this.#now());
    return { outcome: "saved", preferences };
  }
}
