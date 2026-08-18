/**
 * The ONLY module allowed to know ESPN draft-room selectors or labels.
 *
 * ============================ PROVISIONAL — PENDING LIVE VALIDATION ============================
 * Every selector string and every label below is a documented *candidate*, not a verified value.
 * Live validation has not been run because it needs an authenticated ESPN draft room. Until it
 * has, `verified` stays false on each family and the adapter resolves nothing in a real room.
 *
 * Validation updates only `ESPN_DRAFT_SELECTORS` and `ESPN_DRAFT_LABELS` in this file: replace each
 * `candidates` list with the values observed in a real room (most specific first), set
 * `verified: true` on confirmed families, and extend the label maps with the exact strings ESPN
 * renders. No other module, and no test, hard-codes a selector string.
 * =============================================================================================
 *
 * Selector preference order: `data-testid`, then element IDs, then explicit data attributes and
 * stable structural classes, and only then normalized text. Text matching is a fallback.
 *
 * Everything here is fail-closed. A family that matches nothing yields `null`; a family that
 * matches more than one node yields `null` plus an ambiguity marker so the sanitizer can count the
 * row unresolved. The adapter never picks "the first one" and never infers a value it did not read.
 *
 * The adapter returns raw strings only. Trimming, whitespace collapsing, control-character
 * rejection, number parsing, and bounds all live in `observation.ts`.
 */

import {
  ESPN_LIVE_DRAFT_LIMITS,
  type EspnLiveDraftState,
  type EspnLiveDraftType,
} from "./dom-contract.js";

/**
 * The slice of the DOM this adapter uses. A real `Element` satisfies this structurally, so the
 * content script passes `document.documentElement` and tests pass hand-built fakes. There is no
 * jsdom in this repository and none is wanted: the adapter's contract is exactly these four members.
 */
export interface DraftRoomElement {
  getAttribute(name: string): string | null;
  readonly textContent: string | null;
  querySelector(selector: string): DraftRoomElement | null;
  querySelectorAll(selector: string): ArrayLike<DraftRoomElement>;
}

export interface SelectorFamily {
  /** What this family identifies. Doubles as the validation checklist and unresolved-family code. */
  readonly purpose: string;
  /** Tried in order. For single lookups the first candidate matching exactly one node wins. */
  readonly candidates: readonly string[];
  /** When set, the value is read from this attribute instead of the element's text. */
  readonly attribute: string | null;
  /** Set true once the candidate list is confirmed against a real ESPN draft room. */
  readonly verified: boolean;
}

/**
 * Candidate selectors. Each entry documents what live validation must confirm.
 *
 * A family whose `candidates` list is exhausted resolves to nothing, which fails the observation
 * closed rather than producing a guessed board.
 */
export const ESPN_DRAFT_SELECTORS = {
  /** Proves the page really rendered a draft room rather than a lobby, recap, or error page. */
  draftRoot: {
    purpose: "draft-root",
    candidates: [
      '[data-testid="draft-room"]',
      "#draft-room",
      "[data-draft-room]",
      ".draft-content-wrapper",
    ],
    attribute: null,
    verified: false,
  },
  /** Explicit waiting/live/paused/complete state. Confirm the attribute AND its value vocabulary. */
  draftState: {
    purpose: "draft-state",
    candidates: ["[data-draft-status]", '[data-testid="draft-status"]', "#draft-status"],
    attribute: "data-draft-status",
    verified: false,
  },
  /** Text fallback for state when no explicit attribute exists. Matched through ESPN_DRAFT_LABELS. */
  draftStateLabel: {
    purpose: "draft-state-label",
    candidates: ['[data-testid="draft-status-label"]', ".draft-status__label"],
    attribute: null,
    verified: false,
  },
  /** Structural state markers emitted by ESPN's current draft scenario switch. */
  draftWaitingMarker: {
    purpose: "draft-waiting-marker",
    candidates: [".pickArea > .pre-draft"],
    attribute: null,
    verified: false,
  },
  draftLiveMarker: {
    purpose: "draft-live-marker",
    candidates: [
      '.pickArea [data-testid="bidding-form"]',
      '.pickArea [data-testid="opening-bid-form"]',
      '.pickArea > [data-testid="player-drafted"]',
      '.pickArea > [data-testid="player-selected"]',
      ".pickArea > .in-draft",
      ".pickArea > .on-autopick",
      ".pickArea > .on-the-clock",
      ".pickArea > .miller-banner",
    ],
    attribute: null,
    verified: false,
  },
  draftPausedMarker: {
    purpose: "draft-paused-marker",
    candidates: [".pickArea > .paused-draft", ".pickArea .paused-draft__draft-paused"],
    attribute: null,
    verified: false,
  },
  draftCompleteMarker: {
    purpose: "draft-complete-marker",
    candidates: [".pickArea > .post-draft"],
    attribute: null,
    verified: false,
  },
  /** Snake versus auction. Confirm both settings and visible layout. */
  draftType: {
    purpose: "draft-type",
    candidates: ["[data-draft-type]", '[data-testid="draft-type"]', "#draft-type"],
    attribute: "data-draft-type",
    verified: false,
  },
  draftTypeLabel: {
    purpose: "draft-type-label",
    candidates: ['[data-testid="draft-type-label"]', ".draft-settings__type"],
    attribute: null,
    verified: false,
  },
  /** The official bundle renders this mounted table only for salary-cap drafts. */
  auctionStructure: {
    purpose: "auction-structure",
    candidates: [".budget_tab__container .budgets-table", ".budget_tab__container"],
    attribute: null,
    verified: false,
  },
  expectedTeamCount: {
    purpose: "expected-team-count",
    candidates: ["[data-team-count]", '[data-testid="draft-team-count"]'],
    attribute: "data-team-count",
    verified: false,
  },
  /** One mounted budget-table row per fantasy team in an auction room. */
  budgetTeamRow: {
    purpose: "budget-team-row",
    candidates: [".budget_tab__container .budgets-table .Table__TBODY .Table__TR"],
    attribute: null,
    verified: false,
  },
  expectedRosterSize: {
    purpose: "expected-roster-size",
    candidates: ["[data-roster-size]", '[data-testid="draft-roster-size"]'],
    attribute: "data-roster-size",
    verified: false,
  },

  /**
   * Proves the completed-history surface itself mounted, including before its first row. Live
   * validation must also prove the table is not viewport-virtualized before auction approval.
   */
  pickHistoryContainer: {
    purpose: "pick-history-container",
    candidates: [".pick-history-tables"],
    attribute: null,
    verified: false,
  },

  /**
   * One row per completed pick or completed auction sale. Validation must prove a late join or reload
   * reconstructs every prior row without manual scrolling; if the table is virtualized and only
   * renders visible rows, record that limitation explicitly rather than shipping a partial board.
   */
  pickRow: {
    purpose: "pick-row",
    candidates: [
      '[data-testid="draft-pick-row"]',
      "[data-pick-sequence]",
      ".draft-pick-row",
      ".pick-history-tables .pick-history-table .Table__TBODY .Table__TR",
    ],
    attribute: null,
    verified: false,
  },
  pickSequence: {
    purpose: "pick-sequence",
    candidates: ["[data-overall-pick]", '[data-testid="pick-overall"]'],
    attribute: "data-overall-pick",
    verified: false,
  },
  pickSequenceText: {
    purpose: "pick-sequence-text",
    candidates: [".Table__TD:first-child"],
    attribute: null,
    verified: false,
  },
  pickRound: {
    purpose: "pick-round",
    candidates: ["[data-round]", '[data-testid="pick-round"]'],
    attribute: "data-round",
    verified: false,
  },
  pickRoundPick: {
    purpose: "pick-round-pick",
    candidates: ["[data-round-pick]", '[data-testid="pick-round-pick"]'],
    attribute: "data-round-pick",
    verified: false,
  },
  /** Presence or value is matched against ESPN_DRAFT_LABELS.keeper; absence means "not a keeper". */
  pickKeeper: {
    purpose: "pick-keeper",
    candidates: ["[data-keeper]", '[data-testid="pick-keeper"]'],
    attribute: "data-keeper",
    verified: false,
  },
  pickTeamId: {
    purpose: "pick-team-id",
    candidates: ["[data-team-id]", '[data-testid="pick-team"]'],
    attribute: "data-team-id",
    verified: false,
  },
  pickTeamName: {
    purpose: "pick-team-name",
    candidates: [
      '[data-testid="pick-team-name"]',
      ".draft-pick__team-name",
      ".Table__TD:nth-child(3)",
    ],
    attribute: null,
    verified: false,
  },
  pickPlayerId: {
    purpose: "pick-player-id",
    candidates: ["[data-player-id]", '[data-testid="pick-player"]'],
    attribute: "data-player-id",
    verified: false,
  },
  pickPlayerName: {
    purpose: "pick-player-name",
    candidates: [
      '[data-testid="pick-player-name"]',
      ".draft-pick__player-name",
      ".Table__TD:nth-child(2) .playerinfo__playername",
    ],
    attribute: null,
    verified: false,
  },
  pickProTeam: {
    purpose: "pick-pro-team",
    candidates: [
      '[data-testid="pick-pro-team"]',
      ".draft-pick__pro-team",
      ".Table__TD:nth-child(2) .playerinfo__playerteam",
    ],
    attribute: null,
    verified: false,
  },
  pickPosition: {
    purpose: "pick-position",
    candidates: [
      '[data-testid="pick-position"]',
      ".draft-pick__position",
      ".Table__TD:nth-child(2) .playerinfo__playerpos",
    ],
    attribute: null,
    verified: false,
  },
  /** The explicit winning/sale value only. Never a generic dollar amount elsewhere in the row. */
  pickPrice: {
    purpose: "pick-price",
    candidates: ["[data-winning-bid]", '[data-testid="pick-winning-bid"]'],
    attribute: "data-winning-bid",
    verified: false,
  },
  pickPriceText: {
    purpose: "pick-price-text",
    candidates: [".Table__TD:last-child"],
    attribute: null,
    verified: false,
  },
  pickNominatingTeamId: {
    purpose: "pick-nominating-team-id",
    candidates: ["[data-nominating-team-id]", '[data-testid="pick-nominating-team"]'],
    attribute: "data-nominating-team-id",
    verified: false,
  },

  /**
   * Actual owner of every draft slot, including traded picks, custom orders, and keeper-occupied
   * slots. Never infer traded picks from a standard snake pattern.
   */
  ownershipRow: {
    purpose: "ownership-row",
    candidates: ['[data-testid="draft-order-row"]', "[data-owned-pick]", ".draft-order__row"],
    attribute: null,
    verified: false,
  },
  ownershipOverallPick: {
    purpose: "ownership-overall-pick",
    candidates: ["[data-overall-pick]", '[data-testid="order-overall-pick"]'],
    attribute: "data-overall-pick",
    verified: false,
  },
  ownershipTeamId: {
    purpose: "ownership-team-id",
    candidates: ["[data-team-id]", '[data-testid="order-team"]'],
    attribute: "data-team-id",
    verified: false,
  },
  ownershipTeamName: {
    purpose: "ownership-team-name",
    candidates: ['[data-testid="order-team-name"]', ".draft-order__team-name"],
    attribute: null,
    verified: false,
  },

  /** Transient auction state. Absent in snake rooms and between nominations. */
  auctionPanel: {
    purpose: "auction-panel",
    candidates: [
      '[data-testid="auction-nomination"]',
      "#auction-nomination",
      ".auction-current",
      '[data-testid="player-selected"]:has([data-testid="bidding-form"])',
    ],
    attribute: null,
    verified: false,
  },
  auctionNominationNumber: {
    purpose: "auction-nomination-number",
    candidates: ["[data-nomination-number]", '[data-testid="nomination-number"]'],
    attribute: "data-nomination-number",
    verified: false,
  },
  auctionNominatingTeamId: {
    purpose: "auction-nominating-team-id",
    candidates: ["[data-nominating-team-id]", '[data-testid="nominating-team"]'],
    attribute: "data-nominating-team-id",
    verified: false,
  },
  auctionPlayerId: {
    purpose: "auction-player-id",
    candidates: ["[data-player-id]", '[data-testid="nominated-player"]'],
    attribute: "data-player-id",
    verified: false,
  },
  auctionPlayerName: {
    purpose: "auction-player-name",
    candidates: [
      '[data-testid="nominated-player-name"]',
      ".auction-current__player-name",
      ".playerinfo__playername",
    ],
    attribute: null,
    verified: false,
  },
  auctionProTeam: {
    purpose: "auction-pro-team",
    candidates: [
      '[data-testid="nominated-pro-team"]',
      ".auction-current__pro-team",
      ".playerinfo__playerteam",
    ],
    attribute: null,
    verified: false,
  },
  auctionPosition: {
    purpose: "auction-position",
    candidates: [
      '[data-testid="nominated-position"]',
      ".auction-current__position",
      ".playerinfo__playerpos",
    ],
    attribute: null,
    verified: false,
  },
  auctionHighBidTeamId: {
    purpose: "auction-high-bid-team-id",
    candidates: ["[data-high-bid-team-id]", '[data-testid="high-bid-team"]'],
    attribute: "data-high-bid-team-id",
    verified: false,
  },
  auctionHighBid: {
    purpose: "auction-high-bid",
    candidates: ["[data-high-bid]", '[data-testid="high-bid"]'],
    attribute: "data-high-bid",
    verified: false,
  },
  /** Visible `Current offer: $<amount>` label in the official bidding form. */
  auctionCurrentAmount: {
    purpose: "auction-current-amount",
    candidates: [".current-amount"],
    attribute: null,
    verified: false,
  },
  /** First item is the highest offer; its rendered text is `$<amount> <team full name>`. */
  auctionHighBidLine: {
    purpose: "auction-high-bid-line",
    candidates: [".bid-history__list .bid:first-child"],
    attribute: null,
    verified: false,
  },
} as const satisfies Record<string, SelectorFamily>;

export type EspnDraftSelectorName = keyof typeof ESPN_DRAFT_SELECTORS;

/**
 * Family verification and mode activation are deliberately separate. Static bundle evidence can
 * add candidates, but only an authenticated state-matrix review may approve a whole draft mode.
 */
export const ESPN_DRAFT_SELECTOR_PROFILES = {
  auction: { approved: false },
  snake: { approved: false },
} as const satisfies Record<EspnLiveDraftType, { readonly approved: boolean }>;

/**
 * Normalized-text vocabularies. Keys are compared after `normalizeDraftText` lowercases and
 * collapses whitespace, so validation records the *rendered* string and the comparison stays stable
 * across casing and spacing changes.
 */
export const ESPN_DRAFT_LABELS: {
  readonly state: Readonly<Record<string, EspnLiveDraftState>>;
  readonly draftType: Readonly<Record<string, EspnLiveDraftType>>;
  readonly keeperTrue: readonly string[];
  readonly keeperFalse: readonly string[];
} = {
  state: {
    waiting: "waiting",
    "not started": "waiting",
    "draft has not started": "waiting",
    live: "live",
    "in progress": "live",
    "on the clock": "live",
    paused: "paused",
    "draft paused": "paused",
    complete: "complete",
    completed: "complete",
    "draft complete": "complete",
  },
  draftType: {
    snake: "snake",
    "snake draft": "snake",
    standard: "snake",
    auction: "auction",
    "auction draft": "auction",
    "salary cap": "auction",
  },
  keeperTrue: ["true", "1", "yes", "keeper", "k"],
  keeperFalse: ["false", "0", "no", "", "-"],
};

/** Adapter revision. Bumped whenever the extraction shape changes, not when selectors change. */
export const ESPN_DRAFT_ADAPTER_VERSION = 2;

/**
 * Revision of candidate ordering, so a privacy-safe calibration `candidateIndex` is reproducible.
 *
 * Static provenance for revision 2: ESPN's official football draft bundle, anonymously fetched
 * 2026-08-11, build `90216808-e960-4555-8614-95ab1fc2d5b4`:
 * https://cdn1.espn.net/kona/03952a533239-1.461/_next/90216808-e960-4555-8614-95ab1fc2d5b4/page/football/draft.js
 * Static render code is useful candidate evidence, but is not authenticated live-DOM verification.
 */
export const ESPN_DRAFT_SELECTOR_TABLE_VERSION = 2;

/**
 * The ESPN football draft-room route. Also ESPN knowledge, so it lives in this file with the
 * selectors: live validation confirms the real path and query names here and nowhere else.
 *
 * The manifest's `content_scripts.matches` is necessarily coarser than this (match patterns cannot
 * require a query parameter), so this recognizer is the authoritative gate. It is deliberately
 * exact: `/football/draftrecap` and the mock lobby must not be treated as a live room, and a mock
 * draft carries no league ID so it can never match a paired Laces Out league.
 */
export const ESPN_DRAFT_ROUTES = {
  host: "fantasy.espn.com",
  pathnames: ["/football/draft", "/football/draft/"],
  /** Manifest match patterns; broader than the recognizer above by necessity. */
  manifestMatches: ["https://fantasy.espn.com/football/draft*"],
  leagueIdParameters: ["leagueId"],
  seasonParameters: ["seasonId", "season"],
} as const;

export interface EspnDraftRoute {
  readonly leagueId: string;
  readonly season: number;
}

/** Recognizes a live ESPN football draft-room URL, or returns null. Fails closed on anything odd. */
export function recognizeEspnDraftRoute(
  href: string,
  seasonBounds: { readonly minimum: number; readonly maximum: number },
): EspnDraftRoute | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== ESPN_DRAFT_ROUTES.host) return null;
  if (!ESPN_DRAFT_ROUTES.pathnames.some((pathname) => pathname === url.pathname)) return null;
  const leagueIds = ESPN_DRAFT_ROUTES.leagueIdParameters.flatMap((parameter) =>
    url.searchParams.getAll(parameter),
  );
  if (leagueIds.length !== 1) return null;
  const leagueId = leagueIds[0];
  if (leagueId === undefined || !/^\d{1,20}$/u.test(leagueId)) return null;
  const seasons = ESPN_DRAFT_ROUTES.seasonParameters.flatMap((parameter) =>
    url.searchParams.getAll(parameter),
  );
  if (seasons.length !== 1) return null;
  const seasonText = seasons[0];
  if (seasonText === undefined || !/^\d{4}$/u.test(seasonText)) return null;
  const season = Number(seasonText);
  if (season < seasonBounds.minimum || season > seasonBounds.maximum) return null;
  return { leagueId, season };
}

export type SelectorResolution =
  | { readonly kind: "resolved"; readonly element: DraftRoomElement }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous"; readonly matches: number };

/**
 * Resolves exactly one node.
 *
 * A candidate matching zero nodes falls through to the next candidate. A candidate matching more
 * than one node is terminal: an ambiguous match means the assumption behind the selector is wrong,
 * and falling through would silently substitute a weaker selector for a broken strong one.
 */
export function resolveSingle(root: DraftRoomElement, family: SelectorFamily): SelectorResolution {
  for (const candidate of family.candidates) {
    const matches = safeQueryAll(root, candidate);
    if (matches.length === 0) continue;
    if (matches.length > 1) return { kind: "ambiguous", matches: matches.length };
    const element = matches[0];
    if (element === undefined) return { kind: "missing" };
    return { kind: "resolved", element };
  }
  return { kind: "missing" };
}

/** Resolves a repeated family. The first candidate matching at least one node wins outright. */
export function resolveAll(
  root: DraftRoomElement,
  family: SelectorFamily,
  limit: number,
): readonly DraftRoomElement[] {
  for (const candidate of family.candidates) {
    const matches = safeQueryAll(root, candidate);
    if (matches.length === 0) continue;
    const rows: DraftRoomElement[] = [];
    for (let index = 0; index < matches.length && rows.length < limit; index += 1) {
      const element = matches[index];
      if (element !== undefined) rows.push(element);
    }
    return rows;
  }
  return [];
}

// A malformed selector, a detached node, or a hostile page overriding `querySelectorAll` must not
// throw out of the adapter; an empty match is the fail-closed answer.
function safeQueryAll(root: DraftRoomElement, selector: string): readonly DraftRoomElement[] {
  let matches: ArrayLike<DraftRoomElement>;
  try {
    matches = root.querySelectorAll(selector);
  } catch {
    return [];
  }
  const length = typeof matches.length === "number" ? matches.length : 0;
  const result: DraftRoomElement[] = [];
  for (let index = 0; index < length; index += 1) {
    const element = matches[index];
    if (element !== null && typeof element === "object") result.push(element);
  }
  return result;
}

/** Reads a family's value from a scope: the configured attribute when set, otherwise raw text. */
function readValue(
  scope: DraftRoomElement,
  family: SelectorFamily,
): { readonly value: string | null; readonly ambiguous: boolean } {
  const resolution = resolveSingle(scope, family);
  if (resolution.kind === "ambiguous") return { value: null, ambiguous: true };
  if (resolution.kind === "missing") return { value: null, ambiguous: false };
  const raw =
    family.attribute === null
      ? resolution.element.textContent
      : resolution.element.getAttribute(family.attribute);
  return { value: typeof raw === "string" ? raw : null, ambiguous: false };
}

export interface RawPickRow {
  readonly sequence: string | null;
  readonly round: string | null;
  readonly roundPick: string | null;
  readonly keeperLabel: string | null;
  readonly teamId: string | null;
  readonly teamName: string | null;
  readonly playerId: string | null;
  readonly playerName: string | null;
  readonly proTeam: string | null;
  readonly position: string | null;
  readonly price: string | null;
  readonly nominatingTeamId: string | null;
  /** Families that matched more than one node inside this row. Never guessed, never used. */
  readonly ambiguousFields: readonly string[];
}

export interface RawOwnershipRow {
  readonly overallPick: string | null;
  readonly teamId: string | null;
  readonly teamName: string | null;
  readonly ambiguousFields: readonly string[];
}

export interface RawAuctionPanel {
  readonly nominationNumber: string | null;
  readonly nominatingTeamId: string | null;
  readonly playerId: string | null;
  readonly playerName: string | null;
  readonly proTeam: string | null;
  readonly position: string | null;
  readonly highBidTeamId: string | null;
  readonly highBid: string | null;
  readonly currentAmount: string | null;
  readonly highBidLine: string | null;
  readonly ambiguousFields: readonly string[];
}

export interface RawDraftRoomExtraction {
  readonly adapterVersion: number;
  /** False until live validation confirms every family this extraction depended on. */
  readonly selectorsVerified: boolean;
  /** False when the draft-root family did not resolve: this page is not a usable draft room. */
  readonly recognized: boolean;
  /** Purposes of families that matched nothing or matched ambiguously at the document level. */
  readonly unresolvedFamilies: readonly string[];
  readonly stateAttribute: string | null;
  readonly stateLabel: string | null;
  /** Fixed semantic value from one mutually exclusive, bundle-evidenced scenario marker. */
  readonly structuralState: EspnLiveDraftState | null;
  readonly draftTypeAttribute: string | null;
  readonly draftTypeLabel: string | null;
  /** Auction only: the mounted budgets table is emitted only by the salary-cap tab set. */
  readonly structuralDraftType: EspnLiveDraftType | null;
  readonly expectedTeamCountText: string | null;
  /** Auction only: bounded count of mounted budget-table team rows. */
  readonly structuralTeamCount: number | null;
  readonly expectedRosterSizeText: string | null;
  /** Required before completed-row count may supply a missing auction nomination number. */
  readonly completedHistoryObserved?: boolean;
  readonly pickRows: readonly RawPickRow[];
  readonly ownershipRows: readonly RawOwnershipRow[];
  readonly auction: RawAuctionPanel | null;
  /** True when the DOM rendered more rows than the bounded contract permits. Fails the snapshot. */
  readonly pickRowOverflow: boolean;
  readonly ownershipRowOverflow: boolean;
  readonly teamRowOverflow: boolean;
  /** Privacy-safe admission diagnostics: selector names only, never provider text. */
  readonly selectorProfile?: EspnLiveDraftType | null;
  readonly selectorFamiliesUsed?: readonly EspnDraftSelectorName[];
  readonly selectorSemanticsComplete?: boolean;
}

interface FieldReader {
  read(name: EspnDraftSelectorName): string | null;
  readonly ambiguousFields: readonly string[];
}

function fieldReader(scope: DraftRoomElement): FieldReader {
  const ambiguousFields: string[] = [];
  return {
    read(name) {
      const family: SelectorFamily = ESPN_DRAFT_SELECTORS[name];
      const { value, ambiguous } = readValue(scope, family);
      if (ambiguous) ambiguousFields.push(family.purpose);
      return value;
    },
    ambiguousFields,
  };
}

function readTracked(
  reader: FieldReader,
  name: EspnDraftSelectorName,
  usedFamilies: Set<EspnDraftSelectorName>,
): string | null {
  const value = reader.read(name);
  if (value !== null) usedFamilies.add(name);
  return value;
}

const SELECTOR_LABEL_WHITESPACE = /(?:\s|\u00a0|\u200b|\u200c|\u200d|\ufeff)+/gu;

function normalizeSelectorLabel(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(SELECTOR_LABEL_WHITESPACE, " ").trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 200) return null;
  return /[\p{Cc}\p{Cf}]/u.test(normalized) ? null : normalized;
}

export interface EspnDraftSemanticResolution<T> {
  readonly value: T | null;
  readonly selectorName: EspnDraftSelectorName | null;
}

/** Resolves state and records the selector family whose value was actually understood. */
export function resolveEspnDraftState(
  attribute: string | null,
  label: string | null,
  structural: EspnLiveDraftState | null,
): EspnDraftSemanticResolution<EspnLiveDraftState> {
  const attributeLabel = normalizeSelectorLabel(attribute);
  const fromAttribute =
    attributeLabel === null ? undefined : ESPN_DRAFT_LABELS.state[attributeLabel];
  if (fromAttribute !== undefined) return { value: fromAttribute, selectorName: "draftState" };
  const textLabel = normalizeSelectorLabel(label);
  const fromLabel = textLabel === null ? undefined : ESPN_DRAFT_LABELS.state[textLabel];
  if (fromLabel !== undefined) return { value: fromLabel, selectorName: "draftStateLabel" };
  if (structural === null) return { value: null, selectorName: null };
  const selectorName: EspnDraftSelectorName =
    structural === "waiting"
      ? "draftWaitingMarker"
      : structural === "live"
        ? "draftLiveMarker"
        : structural === "paused"
          ? "draftPausedMarker"
          : "draftCompleteMarker";
  return { value: structural, selectorName };
}

/** Resolves draft type and records the selector family whose value was actually understood. */
export function resolveEspnDraftType(
  attribute: string | null,
  label: string | null,
  structural: EspnLiveDraftType | null,
): EspnDraftSemanticResolution<EspnLiveDraftType> {
  const attributeLabel = normalizeSelectorLabel(attribute);
  const fromAttribute =
    attributeLabel === null ? undefined : ESPN_DRAFT_LABELS.draftType[attributeLabel];
  if (fromAttribute !== undefined) return { value: fromAttribute, selectorName: "draftType" };
  const textLabel = normalizeSelectorLabel(label);
  const fromLabel = textLabel === null ? undefined : ESPN_DRAFT_LABELS.draftType[textLabel];
  if (fromLabel !== undefined) return { value: fromLabel, selectorName: "draftTypeLabel" };
  return structural === "auction"
    ? { value: structural, selectorName: "auctionStructure" }
    : { value: null, selectorName: null };
}

function isBoundedSelectorInteger(value: string | null, minimum: number, maximum: number): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().replace(/^[#$]/u, "").replace(/,/gu, "").replace(/\s/gu, "");
  if (!/^-?\d{1,15}$/u.test(normalized)) return false;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum;
}

/** Pure admission predicate, exported so the fail-closed release switch can be pinned in tests. */
export function evaluateEspnDraftSelectorAdmission(input: {
  readonly profileApproved: boolean;
  readonly requiredSemanticsComplete: boolean;
  readonly usedFamilies: readonly SelectorFamily[];
}): boolean {
  return (
    input.profileApproved &&
    input.requiredSemanticsComplete &&
    input.usedFamilies.every((family) => family.verified)
  );
}

function extractPickRow(
  row: DraftRoomElement,
  usedFamilies: Set<EspnDraftSelectorName>,
): RawPickRow {
  const reader = fieldReader(row);
  const sequence = readTracked(reader, "pickSequence", usedFamilies);
  const price = readTracked(reader, "pickPrice", usedFamilies);
  return {
    sequence: sequence ?? readTracked(reader, "pickSequenceText", usedFamilies),
    round: readTracked(reader, "pickRound", usedFamilies),
    roundPick: readTracked(reader, "pickRoundPick", usedFamilies),
    keeperLabel: readTracked(reader, "pickKeeper", usedFamilies),
    teamId: readTracked(reader, "pickTeamId", usedFamilies),
    teamName: readTracked(reader, "pickTeamName", usedFamilies),
    playerId: readTracked(reader, "pickPlayerId", usedFamilies),
    playerName: readTracked(reader, "pickPlayerName", usedFamilies),
    proTeam: readTracked(reader, "pickProTeam", usedFamilies),
    position: readTracked(reader, "pickPosition", usedFamilies),
    price: price ?? readTracked(reader, "pickPriceText", usedFamilies),
    nominatingTeamId: readTracked(reader, "pickNominatingTeamId", usedFamilies),
    ambiguousFields: reader.ambiguousFields,
  };
}

function extractOwnershipRow(
  row: DraftRoomElement,
  usedFamilies: Set<EspnDraftSelectorName>,
): RawOwnershipRow {
  const reader = fieldReader(row);
  return {
    overallPick: readTracked(reader, "ownershipOverallPick", usedFamilies),
    teamId: readTracked(reader, "ownershipTeamId", usedFamilies),
    teamName: readTracked(reader, "ownershipTeamName", usedFamilies),
    ambiguousFields: reader.ambiguousFields,
  };
}

function extractAuctionPanel(
  panel: DraftRoomElement,
  room: DraftRoomElement,
  usedFamilies: Set<EspnDraftSelectorName>,
): RawAuctionPanel {
  const reader = fieldReader(panel);
  const roomReader = fieldReader(room);
  return {
    nominationNumber: readTracked(reader, "auctionNominationNumber", usedFamilies),
    nominatingTeamId: readTracked(reader, "auctionNominatingTeamId", usedFamilies),
    playerId: readTracked(reader, "auctionPlayerId", usedFamilies),
    playerName: readTracked(reader, "auctionPlayerName", usedFamilies),
    proTeam: readTracked(reader, "auctionProTeam", usedFamilies),
    position: readTracked(reader, "auctionPosition", usedFamilies),
    highBidTeamId: readTracked(reader, "auctionHighBidTeamId", usedFamilies),
    highBid: readTracked(reader, "auctionHighBid", usedFamilies),
    currentAmount: readTracked(reader, "auctionCurrentAmount", usedFamilies),
    highBidLine: readTracked(roomReader, "auctionHighBidLine", usedFamilies),
    ambiguousFields: [...reader.ambiguousFields, ...roomReader.ambiguousFields],
  };
}

interface StructuralMarkerResolution<T> {
  readonly value: T | null;
  readonly family: SelectorFamily | null;
  readonly unresolved: readonly string[];
}

/** Resolves mutually exclusive semantic markers without copying their rendered text. */
function resolveStructuralMarker<T>(
  scope: DraftRoomElement,
  markers: readonly { readonly family: SelectorFamily; readonly value: T }[],
  conflictCode: string,
): StructuralMarkerResolution<T> {
  const resolved: { readonly family: SelectorFamily; readonly value: T }[] = [];
  const unresolved: string[] = [];
  for (const marker of markers) {
    const resolution = resolveSingle(scope, marker.family);
    if (resolution.kind === "ambiguous") unresolved.push(marker.family.purpose);
    if (resolution.kind === "resolved") resolved.push(marker);
  }
  if (unresolved.length > 0 || resolved.length > 1) {
    return {
      value: null,
      family: null,
      unresolved: resolved.length > 1 ? [...unresolved, conflictCode] : unresolved,
    };
  }
  const marker = resolved[0];
  return marker === undefined
    ? { value: null, family: null, unresolved }
    : { value: marker.value, family: marker.family, unresolved };
}

/**
 * Reads a draft-room DOM into a raw extraction record of plain strings.
 *
 * Row scans are capped one past the contract maximum so the sanitizer can tell a legal board from
 * an oversized or hostile one instead of quietly truncating it.
 */
export function extractDraftRoom(root: DraftRoomElement): RawDraftRoomExtraction {
  const rowLimit = ESPN_LIVE_DRAFT_LIMITS.maximumPicks + 1;
  const unresolvedFamilies: string[] = [];
  const document = fieldReader(root);

  const rootResolution = resolveSingle(root, ESPN_DRAFT_SELECTORS.draftRoot);
  if (rootResolution.kind !== "resolved") {
    unresolvedFamilies.push(ESPN_DRAFT_SELECTORS.draftRoot.purpose);
    return {
      adapterVersion: ESPN_DRAFT_ADAPTER_VERSION,
      selectorsVerified: false,
      recognized: false,
      unresolvedFamilies,
      stateAttribute: null,
      stateLabel: null,
      structuralState: null,
      draftTypeAttribute: null,
      draftTypeLabel: null,
      structuralDraftType: null,
      expectedTeamCountText: null,
      structuralTeamCount: null,
      expectedRosterSizeText: null,
      completedHistoryObserved: false,
      pickRows: [],
      ownershipRows: [],
      auction: null,
      pickRowOverflow: false,
      ownershipRowOverflow: false,
      teamRowOverflow: false,
      selectorProfile: null,
      selectorFamiliesUsed: [],
      selectorSemanticsComplete: false,
    };
  }
  const scope = rootResolution.element;
  const scoped = fieldReader(scope);

  const stateAttribute = scoped.read("draftState");
  const stateLabel = scoped.read("draftStateLabel");
  const stateMarker = resolveStructuralMarker(
    scope,
    [
      { family: ESPN_DRAFT_SELECTORS.draftWaitingMarker, value: "waiting" },
      { family: ESPN_DRAFT_SELECTORS.draftLiveMarker, value: "live" },
      { family: ESPN_DRAFT_SELECTORS.draftPausedMarker, value: "paused" },
      { family: ESPN_DRAFT_SELECTORS.draftCompleteMarker, value: "complete" },
    ] as const,
    "draft-state-marker-conflict",
  );
  unresolvedFamilies.push(...stateMarker.unresolved);
  const draftTypeAttribute = scoped.read("draftType");
  const draftTypeLabel = scoped.read("draftTypeLabel");
  const auctionStructureResolution = resolveSingle(scope, ESPN_DRAFT_SELECTORS.auctionStructure);
  if (auctionStructureResolution.kind === "ambiguous") {
    unresolvedFamilies.push(ESPN_DRAFT_SELECTORS.auctionStructure.purpose);
  }
  const structuralDraftType =
    auctionStructureResolution.kind === "resolved" ? ("auction" as const) : null;
  const expectedTeamCountText = scoped.read("expectedTeamCount");
  const expectedRosterSizeText = scoped.read("expectedRosterSize");

  const pickRowElements = resolveAll(scope, ESPN_DRAFT_SELECTORS.pickRow, rowLimit);
  const historyContainerResolution = resolveSingle(
    scope,
    ESPN_DRAFT_SELECTORS.pickHistoryContainer,
  );
  if (historyContainerResolution.kind === "ambiguous") {
    unresolvedFamilies.push(ESPN_DRAFT_SELECTORS.pickHistoryContainer.purpose);
  }
  const ownershipRowElements = resolveAll(scope, ESPN_DRAFT_SELECTORS.ownershipRow, rowLimit);
  const teamRowElements = resolveAll(
    scope,
    ESPN_DRAFT_SELECTORS.budgetTeamRow,
    ESPN_LIVE_DRAFT_LIMITS.maximumTeams + 1,
  );
  const auctionResolution = resolveSingle(scope, ESPN_DRAFT_SELECTORS.auctionPanel);
  if (auctionResolution.kind === "ambiguous") {
    unresolvedFamilies.push(ESPN_DRAFT_SELECTORS.auctionPanel.purpose);
  }

  const usedFamilyNames = new Set<EspnDraftSelectorName>(["draftRoot"]);
  const stateSemantic = resolveEspnDraftState(stateAttribute, stateLabel, stateMarker.value);
  if (stateSemantic.selectorName !== null) usedFamilyNames.add(stateSemantic.selectorName);
  const typeSemantic = resolveEspnDraftType(
    draftTypeAttribute,
    draftTypeLabel,
    structuralDraftType,
  );
  if (typeSemantic.selectorName !== null) usedFamilyNames.add(typeSemantic.selectorName);
  const structuralTeamCount =
    teamRowElements.length > 0 && teamRowElements.length <= ESPN_LIVE_DRAFT_LIMITS.maximumTeams
      ? teamRowElements.length
      : null;
  const explicitTeamCountIsUsable = isBoundedSelectorInteger(
    expectedTeamCountText,
    2,
    ESPN_LIVE_DRAFT_LIMITS.maximumTeams,
  );
  if (explicitTeamCountIsUsable) usedFamilyNames.add("expectedTeamCount");
  else if (structuralTeamCount !== null && structuralTeamCount >= 2) {
    usedFamilyNames.add("budgetTeamRow");
  }
  if (expectedRosterSizeText !== null) usedFamilyNames.add("expectedRosterSize");

  if (pickRowElements.length > 0) usedFamilyNames.add("pickRow");
  const completedHistoryObserved = historyContainerResolution.kind === "resolved";
  if (completedHistoryObserved) usedFamilyNames.add("pickHistoryContainer");
  const pickRows = pickRowElements
    .slice(0, ESPN_LIVE_DRAFT_LIMITS.maximumPicks)
    .map((row) => extractPickRow(row, usedFamilyNames));
  if (ownershipRowElements.length > 0) usedFamilyNames.add("ownershipRow");
  const ownershipRows = ownershipRowElements
    .slice(0, ESPN_LIVE_DRAFT_LIMITS.maximumPicks)
    .map((row) => extractOwnershipRow(row, usedFamilyNames));
  if (auctionResolution.kind === "resolved") usedFamilyNames.add("auctionPanel");
  const auction =
    auctionResolution.kind === "resolved"
      ? extractAuctionPanel(auctionResolution.element, scope, usedFamilyNames)
      : null;

  const selectorProfile = typeSemantic.value;
  const activeAuctionSemanticsComplete =
    auction === null ||
    (auction.playerName !== null &&
      (auction.nominationNumber !== null || completedHistoryObserved) &&
      (auction.highBid !== null || auction.currentAmount !== null || auction.highBidLine !== null));
  const selectorSemanticsComplete =
    stateSemantic.value !== null &&
    selectorProfile !== null &&
    (explicitTeamCountIsUsable || (structuralTeamCount !== null && structuralTeamCount >= 2)) &&
    activeAuctionSemanticsComplete;
  const selectorFamiliesUsed = [...usedFamilyNames];
  const usedFamilies = selectorFamiliesUsed.map((name) => ESPN_DRAFT_SELECTORS[name]);
  const selectorsVerified =
    selectorProfile !== null &&
    evaluateEspnDraftSelectorAdmission({
      profileApproved: ESPN_DRAFT_SELECTOR_PROFILES[selectorProfile].approved,
      requiredSemanticsComplete: selectorSemanticsComplete,
      usedFamilies,
    });

  return {
    adapterVersion: ESPN_DRAFT_ADAPTER_VERSION,
    selectorsVerified,
    recognized: true,
    unresolvedFamilies: [
      ...unresolvedFamilies,
      ...document.ambiguousFields,
      ...scoped.ambiguousFields,
    ],
    stateAttribute,
    stateLabel,
    structuralState: stateMarker.value,
    draftTypeAttribute,
    draftTypeLabel,
    structuralDraftType,
    expectedTeamCountText,
    structuralTeamCount,
    expectedRosterSizeText,
    completedHistoryObserved,
    pickRows,
    ownershipRows,
    auction,
    pickRowOverflow: pickRowElements.length > ESPN_LIVE_DRAFT_LIMITS.maximumPicks,
    ownershipRowOverflow: ownershipRowElements.length > ESPN_LIVE_DRAFT_LIMITS.maximumPicks,
    teamRowOverflow: teamRowElements.length > ESPN_LIVE_DRAFT_LIMITS.maximumTeams,
    selectorProfile,
    selectorFamiliesUsed,
    selectorSemanticsComplete,
  };
}
