import { describe, expect, it } from "vitest";

import {
  ESPN_DRAFT_STRUCTURAL_DISCOVERY,
  createEspnDraftStructuralDiscoveryReport,
  sanitizeStructuralAttributeName,
  sanitizeStructuralClassToken,
  serializeEspnDraftStructuralDiscoveryReport,
  shouldCreateEspnStructuralDiscoveryReport,
} from "./calibration-discovery.js";
import { createEspnDraftCalibrationReport, type EspnDraftCalibrationRoute } from "./calibration.js";
import { ESPN_DRAFT_SELECTORS, type DraftRoomElement } from "./dom-adapter.js";

interface DiscoveryFake extends DraftRoomElement {
  readonly tagName: string;
  readonly parentElement: DiscoveryFake | null;
  getAttributeNames(): string[];
}

interface DiscoveryFakeOptions {
  readonly tag?: string;
  readonly classes?: string;
  readonly attributeNames?: readonly string[];
  readonly parent?: DiscoveryFake | null;
  readonly descendants?: readonly DiscoveryFake[];
  readonly attributeReads?: string[];
  readonly throwOnAllQuery?: boolean;
}

function discoveryFake(options: DiscoveryFakeOptions = {}): DiscoveryFake {
  const attributeReads = options.attributeReads ?? [];
  return {
    tagName: options.tag ?? "div",
    parentElement: options.parent ?? null,
    get textContent(): string | null {
      throw new Error("private rendered text must never be read");
    },
    getAttribute(name): string | null {
      attributeReads.push(name);
      if (name === "class") return options.classes ?? null;
      throw new Error(`private attribute value requested: ${name}`);
    },
    getAttributeNames: () => [...(options.attributeNames ?? [])],
    querySelector: (selector) => {
      const matches = selector === "*" ? (options.descendants ?? []) : [];
      return matches[0] ?? null;
    },
    querySelectorAll: (selector) => {
      if (selector === "*" && options.throwOnAllQuery === true) {
        throw new Error("private query failure details");
      }
      return selector === "*" ? [...(options.descendants ?? [])] : [];
    },
  };
}

const mockRoute: EspnDraftCalibrationRoute = { roomKind: "mock" };

describe("privacy-safe ESPN structural discovery", () => {
  it("retains only structural class tokens and allowlisted attribute names", () => {
    expect(sanitizeStructuralClassToken("pick__message-information")).toBe(
      "pick__message-information",
    );
    expect(sanitizeStructuralClassToken("playerinfo__playername")).toBe("playerinfo__playername");
    expect(sanitizeStructuralClassToken("Table__TR")).toBe("Table__TR");
    for (const unsafe of [
      "draft-Alice",
      "team-privateleague",
      "css-38172910",
      "jsx-qwertyuiopasdfghjklzxcvbnm",
      "swid",
      "espn_s2",
      "authorization",
      "draft/room",
    ]) {
      expect(sanitizeStructuralClassToken(unsafe)).toBeNull();
    }

    expect(sanitizeStructuralAttributeName("data-testid")).toBe("data-testid");
    expect(sanitizeStructuralAttributeName("DATA-AUCTION-PANEL")).toBe("data-auction-panel");
    for (const unsafe of [
      "id",
      "aria-label",
      "href",
      "value",
      "data-player-id",
      "data-private-team",
      "data-auth-token",
      "data-room-123",
    ]) {
      expect(sanitizeStructuralAttributeName(unsafe)).toBeNull();
    }
  });

  it("never reads or exports text, HTML, URLs, identifiers, attribute values, or secrets", () => {
    const attributeReads: string[] = [];
    const room = discoveryFake({
      tag: "SECTION",
      classes: "draft-room draft-Alice privateLeague swid css-38172910",
      attributeNames: [
        "class",
        "id",
        "aria-label",
        "href",
        "value",
        "data-draft-panel",
        "data-private-team",
        "data-player-id",
        "data-auth-token",
      ],
      attributeReads,
    });
    const panel = discoveryFake({
      tag: "DIV",
      classes:
        "auction-current pick__message-information playerinfo__playername team-Bob secret987",
      attributeNames: [
        "data-testid",
        "data-auction-panel",
        "data-high-bid",
        "onclick",
        "style",
        "title",
      ],
      parent: room,
      attributeReads,
    });
    const root = discoveryFake({
      tag: "HTML",
      descendants: [room, panel],
      attributeReads,
    });

    const serialized = serializeEspnDraftStructuralDiscoveryReport(
      createEspnDraftStructuralDiscoveryReport(root),
    );
    expect(serialized).toContain("draft-room");
    expect(serialized).toContain("auction-current");
    expect(serialized).toContain("pick__message-information");
    expect(serialized).toContain("playerinfo__playername");
    expect(serialized).toContain("data-testid");
    expect(serialized).toContain("data-auction-panel");
    expect(serialized).toContain("data-high-bid");
    expect(attributeReads.every((name) => name === "class")).toBe(true);

    for (const forbidden of [
      "Alice",
      "Bob",
      "privateLeague",
      "private-team",
      "player-id",
      "auth-token",
      "aria-label",
      "onclick",
      "style",
      "title",
      "href",
      "swid",
      "espn_s2",
      "secret987",
      "38172910",
      "https://fantasy.espn.com/private",
      "PRIVATE PLAYER NAME",
      "PRIVATE TEAM NAME",
      "$87",
      "<script",
      "outerhtml",
      "innerhtml",
      "cookie",
      "authorization",
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(serialized).not.toContain("\n");
    expect(serialized.length).toBeLessThanOrEqual(
      ESPN_DRAFT_STRUCTURAL_DISCOVERY.maximumSerializedLength,
    );
  });

  it("caps scans, signatures, classes, attributes, ancestry, counts, and serialized size", () => {
    const parent = discoveryFake({
      tag: "SECTION",
      classes: "draft room panel wrapper",
      attributeNames: ["data-draft-panel", "data-draft-status", "data-draft-type"],
    });
    const descendants = Array.from(
      { length: ESPN_DRAFT_STRUCTURAL_DISCOVERY.maximumScannedElements + 50 },
      () =>
        discoveryFake({
          tag: "DIV",
          classes: "auction current player position price roster team",
          attributeNames: [
            "data-auction-panel",
            "data-current-bid",
            "data-player-position",
            "data-roster-slot",
          ],
          parent,
        }),
    );
    const root = discoveryFake({ descendants });
    const report = createEspnDraftStructuralDiscoveryReport(root);
    const serialized = serializeEspnDraftStructuralDiscoveryReport(report);

    expect(report.scanState).toBe("capped");
    expect(report.scannedElements).toBe("over-two-hundred-fifty-six");
    expect(report.evidenceBearingElements).toBe("over-two-hundred-fifty-six");
    expect(report.paths.length).toBeLessThanOrEqual(
      ESPN_DRAFT_STRUCTURAL_DISCOVERY.maximumSignatures,
    );
    for (const path of report.paths) {
      expect(path.ancestry.length).toBeLessThanOrEqual(
        ESPN_DRAFT_STRUCTURAL_DISCOVERY.maximumAncestorDepth,
      );
      for (const node of path.ancestry) {
        expect(node.classes.length).toBeLessThanOrEqual(
          ESPN_DRAFT_STRUCTURAL_DISCOVERY.maximumClassesPerNode,
        );
        expect(node.attributes.length).toBeLessThanOrEqual(
          ESPN_DRAFT_STRUCTURAL_DISCOVERY.maximumAttributesPerNode,
        );
      }
    }
    expect(serialized.length).toBeLessThanOrEqual(
      ESPN_DRAFT_STRUCTURAL_DISCOVERY.maximumSerializedLength,
    );
  });

  it("returns a fixed query-error report without exception details", () => {
    const report = createEspnDraftStructuralDiscoveryReport(
      discoveryFake({ throwOnAllQuery: true }),
    );
    expect(report).toMatchObject({
      scanState: "query-error",
      scannedElements: "none",
      evidenceBearingElements: "none",
      paths: [],
    });
    expect(JSON.stringify(report)).not.toContain("private query failure");
  });

  it("activates for clean full or partial candidate failure, but not query errors alone", () => {
    const allMissing = createEspnDraftCalibrationReport(discoveryFake(), mockRoute);
    expect(shouldCreateEspnStructuralDiscoveryReport(allMissing)).toBe(true);

    const room = discoveryFake();
    const partialRoot: DraftRoomElement = {
      textContent: null,
      getAttribute: () => null,
      querySelector: () => null,
      querySelectorAll: (selector) =>
        selector === ESPN_DRAFT_SELECTORS.draftRoot.candidates[0] ? [room] : [],
    };
    const partial = createEspnDraftCalibrationReport(partialRoot, mockRoute);
    expect(partial.families.find((family) => family.family === "draft-root")?.resolution).toBe(
      "resolved",
    );
    expect(shouldCreateEspnStructuralDiscoveryReport(partial)).toBe(true);

    const throwingRoot: DraftRoomElement = {
      textContent: null,
      getAttribute: () => null,
      querySelector: () => null,
      querySelectorAll: () => {
        throw new Error("query blocked");
      },
    };
    const queryError = createEspnDraftCalibrationReport(throwingRoot, mockRoute);
    expect(shouldCreateEspnStructuralDiscoveryReport(queryError)).toBe(false);
  });

  it("versions structural reports against the selector table that produced candidate indexes", () => {
    const report = createEspnDraftStructuralDiscoveryReport(discoveryFake());
    expect(report.selectorTableVersion).toBeGreaterThan(0);
    expect(report).toMatchObject({
      schemaVersion: 2,
      trigger: "checked-in-selectors-incomplete",
      liveFeedAdmission: "blocked-local-diagnostic-only",
    });
  });
});
