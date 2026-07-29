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
 * link targets, and only then normalized text. Text matching is a fallback.
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
    candidates: ['[data-testid="draft-room"]', "#draft-room", "[data-draft-room]"],
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
  expectedTeamCount: {
    purpose: "expected-team-count",
    candidates: ["[data-team-count]", '[data-testid="draft-team-count"]'],
    attribute: "data-team-count",
    verified: false,
  },
  expectedRosterSize: {
    purpose: "expected-roster-size",
    candidates: ["[data-roster-size]", '[data-testid="draft-roster-size"]'],
    attribute: "data-roster-size",
    verified: false,
  },

  /**
   * One row per completed pick or completed auction sale. Validation must prove a late join or reload
   * reconstructs every prior row without manual scrolling; if the table is virtualized and only
   * renders visible rows, record that limitation explicitly rather than shipping a partial board.
   */
  pickRow: {
    purpose: "pick-row",
    candidates: ['[data-testid="draft-pick-row"]', "[data-pick-sequence]", ".draft-pick-row"],
    attribute: null,
    verified: false,
  },
  pickSequence: {
    purpose: "pick-sequence",
    candidates: ["[data-overall-pick]", '[data-testid="pick-overall"]'],
    attribute: "data-overall-pick",
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
    candidates: ['[data-testid="pick-team-name"]', ".draft-pick__team-name"],
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
    candidates: ['[data-testid="pick-player-name"]', ".draft-pick__player-name"],
    attribute: null,
    verified: false,
  },
  pickProTeam: {
    purpose: "pick-pro-team",
    candidates: ['[data-testid="pick-pro-team"]', ".draft-pick__pro-team"],
    attribute: null,
    verified: false,
  },
  pickPosition: {
    purpose: "pick-position",
    candidates: ['[data-testid="pick-position"]', ".draft-pick__position"],
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
    candidates: ['[data-testid="auction-nomination"]', "#auction-nomination", ".auction-current"],
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
    candidates: ['[data-testid="nominated-player-name"]', ".auction-current__player-name"],
    attribute: null,
    verified: false,
  },
  auctionProTeam: {
    purpose: "auction-pro-team",
    candidates: ['[data-testid="nominated-pro-team"]', ".auction-current__pro-team"],
    attribute: null,
    verified: false,
  },
  auctionPosition: {
    purpose: "auction-position",
    candidates: ['[data-testid="nominated-position"]', ".auction-current__position"],
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
} as const satisfies Record<string, SelectorFamily>;

export type EspnDraftSelectorName = keyof typeof ESPN_DRAFT_SELECTORS;

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
export const ESPN_DRAFT_ADAPTER_VERSION = 1;

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
  const leagueId = ESPN_DRAFT_ROUTES.leagueIdParameters.reduce<string | null>(
    (found, parameter) => found ?? url.searchParams.get(parameter),
    null,
  );
  if (leagueId === null || !/^\d{1,20}$/u.test(leagueId)) return null;
  const seasonText = ESPN_DRAFT_ROUTES.seasonParameters.reduce<string | null>(
    (found, parameter) => found ?? url.searchParams.get(parameter),
    null,
  );
  if (seasonText === null || !/^\d{4}$/u.test(seasonText)) return null;
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
  readonly draftTypeAttribute: string | null;
  readonly draftTypeLabel: string | null;
  readonly expectedTeamCountText: string | null;
  readonly expectedRosterSizeText: string | null;
  readonly pickRows: readonly RawPickRow[];
  readonly ownershipRows: readonly RawOwnershipRow[];
  readonly auction: RawAuctionPanel | null;
  /** True when the DOM rendered more rows than the bounded contract permits. Fails the snapshot. */
  readonly pickRowOverflow: boolean;
  readonly ownershipRowOverflow: boolean;
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

function extractPickRow(row: DraftRoomElement): RawPickRow {
  const reader = fieldReader(row);
  return {
    sequence: reader.read("pickSequence"),
    round: reader.read("pickRound"),
    roundPick: reader.read("pickRoundPick"),
    keeperLabel: reader.read("pickKeeper"),
    teamId: reader.read("pickTeamId"),
    teamName: reader.read("pickTeamName"),
    playerId: reader.read("pickPlayerId"),
    playerName: reader.read("pickPlayerName"),
    proTeam: reader.read("pickProTeam"),
    position: reader.read("pickPosition"),
    price: reader.read("pickPrice"),
    nominatingTeamId: reader.read("pickNominatingTeamId"),
    ambiguousFields: reader.ambiguousFields,
  };
}

function extractOwnershipRow(row: DraftRoomElement): RawOwnershipRow {
  const reader = fieldReader(row);
  return {
    overallPick: reader.read("ownershipOverallPick"),
    teamId: reader.read("ownershipTeamId"),
    teamName: reader.read("ownershipTeamName"),
    ambiguousFields: reader.ambiguousFields,
  };
}

function extractAuctionPanel(panel: DraftRoomElement): RawAuctionPanel {
  const reader = fieldReader(panel);
  return {
    nominationNumber: reader.read("auctionNominationNumber"),
    nominatingTeamId: reader.read("auctionNominatingTeamId"),
    playerId: reader.read("auctionPlayerId"),
    playerName: reader.read("auctionPlayerName"),
    proTeam: reader.read("auctionProTeam"),
    position: reader.read("auctionPosition"),
    highBidTeamId: reader.read("auctionHighBidTeamId"),
    highBid: reader.read("auctionHighBid"),
    ambiguousFields: reader.ambiguousFields,
  };
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
      draftTypeAttribute: null,
      draftTypeLabel: null,
      expectedTeamCountText: null,
      expectedRosterSizeText: null,
      pickRows: [],
      ownershipRows: [],
      auction: null,
      pickRowOverflow: false,
      ownershipRowOverflow: false,
    };
  }
  const scope = rootResolution.element;
  const scoped = fieldReader(scope);

  const stateAttribute = scoped.read("draftState");
  const stateLabel = scoped.read("draftStateLabel");
  const draftTypeAttribute = scoped.read("draftType");
  const draftTypeLabel = scoped.read("draftTypeLabel");
  const expectedTeamCountText = scoped.read("expectedTeamCount");
  const expectedRosterSizeText = scoped.read("expectedRosterSize");

  const pickRowElements = resolveAll(scope, ESPN_DRAFT_SELECTORS.pickRow, rowLimit);
  const ownershipRowElements = resolveAll(scope, ESPN_DRAFT_SELECTORS.ownershipRow, rowLimit);
  const auctionResolution = resolveSingle(scope, ESPN_DRAFT_SELECTORS.auctionPanel);
  if (auctionResolution.kind === "ambiguous") {
    unresolvedFamilies.push(ESPN_DRAFT_SELECTORS.auctionPanel.purpose);
  }

  const usedFamilies: readonly SelectorFamily[] = [
    ESPN_DRAFT_SELECTORS.draftRoot,
    stateAttribute === null
      ? ESPN_DRAFT_SELECTORS.draftStateLabel
      : ESPN_DRAFT_SELECTORS.draftState,
    draftTypeAttribute === null
      ? ESPN_DRAFT_SELECTORS.draftTypeLabel
      : ESPN_DRAFT_SELECTORS.draftType,
    ESPN_DRAFT_SELECTORS.expectedTeamCount,
    ESPN_DRAFT_SELECTORS.pickRow,
    ESPN_DRAFT_SELECTORS.ownershipRow,
  ];

  return {
    adapterVersion: ESPN_DRAFT_ADAPTER_VERSION,
    selectorsVerified: usedFamilies.every((family) => family.verified),
    recognized: true,
    unresolvedFamilies: [
      ...unresolvedFamilies,
      ...document.ambiguousFields,
      ...scoped.ambiguousFields,
    ],
    stateAttribute,
    stateLabel,
    draftTypeAttribute,
    draftTypeLabel,
    expectedTeamCountText,
    expectedRosterSizeText,
    pickRows: pickRowElements
      .slice(0, ESPN_LIVE_DRAFT_LIMITS.maximumPicks)
      .map((row) => extractPickRow(row)),
    ownershipRows: ownershipRowElements
      .slice(0, ESPN_LIVE_DRAFT_LIMITS.maximumPicks)
      .map((row) => extractOwnershipRow(row)),
    auction:
      auctionResolution.kind === "resolved" ? extractAuctionPanel(auctionResolution.element) : null,
    pickRowOverflow: pickRowElements.length > ESPN_LIVE_DRAFT_LIMITS.maximumPicks,
    ownershipRowOverflow: ownershipRowElements.length > ESPN_LIVE_DRAFT_LIMITS.maximumPicks,
  };
}
