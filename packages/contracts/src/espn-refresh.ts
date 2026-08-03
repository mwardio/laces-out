import { z } from "zod";

export const espnArtifactFamilySchema = z.enum([
  "core",
  "available-players",
  "weekly-box-scores",
  "transactions",
  "completed-draft",
]);
export type EspnArtifactFamily = z.infer<typeof espnArtifactFamilySchema>;

/** Member refresh parameters are entirely server-owned; clients cannot force or widen work. */
export const espnLeagueRefreshRequestSchema = z.object({}).strict();

export const espnDirectCapabilityStateSchema = z.enum([
  "unknown",
  "available",
  "not-public",
  "degraded",
  "disabled",
]);
export const espnPreferredSyncModeSchema = z.enum(["direct", "assisted", "automatic"]);
export const espnRefreshFulfillmentModeSchema = z.enum([
  "server-direct",
  "chrome-agent",
  "native-agent",
]);
export const espnRefreshAttemptStateSchema = z.enum([
  "offered",
  "started",
  "accepted",
  "unchanged",
  "login-required",
  "not-public",
  "retryable-error",
  "rejected",
]);
export const bridgeClientKindSchema = z.enum(["chrome-extension", "ios-app"]);

export const espnArtifactFreshnessSchema = z
  .object({
    family: espnArtifactFamilySchema,
    state: z.enum(["fresh", "aging", "stale", "missing"]),
    observedAt: z.iso.datetime().nullable(),
  })
  .strict();

export const espnLeagueRefreshStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.iso.datetime(),
    leagueSeasonId: z.string().uuid(),
    provider: z.literal("espn"),
    current: z.boolean(),
    context: z.enum(["active", "near-lock", "offseason"]),
    artifacts: z.array(espnArtifactFreshnessSchema).min(1).max(5),
    direct: z
      .object({
        enabled: z.boolean(),
        coreState: espnDirectCapabilityStateSchema,
        preferredMode: espnPreferredSyncModeSchema,
        lastProbeAt: z.iso.datetime().nullable(),
        nextProbeAt: z.iso.datetime().nullable(),
        lastSuccessAt: z.iso.datetime().nullable(),
        circuitOpenUntil: z.iso.datetime().nullable(),
      })
      .strict(),
    agents: z
      .object({
        activeCount: z.number().int().nonnegative().max(64),
        mostRecentSeenAt: z.iso.datetime().nullable(),
      })
      .strict(),
    request: z
      .object({
        id: z.string().uuid(),
        state: z.enum(["queued", "processing", "succeeded", "failed", "cancelled"]),
        fulfillmentMode: espnRefreshFulfillmentModeSchema.nullable(),
        requiredArtifacts: z.array(espnArtifactFamilySchema).min(1).max(5),
        minimumCaptureAt: z.iso.datetime(),
        requestedAt: z.iso.datetime(),
        expiresAt: z.iso.datetime(),
        finishedAt: z.iso.datetime().nullable(),
        latestAttempt: z
          .object({
            mode: espnRefreshFulfillmentModeSchema,
            state: espnRefreshAttemptStateSchema,
            deviceName: z.string().max(80).nullable(),
            errorCode: z.string().max(64).nullable(),
            startedAt: z.iso.datetime(),
            finishedAt: z.iso.datetime().nullable(),
          })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
    display: z
      .object({
        code: z.enum([
          "up-to-date",
          "refreshing-direct",
          "refreshing-agent",
          "queued-no-agent",
          "login-required",
          "last-good",
        ]),
        label: z.string().min(1).max(160),
        actionRequired: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type EspnLeagueRefreshStatus = z.infer<typeof espnLeagueRefreshStatusSchema>;

export const espnRefreshAgentPollRequestSchema = z.object({}).strict();
export const espnRefreshAgentPollResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.iso.datetime(),
    pollAfterSeconds: z.number().int().min(60).max(3600),
    requests: z
      .array(
        z
          .object({
            requestId: z.string().uuid(),
            externalLeagueId: z.string().regex(/^\d{1,20}$/u),
            season: z.number().int().min(2000).max(2100),
            minimumCaptureAt: z.iso.datetime(),
            expiresAt: z.iso.datetime(),
            requiredArtifacts: z.array(espnArtifactFamilySchema).min(1).max(5),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type EspnRefreshAgentPollResponse = z.infer<typeof espnRefreshAgentPollResponseSchema>;

export const espnRefreshAgentAttemptRequestSchema = z
  .object({
    state: z.enum(["started", "login-required", "retryable-error", "rejected"]),
    errorCode: z.string().trim().min(1).max(64).optional(),
    detail: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state !== "started" && value.errorCode === undefined) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "a terminal attempt requires a bounded error code",
      });
    }
  });

export const espnRefreshAgentAttemptResponseSchema = z
  .object({
    attemptId: z.string().uuid(),
    state: espnRefreshAttemptStateSchema,
    recordedAt: z.iso.datetime(),
  })
  .strict();
