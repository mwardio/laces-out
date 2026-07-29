/**
 * Wire contract for one ESPN live draft observation.
 *
 * This file is a deliberate, self-contained mirror of the `@fantasy/contracts` live-draft schemas.
 * The browser companion has no workspace dependencies so the packaged bundle stays free of server
 * libraries; the price is that these types, limits, and the digest canonicalizer must match the
 * server copy exactly. `dom-contract.test.ts` pins the digest to the same golden string the server
 * pins, so drift in either copy fails a test instead of failing every live observation mid-draft.
 *
 * Nothing here knows an ESPN selector or label. Raw markup never reaches this contract.
 */

/**
 * Named bounds, never magic numbers, identical to the server's `ESPN_LIVE_DRAFT_LIMITS`. A few
 * entries below (pro-team/position/roster/revision/season bounds) are literals on the server; they
 * are named here so the sanitizer has one place to read them from.
 */
export const ESPN_LIVE_DRAFT_LIMITS = {
  /** An upload larger than this is dropped before it is sent; the server rejects it too. */
  maximumBodyBytes: 1_048_576,
  maximumTeams: 32,
  maximumPicks: 1_000,
  maximumTeamNameLength: 80,
  maximumPlayerNameLength: 120,
  maximumProTeamLength: 12,
  maximumPositionLength: 12,
  maximumPrice: 100_000,
  maximumRosterSize: 100,
  maximumRevision: 1_000_000,
  minimumSeason: 2019,
  maximumSeason: 2100,
  /** Heartbeat cadence while a draft is live. */
  heartbeatIntervalMs: 5_000,
  /** A feed observed within this window is fresh. */
  freshWindowMs: 10_000,
  /** A standby source may claim the lease once the active one goes quiet this long. */
  failoverEligibleMs: 25_000,
  /** Beyond this the feed is disconnected rather than merely stale. */
  disconnectedMs: 60_000,
  /** Ceiling on transient auction uploads so a bidding war cannot flood the API. */
  transientUploadsPerSecond: 2,
} as const;

export type EspnLiveDraftState = "waiting" | "live" | "paused" | "complete";
export type EspnLiveDraftType = "snake" | "auction";

export interface EspnLiveDraftPickOwnershipV1 {
  readonly overallPick: number;
  readonly providerTeamId: string | null;
  readonly teamName: string;
}

export interface EspnLiveDraftPickV1 {
  readonly sequence: number;
  readonly round: number | null;
  readonly roundPick: number | null;
  readonly keeper: boolean;
  readonly providerTeamId: string | null;
  readonly teamName: string;
  readonly providerPlayerId: string | null;
  readonly playerName: string;
  readonly proTeam: string | null;
  readonly position: string | null;
  readonly price: number | null;
  readonly nominatingProviderTeamId: string | null;
}

export interface EspnLiveDraftCurrentAuctionV1 {
  readonly nominationNumber: number;
  readonly nominatingProviderTeamId: string | null;
  readonly providerPlayerId: string | null;
  readonly playerName: string;
  readonly proTeam: string | null;
  readonly position: string | null;
  readonly highBidProviderTeamId: string | null;
  readonly highBid: number | null;
}

export interface EspnLiveDraftCompletenessV1 {
  readonly contiguousThrough: number;
  readonly duplicateSequences: number;
  readonly unresolvedRows: number;
}

export interface EspnLiveDraftObservationV1 {
  readonly schemaVersion: 1;
  readonly kind: "espn-live-draft";
  readonly leagueId: string;
  readonly season: number;
  /** Extension-generated random UUID. Never an ESPN token, cookie, or session identifier. */
  readonly pageSessionId: string;
  readonly revision: number;
  readonly capturedAt: string;
  readonly state: EspnLiveDraftState;
  readonly draftType: EspnLiveDraftType;
  readonly expectedTeamCount: number;
  readonly expectedRosterSize: number | null;
  readonly pickOwnership: readonly EspnLiveDraftPickOwnershipV1[];
  readonly picks: readonly EspnLiveDraftPickV1[];
  readonly currentAuction: EspnLiveDraftCurrentAuctionV1 | null;
  readonly completeness: EspnLiveDraftCompletenessV1;
  readonly checksumSha256: string;
}

export interface EspnLiveDraftHeartbeatV1 {
  readonly schemaVersion: 1;
  readonly kind: "espn-live-draft-heartbeat";
  readonly leagueId: string;
  readonly season: number;
  readonly pageSessionId: string;
  readonly revision: number;
  readonly capturedAt: string;
  readonly state: EspnLiveDraftState;
  readonly lastChecksumSha256: string | null;
}

/** The durable board facts the checksum is taken over. */
export interface EspnLiveDraftDigestInput {
  readonly leagueId: string;
  readonly season: number;
  readonly state: EspnLiveDraftState;
  readonly draftType: EspnLiveDraftType;
  readonly expectedTeamCount: number;
  readonly expectedRosterSize: number | null;
  readonly pickOwnership: readonly EspnLiveDraftPickOwnershipV1[];
  readonly picks: readonly EspnLiveDraftPickV1[];
}

/**
 * Canonical serialization the observation checksum is taken over.
 *
 * Deliberately covers only durable board facts. `capturedAt`, `revision`, `pageSessionId`,
 * `currentAuction`, and `completeness` are excluded so re-observing an unchanged board yields the
 * same checksum — that identity is what makes a replayed snapshot an idempotent no-op instead of a
 * new material event. Field order is fixed here rather than inherited from wire JSON key order, so
 * the companion and the server compute it independently and still agree byte for byte.
 */
export function espnLiveDraftDigestSource(observation: EspnLiveDraftDigestInput): string {
  return JSON.stringify([
    "espn-live-draft/1",
    observation.leagueId,
    observation.season,
    observation.state,
    observation.draftType,
    observation.expectedTeamCount,
    observation.expectedRosterSize,
    observation.pickOwnership.map((entry) => [
      entry.overallPick,
      entry.providerTeamId,
      entry.teamName,
    ]),
    observation.picks.map((pick) => [
      pick.sequence,
      pick.round,
      pick.roundPick,
      pick.keeper,
      pick.providerTeamId,
      pick.teamName,
      pick.providerPlayerId,
      pick.playerName,
      pick.proTeam,
      pick.position,
      pick.price,
      pick.nominatingProviderTeamId,
    ]),
  ]);
}

/** Hex SHA-256, matching the existing bridge snapshot checksum helper. */
export async function espnLiveDraftChecksum(source: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function espnLiveDraftBodyBytes(body: string): number {
  return new TextEncoder().encode(body).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Text lifted from a provider page is untrusted. Control and format characters are rejected
// outright so a hostile or malformed DOM cannot smuggle framing into logs, names, or rendering.
function boundedText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const text = value.trim();
  if (text.length === 0) throw new TypeError(`${label} is empty`);
  if (text.length > maximum) throw new TypeError(`${label} exceeds ${maximum} characters`);
  if (/[\p{Cc}\p{Cf}]/u.test(text)) throw new TypeError(`${label} contains control characters`);
  return text;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a whole number`);
  }
  if (value < minimum || value > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function nullableText(value: unknown, maximum: number, label: string): string | null {
  return value === null ? null : boundedText(value, maximum, label);
}

function nullableInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number | null {
  return value === null ? null : boundedInteger(value, minimum, maximum, label);
}

function providerTeamId(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{1,20}$/u.test(value)) {
    throw new TypeError(`${label} must be a numeric provider ID`);
  }
  return value;
}

// ESPN exposes D/ST as negative player IDs, so the player form permits a leading sign.
function providerPlayerId(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^-?\d{1,20}$/u.test(value)) {
    throw new TypeError(`${label} must be a numeric provider ID`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${label} must be an ISO 8601 UTC timestamp`);
  }
  return value;
}

function pageSessionId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  ) {
    throw new TypeError("Page session ID must be a random UUID");
  }
  return value;
}

function checksum(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a hex SHA-256 digest`);
  }
  return value;
}

function draftState(value: unknown): EspnLiveDraftState {
  if (value === "waiting" || value === "live" || value === "paused" || value === "complete") {
    return value;
  }
  throw new TypeError("Draft state is not a recognized value");
}

function draftType(value: unknown): EspnLiveDraftType {
  if (value === "snake" || value === "auction") return value;
  throw new TypeError("Draft type is not a recognized value");
}

function boundedArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be a list`);
  if (value.length > ESPN_LIVE_DRAFT_LIMITS.maximumPicks) {
    throw new TypeError(`${label} exceeds ${ESPN_LIVE_DRAFT_LIMITS.maximumPicks} entries`);
  }
  return value as readonly unknown[];
}

export function validateEspnLiveDraftPickOwnership(value: unknown): EspnLiveDraftPickOwnershipV1 {
  if (!isRecord(value)) throw new TypeError("Pick ownership entry is missing");
  return {
    overallPick: boundedInteger(
      value.overallPick,
      1,
      ESPN_LIVE_DRAFT_LIMITS.maximumPicks,
      "Overall pick",
    ),
    providerTeamId: providerTeamId(value.providerTeamId, "Pick ownership team ID"),
    teamName: boundedText(
      value.teamName,
      ESPN_LIVE_DRAFT_LIMITS.maximumTeamNameLength,
      "Pick ownership team name",
    ),
  };
}

export function validateEspnLiveDraftPick(value: unknown): EspnLiveDraftPickV1 {
  if (!isRecord(value)) throw new TypeError("Pick is missing");
  return {
    sequence: boundedInteger(value.sequence, 1, ESPN_LIVE_DRAFT_LIMITS.maximumPicks, "Pick order"),
    round: nullableInteger(value.round, 1, ESPN_LIVE_DRAFT_LIMITS.maximumPicks, "Pick round"),
    roundPick: nullableInteger(
      value.roundPick,
      1,
      ESPN_LIVE_DRAFT_LIMITS.maximumTeams,
      "Pick slot in round",
    ),
    keeper: ((): boolean => {
      if (typeof value.keeper !== "boolean") throw new TypeError("Keeper flag must be a boolean");
      return value.keeper;
    })(),
    providerTeamId: providerTeamId(value.providerTeamId, "Pick team ID"),
    teamName: boundedText(
      value.teamName,
      ESPN_LIVE_DRAFT_LIMITS.maximumTeamNameLength,
      "Pick team name",
    ),
    providerPlayerId: providerPlayerId(value.providerPlayerId, "Pick player ID"),
    playerName: boundedText(
      value.playerName,
      ESPN_LIVE_DRAFT_LIMITS.maximumPlayerNameLength,
      "Pick player name",
    ),
    proTeam: nullableText(
      value.proTeam,
      ESPN_LIVE_DRAFT_LIMITS.maximumProTeamLength,
      "Pick pro team",
    ),
    position: nullableText(
      value.position,
      ESPN_LIVE_DRAFT_LIMITS.maximumPositionLength,
      "Pick position",
    ),
    price: nullableInteger(value.price, 0, ESPN_LIVE_DRAFT_LIMITS.maximumPrice, "Pick price"),
    nominatingProviderTeamId: providerTeamId(
      value.nominatingProviderTeamId,
      "Pick nominating team ID",
    ),
  };
}

export function validateEspnLiveDraftCurrentAuction(value: unknown): EspnLiveDraftCurrentAuctionV1 {
  if (!isRecord(value)) throw new TypeError("Current auction state is missing");
  return {
    nominationNumber: boundedInteger(
      value.nominationNumber,
      1,
      ESPN_LIVE_DRAFT_LIMITS.maximumPicks,
      "Nomination number",
    ),
    nominatingProviderTeamId: providerTeamId(value.nominatingProviderTeamId, "Nominating team ID"),
    providerPlayerId: providerPlayerId(value.providerPlayerId, "Nominated player ID"),
    playerName: boundedText(
      value.playerName,
      ESPN_LIVE_DRAFT_LIMITS.maximumPlayerNameLength,
      "Nominated player name",
    ),
    proTeam: nullableText(
      value.proTeam,
      ESPN_LIVE_DRAFT_LIMITS.maximumProTeamLength,
      "Nominated pro team",
    ),
    position: nullableText(
      value.position,
      ESPN_LIVE_DRAFT_LIMITS.maximumPositionLength,
      "Nominated position",
    ),
    highBidProviderTeamId: providerTeamId(value.highBidProviderTeamId, "High bid team ID"),
    highBid: nullableInteger(value.highBid, 0, ESPN_LIVE_DRAFT_LIMITS.maximumPrice, "High bid"),
  };
}

/**
 * Rebuilds the observation from validated fields rather than passing the caller's object through.
 * Any unknown key an untrusted sender attached is structurally dropped, so raw markup or page text
 * cannot ride along to the server even if a content script were compromised.
 */
export function validateEspnLiveDraftObservation(value: unknown): EspnLiveDraftObservationV1 {
  if (!isRecord(value)) throw new TypeError("Live draft observation is missing");
  if (value.schemaVersion !== 1)
    throw new TypeError("Live draft observation schema is unsupported");
  if (value.kind !== "espn-live-draft") throw new TypeError("Live draft observation kind is wrong");
  const leagueId = providerTeamId(value.leagueId, "League ID");
  if (leagueId === null) throw new TypeError("League ID is required");
  const observedType = draftType(value.draftType);
  const picks = boundedArray(value.picks, "Picks").map(validateEspnLiveDraftPick);
  const pickOwnership = boundedArray(value.pickOwnership, "Pick ownership").map(
    validateEspnLiveDraftPickOwnership,
  );
  const currentAuction =
    value.currentAuction === null
      ? null
      : validateEspnLiveDraftCurrentAuction(value.currentAuction);
  if (observedType === "snake" && currentAuction !== null) {
    throw new TypeError("Snake drafts cannot report auction nomination state");
  }
  if (new Set(pickOwnership.map((entry) => entry.overallPick)).size !== pickOwnership.length) {
    throw new TypeError("Overall pick ownership must be unique");
  }
  if (!isRecord(value.completeness)) throw new TypeError("Completeness is missing");
  const completeness: EspnLiveDraftCompletenessV1 = {
    contiguousThrough: boundedInteger(
      value.completeness.contiguousThrough,
      0,
      ESPN_LIVE_DRAFT_LIMITS.maximumPicks,
      "Contiguous pick count",
    ),
    duplicateSequences: boundedInteger(
      value.completeness.duplicateSequences,
      0,
      ESPN_LIVE_DRAFT_LIMITS.maximumPicks,
      "Duplicate pick count",
    ),
    unresolvedRows: boundedInteger(
      value.completeness.unresolvedRows,
      0,
      ESPN_LIVE_DRAFT_LIMITS.maximumPicks,
      "Unresolved row count",
    ),
  };
  if (completeness.contiguousThrough > picks.length) {
    throw new TypeError("Contiguous pick count cannot exceed the number of reported picks");
  }
  return {
    schemaVersion: 1,
    kind: "espn-live-draft",
    leagueId,
    season: boundedInteger(
      value.season,
      ESPN_LIVE_DRAFT_LIMITS.minimumSeason,
      ESPN_LIVE_DRAFT_LIMITS.maximumSeason,
      "Season",
    ),
    pageSessionId: pageSessionId(value.pageSessionId),
    revision: boundedInteger(
      value.revision,
      0,
      ESPN_LIVE_DRAFT_LIMITS.maximumRevision,
      "Page revision",
    ),
    capturedAt: timestamp(value.capturedAt, "Capture time"),
    state: draftState(value.state),
    draftType: observedType,
    expectedTeamCount: boundedInteger(
      value.expectedTeamCount,
      2,
      ESPN_LIVE_DRAFT_LIMITS.maximumTeams,
      "Team count",
    ),
    expectedRosterSize: nullableInteger(
      value.expectedRosterSize,
      1,
      ESPN_LIVE_DRAFT_LIMITS.maximumRosterSize,
      "Roster size",
    ),
    pickOwnership,
    picks,
    currentAuction,
    completeness,
    checksumSha256: checksum(value.checksumSha256, "Observation checksum"),
  };
}

export function validateEspnLiveDraftHeartbeat(value: unknown): EspnLiveDraftHeartbeatV1 {
  if (!isRecord(value)) throw new TypeError("Live draft heartbeat is missing");
  if (value.schemaVersion !== 1) throw new TypeError("Live draft heartbeat schema is unsupported");
  if (value.kind !== "espn-live-draft-heartbeat") {
    throw new TypeError("Live draft heartbeat kind is wrong");
  }
  const leagueId = providerTeamId(value.leagueId, "League ID");
  if (leagueId === null) throw new TypeError("League ID is required");
  return {
    schemaVersion: 1,
    kind: "espn-live-draft-heartbeat",
    leagueId,
    season: boundedInteger(
      value.season,
      ESPN_LIVE_DRAFT_LIMITS.minimumSeason,
      ESPN_LIVE_DRAFT_LIMITS.maximumSeason,
      "Season",
    ),
    pageSessionId: pageSessionId(value.pageSessionId),
    revision: boundedInteger(
      value.revision,
      0,
      ESPN_LIVE_DRAFT_LIMITS.maximumRevision,
      "Page revision",
    ),
    capturedAt: timestamp(value.capturedAt, "Capture time"),
    state: draftState(value.state),
    lastChecksumSha256:
      value.lastChecksumSha256 === null
        ? null
        : checksum(value.lastChecksumSha256, "Last observation checksum"),
  };
}
