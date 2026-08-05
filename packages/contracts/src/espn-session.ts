import { z } from "zod";

const swidPattern =
  /^\{[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}$/iu;
const espnS2Pattern = /^[^\s;\p{Cc}]+$/u;

/** Sensitive body accepted only from an already paired ESPN sync device. */
export const espnSessionGrantRequestSchema = z
  .object({
    swid: z.string().min(38).max(38).regex(swidPattern),
    espnS2: z.string().min(32).max(4096).regex(espnS2Pattern),
    capturedAt: z.iso.datetime(),
  })
  .strict();
export type EspnSessionGrantRequest = z.infer<typeof espnSessionGrantRequestSchema>;

export const espnSessionLeagueSchema = z
  .object({
    leagueId: z.string().uuid(),
    leagueSeasonId: z.string().uuid(),
    name: z.string().min(1),
    externalKey: z.string().regex(/^\d{1,20}$/u),
    season: z.number().int().min(2000).max(2200),
    lastSyncedAt: z.iso.datetime().nullable(),
  })
  .strict();

export const espnSessionConnectionSchema = z
  .object({
    connectionId: z.string().uuid(),
    displayName: z.string().min(1),
    health: z.enum(["pending", "healthy", "degraded", "reauthorize", "disabled"]),
    lastSuccessfulAt: z.iso.datetime().nullable(),
    lastErrorCode: z.string().nullable(),
    lastErrorAt: z.iso.datetime().nullable(),
    leagues: z.array(espnSessionLeagueSchema).max(32),
  })
  .strict();
export type EspnSessionConnection = z.infer<typeof espnSessionConnectionSchema>;

export const espnSessionConnectionListSchema = z
  .object({
    available: z.boolean(),
    connections: z.array(espnSessionConnectionSchema).max(8),
  })
  .strict();
export type EspnSessionConnectionList = z.infer<typeof espnSessionConnectionListSchema>;

export const espnSessionGrantResponseSchema = z
  .object({
    connectionId: z.string().uuid(),
    state: z.literal("healthy"),
    linkedLeagueCount: z.number().int().min(0).max(32),
  })
  .strict();
export type EspnSessionGrantResponse = z.infer<typeof espnSessionGrantResponseSchema>;
