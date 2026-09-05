import {
  ESPN_LIVE_DRAFT_LIMITS,
  type DraftSessionSnapshot,
  type DraftProviderFeedStatus,
  type EspnLiveDraftIssueCode,
  type YahooDraftFeedStatus,
  type YahooDraftIssueCode,
} from "@laces-out/contracts";

import { unfilledStarterSlots } from "./draft-board";
import { providerLabel } from "./copy";

/**
 * Draft Studio entry states from the live-sync plan (§16.1).
 *
 * `manual` is the shared ledger with no provider feed attached. The other state keys are retained
 * across the ESPN and Yahoo presentations, while provider-specific headings keep their claims
 * distinct (for example, Yahoo is assisted polling and is never described as live).
 */
export type LiveDraftEntryState =
  | "manual"
  | "ready"
  | "waiting"
  | "live"
  | "paused"
  | "stale"
  | "manual-backup"
  | "complete"
  | "attention";

export type LiveDraftTone = "neutral" | "live" | "warning" | "critical";

/** Matches the existing `live-freshness-dot--*` vocabulary in globals.css. */
export type LiveDraftFreshness = "fresh" | "aging" | "stale" | "missing";

/** Matches the existing `connection-indicator__dot--*` modifiers in the draft header. */
export type LiveDraftIndicator = "ok" | "stale" | "mock";

const FRESH_WINDOW_SECONDS = ESPN_LIVE_DRAFT_LIMITS.freshWindowMs / 1000;
const FAILOVER_SECONDS = ESPN_LIVE_DRAFT_LIMITS.failoverEligibleMs / 1000;
const DISCONNECTED_SECONDS = ESPN_LIVE_DRAFT_LIMITS.disconnectedMs / 1000;

/**
 * Said once, in the states where it changes what the reader should do. A viewer on a phone cannot
 * make Laces Out read ESPN; some league member's desktop Chrome has to be holding the draft room.
 */
const DESKTOP_SOURCE_REQUIREMENT =
  "Live picks require a league member's desktop Chrome with the ESPN draft room open.";

const MANUAL_ENTRY_DETAIL =
  "Manual entries are shared with the league. No provider feed is attached.";

export interface LiveDraftStatusInput {
  readonly session: DraftSessionSnapshot;
  /** Consecutive failures of this client's own reload loop. */
  readonly pollFailures: number;
  /** Client clock reading when the current snapshot was accepted, for age carry-forward. */
  readonly lastSyncedAt: number | null;
  readonly now: number;
  /** True while the SSE invalidation stream is connected; false while polling alone. */
  readonly streaming: boolean;
  /** A local mock forks the room, so provider state must not be presented as this board. */
  readonly localMock?: boolean;
}

export interface LiveDraftStatusStrip {
  readonly providerName: string;
  readonly sourceLabel: string;
  readonly statusLabel: string;
  readonly freshnessLabel: string;
  readonly freshness: LiveDraftFreshness;
  readonly lastAcceptedLabel: string;
  readonly currentActionLabel: string;
  readonly currentActionCaption: string;
  readonly pickCountHeading: string;
  readonly pickCountLabel: string;
  readonly issueCount: number;
  readonly issueLabel: string | null;
  readonly verificationLabel: string | null;
  readonly standbyLabel: string | null;
  readonly updateChannelLabel: string;
  readonly reconnectGuidance: string | null;
}

export interface ManualBackupControls {
  /** Only a provider-backed room can freeze provider application. */
  readonly available: boolean;
  readonly active: boolean;
  /** Manual overrides change shared state, so they stay commissioner-only (§5.3). */
  readonly authorized: boolean;
  readonly pendingReconciliation: number;
  readonly summary: string;
  readonly activateLabel: string;
  readonly returnLabel: string;
  /** True when held provider snapshots differ, so returning needs an explicit decision. */
  readonly requiresChoice: boolean;
  readonly choiceSummary: string | null;
}

export interface LiveDraftStatus {
  readonly entryState: LiveDraftEntryState;
  readonly providerBacked: boolean;
  readonly providerName: string;
  readonly heading: string;
  readonly detail: string;
  readonly tone: LiveDraftTone;
  readonly indicator: LiveDraftIndicator;
  readonly indicatorTitle: string;
  readonly indicatorDetail: string;
  readonly freshness: LiveDraftFreshness;
  readonly freshnessLabel: string;
  readonly ageSeconds: number | null;
  readonly clientReconnecting: boolean;
  readonly sourceRequirement: string | null;
  readonly reconnectGuidance: string | null;
  /** Replacement for the `.draft-notice__meta` chip. */
  readonly transportChip: string;
  /** Replacement for the draft-log provenance note. */
  readonly ledgerNote: string;
  readonly strip: LiveDraftStatusStrip | null;
  readonly manualBackup: ManualBackupControls;
}

export interface LiveDraftMobileSummary {
  readonly headline: string;
  readonly headlineCaption: string;
  readonly needsLabel: string;
  readonly budgetLabel: string | null;
  readonly feedLabel: string;
  readonly stale: boolean;
  readonly staleLabel: string | null;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Age the server reported, plus the time this client has been holding that response.
 *
 * Only differences of the client's own clock are used, so a browser whose clock disagrees with the
 * server never invents or hides staleness. Without the carry-forward a backgrounded tab kept
 * claiming "updated 2s ago" long after the source browser closed.
 */
export function effectiveFeedAgeSeconds(
  feed: Pick<DraftProviderFeedStatus, "ageSeconds">,
  lastSyncedAt: number | null,
  now: number,
): number | null {
  if (feed.ageSeconds === null) return null;
  const held = lastSyncedAt === null ? 0 : Math.max(0, (now - lastSyncedAt) / 1000);
  return feed.ageSeconds + held;
}

export function liveDraftFreshness(ageSeconds: number | null, fresh = true): LiveDraftFreshness {
  if (ageSeconds === null) return "missing";
  if (ageSeconds <= FRESH_WINDOW_SECONDS) return fresh ? "fresh" : "aging";
  if (ageSeconds <= FAILOVER_SECONDS) return "aging";
  return "stale";
}

function yahooDraftFreshness(
  feed: YahooDraftFeedStatus,
  ageSeconds: number | null,
): LiveDraftFreshness {
  if (ageSeconds === null) return "missing";
  const expected = feed.pollIntervalSeconds;
  if (ageSeconds <= expected * 2) return feed.fresh ? "fresh" : "aging";
  if (ageSeconds <= expected * 4) return "aging";
  return "stale";
}

export function formatFeedAge(ageSeconds: number | null): string {
  if (ageSeconds === null) return "no update yet";
  const seconds = Math.max(0, Math.round(ageSeconds));
  if (seconds < 60) return `updated ${seconds}s ago`;
  if (seconds < 3600) return `updated ${Math.round(seconds / 60)}m ago`;
  return `updated ${Math.round(seconds / 3600)}h ago`;
}

/**
 * Server timestamps are compared against the client clock here, so the result is clamped at zero
 * rather than rendering a negative age when the two disagree by a second or two.
 */
export function formatLastAccepted(occurredAt: string | null, now: number): string {
  if (occurredAt === null) return "no pick accepted yet";
  const parsed = Date.parse(occurredAt);
  if (!Number.isFinite(parsed)) return "last pick time unavailable";
  const seconds = Math.max(0, Math.round((now - parsed) / 1000));
  if (seconds < 60) return `last pick ${seconds}s ago`;
  if (seconds < 3600) return `last pick ${Math.round(seconds / 60)}m ago`;
  return `last pick ${Math.round(seconds / 3600)}h ago`;
}

function formatLastObserved(occurredAt: string | null, now: number): string {
  if (occurredAt === null) return "no pick observed yet";
  const accepted = formatLastAccepted(occurredAt, now);
  return accepted.replace(/^last pick/u, "last observed pick");
}

/**
 * Bounded issue codes become plain sentences. Deliberately never names a player, a team, or a
 * device: the code alone is what the server is allowed to publish (§18.2).
 */
export function describeLiveDraftIssue(code: EspnLiveDraftIssueCode): string {
  switch (code) {
    case "UNRESOLVED_TEAM":
      return "A team in the ESPN draft room does not match a team in this league yet.";
    case "UNRESOLVED_PLAYER":
      return "A player in the ESPN draft room is not in this room's player pool yet.";
    case "PICK_SEQUENCE_GAP":
      return "ESPN reported picks with a gap, so the board is held until the missing pick arrives.";
    case "DUPLICATE_PICK_SEQUENCE":
      return "ESPN reported the same pick number twice, so the board is held.";
    case "EMPTY_RENDER":
      return "The ESPN draft page briefly showed no picks. The last accepted board is still shown.";
    case "PICK_OWNERSHIP_UNKNOWN":
      return "Pick ownership could not be read from ESPN, so live sync is holding.";
    case "DRAFT_TYPE_MISMATCH":
      return "The ESPN draft format does not match this room's format.";
    case "TEAM_COUNT_MISMATCH":
      return "The ESPN draft has a different number of teams than this room.";
    case "ROSTER_CAPACITY_EXCEEDED":
      return "An ESPN pick would exceed a roster limit in this room.";
    case "PRICE_ILLEGAL":
      return "An ESPN sale price falls outside this room's legal bid range.";
    case "REDUCER_INVARIANT":
      return "An ESPN update failed this room's draft rules and was not applied.";
    case "DESTRUCTIVE_PENDING":
      return "ESPN looks like it rolled back a pick. Laces Out is confirming before changing the board.";
    case "MANUAL_BACKUP_ACTIVE":
      return "Manual backup is on, so ESPN updates are being held for review.";
    case "STALE_PAGE_REVISION":
      return "An out-of-date ESPN snapshot arrived and was ignored.";
    case "CHECKSUM_MISMATCH":
      return "An ESPN snapshot failed its integrity check and was ignored.";
    case "SESSION_NOT_READY":
      return "This room is not ready for live ESPN picks yet.";
  }
}

/** Yahoo's official endpoint is cumulative and slower than the ESPN browser source. */
export function describeYahooDraftIssue(code: YahooDraftIssueCode): string {
  switch (code) {
    case "INCOMPLETE_SNAPSHOT":
      return "Yahoo returned an incomplete draft board, so no picks were applied.";
    case "UNRESOLVED_TEAM":
      return "A team in Yahoo's draft results does not match this league yet.";
    case "UNRESOLVED_PLAYER":
      return "A player in Yahoo's draft results is not in this room's player pool yet.";
    case "PICK_SEQUENCE_GAP":
      return "Yahoo reported picks with a gap, so the update was held rather than guessed.";
    case "DRAFT_TYPE_MISMATCH":
      return "Yahoo's draft format does not match this room's format.";
    case "TEAM_COUNT_MISMATCH":
      return "Yahoo reports a different number of teams than this room.";
    case "KEEPER_SCOPE_UNVALIDATED":
      return "This Yahoo keeper format has not cleared assisted-draft validation, so the update was held.";
    case "SNAKE_COST_PRESENT":
      return "Yahoo attached auction data to a snake draft, so the update was held.";
    case "AUCTION_COST_MISSING":
      return "Yahoo omitted a sale price, so the auction update was held.";
    case "AUCTION_COST_INVALID":
      return "Yahoo returned an invalid sale price, so the auction update was held.";
    case "HISTORY_DIVERGED":
      return "Yahoo's draft history differs from this room. The manual board was not rewritten.";
    case "HISTORY_TRUNCATED":
      return "Yahoo returned fewer prior picks than before. The manual board was not changed.";
    case "REDUCER_INVARIANT":
      return "A Yahoo update failed this room's draft rules and was not applied.";
    case "PROVIDER_UNAVAILABLE":
      return "Yahoo draft results are temporarily unavailable. Manual entry remains available.";
    case "POLL_FAILED":
      return "The latest Yahoo check failed. Manual entry remains available.";
    case "RELEASE_SHADOW_ONLY":
      return "Yahoo observations are being collected but are not applied automatically yet.";
    case "CONCURRENT_LEDGER_CHANGE":
      return "The room changed during a Yahoo check, so the update will be compared again.";
    case "COMPLETED_COUNT_MISMATCH":
      return "Yahoo's completed pick count differs from this room, so the result needs review.";
    case "PROVIDER_STATUS_UNSUPPORTED":
      return "Yahoo returned a draft status Laces Out does not recognize, so the update was held.";
  }
}

function feedNeedsAttention(feed: DraftProviderFeedStatus): boolean {
  return (
    feed.state === "degraded" ||
    feed.unresolvedTeams > 0 ||
    feed.unresolvedPlayers > 0 ||
    feed.verification === "mismatched"
  );
}

function sourceLost(ageSeconds: number | null, fresh: boolean, limitSeconds: number): boolean {
  if (ageSeconds === null) return true;
  return !fresh || ageSeconds > limitSeconds;
}

export function liveDraftEntryState(input: LiveDraftStatusInput): LiveDraftEntryState {
  const feed = input.session.providerFeed;
  if (feed === null || input.session.transport === "manual") return "manual";
  if (feed.provider === "espn" && feed.manualBackupActive) return "manual-backup";
  if (feedNeedsAttention(feed)) return "attention";
  if (feed.state === "complete") return "complete";
  // A local reload failure means this client cannot vouch for anything below it, whatever the
  // last response claimed about the source browser.
  if (input.pollFailures > 0) return "stale";
  if (feed.state === "stale") return "stale";
  const age = effectiveFeedAgeSeconds(feed, input.lastSyncedAt, input.now);
  if (feed.provider === "yahoo") {
    if (feed.state === "live") {
      return yahooDraftFreshness(feed, age) === "stale" ? "stale" : "live";
    }
    return "waiting";
  }
  if (feed.state === "live")
    return sourceLost(age, feed.fresh, FRESH_WINDOW_SECONDS) ? "stale" : "live";
  if (feed.state === "paused")
    return sourceLost(age, feed.fresh, FAILOVER_SECONDS) ? "stale" : "paused";
  return age !== null && feed.fresh && age <= FAILOVER_SECONDS ? "ready" : "waiting";
}

const HEADINGS: Readonly<Record<LiveDraftEntryState, string>> = {
  manual: "Manual draft ledger",
  ready: "Ready for ESPN draft",
  waiting: "Waiting for an ESPN draft room",
  live: "Live ESPN Sync",
  paused: "ESPN draft paused",
  stale: "Feed stale",
  "manual-backup": "Manual backup active",
  complete: "Draft complete",
  attention: "Live sync needs attention",
};

const TONES: Readonly<Record<LiveDraftEntryState, LiveDraftTone>> = {
  manual: "neutral",
  ready: "neutral",
  waiting: "neutral",
  live: "live",
  paused: "warning",
  stale: "critical",
  "manual-backup": "warning",
  complete: "neutral",
  attention: "critical",
};

export function liveDraftHeading(state: LiveDraftEntryState): string {
  return HEADINGS[state];
}

function headingFor(state: LiveDraftEntryState, feed: DraftProviderFeedStatus | null): string {
  if (feed?.provider !== "yahoo") return HEADINGS[state];
  switch (state) {
    case "waiting":
    case "ready":
      return "Checking Yahoo";
    case "live":
      return "Yahoo-assisted sync";
    case "stale":
    case "paused":
      return "Yahoo check delayed";
    case "attention":
      return "Yahoo update needs review";
    case "complete":
      return feed.verification === "verified"
        ? "Final board matches Yahoo"
        : "Yahoo draft complete";
    case "manual":
      return HEADINGS.manual;
    case "manual-backup":
      return HEADINGS["manual-backup"];
  }
}

function attentionDetail(feed: DraftProviderFeedStatus): string {
  if (feed.lastIssueCode !== null) {
    return feed.provider === "yahoo"
      ? describeYahooDraftIssue(feed.lastIssueCode)
      : describeLiveDraftIssue(feed.lastIssueCode);
  }
  const unresolved = feed.unresolvedTeams + feed.unresolvedPlayers;
  if (unresolved > 0) {
    return `${pluralize(unresolved, `${providerLabel(feed.provider)} row`)} could not be matched to this league, so the board is held rather than guessed.`;
  }
  if (feed.verification === "mismatched") {
    return `The completed ${providerLabel(feed.provider)} result differs from this room's ledger. Nothing was rewritten; the difference is waiting for review.`;
  }
  return feed.provider === "yahoo"
    ? "The Yahoo update was held rather than changing the board without complete evidence."
    : "Live sync is holding rather than applying an update it could not verify.";
}

function completeDetail(feed: DraftProviderFeedStatus): string {
  const picks = `${pluralize(feed.pickCount, "pick")} recorded.`;
  if (feed.provider === "yahoo") {
    if (feed.applicationMode === "shadow") {
      return `Yahoo reported the draft finished. ${pluralize(feed.pickCount, "pick")} observed; the shared manual board remains primary.`;
    }
    if (feed.verification === "verified") {
      return `The final room board exactly matches Yahoo's completed draft results. ${picks}`;
    }
    if (feed.verification === "mismatched") {
      return `Yahoo reported the draft finished, but its final result differs from this room. Nothing was rewritten. ${picks}`;
    }
    return `Yahoo reported the draft finished. Final board verification is still pending. ${picks}`;
  }
  if (feed.verification === "verified") {
    return `ESPN reported the draft finished and the completed ESPN result matches this ledger. ${picks}`;
  }
  if (feed.verification === "mismatched") {
    return `ESPN reported the draft finished, but the completed ESPN result differs from this ledger. ${picks}`;
  }
  return `ESPN reported the draft finished. The completed ESPN result has not been published for cross-check yet. ${picks}`;
}

function entryDetail(
  state: LiveDraftEntryState,
  feed: DraftProviderFeedStatus | null,
  input: LiveDraftStatusInput,
): string {
  if (feed === null) return MANUAL_ENTRY_DETAIL;
  const provider = providerLabel(feed.provider);
  if (feed.provider === "yahoo") {
    if (feed.applicationMode === "shadow" && state !== "attention" && state !== "complete") {
      return "Yahoo observations are not applied automatically yet. Manual entry remains the primary board.";
    }
    switch (state) {
      case "ready":
      case "waiting":
        return "Laces Out is checking Yahoo's official draft results. Manual entry remains available.";
      case "live":
        return `${pluralize(feed.pickCount, "confirmed pick")} found through Yahoo. Manual entry remains available.`;
      case "paused":
      case "stale":
        return input.pollFailures > 0
          ? "This device cannot reach Laces Out. Manual entry remains available."
          : "Yahoo has not returned a recent update. Checks will retry, and manual entry remains available.";
      case "complete":
        return completeDetail(feed);
      case "attention":
        return attentionDetail(feed);
      case "manual":
        return MANUAL_ENTRY_DETAIL;
      case "manual-backup":
        return "Manual entry remains available while Yahoo checks are paused.";
    }
  }
  switch (state) {
    case "ready":
      return `${provider} draft room is open in paired desktop Chrome.`;
    case "waiting":
      return `Open the ${provider} draft room in paired desktop Chrome.`;
    case "live":
      return `${provider} is updating this room. ${pluralize(feed.pickCount, "pick")} accepted.`;
    case "paused":
      return `${provider} draft paused. The last accepted board is shown.`;
    case "stale":
      return input.pollFailures > 0
        ? "This device cannot reach Laces Out. The board may be behind."
        : `No ${provider} update has been accepted recently. The last verified board is shown.`;
    case "manual-backup":
      return feed.pendingReconciliation > 0
        ? `Provider picks are frozen. ${pluralize(feed.pendingReconciliation, "held " + provider + " update")} still differ from this ledger.`
        : "Provider picks are frozen. Manual entries continue from the last accepted provider state.";
    case "complete":
      return completeDetail(feed);
    case "attention":
      return attentionDetail(feed);
    case "manual":
      return MANUAL_ENTRY_DETAIL;
  }
}

function currentAction(
  session: DraftSessionSnapshot,
  feed: DraftProviderFeedStatus | null,
): { readonly label: string; readonly caption: string } {
  const auction = feed?.provider === "espn" ? feed.currentAuction : null;
  if (auction) {
    const bid = auction.highBid === null ? "no bid yet" : `high bid $${auction.highBid}`;
    return {
      label: `${auction.playerName} · ${bid}`,
      caption: `Nomination ${auction.nominationNumber}`,
    };
  }
  if (session.state.complete) return { label: "Draft complete", caption: "No pick pending" };
  const nomination = session.state.activeNomination;
  if (nomination) {
    const team = session.config.teams.find((entry) => entry.id === nomination.nominatorTeamId);
    const player = session.config.players.find((entry) => entry.id === nomination.playerId);
    return {
      label: `${player?.name ?? "Nominated player"} · ${team?.name ?? "nominating team"}`,
      caption: `Nomination ${nomination.nominationNumber}`,
    };
  }
  const nextPick = session.state.nextPick;
  if (nextPick) {
    const team = session.config.teams.find((entry) => entry.id === nextPick.teamId);
    return {
      label: `${team?.name ?? "Next team"}`,
      caption: `Pick ${nextPick.overallPick}`,
    };
  }
  return { label: "Waiting for the first pick", caption: "No pick pending" };
}

function verificationLabel(feed: DraftProviderFeedStatus): string | null {
  if (feed.provider === "yahoo") {
    if (feed.applicationMode === "shadow") return null;
    switch (feed.verification) {
      case "verified":
        return "Final board matches Yahoo";
      case "mismatched":
        return "Final board differs from Yahoo; no picks were rewritten";
      case "pending":
        return feed.state === "complete" ? "Final Yahoo check pending" : null;
    }
  }
  switch (feed.verification) {
    case "verified":
      return "Matches the completed ESPN result";
    case "mismatched":
      return "Differs from the completed ESPN result";
    case "pending":
      return feed.state === "complete" ? "Completed ESPN result not published yet" : null;
  }
}

function manualBackupControls(
  session: DraftSessionSnapshot,
  feed: DraftProviderFeedStatus | null,
): ManualBackupControls {
  const authorized = session.accessRole === "commissioner";
  if (feed === null || feed.provider === "yahoo") {
    return {
      available: false,
      active: false,
      authorized,
      pendingReconciliation: 0,
      summary: "This room has no provider feed to fall back from.",
      activateLabel: "Activate manual backup",
      returnLabel: "Return to provider sync",
      requiresChoice: false,
      choiceSummary: null,
    };
  }
  const provider = providerLabel(feed.provider);
  const pending = feed.pendingReconciliation;
  return {
    available: true,
    active: feed.manualBackupActive,
    authorized,
    pendingReconciliation: pending,
    summary: feed.manualBackupActive
      ? `${provider} updates are still being validated and counted, but none are applied while manual backup is on.`
      : `Freezes ${provider} picks so a commissioner can keep the board moving by hand.`,
    activateLabel: "Activate manual backup",
    returnLabel:
      pending > 0 ? `Review ${pluralize(pending, "difference")}` : `Return to ${provider} sync`,
    requiresChoice: feed.manualBackupActive && pending > 0,
    choiceSummary:
      feed.manualBackupActive && pending > 0
        ? `${pluralize(pending, "held " + provider + " update")} differ from this ledger. Choose which one becomes the room before provider control resumes.`
        : null,
  };
}

function transportChip(
  state: LiveDraftEntryState,
  feed: DraftProviderFeedStatus | null,
  localMock: boolean,
): string {
  if (localMock) return "Local memory only";
  if (feed === null) return "Shared app ledger · no provider feed attached";
  if (feed.provider === "yahoo") {
    return feed.applicationMode === "shadow"
      ? "Yahoo observations only · manual board primary"
      : "Yahoo-assisted checks · read-only · manual entry available";
  }
  const provider = providerLabel(feed.provider);
  if (state === "manual-backup") return `${provider} sync frozen · manual backup`;
  if (state === "stale" || state === "attention")
    return `${provider} live sync · read-only · needs a source`;
  return `${provider} live sync · read-only`;
}

function ledgerNote(feed: DraftProviderFeedStatus | null, localMock: boolean): string {
  if (localMock) return "Practice events exist only in this browser tab.";
  if (feed === null) {
    return "Manual entries are saved for league members.";
  }
  if (feed.provider === "yahoo" && feed.applicationMode === "shadow") {
    return "Yahoo observations are not applied automatically. The shared manual board remains primary.";
  }
  if (feed.provider === "yahoo") {
    return "Confirmed Yahoo picks and manual entries are saved here with their source.";
  }
  const provider = providerLabel(feed.provider);
  return `${provider} picks and manual entries are saved here with their source.`;
}

export function describeLiveDraft(input: LiveDraftStatusInput): LiveDraftStatus {
  const { session } = input;
  const feed = session.transport === "manual" ? null : session.providerFeed;
  const localMock = input.localMock === true;
  const entryState = liveDraftEntryState(input);
  const age = feed === null ? null : effectiveFeedAgeSeconds(feed, input.lastSyncedAt, input.now);
  const freshness =
    feed === null
      ? "missing"
      : feed.provider === "yahoo"
        ? yahooDraftFreshness(feed, age)
        : liveDraftFreshness(age, feed.fresh);
  const freshnessLabel = feed === null ? "app ledger only" : formatFeedAge(age);
  const providerName = feed === null ? "Laces Out" : providerLabel(feed.provider);
  const clientReconnecting = input.pollFailures > 0;
  const heading = headingFor(entryState, feed);

  const reconnectGuidance = clientReconnecting
    ? "Retrying automatically. The last accepted board is shown."
    : entryState === "stale" || entryState === "waiting"
      ? feed?.provider === "yahoo"
        ? "Yahoo checks retry automatically. Manual entry remains available."
        : `Reopen or refocus the ${providerName} draft room in paired desktop Chrome.`
      : null;

  const sourceRequirement =
    feed?.provider === "espn" &&
    (entryState === "ready" || entryState === "waiting" || entryState === "stale")
      ? DESKTOP_SOURCE_REQUIREMENT
      : null;

  const action = currentAction(session, feed);
  const issueCount = feed === null ? 0 : feed.unresolvedTeams + feed.unresolvedPlayers;

  const strip: LiveDraftStatusStrip | null =
    feed === null
      ? null
      : {
          providerName,
          sourceLabel: `${providerName} league ${feed.providerLeagueId} · ${feed.season}`,
          statusLabel: heading,
          freshnessLabel,
          freshness,
          lastAcceptedLabel:
            feed.provider === "yahoo" && feed.applicationMode === "shadow"
              ? formatLastObserved(feed.lastMaterialEventAt, input.now)
              : formatLastAccepted(feed.lastMaterialEventAt, input.now),
          currentActionLabel: action.label,
          currentActionCaption: action.caption,
          pickCountHeading:
            feed.provider === "yahoo"
              ? feed.applicationMode === "shadow"
                ? "Observed"
                : "Confirmed"
              : "Accepted",
          pickCountLabel: pluralize(feed.pickCount, "pick"),
          issueCount,
          issueLabel:
            feed.lastIssueCode !== null && feed.lastIssueCode !== "RELEASE_SHADOW_ONLY"
              ? feed.provider === "yahoo"
                ? describeYahooDraftIssue(feed.lastIssueCode)
                : describeLiveDraftIssue(feed.lastIssueCode)
              : issueCount > 0
                ? `${pluralize(issueCount, "unmatched row")} held for review`
                : null,
          verificationLabel: verificationLabel(feed),
          standbyLabel:
            feed.provider === "espn" && feed.standbySources > 0
              ? `${pluralize(feed.standbySources, "standby browser")} ready to take over`
              : null,
          updateChannelLabel:
            feed.provider === "yahoo"
              ? feed.state === "live"
                ? `Official Yahoo checks at most every ${feed.pollIntervalSeconds} seconds`
                : feed.state === "complete"
                  ? "Yahoo polling finished"
                  : feed.state === "stale" || feed.state === "degraded"
                    ? "Yahoo checks backing off automatically"
                    : "Yahoo checks run periodically"
              : input.streaming
                ? "Live updates streaming"
                : "Checking for updates every 5 seconds",
          reconnectGuidance,
        };

  const indicator: LiveDraftIndicator = localMock
    ? "mock"
    : clientReconnecting || entryState === "stale" || entryState === "attention"
      ? "stale"
      : "ok";

  return {
    entryState,
    providerBacked: feed !== null,
    providerName,
    heading,
    detail: entryDetail(entryState, feed, input),
    tone: TONES[entryState],
    indicator,
    indicatorTitle: localMock
      ? "Local mock"
      : clientReconnecting
        ? "Reconnecting"
        : feed === null
          ? "Laces Out ledger"
          : heading,
    indicatorDetail:
      feed === null
        ? `Event ${session.sequence} · ${clientReconnecting ? "retrying" : "auto-refresh on"}`
        : `Event ${session.sequence} · ${freshnessLabel}`,
    freshness,
    freshnessLabel,
    ageSeconds: age,
    clientReconnecting,
    sourceRequirement,
    reconnectGuidance,
    transportChip: transportChip(entryState, feed, localMock),
    ledgerNote: ledgerNote(feed, localMock),
    strip,
    manualBackup: manualBackupControls(session, feed),
  };
}

/**
 * Everything a phone needs to make the next decision without opening a second panel (§16.4).
 * Recommendation copy is supplied by the caller because it comes from the local board model, not
 * from the session snapshot.
 */
export function describeMobileDecision(
  session: DraftSessionSnapshot,
  activeTeamId: string | undefined,
  status: LiveDraftStatus,
): LiveDraftMobileSummary {
  const teamState = session.state.teams.find((team) => team.teamId === activeTeamId);
  const teamConfig = session.config.teams.find((team) => team.id === activeTeamId);

  const headline = status.strip?.currentActionLabel ?? defaultHeadline(session);
  const headlineCaption = status.strip?.currentActionCaption ?? defaultCaption(session);

  const openStarters =
    teamConfig && teamState
      ? unfilledStarterSlots(
          session.config.players,
          teamState.roster.map((entry) => entry.playerId),
          teamConfig.rosterSlots,
        )
      : [];
  const needLabels = [...new Set(openStarters.map((slot) => slot.label))].slice(0, 3);
  const needsLabel = teamState
    ? needLabels.length > 0
      ? `${pluralize(teamState.openSlots, "open slot")} · need ${needLabels.join(", ")}`
      : `${pluralize(teamState.openSlots, "open slot")} · starters filled`
    : "Select a team for roster needs";

  const budgetLabel =
    session.config.mode === "AUCTION" && teamState
      ? `$${teamState.remainingBudget ?? 0} left · $${teamState.maximumBid ?? 0} legal max`
      : null;

  const stale = status.entryState === "stale" || status.clientReconnecting;

  return {
    headline,
    headlineCaption,
    needsLabel,
    budgetLabel,
    feedLabel: status.providerBacked
      ? `${status.heading} · ${status.freshnessLabel}`
      : `Shared ledger · event ${session.sequence}`,
    stale,
    staleLabel: stale
      ? status.clientReconnecting
        ? "Not connected — showing last accepted board"
        : status.providerName === "Yahoo"
          ? "Yahoo check delayed — manual entry remains available"
          : `${status.providerName} feed stale — showing last accepted board`
      : null,
  };
}

function defaultHeadline(session: DraftSessionSnapshot): string {
  if (session.state.complete) return "Draft complete";
  const nextPick = session.state.nextPick;
  if (!nextPick) return "Waiting for the first pick";
  const team = session.config.teams.find((entry) => entry.id === nextPick.teamId);
  return team?.name ?? "Next team";
}

function defaultCaption(session: DraftSessionSnapshot): string {
  if (session.state.complete) return "No pick pending";
  const nextPick = session.state.nextPick;
  return nextPick ? `Pick ${nextPick.overallPick}` : "No pick pending";
}

/**
 * The setup screen has no session yet, so entry copy comes from the league's provider instead.
 * Yahoo's option is explicitly beta, read-only, and opt-in; the server remains authoritative and
 * may reject setup when its release switch is off. Every other provider keeps the existing manual
 * promise until the API exposes a provider-specific setup capability.
 *
 * TODO(espn-live-draft): restore the ESPN branch when `ESPN_LIVE_DRAFT_SYNC` is turned on.
 *
 * ESPN gets the neutral line even though the code path exists, because this function
 * only knows the league's provider — the server reports `providerFeed: null` both when the flag
 * is off and when it is on with no source connected, so "ESPN" alone cannot tell the difference.
 * Promising live sync here while the flag is off would be a claim a manager could act on, and
 * draft day happens once. Restoring the branch needs the server to report capability rather than
 * this function inferring it; see the release gate in docs/provider-notes/espn.md.
 *
 * The sentence to restore, once capability is real and reported:
 *   "Manual event entry is persistent and shared. An ESPN draft can also drive this room live
 *    while a paired desktop Chrome keeps the ESPN draft room open."
 */
export function describeDraftSetupCapability(
  provider: string | null,
  yahooAssistSupported = false,
): string {
  if (provider === "yahoo" && yahooAssistSupported) {
    return "Start a shared manual room, with optional read-only Yahoo-assisted checks.";
  }
  return "Manual entries are shared. No live draft feed is attached.";
}

/** Exported so the disconnected threshold is one number rather than three drifting literals. */
export const LIVE_DRAFT_THRESHOLD_SECONDS = {
  fresh: FRESH_WINDOW_SECONDS,
  failover: FAILOVER_SECONDS,
  disconnected: DISCONNECTED_SECONDS,
} as const;
