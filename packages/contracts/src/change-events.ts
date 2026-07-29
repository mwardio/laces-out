import { z } from "zod";

/**
 * Wire contracts for the change-event feed (WP5 / A6 + D9).
 *
 * **Browser-safe.** This module has no `node:` import — `apps/web` client components read the
 * contracts barrel, so anything requiring `node:crypto` belongs in `@fantasy/change-events` instead.
 *
 * **Versioned registry, not a single wire shape.** Every stored payload begins with
 * `v: CHANGE_EVENT_PAYLOAD_VERSION`. `parseChangeEventPayload` reads `v` *before* validating, so a
 * row written by a future version degrades to `unsupported-version` and still renders as a feed
 * entry rather than disappearing or throwing. `change_events` is append-only at the database level,
 * so a payload written today can never be migrated in place — forward-compatible reads are the only
 * available answer.
 *
 * **Cursor convention introduced here.** No route in this repository paginated before WP5. The
 * scheme is an opaque `base64url("<occurredAtIso>|<uuid>")` cursor read against
 * `order by occurred_at desc, id desc`, with `nextCursor: null` on the last page. Decoding validates
 * both halves and returns `null` on anything else, so a forged cursor can never reach SQL. Copy this
 * scheme rather than inventing a second one.
 */

/** The producers allowed to write a change event. `source` is half of the deduplication key. */
export const CHANGE_EVENT_SOURCES = [
  "league-sync",
  "roster-diff",
  "injury-report",
  "decision-delta",
] as const;
export type ChangeEventSource = (typeof CHANGE_EVENT_SOURCES)[number];

export const CHANGE_EVENT_KINDS = [
  "league.sync.completed",
  "roster.changed",
  "player.injury.changed",
  "recommendation.changed",
] as const;
export type ChangeEventKind = (typeof CHANGE_EVENT_KINDS)[number];

/** Verbatim from `change_events_visibility_check`. Widening this needs a forward migration. */
export const CHANGE_EVENT_VISIBILITIES = ["private", "league", "global"] as const;
export type ChangeEventVisibility = (typeof CHANGE_EVENT_VISIBILITIES)[number];

/** Verbatim from `change_events_severity_check`. */
export const CHANGE_EVENT_SEVERITIES = ["info", "action", "warning", "critical"] as const;
export type ChangeEventSeverity = (typeof CHANGE_EVENT_SEVERITIES)[number];

export const changeEventSourceSchema = z.enum(CHANGE_EVENT_SOURCES);
export const changeEventKindSchema = z.enum(CHANGE_EVENT_KINDS);
export const changeEventVisibilitySchema = z.enum(CHANGE_EVENT_VISIBILITIES);
export const changeEventSeveritySchema = z.enum(CHANGE_EVENT_SEVERITIES);

/** Bumped only when a payload shape changes incompatibly. Old rows keep their stored version. */
export const CHANGE_EVENT_PAYLOAD_VERSION = 1;

const versionSchema = z.literal(CHANGE_EVENT_PAYLOAD_VERSION);
const checksumSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const nameSchema = z.string().min(1).max(120);
const seasonSchema = z.number().int().min(1999).max(2200);
const weekSchema = z.number().int().min(0).max(25);

const rosterPlayerSchema = z.object({ playerId: z.string().uuid(), name: nameSchema }).strict();

export const leagueSyncCompletedPayloadSchema = z
  .object({
    v: versionSchema,
    provider: z.enum(["espn", "yahoo", "sleeper"]),
    season: seasonSchema,
    week: weekSchema.nullable(),
    teamCount: z.number().int().min(0).max(64),
  })
  .strict();
export type LeagueSyncCompletedPayload = z.infer<typeof leagueSyncCompletedPayloadSchema>;

export const rosterChangedPayloadSchema = z
  .object({
    v: versionSchema,
    teamId: z.string().uuid(),
    teamName: nameSchema,
    season: seasonSchema,
    week: weekSchema.nullable(),
    // Bounded so a mass drop cannot write an unbounded JSONB blob; the overflow is counted instead.
    added: z.array(rosterPlayerSchema).max(8),
    removed: z.array(rosterPlayerSchema).max(8),
    promoted: z.array(rosterPlayerSchema).max(8),
    benched: z.array(rosterPlayerSchema).max(8),
    moreCount: z.number().int().min(0).max(512),
  })
  .strict();
export type RosterChangedPayload = z.infer<typeof rosterChangedPayloadSchema>;

export const playerInjuryChangedPayloadSchema = z
  .object({
    v: versionSchema,
    playerId: z.string().uuid(),
    playerName: nameSchema,
    teamName: nameSchema,
    season: seasonSchema,
    week: weekSchema,
    reportStatus: z.enum(["out", "doubtful", "questionable", "probable", "note"]).nullable(),
    practiceStatus: z.string().min(1).max(80).nullable(),
  })
  .strict();
export type PlayerInjuryChangedPayload = z.infer<typeof playerInjuryChangedPayloadSchema>;

/**
 * ADR 0003: a recommendation-shaped output retains its algorithm version and input checksum. Both
 * are copied here from the persisted `recommendation_runs` row the delta was computed from, so the
 * feed entry is traceable to a stored, replayable run rather than to a request-time computation.
 */
export const recommendationChangedPayloadSchema = z
  .object({
    v: versionSchema,
    leagueSeasonId: z.string().uuid(),
    fantasyTeamId: z.string().uuid(),
    teamName: nameSchema,
    week: weekSchema.nullable(),
    kinds: z
      .array(z.enum(["lineup", "waiver", "trade"]))
      .min(1)
      .max(3),
    fingerprint: checksumSchema,
    algorithmVersion: z.string().min(1).max(120),
    inputChecksum: checksumSchema,
  })
  .strict();
export type RecommendationChangedPayload = z.infer<typeof recommendationChangedPayloadSchema>;

const payloadSchemas = {
  "league.sync.completed": leagueSyncCompletedPayloadSchema,
  "roster.changed": rosterChangedPayloadSchema,
  "player.injury.changed": playerInjuryChangedPayloadSchema,
  "recommendation.changed": recommendationChangedPayloadSchema,
} as const satisfies Record<ChangeEventKind, z.ZodType>;

export type ChangeEventPayloadFor<K extends ChangeEventKind> = z.infer<(typeof payloadSchemas)[K]>;

export type ParsedChangeEventPayload = {
  [K in ChangeEventKind]: {
    readonly state: "parsed";
    readonly eventType: K;
    readonly payload: ChangeEventPayloadFor<K>;
  };
}[ChangeEventKind];

export type ChangeEventPayloadParseResult =
  | ParsedChangeEventPayload
  | { readonly state: "unsupported-version"; readonly version: number }
  | { readonly state: "malformed"; readonly issues: readonly string[] }
  | { readonly state: "unknown-kind" };

function isRegisteredKind(value: string): value is ChangeEventKind {
  return (CHANGE_EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * Never throws. A producer bug, a legacy row, and a future writer's row are three different answers,
 * and the feed renders all three rather than dropping a row it cannot fully understand.
 */
export function parseChangeEventPayload(
  eventType: string,
  payload: unknown,
): ChangeEventPayloadParseResult {
  if (!isRegisteredKind(eventType)) return { state: "unknown-kind" };
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { state: "malformed", issues: ["payload is not an object"] };
  }
  // Read the version before validating: a future writer's shape must degrade legibly rather than
  // failing every field it added.
  const version = (payload as Record<string, unknown>)["v"];
  if (typeof version === "number" && version !== CHANGE_EVENT_PAYLOAD_VERSION) {
    return { state: "unsupported-version", version };
  }
  const parsed = payloadSchemas[eventType].safeParse(payload);
  if (!parsed.success) {
    return {
      state: "malformed",
      issues: parsed.error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }
  return { state: "parsed", eventType, payload: parsed.data } as ParsedChangeEventPayload;
}

const cursorOccurredAtSchema = z.iso.datetime();
const cursorIdSchema = z.string().uuid();

function toBase64Url(value: string): string {
  // `btoa` is global in Node 18+ and every supported browser. The payload is ASCII by construction.
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/u.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  try {
    return atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="));
  } catch {
    return null;
  }
}

export interface ChangeEventCursor {
  readonly occurredAt: string;
  readonly id: string;
}

export function encodeChangeEventCursor(occurredAt: string, id: string): string {
  return toBase64Url(`${occurredAt}|${id}`);
}

/** Returns `null` for anything that is not a cursor this module produced. */
export function decodeChangeEventCursor(cursor: string): ChangeEventCursor | null {
  const decoded = fromBase64Url(cursor);
  if (decoded === null) return null;
  const separator = decoded.indexOf("|");
  if (separator === -1) return null;
  const occurredAt = cursorOccurredAtSchema.safeParse(decoded.slice(0, separator));
  const id = cursorIdSchema.safeParse(decoded.slice(separator + 1));
  if (!occurredAt.success || !id.success) return null;
  return { occurredAt: occurredAt.data, id: id.data };
}

export const changeEventSchema = z
  .object({
    id: z.string().uuid(),
    eventType: z.string().min(1).max(80),
    severity: changeEventSeveritySchema,
    visibility: changeEventVisibilitySchema,
    leagueId: z.string().uuid().nullable(),
    occurredAt: z.iso.datetime(),
    headline: z.string().min(1).max(160),
    detail: z.string().min(1).max(400).nullable(),
    /** Always application-relative: the service worker opens same-origin destinations only. */
    url: z.string().min(1).max(200),
    state: z.enum(["unread", "read"]),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ChangeEvent = z.infer<typeof changeEventSchema>;

export const changeEventFeedResponseSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    unreadCount: z.number().int().min(0).max(999),
    nextCursor: z.string().max(200).nullable(),
    events: z.array(changeEventSchema).max(50),
  })
  .strict();
export type ChangeEventFeedResponse = z.infer<typeof changeEventFeedResponseSchema>;

export const changeEventReceiptResponseSchema = z
  .object({
    eventId: z.string().uuid(),
    state: z.enum(["read", "dismissed"]),
    at: z.iso.datetime(),
  })
  .strict();
export type ChangeEventReceiptResponse = z.infer<typeof changeEventReceiptResponseSchema>;
