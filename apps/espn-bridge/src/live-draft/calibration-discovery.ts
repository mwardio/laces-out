/**
 * Privacy-filtered structural discovery for the local-only ESPN calibration build.
 *
 * This fallback is intentionally much less expressive than a DOM snapshot. It reads no rendered
 * text and exports no attribute value other than class tokens that pass a strict structural-word
 * allowlist. The resulting report is useful for proposing new selector candidates without
 * exposing a league, team, player, account, URL, bid, cookie, or browser-session value.
 */

import type { EspnDraftCalibrationReportV1 } from "./calibration.js";
import {
  ESPN_DRAFT_ADAPTER_VERSION,
  ESPN_DRAFT_SELECTOR_TABLE_VERSION,
  type DraftRoomElement,
} from "./dom-adapter.js";

export const ESPN_DRAFT_STRUCTURAL_DISCOVERY = {
  maximumScannedElements: 2_048,
  maximumSignatures: 18,
  maximumAncestorDepth: 3,
  maximumClassesPerNode: 3,
  maximumAttributesPerNode: 3,
  maximumAttributeNamesInspected: 64,
  maximumClassAttributeLength: 1_024,
  maximumClassTokenLength: 48,
  maximumSerializedLength: 16_000,
} as const;

const SAFE_TAG_NAMES = [
  "a",
  "article",
  "aside",
  "body",
  "button",
  "div",
  "footer",
  "form",
  "header",
  "html",
  "input",
  "label",
  "li",
  "main",
  "nav",
  "ol",
  "option",
  "p",
  "section",
  "select",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "time",
  "tr",
  "ul",
] as const;

type SafeStructuralTag = (typeof SAFE_TAG_NAMES)[number] | "other";

/**
 * Every exported class token must decompose entirely into this fixed vocabulary. This prevents a
 * class such as `draft-alice`, `team-privateleague`, or an opaque build hash from leaking through
 * merely because it also contains a useful draft word.
 */
const SAFE_STRUCTURAL_WORDS = new Set([
  "active",
  "amount",
  "auction",
  "bid",
  "bidding",
  "body",
  "bottom",
  "budget",
  "button",
  "cap",
  "card",
  "cell",
  "clock",
  "closed",
  "complete",
  "container",
  "content",
  "control",
  "cost",
  "current",
  "data",
  "detail",
  "details",
  "display",
  "dollar",
  "draft",
  "drafted",
  "drafting",
  "draftpick",
  "draftroom",
  "footer",
  "form",
  "header",
  "high",
  "history",
  "info",
  "information",
  "item",
  "label",
  "left",
  "list",
  "live",
  "main",
  "message",
  "modal",
  "money",
  "name",
  "nominate",
  "nominated",
  "nomination",
  "nominee",
  "offer",
  "open",
  "opening",
  "overall",
  "owner",
  "ownership",
  "panel",
  "paused",
  "pick",
  "pickrow",
  "player",
  "playerinfo",
  "playername",
  "playerpos",
  "playerteam",
  "position",
  "price",
  "pro",
  "queue",
  "result",
  "right",
  "room",
  "roster",
  "round",
  "row",
  "sale",
  "section",
  "selected",
  "selection",
  "slot",
  "status",
  "table",
  "tables",
  "tab",
  "tbody",
  "td",
  "team",
  "teamname",
  "th",
  "thead",
  "timer",
  "tr",
  "value",
  "view",
  "waiting",
  "winning",
  "wrapper",
  "budgets",
]);

const SAFE_DATA_ATTRIBUTE_WORDS = new Set([
  "amount",
  "auction",
  "bid",
  "budget",
  "cap",
  "clock",
  "count",
  "current",
  "draft",
  "high",
  "history",
  "item",
  "live",
  "name",
  "nomination",
  "nominee",
  "number",
  "overall",
  "owner",
  "ownership",
  "panel",
  "pick",
  "player",
  "position",
  "price",
  "roster",
  "round",
  "row",
  "sale",
  "sequence",
  "slot",
  "state",
  "status",
  "team",
  "timer",
  "type",
  "winning",
]);

const IMPORTANT_DISCOVERY_WORDS = new Set([
  "auction",
  "bid",
  "budget",
  "draft",
  "high",
  "nomination",
  "nominee",
  "pick",
  "player",
  "playerinfo",
  "price",
  "roster",
  "sale",
  "team",
  "winning",
]);

interface StructuralDiscoveryElement extends DraftRoomElement {
  readonly tagName?: string;
  readonly parentElement?: StructuralDiscoveryElement | null;
  getAttributeNames?(): string[];
}

export interface EspnStructuralNodeSignature {
  /** Fixed allowlist; an unknown/custom element is reduced to `other`. */
  readonly tag: SafeStructuralTag;
  /** Sanitized class tokens only; never the unfiltered class attribute. */
  readonly classes: readonly string[];
  /** Allowlisted attribute names only. Attribute values are never read. */
  readonly attributes: readonly string[];
}

export type EspnStructuralCountBucket =
  | "none"
  | "one"
  | "two-to-four"
  | "five-to-sixteen"
  | "seventeen-to-two-hundred-fifty-six"
  | "over-two-hundred-fifty-six";

export interface EspnStructuralPathDiagnostic {
  /** Oldest included ancestor first and the evidence-bearing element last. */
  readonly ancestry: readonly EspnStructuralNodeSignature[];
  readonly occurrences: EspnStructuralCountBucket;
}

export interface EspnDraftStructuralDiscoveryReportV2 {
  readonly schemaVersion: 2;
  readonly kind: "laces-out-espn-draft-structural-discovery";
  readonly adapterVersion: number;
  readonly selectorTableVersion: number;
  readonly trigger: "checked-in-selectors-incomplete";
  readonly scanState: "complete" | "capped" | "query-error";
  readonly scannedElements: EspnStructuralCountBucket;
  readonly evidenceBearingElements: EspnStructuralCountBucket;
  readonly paths: readonly EspnStructuralPathDiagnostic[];
  readonly liveFeedAdmission: "blocked-local-diagnostic-only";
}

interface RankedPath {
  readonly key: string;
  readonly ancestry: readonly EspnStructuralNodeSignature[];
  readonly score: number;
  occurrences: number;
}

function countBucket(count: number): EspnStructuralCountBucket {
  if (count <= 0) return "none";
  if (count === 1) return "one";
  if (count <= 4) return "two-to-four";
  if (count <= 16) return "five-to-sixteen";
  if (count <= 256) return "seventeen-to-two-hundred-fifty-six";
  return "over-two-hundred-fifty-six";
}

function structuralWords(token: string): readonly string[] {
  return token
    .replace(/([a-z])([A-Z])/gu, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1-$2")
    .split(/[_-]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

function hasSuspiciousEntropy(token: string): boolean {
  if (token.length < 16) return false;
  const normalized = token.toLowerCase();
  const frequencies = new Map<string, number>();
  for (const character of normalized) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / normalized.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy > 4.15;
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function importantWordCount(value: string): number {
  return structuralWords(value).filter((word) => IMPORTANT_DISCOVERY_WORDS.has(word)).length;
}

/** Returns a class token only when it is demonstrably structural and non-identifying. */
export function sanitizeStructuralClassToken(token: string): string | null {
  if (
    token.length < 2 ||
    token.length > ESPN_DRAFT_STRUCTURAL_DISCOVERY.maximumClassTokenLength ||
    !/^[A-Za-z][A-Za-z_-]*$/u.test(token) ||
    /\d/u.test(token) ||
    hasSuspiciousEntropy(token)
  ) {
    return null;
  }
  const words = structuralWords(token);
  if (words.length === 0 || words.some((word) => !SAFE_STRUCTURAL_WORDS.has(word))) return null;
  return token;
}

/** Returns an attribute name only. The corresponding value is deliberately never requested. */
export function sanitizeStructuralAttributeName(name: string): string | null {
  const normalized = name.toLowerCase();
  if (normalized === "data-testid") return normalized;
  if (
    normalized.length < 6 ||
    normalized.length > 48 ||
    !/^data-[a-z][a-z-]*$/u.test(normalized) ||
    /\d/u.test(normalized)
  ) {
    return null;
  }
  const words = normalized.slice("data-".length).split("-");
  if (words.some((word) => !SAFE_DATA_ATTRIBUTE_WORDS.has(word))) return null;
  return normalized;
}

function safeTagName(element: StructuralDiscoveryElement): SafeStructuralTag {
  let raw: string | undefined;
  try {
    raw = element.tagName;
  } catch {
    return "other";
  }
  const normalized = typeof raw === "string" ? raw.toLowerCase() : "";
  return (SAFE_TAG_NAMES as readonly string[]).includes(normalized)
    ? (normalized as SafeStructuralTag)
    : "other";
}

function safeClasses(element: StructuralDiscoveryElement): readonly string[] {
  let raw: string | null;
  try {
    raw = element.getAttribute("class");
  } catch {
    return [];
  }
  if (
    raw === null ||
    raw.length === 0 ||
    raw.length > ESPN_DRAFT_STRUCTURAL_DISCOVERY.maximumClassAttributeLength
  ) {
    return [];
  }
  const classes = new Set<string>();
  for (const token of raw.split(/\s+/u)) {
    const safe = sanitizeStructuralClassToken(token);
    if (safe !== null) classes.add(safe);
  }
  return [...classes]
    .sort(
      (left, right) =>
        importantWordCount(right) - importantWordCount(left) || lexicalCompare(left, right),
    )
    .slice(0, ESPN_DRAFT_STRUCTURAL_DISCOVERY.maximumClassesPerNode);
}

function safeAttributeNames(element: StructuralDiscoveryElement): readonly string[] {
  if (typeof element.getAttributeNames !== "function") return [];
  let names: readonly string[];
  try {
    names = element.getAttributeNames();
  } catch {
    return [];
  }
  const attributes = new Set<string>();
  for (
    let index = 0;
    index < Math.min(names.length, ESPN_DRAFT_STRUCTURAL_DISCOVERY.maximumAttributeNamesInspected);
    index += 1
  ) {
    const name = names[index];
    if (typeof name !== "string") continue;
    const safe = sanitizeStructuralAttributeName(name);
    if (safe !== null) attributes.add(safe);
  }
  return [...attributes]
    .sort(
      (left, right) =>
        importantWordCount(right) - importantWordCount(left) || lexicalCompare(left, right),
    )
    .slice(0, ESPN_DRAFT_STRUCTURAL_DISCOVERY.maximumAttributesPerNode);
}

function nodeSignature(element: StructuralDiscoveryElement): EspnStructuralNodeSignature {
  return {
    tag: safeTagName(element),
    classes: safeClasses(element),
    attributes: safeAttributeNames(element),
  };
}

function parentOf(element: StructuralDiscoveryElement): StructuralDiscoveryElement | null {
  try {
    const parent = element.parentElement;
    return parent !== null && typeof parent === "object" ? parent : null;
  } catch {
    return null;
  }
}

function signatureScore(ancestry: readonly EspnStructuralNodeSignature[]): number {
  let score = 0;
  for (let index = 0; index < ancestry.length; index += 1) {
    const node = ancestry[index];
    if (node === undefined) continue;
    const selfWeight = index === ancestry.length - 1 ? 3 : 1;
    score += node.classes.length * selfWeight * 2 + node.attributes.length * selfWeight;
    for (const className of node.classes) {
      const words = structuralWords(className);
      score += words.filter((word) => IMPORTANT_DISCOVERY_WORDS.has(word)).length * selfWeight * 3;
    }
    for (const attribute of node.attributes) {
      score +=
        attribute.split("-").filter((word) => IMPORTANT_DISCOVERY_WORDS.has(word)).length *
        selfWeight *
        2;
    }
  }
  return score;
}

function structuralPath(
  element: StructuralDiscoveryElement,
): readonly EspnStructuralNodeSignature[] {
  const reverse: EspnStructuralNodeSignature[] = [];
  let current: StructuralDiscoveryElement | null = element;
  for (
    let depth = 0;
    current !== null && depth < ESPN_DRAFT_STRUCTURAL_DISCOVERY.maximumAncestorDepth;
    depth += 1
  ) {
    reverse.push(nodeSignature(current));
    current = parentOf(current);
  }
  return reverse.reverse();
}

/**
 * Discovery is an exceptional fallback, not extra collection on every room. A cleanly unresolved
 * family is enough to activate it even if another candidate (usually the room root) matched; this
 * keeps one partial calibration pass useful. Query errors alone are not treated as misses because
 * an exception is not evidence that a selector is absent.
 */
export function shouldCreateEspnStructuralDiscoveryReport(
  report: EspnDraftCalibrationReportV1,
): boolean {
  return (
    report.structuralVerification !== "pass" &&
    report.families.length > 0 &&
    report.families.some((family) =>
      ["missing", "ambiguous", "inconsistent", "attribute-missing"].includes(family.resolution),
    )
  );
}

/**
 * Scans only element structure. The function never reads textContent, HTML, attribute values other
 * than the filtered class list, document location, cookies, storage, or any browser/network API.
 */
export function createEspnDraftStructuralDiscoveryReport(
  root: DraftRoomElement,
): EspnDraftStructuralDiscoveryReportV2 {
  let matches: ArrayLike<DraftRoomElement>;
  try {
    matches = root.querySelectorAll("*");
  } catch {
    return {
      schemaVersion: 2,
      kind: "laces-out-espn-draft-structural-discovery",
      adapterVersion: ESPN_DRAFT_ADAPTER_VERSION,
      selectorTableVersion: ESPN_DRAFT_SELECTOR_TABLE_VERSION,
      trigger: "checked-in-selectors-incomplete",
      scanState: "query-error",
      scannedElements: "none",
      evidenceBearingElements: "none",
      paths: [],
      liveFeedAdmission: "blocked-local-diagnostic-only",
    };
  }

  const available = typeof matches.length === "number" ? matches.length : 0;
  const scanLimit = Math.min(available, ESPN_DRAFT_STRUCTURAL_DISCOVERY.maximumScannedElements);
  const ranked = new Map<string, RankedPath>();
  let evidenceBearingElements = 0;

  for (let index = 0; index < scanLimit; index += 1) {
    const candidate = matches[index];
    if (candidate === null || typeof candidate !== "object") continue;
    const element = candidate as StructuralDiscoveryElement;
    const own = nodeSignature(element);
    if (own.classes.length === 0 && own.attributes.length === 0) continue;
    evidenceBearingElements += 1;
    const ancestry = structuralPath(element);
    const key = JSON.stringify(ancestry);
    const existing = ranked.get(key);
    if (existing !== undefined) {
      existing.occurrences += 1;
      continue;
    }
    ranked.set(key, {
      key,
      ancestry,
      score: signatureScore(ancestry),
      occurrences: 1,
    });
  }

  const rankedPaths = [...ranked.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.occurrences - right.occurrences ||
        lexicalCompare(left.key, right.key),
    )
    .slice(0, ESPN_DRAFT_STRUCTURAL_DISCOVERY.maximumSignatures)
    .map(({ ancestry, occurrences }) => ({ ancestry, occurrences: countBucket(occurrences) }));

  const reportWithoutPaths = {
    schemaVersion: 2,
    kind: "laces-out-espn-draft-structural-discovery",
    adapterVersion: ESPN_DRAFT_ADAPTER_VERSION,
    selectorTableVersion: ESPN_DRAFT_SELECTOR_TABLE_VERSION,
    trigger: "checked-in-selectors-incomplete",
    scanState: available > scanLimit ? "capped" : "complete",
    scannedElements: countBucket(scanLimit),
    evidenceBearingElements: countBucket(evidenceBearingElements),
    liveFeedAdmission: "blocked-local-diagnostic-only",
  } as const;
  const paths: EspnStructuralPathDiagnostic[] = [];
  for (const candidate of rankedPaths) {
    const next = [...paths, candidate];
    if (
      JSON.stringify({ ...reportWithoutPaths, paths: next }).length >
      ESPN_DRAFT_STRUCTURAL_DISCOVERY.maximumSerializedLength
    ) {
      break;
    }
    paths.push(candidate);
  }
  return { ...reportWithoutPaths, paths };
}

export function serializeEspnDraftStructuralDiscoveryReport(
  report: EspnDraftStructuralDiscoveryReportV2,
): string {
  const serialized = JSON.stringify(report);
  if (serialized.length > ESPN_DRAFT_STRUCTURAL_DISCOVERY.maximumSerializedLength) {
    throw new Error("structural discovery report exceeded its fixed size bound");
  }
  return serialized;
}
