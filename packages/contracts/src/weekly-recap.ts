import { z } from "zod";

/**
 * Mirrors aiProviderNameSchema from the barrel. Declared locally because the barrel re-exports
 * this module, and a leaf-to-barrel import would create a cycle.
 */
const recapProviderSchema = z.enum([
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "grok",
  "openrouter",
]);

export const PERSONA_CARD_MAX_LENGTH = 500;

export const recapSpiceLevelSchema = z.enum(["mild", "medium", "scorched"]);
export type RecapSpiceLevel = z.infer<typeof recapSpiceLevelSchema>;

const recapUnavailableReasonSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(1_000),
  })
  .strict();

export const recapGenerationAvailabilitySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("available") }).strict(),
  z
    .object({
      state: z.literal("unavailable"),
      reasons: z.array(recapUnavailableReasonSchema).min(1).max(20),
    })
    .strict(),
  z
    .object({
      state: z.literal("in-progress"),
      retryAfterSeconds: z.number().int().min(1).max(300),
    })
    .strict(),
  z
    .object({
      state: z.literal("cooldown"),
      retryAfterSeconds: z.number().int().min(1).max(300),
    })
    .strict(),
]);
export type RecapGenerationAvailability = z.infer<typeof recapGenerationAvailabilitySchema>;

export const weeklyRecapSchema = z
  .object({
    week: z.number().int().min(1).max(30),
    body: z.string().min(1).max(30_000),
    provider: recapProviderSchema,
    model: z.string().min(1).max(200),
    /** The level configured when this recap was written, which may differ from today's setting. */
    spiceLevel: recapSpiceLevelSchema,
    generatedByDisplayName: z.string().min(1).max(200).nullable(),
    generatedAt: z.iso.datetime(),
  })
  .strict();
export type WeeklyRecap = z.infer<typeof weeklyRecapSchema>;

export const leagueRecapResponseSchema = z
  .object({
    leagueId: z.string().uuid(),
    week: z.number().int().min(1).max(30),
    configuredSpiceLevel: recapSpiceLevelSchema,
    generation: recapGenerationAvailabilitySchema,
    recap: weeklyRecapSchema.nullable(),
  })
  .strict();
export type LeagueRecapResponse = z.infer<typeof leagueRecapResponseSchema>;

export const recapGenerateRequestSchema = z
  .object({
    week: z.number().int().min(1).max(30),
    provider: recapProviderSchema.optional(),
  })
  .strict();
export type RecapGenerateRequest = z.infer<typeof recapGenerateRequestSchema>;

export const recapPersonaCardSchema = z
  .object({
    teamId: z.string().uuid(),
    teamName: z.string().min(1).max(200),
    /** Null when the team has not written a card yet; the list always covers every team. */
    body: z.string().min(1).max(PERSONA_CARD_MAX_LENGTH).nullable(),
    updatedAt: z.iso.datetime().nullable(),
    updatedByDisplayName: z.string().min(1).max(200).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.body === null) !== (value.updatedAt === null)) {
      context.addIssue({
        code: "custom",
        message: "body and updatedAt must either both be present or both be null",
      });
    }
  });
export type RecapPersonaCard = z.infer<typeof recapPersonaCardSchema>;

export const recapPersonaCardListSchema = z
  .object({
    leagueId: z.string().uuid(),
    cards: z.array(recapPersonaCardSchema).max(40),
  })
  .strict();
export type RecapPersonaCardList = z.infer<typeof recapPersonaCardListSchema>;

export const recapPersonaCardSaveRequestSchema = z
  .object({
    body: z.string().trim().min(1).max(PERSONA_CARD_MAX_LENGTH),
  })
  .strict();
export type RecapPersonaCardSaveRequest = z.infer<typeof recapPersonaCardSaveRequestSchema>;

export const recapSettingsSchema = z
  .object({
    leagueId: z.string().uuid(),
    spiceLevel: recapSpiceLevelSchema,
  })
  .strict();
export type RecapSettings = z.infer<typeof recapSettingsSchema>;

export const recapSettingsSaveRequestSchema = z
  .object({
    spiceLevel: recapSpiceLevelSchema,
  })
  .strict();
export type RecapSettingsSaveRequest = z.infer<typeof recapSettingsSaveRequestSchema>;
