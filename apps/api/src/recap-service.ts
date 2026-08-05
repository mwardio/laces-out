import {
  leagueWeeklyAwardsSectionSchema,
  type AiProviderName,
  type LeagueRecapResponse,
  type RecapPersonaCard,
  type RecapPersonaCardList,
  type RecapSettings,
  type RecapSpiceLevel,
  type WeeklyRecap,
} from "@fantasy/contracts";
import {
  fantasyTeams,
  leagueMemberships,
  leagues,
  leagueSeasons,
  recapGenerationGuards,
  recapPersonaCards,
  users,
  weeklyRecaps,
  type Database,
  type LeagueMembershipRole,
} from "@fantasy/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { AiAnalyticsSnapshotPort, RecapPromptInputs, RecapPromptPort } from "./ai-service.js";
import { mayMutate } from "./draft-session.js";

/** League-wide pause after a successful generation, so a reroll war cannot thrash the recap. */
export const RECAP_COOLDOWN_SECONDS = 45;

/**
 * How long one in-flight generation may hold the league/week lease. Long enough for a slow
 * provider, short enough that an abandoned request recovers without an operator.
 */
export const RECAP_LEASE_SECONDS = 120;

export interface RecapMembershipRow {
  readonly role: LeagueMembershipRole;
  readonly claimedFantasyTeamId: string | null;
}

export interface RecapSeasonRow {
  readonly id: string;
}

export interface RecapTeamRow {
  readonly id: string;
  readonly name: string;
}

export interface RecapCardRow {
  readonly fantasyTeamId: string;
  readonly teamName: string;
  readonly body: string;
  readonly updatedAt: Date;
  readonly updatedByDisplayName: string | null;
}

export interface StoredRecapRow {
  readonly week: number;
  readonly body: string;
  readonly provider: AiProviderName;
  readonly model: string;
  readonly spiceLevel: RecapSpiceLevel;
  readonly generatedByDisplayName: string | null;
  readonly generatedAt: Date;
}

export interface SaveCardInput {
  readonly leagueSeasonId: string;
  readonly fantasyTeamId: string;
  readonly body: string;
  readonly updatedByUserId: string;
}

export interface SaveRecapInput {
  readonly leagueSeasonId: string;
  readonly week: number;
  readonly body: string;
  readonly provider: AiProviderName;
  readonly model: string;
  readonly spiceLevel: RecapSpiceLevel;
  readonly generatedByUserId: string;
}

/**
 * `in-progress` and `cooldown` are separate members rather than one with a union discriminant so
 * that narrowing on `state` actually removes a constituent at the call site.
 */
export type GenerationAvailability =
  | { readonly state: "available" }
  | { readonly state: "in-progress"; readonly retryAfterSeconds: number }
  | { readonly state: "cooldown"; readonly retryAfterSeconds: number };

export type AcquireGenerationResult =
  | { readonly state: "acquired"; readonly leaseToken: string }
  | { readonly state: "in-progress"; readonly retryAfterSeconds: number }
  | { readonly state: "cooldown"; readonly retryAfterSeconds: number };

export interface RecapRepository {
  findMembership(userId: string, leagueId: string): Promise<RecapMembershipRow | undefined>;
  findLatestSeason(leagueId: string): Promise<RecapSeasonRow | undefined>;
  listTeams(leagueSeasonId: string): Promise<readonly RecapTeamRow[]>;
  listCards(leagueSeasonId: string): Promise<readonly RecapCardRow[]>;
  saveCard(input: SaveCardInput): Promise<RecapCardRow>;
  deleteCard(leagueSeasonId: string, fantasyTeamId: string): Promise<boolean>;
  findRecap(leagueSeasonId: string, week: number): Promise<StoredRecapRow | undefined>;
  saveRecapAndCompleteGeneration(
    input: SaveRecapInput,
    leaseToken: string,
    completedAt: Date,
  ): Promise<StoredRecapRow>;
  acquireGeneration(
    leagueSeasonId: string,
    week: number,
    now: Date,
  ): Promise<AcquireGenerationResult>;
  getGenerationAvailability(
    leagueSeasonId: string,
    week: number,
    now: Date,
  ): Promise<GenerationAvailability>;
  abandonGeneration(leagueSeasonId: string, week: number, leaseToken: string): Promise<void>;
  getSpiceLevel(leagueId: string): Promise<RecapSpiceLevel | undefined>;
  saveSpiceLevel(leagueId: string, spiceLevel: RecapSpiceLevel): Promise<void>;
}

/** The slice of an AI feature response the recap needs. Satisfied by AiService.generateFeature. */
export interface RecapGeneration {
  readonly answer: string;
  readonly provider: AiProviderName;
  readonly model: string;
}

export interface RecapAiPort {
  generateFeature(input: {
    readonly userId: string;
    readonly feature: "weekly-recap";
    readonly leagueId: string;
    readonly provider?: AiProviderName;
    readonly weeklyAwardsWeek: number;
    readonly recapSpiceLevel: RecapSpiceLevel;
    readonly useIncludedProvider?: boolean;
  }): Promise<RecapGeneration>;
}

export type RecapGenerateResult =
  | { readonly state: "generated"; readonly response: LeagueRecapResponse }
  | { readonly state: "forbidden" }
  | { readonly state: "unconfigured" }
  | { readonly state: "configuration-changed" }
  | { readonly state: "unavailable"; readonly message: string }
  | { readonly state: "in-progress"; readonly retryAfterSeconds: number }
  | { readonly state: "cooldown"; readonly retryAfterSeconds: number };

export type RecapCardSaveResult =
  | { readonly state: "saved"; readonly card: RecapPersonaCard }
  | { readonly state: "forbidden" }
  | { readonly state: "unknown-team" };

export type RecapPersonaCardListResult =
  | { readonly state: "listed"; readonly list: RecapPersonaCardList }
  | { readonly state: "forbidden" };

export type RecapCardDeleteResult =
  | { readonly state: "deleted" }
  | { readonly state: "forbidden" }
  | { readonly state: "unknown-team" };

export type RecapSettingsSaveResult =
  { readonly state: "saved"; readonly settings: RecapSettings } | { readonly state: "forbidden" };

/** Raised when a lease was taken over mid-flight; the stored recap is left exactly as it was. */
export class RecapLeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecapLeaseLostError";
  }
}

const awardsEnvelopeSchema = z.object({ weeklyAwards: leagueWeeklyAwardsSectionSchema });

function toWeeklyRecap(row: StoredRecapRow): WeeklyRecap {
  return {
    week: row.week,
    body: row.body,
    provider: row.provider,
    model: row.model,
    spiceLevel: row.spiceLevel,
    generatedByDisplayName: row.generatedByDisplayName,
    generatedAt: row.generatedAt.toISOString(),
  };
}

/** Seconds remaining until `deadline`, rounded up and never below one. */
function retryAfter(deadline: Date, now: Date): number {
  return Math.max(1, Math.ceil((deadline.getTime() - now.getTime()) / 1_000));
}

export class DrizzleRecapRepository implements RecapRepository, RecapPromptPort {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async findMembership(userId: string, leagueId: string): Promise<RecapMembershipRow | undefined> {
    const [row] = await this.#database
      .select({
        role: leagueMemberships.role,
        claimedFantasyTeamId: leagueMemberships.claimedFantasyTeamId,
      })
      .from(leagueMemberships)
      .where(and(eq(leagueMemberships.userId, userId), eq(leagueMemberships.leagueId, leagueId)))
      .limit(1);
    return row;
  }

  async findLatestSeason(leagueId: string): Promise<RecapSeasonRow | undefined> {
    const [row] = await this.#database
      .select({ id: leagueSeasons.id })
      .from(leagueSeasons)
      .where(eq(leagueSeasons.leagueId, leagueId))
      .orderBy(desc(leagueSeasons.season), desc(leagueSeasons.updatedAt), desc(leagueSeasons.id))
      .limit(1);
    return row;
  }

  async listTeams(leagueSeasonId: string): Promise<readonly RecapTeamRow[]> {
    return this.#database
      .select({ id: fantasyTeams.id, name: fantasyTeams.name })
      .from(fantasyTeams)
      .where(eq(fantasyTeams.leagueSeasonId, leagueSeasonId))
      .orderBy(fantasyTeams.name);
  }

  async listCards(leagueSeasonId: string): Promise<readonly RecapCardRow[]> {
    return this.#database
      .select({
        fantasyTeamId: recapPersonaCards.fantasyTeamId,
        teamName: fantasyTeams.name,
        body: recapPersonaCards.body,
        updatedAt: recapPersonaCards.updatedAt,
        updatedByDisplayName: users.displayName,
      })
      .from(recapPersonaCards)
      .innerJoin(fantasyTeams, eq(fantasyTeams.id, recapPersonaCards.fantasyTeamId))
      .leftJoin(users, eq(users.id, recapPersonaCards.updatedByUserId))
      .where(eq(recapPersonaCards.leagueSeasonId, leagueSeasonId))
      .orderBy(fantasyTeams.name);
  }

  async saveCard(input: SaveCardInput): Promise<RecapCardRow> {
    const values = {
      leagueSeasonId: input.leagueSeasonId,
      fantasyTeamId: input.fantasyTeamId,
      body: input.body,
      updatedByUserId: input.updatedByUserId,
      updatedAt: new Date(),
    };
    const [saved] = await this.#database
      .insert(recapPersonaCards)
      .values(values)
      .onConflictDoUpdate({ target: [recapPersonaCards.fantasyTeamId], set: values })
      .returning({ fantasyTeamId: recapPersonaCards.fantasyTeamId });
    if (!saved) throw new Error("Persona card save did not return a record");
    const cards = await this.listCards(input.leagueSeasonId);
    const card = cards.find((row) => row.fantasyTeamId === input.fantasyTeamId);
    if (!card) throw new Error("Persona card save could not be read back");
    return card;
  }

  async deleteCard(leagueSeasonId: string, fantasyTeamId: string): Promise<boolean> {
    const deleted = await this.#database
      .delete(recapPersonaCards)
      .where(
        and(
          eq(recapPersonaCards.leagueSeasonId, leagueSeasonId),
          eq(recapPersonaCards.fantasyTeamId, fantasyTeamId),
        ),
      )
      .returning({ id: recapPersonaCards.id });
    return deleted.length > 0;
  }

  async findRecap(leagueSeasonId: string, week: number): Promise<StoredRecapRow | undefined> {
    const [row] = await this.#database
      .select({
        week: weeklyRecaps.week,
        body: weeklyRecaps.body,
        provider: weeklyRecaps.provider,
        model: weeklyRecaps.model,
        spiceLevel: weeklyRecaps.spiceLevel,
        generatedByDisplayName: users.displayName,
        generatedAt: weeklyRecaps.createdAt,
      })
      .from(weeklyRecaps)
      .leftJoin(users, eq(users.id, weeklyRecaps.generatedByUserId))
      .where(and(eq(weeklyRecaps.leagueSeasonId, leagueSeasonId), eq(weeklyRecaps.week, week)))
      .limit(1);
    return row;
  }

  /**
   * One short transaction, opened only after the provider has already answered — a database
   * transaction is never held across a provider request. The guard is cleared under the lease
   * token first, so a request whose lease expired mid-flight, and whose slot another member has
   * since taken, rolls back instead of overwriting the newer recap.
   */
  async saveRecapAndCompleteGeneration(
    input: SaveRecapInput,
    leaseToken: string,
    completedAt: Date,
  ): Promise<StoredRecapRow> {
    return this.#database.transaction(async (transaction) => {
      const cleared = await transaction
        .update(recapGenerationGuards)
        .set({
          leaseToken: null,
          leaseExpiresAt: null,
          lastCompletedAt: completedAt,
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(recapGenerationGuards.leagueSeasonId, input.leagueSeasonId),
            eq(recapGenerationGuards.week, input.week),
            eq(recapGenerationGuards.leaseToken, leaseToken),
          ),
        )
        .returning({ id: recapGenerationGuards.id });
      if (cleared.length === 0) {
        throw new RecapLeaseLostError(
          "The generation lease for this week was taken over before the recap could be stored.",
        );
      }
      const values = {
        leagueSeasonId: input.leagueSeasonId,
        week: input.week,
        body: input.body,
        provider: input.provider,
        model: input.model,
        spiceLevel: input.spiceLevel,
        generatedByUserId: input.generatedByUserId,
        createdAt: completedAt,
      };
      await transaction
        .insert(weeklyRecaps)
        .values(values)
        .onConflictDoUpdate({
          target: [weeklyRecaps.leagueSeasonId, weeklyRecaps.week],
          set: values,
        });
      const [row] = await transaction
        .select({
          week: weeklyRecaps.week,
          body: weeklyRecaps.body,
          provider: weeklyRecaps.provider,
          model: weeklyRecaps.model,
          spiceLevel: weeklyRecaps.spiceLevel,
          generatedByDisplayName: users.displayName,
          generatedAt: weeklyRecaps.createdAt,
        })
        .from(weeklyRecaps)
        .leftJoin(users, eq(users.id, weeklyRecaps.generatedByUserId))
        .where(
          and(
            eq(weeklyRecaps.leagueSeasonId, input.leagueSeasonId),
            eq(weeklyRecaps.week, input.week),
          ),
        )
        .limit(1);
      if (!row) throw new Error("Weekly recap save could not be read back");
      return row;
    });
  }

  /**
   * One atomic upsert. The conflict branch's `setWhere` is what makes it a lease: the row only
   * changes hands when the previous lease is absent or expired *and* the cooldown has elapsed, so
   * two simultaneous callers cannot both come away holding a token. An empty `returning` means the
   * predicate rejected the takeover.
   */
  async acquireGeneration(
    leagueSeasonId: string,
    week: number,
    now: Date,
  ): Promise<AcquireGenerationResult> {
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + RECAP_LEASE_SECONDS * 1_000);
    const cooldownStart = new Date(now.getTime() - RECAP_COOLDOWN_SECONDS * 1_000);
    const acquired = await this.#database
      .insert(recapGenerationGuards)
      .values({ leagueSeasonId, week, leaseToken, leaseExpiresAt, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [recapGenerationGuards.leagueSeasonId, recapGenerationGuards.week],
        set: { leaseToken, leaseExpiresAt, updatedAt: now },
        // Timestamps are bound as ISO text with an explicit cast: this fragment is raw SQL, so
        // Drizzle has no column type to serialize a JS Date against.
        setWhere: sql`(${recapGenerationGuards.leaseExpiresAt} is null or ${recapGenerationGuards.leaseExpiresAt} <= ${now.toISOString()}::timestamptz) and (${recapGenerationGuards.lastCompletedAt} is null or ${recapGenerationGuards.lastCompletedAt} <= ${cooldownStart.toISOString()}::timestamptz)`,
      })
      .returning({ id: recapGenerationGuards.id });
    if (acquired.length > 0) return { state: "acquired", leaseToken };
    const availability = await this.getGenerationAvailability(leagueSeasonId, week, now);
    // The upsert already proved the slot is not free, so a momentary "available" here is a race
    // rather than an invitation to loop.
    return availability.state === "available"
      ? { state: "in-progress", retryAfterSeconds: 1 }
      : availability;
  }

  async getGenerationAvailability(
    leagueSeasonId: string,
    week: number,
    now: Date,
  ): Promise<GenerationAvailability> {
    const [guard] = await this.#database
      .select({
        leaseExpiresAt: recapGenerationGuards.leaseExpiresAt,
        lastCompletedAt: recapGenerationGuards.lastCompletedAt,
      })
      .from(recapGenerationGuards)
      .where(
        and(
          eq(recapGenerationGuards.leagueSeasonId, leagueSeasonId),
          eq(recapGenerationGuards.week, week),
        ),
      )
      .limit(1);
    if (!guard) return { state: "available" };
    if (guard.leaseExpiresAt && guard.leaseExpiresAt > now) {
      return { state: "in-progress", retryAfterSeconds: retryAfter(guard.leaseExpiresAt, now) };
    }
    const cooldownEnd = guard.lastCompletedAt
      ? new Date(guard.lastCompletedAt.getTime() + RECAP_COOLDOWN_SECONDS * 1_000)
      : null;
    if (cooldownEnd && cooldownEnd > now) {
      return { state: "cooldown", retryAfterSeconds: retryAfter(cooldownEnd, now) };
    }
    return { state: "available" };
  }

  async abandonGeneration(leagueSeasonId: string, week: number, leaseToken: string): Promise<void> {
    // Deliberately never touches lastCompletedAt: a failed generation starts no cooldown.
    await this.#database
      .update(recapGenerationGuards)
      .set({ leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(recapGenerationGuards.leagueSeasonId, leagueSeasonId),
          eq(recapGenerationGuards.week, week),
          eq(recapGenerationGuards.leaseToken, leaseToken),
        ),
      );
  }

  async getSpiceLevel(leagueId: string): Promise<RecapSpiceLevel | undefined> {
    const [row] = await this.#database
      .select({ spiceLevel: leagues.recapSpiceLevel })
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .limit(1);
    return row?.spiceLevel;
  }

  async saveSpiceLevel(leagueId: string, spiceLevel: RecapSpiceLevel): Promise<void> {
    await this.#database
      .update(leagues)
      .set({ recapSpiceLevel: spiceLevel, updatedAt: new Date() })
      .where(eq(leagues.id, leagueId));
  }

  async getPromptInputs(leagueId: string): Promise<RecapPromptInputs | undefined> {
    const spiceLevel = await this.getSpiceLevel(leagueId);
    if (!spiceLevel) return undefined;
    const season = await this.findLatestSeason(leagueId);
    const cards = season ? await this.listCards(season.id) : [];
    return {
      spiceLevel,
      personaCards: cards.map((card) => ({ teamName: card.teamName, notes: card.body })),
    };
  }
}

export class RecapService {
  readonly #repository: RecapRepository;
  readonly #analytics: AiAnalyticsSnapshotPort;
  readonly #ai: RecapAiPort | undefined;
  readonly #now: () => Date;

  constructor(input: {
    readonly repository: RecapRepository;
    readonly analytics: AiAnalyticsSnapshotPort;
    readonly ai?: RecapAiPort;
    readonly now?: () => Date;
  }) {
    this.#repository = input.repository;
    this.#analytics = input.analytics;
    this.#ai = input.ai;
    this.#now = input.now ?? (() => new Date());
  }

  async getRecap(
    userId: string,
    leagueId: string,
    week: number,
  ): Promise<LeagueRecapResponse | undefined> {
    const membership = await this.#repository.findMembership(userId, leagueId);
    if (!membership) return undefined;
    const configuredSpiceLevel = (await this.#repository.getSpiceLevel(leagueId)) ?? "medium";
    const season = await this.#repository.findLatestSeason(leagueId);
    if (!season) {
      return {
        leagueId,
        week,
        configuredSpiceLevel,
        generation: {
          state: "unavailable",
          reasons: [
            {
              code: "LEAGUE_SEASON_UNAVAILABLE",
              message: "The league has no synchronized season yet.",
            },
          ],
        },
        recap: null,
      };
    }
    const stored = await this.#repository.findRecap(season.id, week);
    const awards = await this.#awardsSection(userId, leagueId, week);
    const generation =
      awards.state === "available"
        ? await this.#repository.getGenerationAvailability(season.id, week, this.#now())
        : {
            state: "unavailable" as const,
            reasons: awards.reasons.map((reason) => ({
              code: reason.code,
              message: reason.message,
            })),
          };
    return {
      leagueId,
      week,
      configuredSpiceLevel,
      generation,
      recap: stored ? toWeeklyRecap(stored) : null,
    };
  }

  async generate(
    userId: string,
    leagueId: string,
    input: {
      readonly week: number;
      readonly provider?: AiProviderName;
      readonly expectedSpiceLevel?: RecapSpiceLevel;
    },
  ): Promise<RecapGenerateResult | undefined> {
    const membership = await this.#repository.findMembership(userId, leagueId);
    if (!membership) return undefined;
    if (membership.role === "viewer") return { state: "forbidden" };
    const ai = this.#ai;
    if (!ai) return { state: "unconfigured" };
    const season = await this.#repository.findLatestSeason(leagueId);
    if (!season) {
      return { state: "unavailable", message: "The league has no synchronized season yet." };
    }
    const awards = await this.#awardsSection(userId, leagueId, input.week);
    if (awards.state !== "available") {
      return {
        state: "unavailable",
        message: awards.reasons.map((reason) => reason.message).join(" "),
      };
    }
    // Read the dial before taking the lease so the stored recap records exactly the level the
    // prompt was assembled with, even if a commissioner moves it mid-generation.
    const spiceLevel = (await this.#repository.getSpiceLevel(leagueId)) ?? "medium";
    if (input.expectedSpiceLevel !== undefined && input.expectedSpiceLevel !== spiceLevel) {
      return { state: "configuration-changed" };
    }
    const lease = await this.#repository.acquireGeneration(season.id, input.week, this.#now());
    if (lease.state !== "acquired") return lease;

    let generated: RecapGeneration;
    try {
      generated = await ai.generateFeature({
        userId,
        feature: "weekly-recap",
        leagueId,
        weeklyAwardsWeek: input.week,
        recapSpiceLevel: spiceLevel,
        ...(input.provider ? { provider: input.provider } : { useIncludedProvider: true }),
      });
      if (input.provider !== undefined && generated.provider !== input.provider) {
        throw new Error("The AI provider did not match the consented recap provider");
      }
    } catch (error) {
      // A provider failure releases the lease, keeps the stored recap, and starts no cooldown.
      await this.#repository.abandonGeneration(season.id, input.week, lease.leaseToken);
      throw error;
    }

    let stored: StoredRecapRow;
    try {
      stored = await this.#repository.saveRecapAndCompleteGeneration(
        {
          leagueSeasonId: season.id,
          week: input.week,
          body: generated.answer,
          provider: generated.provider,
          model: generated.model,
          spiceLevel,
          generatedByUserId: userId,
        },
        lease.leaseToken,
        this.#now(),
      );
    } catch (error) {
      // Losing an expired lease to a member who already finished is a race, not a fault: report
      // the guard's live state so the client refetches rather than seeing a server error.
      if (!(error instanceof RecapLeaseLostError)) throw error;
      const availability = await this.#repository.getGenerationAvailability(
        season.id,
        input.week,
        this.#now(),
      );
      return availability.state === "available"
        ? { state: "cooldown", retryAfterSeconds: 1 }
        : availability;
    }

    return {
      state: "generated",
      response: {
        leagueId,
        week: input.week,
        configuredSpiceLevel: spiceLevel,
        generation: { state: "cooldown", retryAfterSeconds: RECAP_COOLDOWN_SECONDS },
        recap: toWeeklyRecap(stored),
      },
    };
  }

  async listPersonaCards(
    userId: string,
    leagueId: string,
  ): Promise<RecapPersonaCardListResult | undefined> {
    const membership = await this.#repository.findMembership(userId, leagueId);
    if (!membership) return undefined;
    if (!mayMutate(membership.role)) return { state: "forbidden" };
    const season = await this.#repository.findLatestSeason(leagueId);
    if (!season) return { state: "listed", list: { leagueId, cards: [] } };
    const [teams, cards] = await Promise.all([
      this.#repository.listTeams(season.id),
      this.#repository.listCards(season.id),
    ]);
    const byTeam = new Map(cards.map((card) => [card.fantasyTeamId, card]));
    return {
      state: "listed",
      list: {
        leagueId,
        cards: teams.map((team) => {
          const card = byTeam.get(team.id);
          return {
            teamId: team.id,
            teamName: team.name,
            body: card?.body ?? null,
            updatedAt: card ? card.updatedAt.toISOString() : null,
            updatedByDisplayName: card?.updatedByDisplayName ?? null,
          };
        }),
      },
    };
  }

  async savePersonaCard(
    userId: string,
    leagueId: string,
    teamId: string,
    body: string,
  ): Promise<RecapCardSaveResult | undefined> {
    const context = await this.#cardContext(userId, leagueId, teamId);
    if (context === undefined) return undefined;
    if (context.state !== "allowed") return context;
    const saved = await this.#repository.saveCard({
      leagueSeasonId: context.season.id,
      fantasyTeamId: teamId,
      body,
      updatedByUserId: userId,
    });
    return {
      state: "saved",
      card: {
        teamId: saved.fantasyTeamId,
        teamName: saved.teamName,
        body: saved.body,
        updatedAt: saved.updatedAt.toISOString(),
        updatedByDisplayName: saved.updatedByDisplayName,
      },
    };
  }

  async deletePersonaCard(
    userId: string,
    leagueId: string,
    teamId: string,
  ): Promise<RecapCardDeleteResult | undefined> {
    const context = await this.#cardContext(userId, leagueId, teamId);
    if (context === undefined) return undefined;
    if (context.state !== "allowed") return context;
    // A team with no card clears to the same end state, so this stays idempotent by design.
    await this.#repository.deleteCard(context.season.id, teamId);
    return { state: "deleted" };
  }

  async saveSettings(
    userId: string,
    leagueId: string,
    spiceLevel: RecapSpiceLevel,
  ): Promise<RecapSettingsSaveResult | undefined> {
    const membership = await this.#repository.findMembership(userId, leagueId);
    if (!membership) return undefined;
    if (!mayMutate(membership.role)) return { state: "forbidden" };
    await this.#repository.saveSpiceLevel(leagueId, spiceLevel);
    return { state: "saved", settings: { leagueId, spiceLevel } };
  }

  /** Commissioner-level authorization and team existence — the checks both card writes share. */
  async #cardContext(
    userId: string,
    leagueId: string,
    teamId: string,
  ): Promise<
    | { readonly state: "allowed"; readonly season: RecapSeasonRow }
    | { readonly state: "forbidden" }
    | { readonly state: "unknown-team" }
    | undefined
  > {
    const membership = await this.#repository.findMembership(userId, leagueId);
    if (!membership) return undefined;
    if (!mayMutate(membership.role)) return { state: "forbidden" };
    const season = await this.#repository.findLatestSeason(leagueId);
    if (!season) return { state: "unknown-team" };
    const teams = await this.#repository.listTeams(season.id);
    if (!teams.some((team) => team.id === teamId)) return { state: "unknown-team" };
    return { state: "allowed", season };
  }

  /**
   * The deterministic awards section for one week, parsed rather than trusted. A snapshot that
   * fails validation is treated exactly like an unavailable week: no recap is written from it.
   */
  async #awardsSection(
    userId: string,
    leagueId: string,
    week: number,
  ): Promise<
    | { readonly state: "available" }
    | {
        readonly state: "unavailable";
        readonly reasons: readonly { readonly code: string; readonly message: string }[];
      }
  > {
    const snapshot = await this.#analytics.getSnapshot(userId, leagueId, {
      weeklyAwardsWeek: week,
    });
    const parsed = awardsEnvelopeSchema.safeParse(snapshot);
    if (parsed.success && parsed.data.weeklyAwards.state === "available") {
      return { state: "available" };
    }
    return {
      state: "unavailable",
      reasons:
        parsed.success && parsed.data.weeklyAwards.state === "unavailable"
          ? parsed.data.weeklyAwards.reasons
          : [
              {
                code: "AWARDS_WEEK_UNAVAILABLE",
                message: "The weekly awards are not available.",
              },
            ],
    };
  }
}
