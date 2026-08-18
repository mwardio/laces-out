/**
 * Local-only ESPN draft-room selector calibration.
 *
 * This module deliberately has no service-worker, storage, or network dependency. It inspects only
 * the fixed selector candidates already checked into `dom-adapter.ts` and emits a closed,
 * size-bounded vocabulary: family names, candidate indexes, cardinalities, and invariant states.
 * It never returns a URL, provider ID, attribute value, text node, markup, cookie, or credential.
 *
 * A calibration report is evidence for a human to review; it is never authorization to upload a
 * board. In particular, this module does not mutate `ESPN_DRAFT_SELECTORS[*].verified` and never
 * bypasses the live content script's stored-pairing preflight.
 */

import {
  ESPN_DRAFT_ADAPTER_VERSION,
  ESPN_DRAFT_LABELS,
  ESPN_DRAFT_ROUTES,
  ESPN_DRAFT_SELECTOR_PROFILES,
  ESPN_DRAFT_SELECTOR_TABLE_VERSION,
  ESPN_DRAFT_SELECTORS,
  extractDraftRoom,
  recognizeEspnDraftRoute,
  type DraftRoomElement,
  type EspnDraftSelectorName,
  type SelectorFamily,
} from "./dom-adapter.js";
import { ESPN_LIVE_DRAFT_LIMITS, type EspnLiveDraftState } from "./dom-contract.js";
import {
  normalizeDraftLabel,
  parseDraftInteger,
  parseEspnAuctionBidLine,
  parseEspnAuctionCurrentAmount,
} from "./observation.js";

export const ESPN_DRAFT_CALIBRATION = {
  /** Mock-room parameters are an explicit allowlist, not a substring test over the URL. */
  mockIdentifierParameters: ["mockDraftId"],
  maximumSampledRows: 3,
  maximumSessionEvidenceSerializedLength: 4_096,
} as const;

export interface EspnDraftCalibrationRoute {
  /** IDs are intentionally discarded; the report needs only this fixed classification. */
  readonly roomKind: "mock" | "paired" | "league-shaped";
}

/**
 * Recognizes a room in which local diagnostics may run.
 *
 * The ordinary recognizer remains authoritative for uploads. This separate recognizer also accepts
 * an explicit `mockDraftId` or a numeric league-shaped room without a season, because ESPN's public
 * mock flow may use either. A lobby, recap, malformed route, or ambiguous ID stays inert.
 */
export function recognizeEspnDraftCalibrationRoute(
  href: string,
  seasonBounds: { readonly minimum: number; readonly maximum: number },
): EspnDraftCalibrationRoute | null {
  const paired = recognizeEspnDraftRoute(href, seasonBounds);
  if (paired !== null) return { roomKind: "paired" };

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== ESPN_DRAFT_ROUTES.host) return null;
  if (!ESPN_DRAFT_ROUTES.pathnames.some((pathname) => pathname === url.pathname)) return null;

  const leagueIdentifiers = ESPN_DRAFT_ROUTES.leagueIdParameters.flatMap((parameter) =>
    url.searchParams.getAll(parameter),
  );
  if (leagueIdentifiers.length > 0) {
    // ESPN currently gives public mock waiting rooms an ephemeral numeric league-shaped ID. The
    // launched room may omit a season, so calibration accepts that exact shape locally while the
    // ordinary upload recognizer continues to reject it. A malformed or duplicate ID stays inert.
    if (
      leagueIdentifiers.length !== 1 ||
      leagueIdentifiers[0] === undefined ||
      !/^\d{1,20}$/u.test(leagueIdentifiers[0])
    ) {
      return null;
    }
    const seasons = ESPN_DRAFT_ROUTES.seasonParameters.flatMap((parameter) =>
      url.searchParams.getAll(parameter),
    );
    if (seasons.length > 1) return null;
    if (seasons.length === 1) {
      const seasonText = seasons[0];
      if (seasonText === undefined || !/^\d{4}$/u.test(seasonText)) return null;
      const season = Number(seasonText);
      if (season < seasonBounds.minimum || season > seasonBounds.maximum) return null;
    }
    return { roomKind: "league-shaped" };
  }

  const identifiers = ESPN_DRAFT_CALIBRATION.mockIdentifierParameters.flatMap((parameter) =>
    url.searchParams.getAll(parameter),
  );
  if (
    identifiers.length !== 1 ||
    identifiers[0] === undefined ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(identifiers[0])
  ) {
    return null;
  }

  const seasons = ESPN_DRAFT_ROUTES.seasonParameters.flatMap((parameter) =>
    url.searchParams.getAll(parameter),
  );
  if (seasons.length > 1) return null;
  if (seasons.length === 1) {
    const seasonText = seasons[0];
    if (seasonText === undefined || !/^\d{4}$/u.test(seasonText)) return null;
    const season = Number(seasonText);
    if (season < seasonBounds.minimum || season > seasonBounds.maximum) return null;
  }
  return { roomKind: "mock" };
}

export type CalibrationResolution =
  | "resolved"
  | "missing"
  | "ambiguous"
  | "inconsistent"
  | "attribute-missing"
  | "query-error"
  | "not-observable";

export type CalibrationCardinality = "none" | "one" | "many" | "mixed" | "not-observable";

export interface EspnSelectorFamilyDiagnostic {
  /** A fixed purpose string from the checked-in selector table. */
  readonly family: string;
  readonly scope: "document" | "room" | "pick-row-sample" | "ownership-row-sample" | "auction";
  readonly resolution: CalibrationResolution;
  /** Index into the checked-in candidate list; selector strings themselves are not exported. */
  readonly candidateIndex: number | null;
  readonly cardinality: CalibrationCardinality;
  /** Capped at ESPN_DRAFT_CALIBRATION.maximumSampledRows. */
  readonly sampledScopes: number;
}

export type CalibrationInvariantStatus = "pass" | "fail" | "inconclusive";

export interface EspnCalibrationInvariantDiagnostic {
  /** Closed vocabulary defined below. */
  readonly invariant:
    | "draft-root-unique"
    | "draft-state-known"
    | "draft-type-known"
    | "salary-cap-mode"
    | "team-count-bounded"
    | "completed-row-parent"
    | "sampled-completed-row-shape"
    | "ownership-row-parent"
    | "sampled-ownership-row-shape"
    | "auction-panel-parent"
    | "active-auction-shape"
    | "auction-high-bid-line-parseable"
    | "auction-current-offer-correlated"
    | "auction-nomination-derivable"
    | "static-selector-approval"
    | "complete-history-visible";
  readonly status: CalibrationInvariantStatus;
}

export interface EspnDraftCalibrationReportV1 {
  readonly schemaVersion: 1;
  readonly kind: "laces-out-espn-draft-dom-calibration";
  readonly adapterVersion: number;
  readonly selectorTableVersion: number;
  readonly routeKind: "mock" | "paired" | "league-shaped";
  readonly draftState: EspnLiveDraftState | "unknown";
  readonly draftType: "auction" | "snake" | "unknown";
  readonly completedRowCount:
    "none" | "one" | "two-to-eight" | "nine-to-thirty-two" | "over-thirty-two";
  readonly ownershipRowCount:
    "none" | "one" | "two-to-eight" | "nine-to-thirty-two" | "over-thirty-two";
  readonly auctionPanelCount: "none" | "one" | "many";
  /**
   * Fixed classification of the visible current-offer and highest-bid surfaces. No amount or team
   * name leaves the page. A current-only frame must be observed before a user-entered bid before it
   * can be treated as opening-state evidence.
   */
  readonly auctionOfferEvidence:
    | "not-observable"
    | "current-only-zero"
    | "current-only-positive"
    | "accepted-correlated"
    | "mismatch-or-unparseable";
  readonly structuralVerification: "pass" | "fail" | "inconclusive";
  /** Calibration is never an upload channel, even after its structural checks pass. */
  readonly liveFeedAdmission: "blocked-local-diagnostic-only";
  readonly families: readonly EspnSelectorFamilyDiagnostic[];
  readonly invariants: readonly EspnCalibrationInvariantDiagnostic[];
}

export interface EspnDraftCalibrationSessionEvidenceV1 {
  readonly schemaVersion: 1;
  readonly kind: "laces-out-espn-draft-calibration-session-evidence";
  readonly adapterVersion: number;
  readonly selectorTableVersion: number;
  readonly routeKind: "mock" | "paired" | "league-shaped";
  /** This accumulator is intentionally discarded on navigation or reload. */
  readonly scope: "single-page-lifetime";
  readonly changedFramesObserved:
    "none" | "one" | "two-to-eight" | "nine-to-sixty-four" | "over-sixty-four";
  readonly statesObserved: {
    readonly waiting: boolean;
    readonly live: boolean;
    readonly paused: boolean;
    readonly complete: boolean;
  };
  readonly auctionEvidenceObserved: {
    readonly salaryCapMode: boolean;
    readonly firstNominationWithoutCompletedRows: boolean;
    readonly laterNominationWithCompletedRows: boolean;
    readonly currentOnlyZero: boolean;
    readonly currentOnlyPositive: boolean;
    readonly acceptedHighestBidLineParseable: boolean;
    readonly acceptedCurrentAmountCorrelated: boolean;
    readonly mismatchOrUnparseable: boolean;
  };
  readonly roomEvidenceObserved: {
    readonly structurallyPassingFrame: boolean;
    readonly historyContainerMounted: boolean;
    readonly budgetRowsConsistentWithBoundedTeamCount: boolean;
    readonly completedSaleRowShape: boolean;
    readonly completedStateHistoryShape: boolean;
    readonly completedRowBucketAdvanced: boolean;
    readonly completedRowBucketRegressed: boolean;
  };
  readonly selectorProblemsObserved: {
    readonly ambiguity: boolean;
    readonly inconsistency: boolean;
    readonly queryError: boolean;
  };
  /**
   * These fixed values prevent a single in-memory aggregate from being mistaken for cross-page or
   * non-virtualization proof.
   */
  readonly continuityLimits: {
    readonly reload: "requires-separate-page-session-report";
    readonly lateJoin: "requires-separate-page-session-report";
    readonly completedRoomReload: "requires-separate-page-session-report";
    readonly nonVirtualizedCompleteHistory: "not-proven-by-single-page-dom-observation";
  };
  readonly liveFeedAdmission: "blocked-local-diagnostic-only";
}

export interface EspnDraftCalibrationSessionAccumulator {
  observe(report: EspnDraftCalibrationReportV1): EspnDraftCalibrationSessionEvidenceV1;
  current(): EspnDraftCalibrationSessionEvidenceV1;
}

interface CandidateInspection {
  readonly resolution: CalibrationResolution;
  readonly candidateIndex: number | null;
  readonly cardinality: CalibrationCardinality;
  readonly elements: readonly DraftRoomElement[];
}

function queryCandidate(
  scope: DraftRoomElement,
  selector: string,
):
  | { readonly state: "ok"; readonly elements: readonly DraftRoomElement[] }
  | { readonly state: "error" } {
  let matches: ArrayLike<DraftRoomElement>;
  try {
    matches = scope.querySelectorAll(selector);
  } catch {
    return { state: "error" };
  }
  const length = typeof matches.length === "number" ? matches.length : 0;
  const elements: DraftRoomElement[] = [];
  const sampleLimit = ESPN_DRAFT_CALIBRATION.maximumSampledRows;
  for (let index = 0; index < length && elements.length < sampleLimit; index += 1) {
    const element = matches[index];
    if (element !== null && typeof element === "object") elements.push(element);
  }
  return { state: "ok", elements };
}

function inspectCandidateFamily(
  scope: DraftRoomElement,
  family: SelectorFamily,
  repeated: boolean,
): CandidateInspection {
  for (let index = 0; index < family.candidates.length; index += 1) {
    const selector = family.candidates[index];
    if (selector === undefined) continue;
    const result = queryCandidate(scope, selector);
    if (result.state === "error") {
      return {
        resolution: "query-error",
        candidateIndex: index,
        cardinality: "not-observable",
        elements: [],
      };
    }
    if (result.elements.length === 0) continue;
    if (!repeated && result.elements.length > 1) {
      return {
        resolution: "ambiguous",
        candidateIndex: index,
        cardinality: "many",
        elements: result.elements,
      };
    }
    let attributeMissing = false;
    if (family.attribute !== null) {
      try {
        attributeMissing = result.elements.some(
          (element) => element.getAttribute(family.attribute!) === null,
        );
      } catch {
        return {
          resolution: "query-error",
          candidateIndex: index,
          cardinality: "not-observable",
          elements: [],
        };
      }
    }
    return {
      resolution: attributeMissing ? "attribute-missing" : "resolved",
      candidateIndex: index,
      cardinality: result.elements.length === 1 ? "one" : "many",
      elements: result.elements,
    };
  }
  return { resolution: "missing", candidateIndex: null, cardinality: "none", elements: [] };
}

function aggregateSampledFamily(
  scopes: readonly DraftRoomElement[],
  family: SelectorFamily,
): CandidateInspection {
  if (scopes.length === 0) {
    return {
      resolution: "not-observable",
      candidateIndex: null,
      cardinality: "not-observable",
      elements: [],
    };
  }
  const inspections = scopes.map((scope) => inspectCandidateFamily(scope, family, false));
  if (inspections.some((entry) => entry.resolution === "query-error")) {
    return {
      resolution: "query-error",
      candidateIndex: null,
      cardinality: "mixed",
      elements: [],
    };
  }
  if (inspections.some((entry) => entry.resolution === "ambiguous")) {
    return {
      resolution: "ambiguous",
      candidateIndex: null,
      cardinality: "mixed",
      elements: [],
    };
  }
  if (inspections.some((entry) => entry.resolution === "attribute-missing")) {
    return {
      resolution: "attribute-missing",
      candidateIndex: null,
      cardinality: "mixed",
      elements: [],
    };
  }
  if (inspections.every((entry) => entry.resolution === "missing")) {
    return { resolution: "missing", candidateIndex: null, cardinality: "none", elements: [] };
  }
  const indexes = new Set(inspections.map((entry) => entry.candidateIndex));
  if (inspections.some((entry) => entry.resolution !== "resolved") || indexes.size !== 1) {
    return {
      resolution: "inconsistent",
      candidateIndex: null,
      cardinality: "mixed",
      elements: [],
    };
  }
  return {
    resolution: "resolved",
    candidateIndex: inspections[0]?.candidateIndex ?? null,
    cardinality: "one",
    elements: [],
  };
}

function publicDiagnostic(
  name: EspnDraftSelectorName,
  scope: EspnSelectorFamilyDiagnostic["scope"],
  inspection: CandidateInspection,
  sampledScopes: number,
): EspnSelectorFamilyDiagnostic {
  return {
    family: ESPN_DRAFT_SELECTORS[name].purpose,
    scope,
    resolution: inspection.resolution,
    candidateIndex: inspection.candidateIndex,
    cardinality: inspection.cardinality,
    sampledScopes: Math.min(sampledScopes, ESPN_DRAFT_CALIBRATION.maximumSampledRows),
  };
}

function unobservableDiagnostic(
  name: EspnDraftSelectorName,
  scope: EspnSelectorFamilyDiagnostic["scope"],
): EspnSelectorFamilyDiagnostic {
  return publicDiagnostic(
    name,
    scope,
    {
      resolution: "not-observable",
      candidateIndex: null,
      cardinality: "not-observable",
      elements: [],
    },
    0,
  );
}

const ROOM_SINGLETON_FAMILIES = [
  "draftState",
  "draftStateLabel",
  "draftWaitingMarker",
  "draftLiveMarker",
  "draftPausedMarker",
  "draftCompleteMarker",
  "draftType",
  "draftTypeLabel",
  "auctionStructure",
  "expectedTeamCount",
  "expectedRosterSize",
  "pickHistoryContainer",
] as const satisfies readonly EspnDraftSelectorName[];

const PICK_FIELD_FAMILIES = [
  "pickSequence",
  "pickSequenceText",
  "pickRound",
  "pickRoundPick",
  "pickKeeper",
  "pickTeamId",
  "pickTeamName",
  "pickPlayerId",
  "pickPlayerName",
  "pickProTeam",
  "pickPosition",
  "pickPrice",
  "pickPriceText",
  "pickNominatingTeamId",
] as const satisfies readonly EspnDraftSelectorName[];

const OWNERSHIP_FIELD_FAMILIES = [
  "ownershipOverallPick",
  "ownershipTeamId",
  "ownershipTeamName",
] as const satisfies readonly EspnDraftSelectorName[];

const AUCTION_FIELD_FAMILIES = [
  "auctionNominationNumber",
  "auctionNominatingTeamId",
  "auctionPlayerId",
  "auctionPlayerName",
  "auctionProTeam",
  "auctionPosition",
  "auctionHighBidTeamId",
  "auctionHighBid",
  "auctionCurrentAmount",
] as const satisfies readonly EspnDraftSelectorName[];

function actualRowCountBucket(
  root: DraftRoomElement,
  family: SelectorFamily,
): EspnDraftCalibrationReportV1["completedRowCount"] {
  for (const selector of family.candidates) {
    let matches: ArrayLike<DraftRoomElement>;
    try {
      matches = root.querySelectorAll(selector);
    } catch {
      return "none";
    }
    const count = typeof matches.length === "number" ? matches.length : 0;
    if (count === 0) continue;
    if (count === 1) return "one";
    if (count <= 8) return "two-to-eight";
    if (count <= 32) return "nine-to-thirty-two";
    return "over-thirty-two";
  }
  return "none";
}

function invariant(
  name: EspnCalibrationInvariantDiagnostic["invariant"],
  status: CalibrationInvariantStatus,
): EspnCalibrationInvariantDiagnostic {
  return { invariant: name, status };
}

function resolutionStatus(
  diagnostic: EspnSelectorFamilyDiagnostic | undefined,
  missingStatus: CalibrationInvariantStatus = "fail",
): CalibrationInvariantStatus {
  if (diagnostic?.resolution === "resolved") return "pass";
  if (diagnostic?.resolution === "missing" || diagnostic?.resolution === "not-observable") {
    return missingStatus;
  }
  return "fail";
}

function knownState(
  value: string | null,
  label: string | null,
  structural: EspnLiveDraftState | null,
): EspnLiveDraftState | "unknown" {
  const attribute = normalizeDraftLabel(value);
  if (attribute !== null) {
    const state = ESPN_DRAFT_LABELS.state[attribute];
    if (state !== undefined) return state;
  }
  const normalizedLabel = normalizeDraftLabel(label);
  if (normalizedLabel !== null) {
    const state = ESPN_DRAFT_LABELS.state[normalizedLabel];
    if (state !== undefined) return state;
  }
  return structural ?? "unknown";
}

function knownDraftType(
  value: string | null,
  label: string | null,
  structural: "auction" | "snake" | null,
): EspnDraftCalibrationReportV1["draftType"] {
  const attribute = normalizeDraftLabel(value);
  if (attribute !== null) {
    const draftType = ESPN_DRAFT_LABELS.draftType[attribute];
    if (draftType !== undefined) return draftType;
  }
  const normalizedLabel = normalizeDraftLabel(label);
  if (normalizedLabel !== null) {
    const draftType = ESPN_DRAFT_LABELS.draftType[normalizedLabel];
    if (draftType !== undefined) return draftType;
  }
  return structural ?? "unknown";
}

/** Builds a sanitized, bounded report. Nothing returned is copied from provider text or a URL. */
export function createEspnDraftCalibrationReport(
  root: DraftRoomElement,
  route: EspnDraftCalibrationRoute,
): EspnDraftCalibrationReportV1 {
  const diagnostics = new Map<EspnDraftSelectorName, EspnSelectorFamilyDiagnostic>();
  const rootInspection = inspectCandidateFamily(root, ESPN_DRAFT_SELECTORS.draftRoot, false);
  diagnostics.set("draftRoot", publicDiagnostic("draftRoot", "document", rootInspection, 1));

  const room = rootInspection.resolution === "resolved" ? rootInspection.elements[0] : undefined;
  let pickInspection: CandidateInspection = {
    resolution: "not-observable",
    candidateIndex: null,
    cardinality: "not-observable",
    elements: [],
  };
  let ownershipInspection = pickInspection;
  let auctionInspection = pickInspection;

  if (room === undefined) {
    for (const name of ROOM_SINGLETON_FAMILIES) {
      diagnostics.set(name, unobservableDiagnostic(name, "room"));
    }
    diagnostics.set("pickRow", unobservableDiagnostic("pickRow", "room"));
    diagnostics.set("ownershipRow", unobservableDiagnostic("ownershipRow", "room"));
    diagnostics.set("budgetTeamRow", unobservableDiagnostic("budgetTeamRow", "room"));
    diagnostics.set("auctionPanel", unobservableDiagnostic("auctionPanel", "room"));
  } else {
    for (const name of ROOM_SINGLETON_FAMILIES) {
      diagnostics.set(
        name,
        publicDiagnostic(
          name,
          "room",
          inspectCandidateFamily(room, ESPN_DRAFT_SELECTORS[name], false),
          1,
        ),
      );
    }
    pickInspection = inspectCandidateFamily(room, ESPN_DRAFT_SELECTORS.pickRow, true);
    ownershipInspection = inspectCandidateFamily(room, ESPN_DRAFT_SELECTORS.ownershipRow, true);
    const budgetTeamInspection = inspectCandidateFamily(
      room,
      ESPN_DRAFT_SELECTORS.budgetTeamRow,
      true,
    );
    auctionInspection = inspectCandidateFamily(room, ESPN_DRAFT_SELECTORS.auctionPanel, false);
    diagnostics.set("pickRow", publicDiagnostic("pickRow", "room", pickInspection, 1));
    diagnostics.set(
      "ownershipRow",
      publicDiagnostic("ownershipRow", "room", ownershipInspection, 1),
    );
    diagnostics.set(
      "budgetTeamRow",
      publicDiagnostic("budgetTeamRow", "room", budgetTeamInspection, 1),
    );
    diagnostics.set("auctionPanel", publicDiagnostic("auctionPanel", "room", auctionInspection, 1));
  }

  for (const name of PICK_FIELD_FAMILIES) {
    const inspection = aggregateSampledFamily(pickInspection.elements, ESPN_DRAFT_SELECTORS[name]);
    diagnostics.set(
      name,
      publicDiagnostic(name, "pick-row-sample", inspection, pickInspection.elements.length),
    );
  }
  for (const name of OWNERSHIP_FIELD_FAMILIES) {
    const inspection = aggregateSampledFamily(
      ownershipInspection.elements,
      ESPN_DRAFT_SELECTORS[name],
    );
    diagnostics.set(
      name,
      publicDiagnostic(
        name,
        "ownership-row-sample",
        inspection,
        ownershipInspection.elements.length,
      ),
    );
  }
  for (const name of AUCTION_FIELD_FAMILIES) {
    const inspection = aggregateSampledFamily(
      auctionInspection.elements,
      ESPN_DRAFT_SELECTORS[name],
    );
    diagnostics.set(
      name,
      publicDiagnostic(name, "auction", inspection, auctionInspection.elements.length),
    );
  }
  const highBidLineInspection =
    room === undefined
      ? {
          resolution: "not-observable" as const,
          candidateIndex: null,
          cardinality: "not-observable" as const,
          elements: [],
        }
      : inspectCandidateFamily(room, ESPN_DRAFT_SELECTORS.auctionHighBidLine, false);
  diagnostics.set(
    "auctionHighBidLine",
    publicDiagnostic("auctionHighBidLine", "auction", highBidLineInspection, room ? 1 : 0),
  );

  // Extraction values are classified into fixed enums or booleans below and never returned.
  const extraction = extractDraftRoom(root);
  const draftState = knownState(
    extraction.stateAttribute,
    extraction.stateLabel,
    extraction.structuralState,
  );
  const draftType = knownDraftType(
    extraction.draftTypeAttribute,
    extraction.draftTypeLabel,
    extraction.structuralDraftType,
  );
  const explicitTeamCount = parseDraftInteger(
    extraction.expectedTeamCountText,
    2,
    ESPN_LIVE_DRAFT_LIMITS.maximumTeams,
  );
  const structuralTeamCount =
    extraction.structuralTeamCount !== null &&
    extraction.structuralTeamCount >= 2 &&
    !extraction.teamRowOverflow
      ? extraction.structuralTeamCount
      : null;
  const teamCountKnown =
    (explicitTeamCount !== null || structuralTeamCount !== null) &&
    !(
      explicitTeamCount !== null &&
      structuralTeamCount !== null &&
      explicitTeamCount !== structuralTeamCount
    );

  const family = (name: EspnDraftSelectorName): EspnSelectorFamilyDiagnostic | undefined =>
    diagnostics.get(name);
  const allResolved = (names: readonly EspnDraftSelectorName[]): boolean =>
    names.every((name) => family(name)?.resolution === "resolved");
  const anyResolved = (names: readonly EspnDraftSelectorName[]): boolean =>
    names.some((name) => family(name)?.resolution === "resolved");

  const completedSequenceResolved = anyResolved(["pickSequence", "pickSequenceText"]);
  const completedPriceResolved = anyResolved(["pickPrice", "pickPriceText"]);
  const completedCoreResolved =
    completedSequenceResolved && allResolved(["pickTeamName", "pickPlayerName"]);
  const completedShape =
    pickInspection.elements.length === 0
      ? "inconclusive"
      : completedCoreResolved && (draftType !== "auction" || completedPriceResolved)
        ? "pass"
        : "fail";
  const ownershipShape =
    ownershipInspection.elements.length === 0
      ? "inconclusive"
      : allResolved(["ownershipOverallPick", "ownershipTeamName"])
        ? "pass"
        : "fail";
  const sampledAuction = extraction.auction;
  const parsedHighBidLine =
    sampledAuction?.highBidLine === null || sampledAuction?.highBidLine === undefined
      ? null
      : parseEspnAuctionBidLine(sampledAuction.highBidLine);
  const parsedCurrentAmount =
    sampledAuction?.currentAmount === null || sampledAuction?.currentAmount === undefined
      ? null
      : parseEspnAuctionCurrentAmount(sampledAuction.currentAmount);
  const highBidLineParseable = parsedHighBidLine !== null;
  const currentOfferCorrelated =
    parsedHighBidLine !== null &&
    parsedCurrentAmount !== null &&
    parsedHighBidLine.amount === parsedCurrentAmount;
  const auctionOfferEvidence: EspnDraftCalibrationReportV1["auctionOfferEvidence"] =
    sampledAuction === null
      ? "not-observable"
      : parsedCurrentAmount === null
        ? "mismatch-or-unparseable"
        : sampledAuction.highBidLine === null
          ? parsedCurrentAmount === 0
            ? "current-only-zero"
            : "current-only-positive"
          : currentOfferCorrelated
            ? "accepted-correlated"
            : "mismatch-or-unparseable";
  const nominationDerivable =
    family("auctionNominationNumber")?.resolution === "resolved" ||
    (family("pickHistoryContainer")?.resolution === "resolved" &&
      (pickInspection.elements.length === 0 || completedShape === "pass"));
  const auctionShape =
    auctionInspection.elements.length === 0
      ? "inconclusive"
      : nominationDerivable &&
          allResolved(["auctionPlayerName", "auctionHighBidLine", "auctionCurrentAmount"]) &&
          highBidLineParseable &&
          currentOfferCorrelated
        ? "pass"
        : "fail";
  const selectorsApproved = ESPN_DRAFT_SELECTOR_PROFILES.auction.approved;

  const invariants: EspnCalibrationInvariantDiagnostic[] = [
    invariant("draft-root-unique", resolutionStatus(family("draftRoot"))),
    invariant("draft-state-known", draftState === "unknown" ? "fail" : "pass"),
    invariant("draft-type-known", draftType === "unknown" ? "fail" : "pass"),
    invariant(
      "salary-cap-mode",
      draftType === "unknown" ? "inconclusive" : draftType === "auction" ? "pass" : "fail",
    ),
    invariant("team-count-bounded", teamCountKnown ? "pass" : "fail"),
    invariant("completed-row-parent", resolutionStatus(family("pickRow"), "inconclusive")),
    invariant("sampled-completed-row-shape", completedShape),
    invariant("ownership-row-parent", resolutionStatus(family("ownershipRow"), "inconclusive")),
    invariant("sampled-ownership-row-shape", ownershipShape),
    invariant("auction-panel-parent", resolutionStatus(family("auctionPanel"), "inconclusive")),
    invariant("active-auction-shape", auctionShape),
    invariant(
      "auction-high-bid-line-parseable",
      auctionInspection.elements.length === 0
        ? "inconclusive"
        : highBidLineParseable
          ? "pass"
          : "fail",
    ),
    invariant(
      "auction-current-offer-correlated",
      auctionInspection.elements.length === 0
        ? "inconclusive"
        : currentOfferCorrelated
          ? "pass"
          : "fail",
    ),
    invariant(
      "auction-nomination-derivable",
      auctionInspection.elements.length === 0
        ? "inconclusive"
        : nominationDerivable
          ? "pass"
          : "fail",
    ),
    invariant("static-selector-approval", selectorsApproved ? "pass" : "fail"),
    // One frame cannot prove that a virtualized list retained rows outside the viewport.
    invariant("complete-history-visible", "inconclusive"),
  ];

  const hardFailure = invariants.some(
    (entry) =>
      entry.status === "fail" &&
      entry.invariant !== "static-selector-approval" &&
      entry.invariant !== "complete-history-visible",
  );
  const runtimeInconclusive = invariants.some(
    (entry) =>
      entry.status === "inconclusive" &&
      entry.invariant !== "complete-history-visible" &&
      entry.invariant !== "sampled-ownership-row-shape" &&
      entry.invariant !== "ownership-row-parent",
  );

  const orderedNames = Object.keys(ESPN_DRAFT_SELECTORS) as EspnDraftSelectorName[];
  const families = orderedNames.map(
    (name) => diagnostics.get(name) ?? unobservableDiagnostic(name, "room"),
  );
  const roomForCounts = room ?? root;

  return {
    schemaVersion: 1,
    kind: "laces-out-espn-draft-dom-calibration",
    adapterVersion: ESPN_DRAFT_ADAPTER_VERSION,
    selectorTableVersion: ESPN_DRAFT_SELECTOR_TABLE_VERSION,
    routeKind: route.roomKind,
    draftState,
    draftType,
    completedRowCount: actualRowCountBucket(roomForCounts, ESPN_DRAFT_SELECTORS.pickRow),
    ownershipRowCount: actualRowCountBucket(roomForCounts, ESPN_DRAFT_SELECTORS.ownershipRow),
    auctionPanelCount:
      auctionInspection.cardinality === "one"
        ? "one"
        : auctionInspection.cardinality === "many"
          ? "many"
          : "none",
    auctionOfferEvidence,
    structuralVerification: hardFailure ? "fail" : runtimeInconclusive ? "inconclusive" : "pass",
    liveFeedAdmission: "blocked-local-diagnostic-only",
    families,
    invariants,
  };
}

/** Compile-time/executable reminder that report values are fixed and bounded. */
export function serializeEspnDraftCalibrationReport(report: EspnDraftCalibrationReportV1): string {
  return JSON.stringify(report);
}

function sessionFrameCountBucket(
  count: number,
): EspnDraftCalibrationSessionEvidenceV1["changedFramesObserved"] {
  if (count <= 0) return "none";
  if (count === 1) return "one";
  if (count <= 8) return "two-to-eight";
  if (count <= 64) return "nine-to-sixty-four";
  return "over-sixty-four";
}

function completedRowBucketRank(report: EspnDraftCalibrationReportV1): number {
  switch (report.completedRowCount) {
    case "none":
      return 0;
    case "one":
      return 1;
    case "two-to-eight":
      return 2;
    case "nine-to-thirty-two":
      return 3;
    case "over-thirty-two":
      return 4;
  }
}

function calibrationInvariantPassed(
  report: EspnDraftCalibrationReportV1,
  invariantName: EspnCalibrationInvariantDiagnostic["invariant"],
): boolean {
  const maximumDiagnostics = 32;
  for (let index = 0; index < report.invariants.length && index < maximumDiagnostics; index += 1) {
    const diagnostic = report.invariants[index];
    if (diagnostic?.invariant === invariantName && diagnostic.status === "pass") return true;
  }
  return false;
}

function calibrationFamilyResolved(
  report: EspnDraftCalibrationReportV1,
  familyName: EspnDraftSelectorName,
): boolean {
  const purpose = ESPN_DRAFT_SELECTORS[familyName].purpose;
  const maximumDiagnostics = Object.keys(ESPN_DRAFT_SELECTORS).length;
  for (let index = 0; index < report.families.length && index < maximumDiagnostics; index += 1) {
    const diagnostic = report.families[index];
    if (diagnostic?.family === purpose && diagnostic.resolution === "resolved") return true;
  }
  return false;
}

/**
 * Accumulates only already-sanitized categories for the lifetime of one loaded page. It has no
 * clock, identifier, storage, or I/O and deliberately cannot claim reload or late-join continuity.
 */
export function createEspnDraftCalibrationSessionAccumulator(
  routeKind: EspnDraftCalibrationRoute["roomKind"],
): EspnDraftCalibrationSessionAccumulator {
  let changedFrameCount = 0;
  let previousCompletedRowBucket: number | null = null;
  const statesObserved = { waiting: false, live: false, paused: false, complete: false };
  const auctionEvidenceObserved = {
    salaryCapMode: false,
    firstNominationWithoutCompletedRows: false,
    laterNominationWithCompletedRows: false,
    currentOnlyZero: false,
    currentOnlyPositive: false,
    acceptedHighestBidLineParseable: false,
    acceptedCurrentAmountCorrelated: false,
    mismatchOrUnparseable: false,
  };
  const roomEvidenceObserved = {
    structurallyPassingFrame: false,
    historyContainerMounted: false,
    budgetRowsConsistentWithBoundedTeamCount: false,
    completedSaleRowShape: false,
    completedStateHistoryShape: false,
    completedRowBucketAdvanced: false,
    completedRowBucketRegressed: false,
  };
  const selectorProblemsObserved = {
    ambiguity: false,
    inconsistency: false,
    queryError: false,
  };

  const snapshot = (): EspnDraftCalibrationSessionEvidenceV1 => ({
    schemaVersion: 1,
    kind: "laces-out-espn-draft-calibration-session-evidence",
    adapterVersion: ESPN_DRAFT_ADAPTER_VERSION,
    selectorTableVersion: ESPN_DRAFT_SELECTOR_TABLE_VERSION,
    routeKind,
    scope: "single-page-lifetime",
    changedFramesObserved: sessionFrameCountBucket(changedFrameCount),
    statesObserved: { ...statesObserved },
    auctionEvidenceObserved: { ...auctionEvidenceObserved },
    roomEvidenceObserved: { ...roomEvidenceObserved },
    selectorProblemsObserved: { ...selectorProblemsObserved },
    continuityLimits: {
      reload: "requires-separate-page-session-report",
      lateJoin: "requires-separate-page-session-report",
      completedRoomReload: "requires-separate-page-session-report",
      nonVirtualizedCompleteHistory: "not-proven-by-single-page-dom-observation",
    },
    liveFeedAdmission: "blocked-local-diagnostic-only",
  });

  return {
    observe(report): EspnDraftCalibrationSessionEvidenceV1 {
      if (
        report.schemaVersion !== 1 ||
        report.kind !== "laces-out-espn-draft-dom-calibration" ||
        report.adapterVersion !== ESPN_DRAFT_ADAPTER_VERSION ||
        report.selectorTableVersion !== ESPN_DRAFT_SELECTOR_TABLE_VERSION ||
        report.routeKind !== routeKind
      ) {
        return snapshot();
      }

      changedFrameCount = Math.min(changedFrameCount + 1, 65);
      if (
        report.draftState === "waiting" ||
        report.draftState === "live" ||
        report.draftState === "paused" ||
        report.draftState === "complete"
      ) {
        statesObserved[report.draftState] = true;
      }

      const salaryCapFrame = report.draftType === "auction";
      const activeAuctionFrame = salaryCapFrame && report.auctionPanelCount === "one";
      auctionEvidenceObserved.salaryCapMode ||= salaryCapFrame;
      if (activeAuctionFrame) {
        const nominationDerivable = calibrationInvariantPassed(
          report,
          "auction-nomination-derivable",
        );
        auctionEvidenceObserved.firstNominationWithoutCompletedRows ||=
          nominationDerivable && report.completedRowCount === "none";
        auctionEvidenceObserved.laterNominationWithCompletedRows ||=
          nominationDerivable && report.completedRowCount !== "none";
        auctionEvidenceObserved.currentOnlyZero ||=
          report.auctionOfferEvidence === "current-only-zero";
        auctionEvidenceObserved.currentOnlyPositive ||=
          report.auctionOfferEvidence === "current-only-positive";
        auctionEvidenceObserved.acceptedHighestBidLineParseable ||= calibrationInvariantPassed(
          report,
          "auction-high-bid-line-parseable",
        );
        auctionEvidenceObserved.acceptedCurrentAmountCorrelated ||=
          report.auctionOfferEvidence === "accepted-correlated" &&
          calibrationInvariantPassed(report, "auction-current-offer-correlated");
        auctionEvidenceObserved.mismatchOrUnparseable ||=
          report.auctionOfferEvidence === "mismatch-or-unparseable";
      }

      const completedSaleRowShape =
        report.completedRowCount !== "none" &&
        calibrationInvariantPassed(report, "completed-row-parent") &&
        calibrationInvariantPassed(report, "sampled-completed-row-shape");
      roomEvidenceObserved.structurallyPassingFrame ||= report.structuralVerification === "pass";
      roomEvidenceObserved.historyContainerMounted ||= calibrationFamilyResolved(
        report,
        "pickHistoryContainer",
      );
      roomEvidenceObserved.budgetRowsConsistentWithBoundedTeamCount ||=
        salaryCapFrame &&
        calibrationFamilyResolved(report, "budgetTeamRow") &&
        calibrationInvariantPassed(report, "team-count-bounded");
      roomEvidenceObserved.completedSaleRowShape ||= completedSaleRowShape;
      roomEvidenceObserved.completedStateHistoryShape ||=
        report.draftState === "complete" && completedSaleRowShape;

      const completedBucket = completedRowBucketRank(report);
      if (previousCompletedRowBucket !== null) {
        roomEvidenceObserved.completedRowBucketAdvanced ||=
          completedBucket > previousCompletedRowBucket;
        roomEvidenceObserved.completedRowBucketRegressed ||=
          completedBucket < previousCompletedRowBucket;
      }
      previousCompletedRowBucket = completedBucket;

      const maximumFamilies = Object.keys(ESPN_DRAFT_SELECTORS).length;
      for (let index = 0; index < report.families.length && index < maximumFamilies; index += 1) {
        const resolution = report.families[index]?.resolution;
        selectorProblemsObserved.ambiguity ||= resolution === "ambiguous";
        selectorProblemsObserved.inconsistency ||= resolution === "inconsistent";
        selectorProblemsObserved.queryError ||= resolution === "query-error";
      }
      return snapshot();
    },
    current: snapshot,
  };
}

export function serializeEspnDraftCalibrationSessionEvidence(
  report: EspnDraftCalibrationSessionEvidenceV1,
): string {
  const routeKind =
    report.routeKind === "paired" || report.routeKind === "league-shaped"
      ? report.routeKind
      : "mock";
  const changedFramesObserved =
    report.changedFramesObserved === "one" ||
    report.changedFramesObserved === "two-to-eight" ||
    report.changedFramesObserved === "nine-to-sixty-four" ||
    report.changedFramesObserved === "over-sixty-four"
      ? report.changedFramesObserved
      : "none";
  const serialized = JSON.stringify({
    schemaVersion: 1,
    kind: "laces-out-espn-draft-calibration-session-evidence",
    adapterVersion: ESPN_DRAFT_ADAPTER_VERSION,
    selectorTableVersion: ESPN_DRAFT_SELECTOR_TABLE_VERSION,
    routeKind,
    scope: "single-page-lifetime",
    changedFramesObserved,
    statesObserved: {
      waiting: report.statesObserved.waiting === true,
      live: report.statesObserved.live === true,
      paused: report.statesObserved.paused === true,
      complete: report.statesObserved.complete === true,
    },
    auctionEvidenceObserved: {
      salaryCapMode: report.auctionEvidenceObserved.salaryCapMode === true,
      firstNominationWithoutCompletedRows:
        report.auctionEvidenceObserved.firstNominationWithoutCompletedRows === true,
      laterNominationWithCompletedRows:
        report.auctionEvidenceObserved.laterNominationWithCompletedRows === true,
      currentOnlyZero: report.auctionEvidenceObserved.currentOnlyZero === true,
      currentOnlyPositive: report.auctionEvidenceObserved.currentOnlyPositive === true,
      acceptedHighestBidLineParseable:
        report.auctionEvidenceObserved.acceptedHighestBidLineParseable === true,
      acceptedCurrentAmountCorrelated:
        report.auctionEvidenceObserved.acceptedCurrentAmountCorrelated === true,
      mismatchOrUnparseable: report.auctionEvidenceObserved.mismatchOrUnparseable === true,
    },
    roomEvidenceObserved: {
      structurallyPassingFrame: report.roomEvidenceObserved.structurallyPassingFrame === true,
      historyContainerMounted: report.roomEvidenceObserved.historyContainerMounted === true,
      budgetRowsConsistentWithBoundedTeamCount:
        report.roomEvidenceObserved.budgetRowsConsistentWithBoundedTeamCount === true,
      completedSaleRowShape: report.roomEvidenceObserved.completedSaleRowShape === true,
      completedStateHistoryShape: report.roomEvidenceObserved.completedStateHistoryShape === true,
      completedRowBucketAdvanced: report.roomEvidenceObserved.completedRowBucketAdvanced === true,
      completedRowBucketRegressed: report.roomEvidenceObserved.completedRowBucketRegressed === true,
    },
    selectorProblemsObserved: {
      ambiguity: report.selectorProblemsObserved.ambiguity === true,
      inconsistency: report.selectorProblemsObserved.inconsistency === true,
      queryError: report.selectorProblemsObserved.queryError === true,
    },
    continuityLimits: {
      reload: "requires-separate-page-session-report",
      lateJoin: "requires-separate-page-session-report",
      completedRoomReload: "requires-separate-page-session-report",
      nonVirtualizedCompleteHistory: "not-proven-by-single-page-dom-observation",
    },
    liveFeedAdmission: "blocked-local-diagnostic-only",
  });
  if (serialized.length > ESPN_DRAFT_CALIBRATION.maximumSessionEvidenceSerializedLength) {
    throw new Error("calibration session evidence exceeded its fixed bound");
  }
  return serialized;
}
