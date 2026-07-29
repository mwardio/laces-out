/**
 * Turns a raw draft-room extraction into a sanitized, bounded, checksummed observation.
 *
 * Pure and fully testable in node: no DOM, no chrome API, no network. This module owns the upload
 * limits, control-character rejection, duplicate/gap detection, and the durable versus transient
 * auction split. It knows no ESPN selector; the only ESPN knowledge it uses is the label vocabulary
 * exported by `dom-adapter.ts`, applied as a lookup.
 *
 * Every rule here is fail-closed. An unreadable field never becomes a guess: it becomes `null` when
 * the contract permits absence, and otherwise drops its row into `completeness.unresolvedRows` so
 * the server can hold rather than advance the board.
 */

import { ESPN_DRAFT_LABELS, type RawDraftRoomExtraction, type RawPickRow } from "./dom-adapter.js";
import {
  ESPN_LIVE_DRAFT_LIMITS,
  espnLiveDraftChecksum,
  espnLiveDraftDigestSource,
  type EspnLiveDraftCompletenessV1,
  type EspnLiveDraftCurrentAuctionV1,
  type EspnLiveDraftObservationV1,
  type EspnLiveDraftPickOwnershipV1,
  type EspnLiveDraftPickV1,
  type EspnLiveDraftState,
  type EspnLiveDraftType,
} from "./dom-contract.js";

// Unicode whitespace plus the invisible characters ESPN markup uses for layout: non-breaking
// space, zero-width space/non-joiner/joiner, and the byte-order mark.
const WHITESPACE_RUN = /(?:\s|\u00a0|\u200b|\u200c|\u200d|\ufeff)+/gu;

/**
 * Collapses provider text to a comparable form.
 *
 * ESPN markup routinely carries newlines, tabs, and non-breaking spaces around a value, so runs of
 * any Unicode whitespace collapse to one space first. Anything still holding a control or format
 * character after that is hostile or corrupt, not merely ugly, and is rejected outright: null, not
 * a scrubbed approximation.
 */
export function normalizeDraftText(value: string | null, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(WHITESPACE_RUN, " ").trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length > maximum) return null;
  if (/[\p{Cc}\p{Cf}]/u.test(collapsed)) return null;
  return collapsed;
}

/** Lowercased normalized text, for label-vocabulary lookups. */
export function normalizeDraftLabel(value: string | null): string | null {
  const text = normalizeDraftText(value, 200);
  return text === null ? null : text.toLowerCase();
}

/**
 * Parses a bounded whole number out of provider text. Currency marks, thousands separators, and
 * ordinal decoration are stripped; anything else — including a fractional value — is rejected.
 */
export function parseDraftInteger(
  value: string | null,
  minimum: number,
  maximum: number,
): number | null {
  const text = normalizeDraftText(value, 32);
  if (text === null) return null;
  const stripped = text.replace(/^[#$]/u, "").replace(/,/gu, "").replace(/\s/gu, "");
  if (!/^-?\d{1,15}$/u.test(stripped)) return null;
  const parsed = Number(stripped);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return null;
  return parsed;
}

/** Provider team IDs are decimal strings and are never rounded through a JavaScript number. */
export function parseProviderTeamId(value: string | null): string | null {
  const text = normalizeDraftText(value, 32);
  return text !== null && /^\d{1,20}$/u.test(text) ? text : null;
}

/** ESPN exposes D/ST as negative player IDs, so the player form permits a leading sign. */
export function parseProviderPlayerId(value: string | null): string | null {
  const text = normalizeDraftText(value, 32);
  return text !== null && /^-?\d{1,20}$/u.test(text) ? text : null;
}

export type EspnLiveDraftSnapshotFailure =
  | "not-a-draft-room"
  | "draft-state-unknown"
  | "draft-type-unknown"
  | "team-count-unknown"
  | "selectors-ambiguous"
  | "row-overflow";

/** A sanitized board, before a page session, revision, capture time, and checksum are attached. */
export interface EspnLiveDraftSnapshot {
  readonly leagueId: string;
  readonly season: number;
  readonly state: EspnLiveDraftState;
  readonly draftType: EspnLiveDraftType;
  readonly expectedTeamCount: number;
  readonly expectedRosterSize: number | null;
  readonly pickOwnership: readonly EspnLiveDraftPickOwnershipV1[];
  readonly picks: readonly EspnLiveDraftPickV1[];
  readonly currentAuction: EspnLiveDraftCurrentAuctionV1 | null;
  readonly completeness: EspnLiveDraftCompletenessV1;
  /** The exact string the checksum is taken over. Compared directly for change detection. */
  readonly digestSource: string;
}

export type EspnLiveDraftSnapshotResult =
  | { readonly ok: true; readonly snapshot: EspnLiveDraftSnapshot }
  | { readonly ok: false; readonly reason: EspnLiveDraftSnapshotFailure };

export interface EspnLiveDraftScope {
  readonly leagueId: string;
  readonly season: number;
}

function resolveState(extraction: RawDraftRoomExtraction): EspnLiveDraftState | null {
  const attribute = normalizeDraftLabel(extraction.stateAttribute);
  const fromAttribute = attribute === null ? undefined : ESPN_DRAFT_LABELS.state[attribute];
  if (fromAttribute !== undefined) return fromAttribute;
  const label = normalizeDraftLabel(extraction.stateLabel);
  const fromLabel = label === null ? undefined : ESPN_DRAFT_LABELS.state[label];
  return fromLabel ?? null;
}

function resolveDraftType(extraction: RawDraftRoomExtraction): EspnLiveDraftType | null {
  const attribute = normalizeDraftLabel(extraction.draftTypeAttribute);
  const fromAttribute = attribute === null ? undefined : ESPN_DRAFT_LABELS.draftType[attribute];
  if (fromAttribute !== undefined) return fromAttribute;
  const label = normalizeDraftLabel(extraction.draftTypeLabel);
  const fromLabel = label === null ? undefined : ESPN_DRAFT_LABELS.draftType[label];
  return fromLabel ?? null;
}

function resolveKeeper(label: string | null): boolean | null {
  const normalized = normalizeDraftLabel(label);
  if (normalized === null) return false;
  if (ESPN_DRAFT_LABELS.keeperTrue.includes(normalized)) return true;
  if (ESPN_DRAFT_LABELS.keeperFalse.includes(normalized)) return false;
  return null;
}

/**
 * Sanitizes one pick row. Returns null when the row cannot be trusted, which the caller counts as
 * an unresolved row rather than dropping silently. A virtualization placeholder — a rendered row
 * with no readable content — is the common benign case and is also counted, so the server sees a
 * gap and holds instead of treating a half-rendered table as a rollback.
 */
function sanitizePick(row: RawPickRow, draftType: EspnLiveDraftType): EspnLiveDraftPickV1 | null {
  if (row.ambiguousFields.length > 0) return null;
  const sequence = parseDraftInteger(row.sequence, 1, ESPN_LIVE_DRAFT_LIMITS.maximumPicks);
  const teamName = normalizeDraftText(row.teamName, ESPN_LIVE_DRAFT_LIMITS.maximumTeamNameLength);
  const playerName = normalizeDraftText(
    row.playerName,
    ESPN_LIVE_DRAFT_LIMITS.maximumPlayerNameLength,
  );
  const keeper = resolveKeeper(row.keeperLabel);
  if (sequence === null || teamName === null || playerName === null || keeper === null) return null;
  const price = parseDraftInteger(row.price, 0, ESPN_LIVE_DRAFT_LIMITS.maximumPrice);
  // A completed auction sale without a readable winning bid would corrupt every budget downstream,
  // so it is held rather than published with a null price.
  if (draftType === "auction" && !keeper && price === null) return null;
  return {
    sequence,
    round: parseDraftInteger(row.round, 1, ESPN_LIVE_DRAFT_LIMITS.maximumPicks),
    roundPick: parseDraftInteger(row.roundPick, 1, ESPN_LIVE_DRAFT_LIMITS.maximumTeams),
    keeper,
    providerTeamId: parseProviderTeamId(row.teamId),
    teamName,
    providerPlayerId: parseProviderPlayerId(row.playerId),
    playerName,
    proTeam: normalizeDraftText(row.proTeam, ESPN_LIVE_DRAFT_LIMITS.maximumProTeamLength),
    position: normalizeDraftText(row.position, ESPN_LIVE_DRAFT_LIMITS.maximumPositionLength),
    price: draftType === "auction" ? price : null,
    nominatingProviderTeamId:
      draftType === "auction" ? parseProviderTeamId(row.nominatingTeamId) : null,
  };
}

function samePick(left: EspnLiveDraftPickV1, right: EspnLiveDraftPickV1): boolean {
  return (
    left.round === right.round &&
    left.roundPick === right.roundPick &&
    left.keeper === right.keeper &&
    left.providerTeamId === right.providerTeamId &&
    left.teamName === right.teamName &&
    left.providerPlayerId === right.providerPlayerId &&
    left.playerName === right.playerName &&
    left.proTeam === right.proTeam &&
    left.position === right.position &&
    left.price === right.price &&
    left.nominatingProviderTeamId === right.nominatingProviderTeamId
  );
}

interface ReconciledPicks {
  readonly picks: readonly EspnLiveDraftPickV1[];
  readonly duplicateSequences: number;
  readonly unresolvedRows: number;
  readonly contiguousThrough: number;
}

/**
 * Deduplicates, orders, and measures the board.
 *
 * Rows are sorted by their explicit pick sequence rather than by DOM position, so a virtualized or
 * reordered table produces the same digest as a freshly rendered one. Two rows claiming the same
 * sequence with different content are both dropped — choosing one would be exactly the silent guess
 * the plan forbids — while an identical repeat is collapsed and merely counted.
 */
function reconcilePicks(
  rows: readonly RawPickRow[],
  draftType: EspnLiveDraftType,
): ReconciledPicks {
  const bySequence = new Map<number, EspnLiveDraftPickV1[]>();
  let unresolvedRows = 0;
  for (const row of rows) {
    const pick = sanitizePick(row, draftType);
    if (pick === null) {
      unresolvedRows += 1;
      continue;
    }
    const existing = bySequence.get(pick.sequence);
    if (existing === undefined) bySequence.set(pick.sequence, [pick]);
    else existing.push(pick);
  }

  const picks: EspnLiveDraftPickV1[] = [];
  let duplicateSequences = 0;
  for (const [, group] of bySequence) {
    const first = group[0];
    if (first === undefined) continue;
    if (group.length === 1) {
      picks.push(first);
      continue;
    }
    duplicateSequences += group.length - 1;
    if (group.every((candidate) => samePick(first, candidate))) picks.push(first);
    else unresolvedRows += group.length;
  }
  picks.sort((left, right) => left.sequence - right.sequence);

  let contiguousThrough = 0;
  for (const pick of picks) {
    if (pick.sequence === contiguousThrough + 1) contiguousThrough = pick.sequence;
    else break;
  }
  return { picks, duplicateSequences, unresolvedRows, contiguousThrough };
}

function sanitizeOwnership(extraction: RawDraftRoomExtraction): {
  readonly ownership: readonly EspnLiveDraftPickOwnershipV1[];
  readonly unresolved: number;
} {
  const bySlot = new Map<number, EspnLiveDraftPickOwnershipV1>();
  const conflicting = new Set<number>();
  let unresolved = 0;
  for (const row of extraction.ownershipRows) {
    if (row.ambiguousFields.length > 0) {
      unresolved += 1;
      continue;
    }
    const overallPick = parseDraftInteger(row.overallPick, 1, ESPN_LIVE_DRAFT_LIMITS.maximumPicks);
    const teamName = normalizeDraftText(row.teamName, ESPN_LIVE_DRAFT_LIMITS.maximumTeamNameLength);
    if (overallPick === null || teamName === null) {
      unresolved += 1;
      continue;
    }
    const entry: EspnLiveDraftPickOwnershipV1 = {
      overallPick,
      providerTeamId: parseProviderTeamId(row.teamId),
      teamName,
    };
    const existing = bySlot.get(overallPick);
    if (existing === undefined) {
      bySlot.set(overallPick, entry);
      continue;
    }
    // Two different owners for one slot means the traded-pick reading is untrustworthy. Drop the
    // slot entirely rather than pick a side; the server holds on unknown ownership.
    if (existing.providerTeamId !== entry.providerTeamId || existing.teamName !== entry.teamName) {
      conflicting.add(overallPick);
    }
    unresolved += 1;
  }
  for (const slot of conflicting) bySlot.delete(slot);
  const ownership = [...bySlot.values()].sort(
    (left, right) => left.overallPick - right.overallPick,
  );
  return { ownership, unresolved };
}

function sanitizeAuction(
  extraction: RawDraftRoomExtraction,
  draftType: EspnLiveDraftType,
): EspnLiveDraftCurrentAuctionV1 | null {
  const panel = extraction.auction;
  if (panel === null || draftType !== "auction") return null;
  if (panel.ambiguousFields.length > 0) return null;
  const nominationNumber = parseDraftInteger(
    panel.nominationNumber,
    1,
    ESPN_LIVE_DRAFT_LIMITS.maximumPicks,
  );
  const playerName = normalizeDraftText(
    panel.playerName,
    ESPN_LIVE_DRAFT_LIMITS.maximumPlayerNameLength,
  );
  if (nominationNumber === null || playerName === null) return null;
  return {
    nominationNumber,
    nominatingProviderTeamId: parseProviderTeamId(panel.nominatingTeamId),
    providerPlayerId: parseProviderPlayerId(panel.playerId),
    playerName,
    proTeam: normalizeDraftText(panel.proTeam, ESPN_LIVE_DRAFT_LIMITS.maximumProTeamLength),
    position: normalizeDraftText(panel.position, ESPN_LIVE_DRAFT_LIMITS.maximumPositionLength),
    highBidProviderTeamId: parseProviderTeamId(panel.highBidTeamId),
    highBid: parseDraftInteger(panel.highBid, 0, ESPN_LIVE_DRAFT_LIMITS.maximumPrice),
  };
}

/**
 * Builds a bounded sanitized board from a raw extraction, or explains why it could not.
 *
 * The failure reasons are a closed vocabulary; none of them carries provider text.
 */
export function buildEspnLiveDraftSnapshot(
  extraction: RawDraftRoomExtraction,
  scope: EspnLiveDraftScope,
): EspnLiveDraftSnapshotResult {
  if (!extraction.recognized) return { ok: false, reason: "not-a-draft-room" };
  if (extraction.pickRowOverflow || extraction.ownershipRowOverflow) {
    return { ok: false, reason: "row-overflow" };
  }
  if (extraction.unresolvedFamilies.length > 0) return { ok: false, reason: "selectors-ambiguous" };

  const state = resolveState(extraction);
  if (state === null) return { ok: false, reason: "draft-state-unknown" };
  const draftType = resolveDraftType(extraction);
  if (draftType === null) return { ok: false, reason: "draft-type-unknown" };
  const expectedTeamCount = parseDraftInteger(
    extraction.expectedTeamCountText,
    2,
    ESPN_LIVE_DRAFT_LIMITS.maximumTeams,
  );
  if (expectedTeamCount === null) return { ok: false, reason: "team-count-unknown" };

  const reconciled = reconcilePicks(extraction.pickRows, draftType);
  const ownership = sanitizeOwnership(extraction);
  const completeness: EspnLiveDraftCompletenessV1 = {
    contiguousThrough: reconciled.contiguousThrough,
    duplicateSequences: Math.min(
      reconciled.duplicateSequences,
      ESPN_LIVE_DRAFT_LIMITS.maximumPicks,
    ),
    unresolvedRows: Math.min(
      reconciled.unresolvedRows + ownership.unresolved,
      ESPN_LIVE_DRAFT_LIMITS.maximumPicks,
    ),
  };
  const snapshot: Omit<EspnLiveDraftSnapshot, "digestSource"> = {
    leagueId: scope.leagueId,
    season: scope.season,
    state,
    draftType,
    expectedTeamCount,
    expectedRosterSize: parseDraftInteger(
      extraction.expectedRosterSizeText,
      1,
      ESPN_LIVE_DRAFT_LIMITS.maximumRosterSize,
    ),
    pickOwnership: ownership.ownership,
    picks: reconciled.picks,
    currentAuction: sanitizeAuction(extraction, draftType),
    completeness,
  };
  return { ok: true, snapshot: { ...snapshot, digestSource: espnLiveDraftDigestSource(snapshot) } };
}

export interface EspnLiveDraftSealContext {
  readonly pageSessionId: string;
  readonly revision: number;
  readonly capturedAt: string;
}

/**
 * Attaches page-session provenance and the checksum. Field order here is the wire order; the
 * checksum is taken over `digestSource`, never over this object's JSON.
 */
export async function sealEspnLiveDraftObservation(
  snapshot: EspnLiveDraftSnapshot,
  context: EspnLiveDraftSealContext,
): Promise<EspnLiveDraftObservationV1> {
  return {
    schemaVersion: 1,
    kind: "espn-live-draft",
    leagueId: snapshot.leagueId,
    season: snapshot.season,
    pageSessionId: context.pageSessionId,
    revision: context.revision,
    capturedAt: context.capturedAt,
    state: snapshot.state,
    draftType: snapshot.draftType,
    expectedTeamCount: snapshot.expectedTeamCount,
    expectedRosterSize: snapshot.expectedRosterSize,
    pickOwnership: snapshot.pickOwnership,
    picks: snapshot.picks,
    currentAuction: snapshot.currentAuction,
    completeness: snapshot.completeness,
    checksumSha256: await espnLiveDraftChecksum(snapshot.digestSource),
  };
}

/** Transient auction identity, so a bid change can be told apart from a board change. */
export function transientAuctionSignature(snapshot: EspnLiveDraftSnapshot): string {
  const auction = snapshot.currentAuction;
  if (auction === null) return "none";
  return JSON.stringify([
    auction.nominationNumber,
    auction.nominatingProviderTeamId,
    auction.providerPlayerId,
    auction.playerName,
    auction.highBidProviderTeamId,
    auction.highBid,
  ]);
}
