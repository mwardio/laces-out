import { z } from "zod";

import type { EspnSessionArtifact } from "./session-client.js";
import {
  EspnWebClientNormalizationError,
  MAX_ESPN_WEB_CLIENT_SNAPSHOT_BYTES,
  canonicalEspnMemberId,
  type EspnWebClientNormalizationIssue,
} from "./web-client-normalizer.js";

const ESPN_READ_ORIGIN = "https://lm-api-reads.fantasy.espn.com";

const providerIdSchema = z
  .union([z.string().regex(/^\d{1,20}$/u), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)])
  .transform((value) => String(value));

const memberIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim());

const espnBooleanSchema = z
  .union([z.boolean(), z.literal(0), z.literal(1)])
  .transform((value) => value === true || value === 1);

const navigationMemberSchema = z
  .object({
    id: memberIdSchema,
    isLeagueManager: espnBooleanSchema.optional(),
    isLeagueCreator: espnBooleanSchema.optional(),
    // ESPN's own web client treats this member-scoped flag as manager authority when present.
    // It is deliberately read only from the exact active member object.
    isLeagueAdmin: espnBooleanSchema.optional(),
  })
  .passthrough();

const navigationPayloadSchema = z
  .object({
    id: providerIdSchema,
    seasonId: z.number().int().min(2000).max(2100),
    members: z.array(navigationMemberSchema).min(1).max(128),
  })
  .passthrough()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    value.members.forEach((member, index) => {
      if (ids.has(member.id)) {
        context.addIssue({
          code: "custom",
          path: ["members", index, "id"],
          message: "navigation member IDs must be unique",
        });
      }
      ids.add(member.id);
    });
  });

const artifactSchema = z
  .object({
    leagueId: z.string().regex(/^\d{1,20}$/u),
    season: z.number().int().min(2000).max(2100),
    endpoint: z.string().url().max(4096),
    capturedAt: z.string().datetime({ offset: true }),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    payload: z.unknown(),
  })
  .strict();

function issues(error: z.ZodError): readonly EspnWebClientNormalizationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    code: "SCHEMA_DRIFT",
    message:
      issue.code === "custom"
        ? issue.message
        : "Value did not match the expected ESPN navigation shape",
  }));
}

function fail(
  code: "INVALID_ENVELOPE" | "INVALID_METADATA" | "SCHEMA_DRIFT" | "TOO_LARGE",
  message: string,
  path?: string,
): never {
  throw new EspnWebClientNormalizationError({
    code,
    message,
    ...(path
      ? {
          issues: [
            {
              path,
              code,
              message: "ESPN navigation evidence did not match its bounded contract",
            },
          ],
        }
      : {}),
  });
}

function validateEndpoint(endpoint: string, leagueId: string, season: number): void {
  const url = new URL(endpoint);
  const expectedPath = `/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const parameters = [...url.searchParams.entries()];
  if (
    url.origin !== ESPN_READ_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== expectedPath ||
    url.hash !== "" ||
    parameters.length !== 1 ||
    parameters[0]?.[0] !== "view" ||
    parameters[0]?.[1] !== "mNav"
  ) {
    fail(
      "INVALID_ENVELOPE",
      "ESPN navigation endpoint is outside the allowed league scope",
      "endpoint",
    );
  }
}

function validateActiveMemberId(value: string): string {
  const result = memberIdSchema.safeParse(value);
  if (!result.success) {
    throw new EspnWebClientNormalizationError({
      code: "INVALID_METADATA",
      message: "ESPN active-member metadata is invalid",
      issues: issues(result.error).map((issue) => ({ ...issue, code: "INVALID_METADATA" })),
    });
  }
  return result.data;
}

/**
 * Returns authority only for the exact authenticated ESPN member in a dedicated mNav response.
 * Any explicit true flag wins. False is authoritative only when both stable base flags are
 * explicitly false; isLeagueAdmin also participates when ESPN exposes it on that member. Missing
 * or ambiguous member evidence remains unknown. No team, owner-name, creator-owner, or co-manager
 * inference is performed.
 */
export function normalizeEspnNavigationManagerAuthority(
  input: EspnSessionArtifact,
  activeMemberId: string,
): boolean | null {
  const artifactResult = artifactSchema.safeParse(input);
  if (!artifactResult.success) {
    throw new EspnWebClientNormalizationError({
      code: "INVALID_ENVELOPE",
      message: "ESPN navigation artifact metadata is invalid",
      issues: issues(artifactResult.error).map((issue) => ({ ...issue, code: "INVALID_ENVELOPE" })),
    });
  }
  const artifact = artifactResult.data;
  validateEndpoint(artifact.endpoint, artifact.leagueId, artifact.season);

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(artifact.payload);
  } catch {
    fail("SCHEMA_DRIFT", "ESPN navigation payload is not JSON serializable");
  }
  if (serialized === undefined) {
    fail("SCHEMA_DRIFT", "ESPN navigation payload is empty");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_ESPN_WEB_CLIENT_SNAPSHOT_BYTES) {
    fail("TOO_LARGE", "ESPN navigation payload exceeds the safety limit");
  }

  const payloadResult = navigationPayloadSchema.safeParse(artifact.payload);
  if (!payloadResult.success) {
    throw new EspnWebClientNormalizationError({
      code: "SCHEMA_DRIFT",
      message: "ESPN navigation payload did not match the bounded member contract",
      issues: issues(payloadResult.error),
    });
  }
  const payload = payloadResult.data;
  if (payload.id !== artifact.leagueId || payload.seasonId !== artifact.season) {
    fail(
      "INVALID_ENVELOPE",
      "ESPN navigation artifact does not identify its enclosed league payload",
      "payload",
    );
  }

  const canonicalActiveMemberId = canonicalEspnMemberId(validateActiveMemberId(activeMemberId));
  const matches = payload.members.filter(
    (member) => canonicalEspnMemberId(member.id) === canonicalActiveMemberId,
  );
  if (matches.length !== 1) return null;

  const member = matches[0]!;
  const flags = [member.isLeagueManager, member.isLeagueCreator];
  if (member.isLeagueAdmin !== undefined) flags.push(member.isLeagueAdmin);
  if (flags.some((flag) => flag === true)) return true;
  return member.isLeagueManager === false && member.isLeagueCreator === false ? false : null;
}
