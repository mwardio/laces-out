import { describe, expect, it } from "vitest";

import {
  ESPN_DRAFT_CALIBRATION,
  createEspnDraftCalibrationSessionAccumulator,
  createEspnDraftCalibrationReport,
  recognizeEspnDraftCalibrationRoute,
  serializeEspnDraftCalibrationReport,
  serializeEspnDraftCalibrationSessionEvidence,
  type EspnDraftCalibrationReportV1,
  type EspnDraftCalibrationRoute,
} from "./calibration.js";
import {
  ESPN_CALIBRATION_CONSOLE_MARKER,
  ESPN_CALIBRATION_DISCOVERY_CONSOLE_MARKER,
  ESPN_CALIBRATION_SESSION_CONSOLE_MARKER,
  calibrationBadgeText,
  calibrationConsoleLine,
  calibrationSessionEvidenceConsoleLine,
  runLocalEspnDraftCalibration,
} from "./calibration-content-script.js";
import {
  ESPN_DRAFT_SELECTORS,
  recognizeEspnDraftRoute,
  type DraftRoomElement,
} from "./dom-adapter.js";

interface FakeSpec {
  readonly attributes?: Readonly<Record<string, string>>;
  readonly text?: string;
  readonly matches?: Readonly<Record<string, readonly FakeSpec[]>>;
  readonly throwsOn?: readonly string[];
}

function fake(spec: FakeSpec): DraftRoomElement {
  const node: DraftRoomElement = {
    getAttribute: (name) => spec.attributes?.[name] ?? null,
    textContent: spec.text ?? null,
    querySelector: (selector) => node.querySelectorAll(selector)[0] ?? null,
    querySelectorAll: (selector) => {
      if (spec.throwsOn?.includes(selector)) throw new Error("query blocked");
      return (spec.matches?.[selector] ?? []).map((child) => fake(child));
    },
  };
  return node;
}

function attributeCell(name: keyof typeof ESPN_DRAFT_SELECTORS, value: string): FakeSpec {
  const attribute = ESPN_DRAFT_SELECTORS[name].attribute;
  if (attribute === null) throw new Error(`${name} is not an attribute family`);
  return { attributes: { [attribute]: value } };
}

function textCell(value: string): FakeSpec {
  return { text: value };
}

function salaryCapRoom(): DraftRoomElement {
  const pick: FakeSpec = {
    matches: {
      [ESPN_DRAFT_SELECTORS.pickSequence.candidates[0]]: [attributeCell("pickSequence", "1")],
      [ESPN_DRAFT_SELECTORS.pickTeamName.candidates[0]]: [
        textCell("PRIVATE TEAM NAME SWID={do-not-export}"),
      ],
      [ESPN_DRAFT_SELECTORS.pickPlayerName.candidates[0]]: [
        textCell("<script>PRIVATE PLAYER</script>"),
      ],
      [ESPN_DRAFT_SELECTORS.pickPrice.candidates[0]]: [attributeCell("pickPrice", "$37")],
    },
  };
  const auction: FakeSpec = {
    matches: {
      [ESPN_DRAFT_SELECTORS.auctionNominationNumber.candidates[0]]: [
        attributeCell("auctionNominationNumber", "2"),
      ],
      [ESPN_DRAFT_SELECTORS.auctionPlayerName.candidates[0]]: [
        textCell("PRIVATE NOMINEE espn_s2=do-not-export"),
      ],
      [ESPN_DRAFT_SELECTORS.auctionHighBid.candidates[0]]: [attributeCell("auctionHighBid", "$14")],
      [ESPN_DRAFT_SELECTORS.auctionCurrentAmount.candidates[0]]: [textCell("Current offer: $14")],
    },
  };
  const room: FakeSpec = {
    matches: {
      [ESPN_DRAFT_SELECTORS.draftState.candidates[0]]: [attributeCell("draftState", "live")],
      [ESPN_DRAFT_SELECTORS.draftType.candidates[0]]: [attributeCell("draftType", "salary cap")],
      [ESPN_DRAFT_SELECTORS.expectedTeamCount.candidates[0]]: [
        attributeCell("expectedTeamCount", "12"),
      ],
      [ESPN_DRAFT_SELECTORS.pickRow.candidates[0]]: [pick],
      [ESPN_DRAFT_SELECTORS.auctionPanel.candidates[0]]: [auction],
      [ESPN_DRAFT_SELECTORS.auctionHighBidLine.candidates[0]]: [
        textCell("$14 PRIVATE HIGH BID TEAM"),
      ],
    },
  };
  return fake({ matches: { [ESPN_DRAFT_SELECTORS.draftRoot.candidates[0]]: [room] } });
}

function salaryCapSessionFrame(options: {
  readonly state: "waiting" | "live" | "paused" | "complete";
  readonly completedRows: number;
  readonly currentAmount?: string;
  readonly highBidLine?: string;
}): DraftRoomElement {
  const picks: FakeSpec[] = Array.from({ length: options.completedRows }, (_, index) => ({
    matches: {
      [ESPN_DRAFT_SELECTORS.pickSequence.candidates[0]]: [
        attributeCell("pickSequence", String(index + 1)),
      ],
      [ESPN_DRAFT_SELECTORS.pickTeamName.candidates[0]]: [textCell(`PRIVATE TEAM ${index}`)],
      [ESPN_DRAFT_SELECTORS.pickPlayerName.candidates[0]]: [textCell(`PRIVATE PLAYER ${index}`)],
      [ESPN_DRAFT_SELECTORS.pickPrice.candidates[0]]: [attributeCell("pickPrice", "$37")],
    },
  }));
  const auction: FakeSpec | null =
    options.currentAmount === undefined
      ? null
      : {
          matches: {
            [ESPN_DRAFT_SELECTORS.auctionNominationNumber.candidates[0]]: [
              attributeCell("auctionNominationNumber", String(options.completedRows + 1)),
            ],
            [ESPN_DRAFT_SELECTORS.auctionPlayerName.candidates[0]]: [
              textCell("PRIVATE NOMINEE espn_s2=do-not-export"),
            ],
            [ESPN_DRAFT_SELECTORS.auctionCurrentAmount.candidates[0]]: [
              textCell(options.currentAmount),
            ],
          },
        };
  const roomMatches: Record<string, readonly FakeSpec[]> = {
    [ESPN_DRAFT_SELECTORS.draftState.candidates[0]]: [attributeCell("draftState", options.state)],
    [ESPN_DRAFT_SELECTORS.draftType.candidates[0]]: [attributeCell("draftType", "salary cap")],
    [ESPN_DRAFT_SELECTORS.expectedTeamCount.candidates[0]]: [
      attributeCell("expectedTeamCount", "12"),
    ],
    [ESPN_DRAFT_SELECTORS.budgetTeamRow.candidates[0]]: Array.from({ length: 12 }, () => ({})),
    [ESPN_DRAFT_SELECTORS.pickHistoryContainer.candidates[0]]: [{}],
    [ESPN_DRAFT_SELECTORS.pickRow.candidates[0]]: picks,
  };
  if (auction !== null) {
    roomMatches[ESPN_DRAFT_SELECTORS.auctionPanel.candidates[0]] = [auction];
  }
  if (options.highBidLine !== undefined) {
    roomMatches[ESPN_DRAFT_SELECTORS.auctionHighBidLine.candidates[0]] = [
      textCell(options.highBidLine),
    ];
  }
  return fake({
    matches: {
      [ESPN_DRAFT_SELECTORS.draftRoot.candidates[0]]: [{ matches: roomMatches }],
    },
  });
}

const bounds = { minimum: 2019, maximum: 2100 };
const mockRoute: EspnDraftCalibrationRoute = { roomKind: "mock" };

describe("ESPN local calibration route", () => {
  it("recognizes an explicit mock room without making it a paired live route", () => {
    const href = "https://fantasy.espn.com/football/draft?mockDraftId=abc_123-xyz&seasonId=2026";
    expect(recognizeEspnDraftCalibrationRoute(href, bounds)).toEqual({ roomKind: "mock" });
    expect(recognizeEspnDraftRoute(href, bounds)).toBeNull();
  });

  it("classifies a valid paired room without retaining its league ID", () => {
    expect(
      recognizeEspnDraftCalibrationRoute(
        "https://fantasy.espn.com/football/draft?leagueId=987654321&seasonId=2026",
        bounds,
      ),
    ).toEqual({ roomKind: "paired" });
  });

  it("accepts a numeric league-shaped room without a season for local diagnostics only", () => {
    const href = "https://fantasy.espn.com/football/draft?leagueId=1340300762";
    expect(recognizeEspnDraftCalibrationRoute(href, bounds)).toEqual({
      roomKind: "league-shaped",
    });
    expect(recognizeEspnDraftRoute(href, bounds)).toBeNull();
  });

  it("stays inert in lobbies, recaps, ambiguous URLs, and malformed paired rooms", () => {
    for (const href of [
      "https://fantasy.espn.com/football/mockdraftlobby?seasonId=2026",
      "https://fantasy.espn.com/football/draftrecap?mockDraftId=123&seasonId=2026",
      "https://fantasy.espn.com/football/draft?seasonId=2026",
      "https://fantasy.espn.com/football/draft?mockDraftId=one&mockDraftId=two",
      "https://fantasy.espn.com/football/draft?mockDraftId=one&seasonId=1800",
      "https://fantasy.espn.com/football/draft?leagueId=broken&mockDraftId=one&seasonId=2026",
      "https://fantasy.espn.com/football/draft?leagueId=1&leagueId=2",
      "http://fantasy.espn.com/football/draft?mockDraftId=one&seasonId=2026",
      "https://fantasy.espn.com.evil.example/football/draft?mockDraftId=one&seasonId=2026",
    ]) {
      expect(recognizeEspnDraftCalibrationRoute(href, bounds)).toBeNull();
    }
  });
});

describe("sanitized ESPN selector calibration", () => {
  it("reports structural evidence but keeps live-feed admission blocked", () => {
    const report = createEspnDraftCalibrationReport(salaryCapRoom(), mockRoute);
    expect(report).toMatchObject({
      schemaVersion: 1,
      kind: "laces-out-espn-draft-dom-calibration",
      routeKind: "mock",
      draftState: "live",
      draftType: "auction",
      completedRowCount: "one",
      auctionPanelCount: "one",
      auctionOfferEvidence: "accepted-correlated",
      structuralVerification: "pass",
      liveFeedAdmission: "blocked-local-diagnostic-only",
    });
    expect(report.families).toHaveLength(Object.keys(ESPN_DRAFT_SELECTORS).length);
    expect(report.families.find((entry) => entry.family === "draft-root")).toMatchObject({
      candidateIndex: 0,
      cardinality: "one",
      resolution: "resolved",
    });
    expect(report.invariants).toContainEqual({
      invariant: "static-selector-approval",
      status: "fail",
    });
    expect(report.invariants).toContainEqual({
      invariant: "complete-history-visible",
      status: "inconclusive",
    });
    expect(report.invariants).toContainEqual({
      invariant: "auction-current-offer-correlated",
      status: "pass",
    });
  });

  it("never serializes provider text, markup, IDs, URL material, or credential names", () => {
    const serialized = serializeEspnDraftCalibrationReport(
      createEspnDraftCalibrationReport(salaryCapRoom(), mockRoute),
    ).toLowerCase();
    for (const forbidden of [
      "private team",
      "private player",
      "private nominee",
      "<script",
      "swid",
      "espn_s2",
      "mockdraftid",
      "leagueid",
      "playerid",
      "teamid",
      "authorization",
      "cookie",
      "queryselector",
      "fantasy.espn.com",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized.length).toBeLessThan(20_000);
  });

  it("fails structural verification on ambiguous roots and bounds every sampled scope", () => {
    const rootSelector = ESPN_DRAFT_SELECTORS.draftRoot.candidates[0];
    const report = createEspnDraftCalibrationReport(
      fake({ matches: { [rootSelector]: Array.from({ length: 20 }, () => ({})) } }),
      mockRoute,
    );
    expect(report.structuralVerification).toBe("fail");
    expect(report.families.every((entry) => entry.sampledScopes <= 3)).toBe(true);
    expect(ESPN_DRAFT_CALIBRATION.maximumSampledRows).toBe(3);
  });

  it("reports selector exceptions as a fixed error rather than leaking exception text", () => {
    const selector = ESPN_DRAFT_SELECTORS.draftRoot.candidates[0];
    const report = createEspnDraftCalibrationReport(fake({ throwsOn: [selector] }), mockRoute);
    expect(report.families[0]).toMatchObject({ resolution: "query-error" });
    expect(JSON.stringify(report)).not.toContain("query blocked");
  });
});

describe("bounded in-memory calibration session evidence", () => {
  it("classifies current-only and accepted-offer frames without exporting amounts", () => {
    const zero = createEspnDraftCalibrationReport(
      salaryCapSessionFrame({
        state: "live",
        completedRows: 0,
        currentAmount: "Current offer: $0",
      }),
      mockRoute,
    );
    const positive = createEspnDraftCalibrationReport(
      salaryCapSessionFrame({
        state: "live",
        completedRows: 0,
        currentAmount: "Current offer: $1",
      }),
      mockRoute,
    );
    const accepted = createEspnDraftCalibrationReport(
      salaryCapSessionFrame({
        state: "live",
        completedRows: 0,
        currentAmount: "Current offer: $14",
        highBidLine: "$14 PRIVATE HIGH BID TEAM",
      }),
      mockRoute,
    );
    const mismatch = createEspnDraftCalibrationReport(
      salaryCapSessionFrame({
        state: "live",
        completedRows: 0,
        currentAmount: "Current offer: $15",
        highBidLine: "$14 PRIVATE HIGH BID TEAM",
      }),
      mockRoute,
    );

    expect(zero.auctionOfferEvidence).toBe("current-only-zero");
    expect(positive.auctionOfferEvidence).toBe("current-only-positive");
    expect(accepted.auctionOfferEvidence).toBe("accepted-correlated");
    expect(mismatch.auctionOfferEvidence).toBe("mismatch-or-unparseable");
    for (const report of [zero, positive, accepted, mismatch]) {
      const serialized = serializeEspnDraftCalibrationReport(report);
      expect(serialized).not.toContain("PRIVATE HIGH BID TEAM");
      expect(serialized).not.toContain("$14");
      expect(serialized).not.toContain("$15");
    }
  });

  it("accumulates the required same-page state matrix as fixed booleans", () => {
    const accumulator = createEspnDraftCalibrationSessionAccumulator(mockRoute.roomKind);
    const frames = [
      salaryCapSessionFrame({ state: "waiting", completedRows: 0 }),
      salaryCapSessionFrame({
        state: "live",
        completedRows: 0,
        currentAmount: "Current offer: $1",
      }),
      salaryCapSessionFrame({
        state: "live",
        completedRows: 0,
        currentAmount: "Current offer: $14",
        highBidLine: "$14 PRIVATE FIRST BIDDER",
      }),
      salaryCapSessionFrame({
        state: "live",
        completedRows: 1,
        currentAmount: "Current offer: $3",
        highBidLine: "$3 PRIVATE LATER BIDDER",
      }),
      salaryCapSessionFrame({ state: "paused", completedRows: 1 }),
      salaryCapSessionFrame({ state: "complete", completedRows: 1 }),
    ];
    let evidence = accumulator.current();
    expect(evidence.changedFramesObserved).toBe("none");
    for (const frame of frames) {
      evidence = accumulator.observe(createEspnDraftCalibrationReport(frame, mockRoute));
    }

    expect(evidence.changedFramesObserved).toBe("two-to-eight");
    expect(evidence.statesObserved).toEqual({
      waiting: true,
      live: true,
      paused: true,
      complete: true,
    });
    expect(evidence.auctionEvidenceObserved).toMatchObject({
      salaryCapMode: true,
      firstNominationWithoutCompletedRows: true,
      laterNominationWithCompletedRows: true,
      currentOnlyZero: false,
      currentOnlyPositive: true,
      acceptedHighestBidLineParseable: true,
      acceptedCurrentAmountCorrelated: true,
      mismatchOrUnparseable: false,
    });
    expect(evidence.roomEvidenceObserved).toMatchObject({
      structurallyPassingFrame: true,
      historyContainerMounted: true,
      budgetRowsConsistentWithBoundedTeamCount: true,
      completedSaleRowShape: true,
      completedStateHistoryShape: true,
      completedRowBucketAdvanced: true,
      completedRowBucketRegressed: false,
    });
    expect(evidence.selectorProblemsObserved).toEqual({
      ambiguity: false,
      inconsistency: false,
      queryError: false,
    });
    expect(evidence.continuityLimits).toEqual({
      reload: "requires-separate-page-session-report",
      lateJoin: "requires-separate-page-session-report",
      completedRoomReload: "requires-separate-page-session-report",
      nonVirtualizedCompleteHistory: "not-proven-by-single-page-dom-observation",
    });
  });

  it("does not copy adversarial fields and keeps serialized evidence bounded", () => {
    const accumulator = createEspnDraftCalibrationSessionAccumulator(mockRoute.roomKind);
    const ordinary = createEspnDraftCalibrationReport(salaryCapRoom(), mockRoute);
    const poisoned = {
      ...ordinary,
      draftState: "PRIVATE STATE espn_s2=secret",
      auctionOfferEvidence: "$87 PRIVATE OFFER",
      families: [
        {
          ...ordinary.families[0],
          family: "PRIVATE FAMILY https://fantasy.espn.com/private?leagueId=38172910",
        },
      ],
      invariants: [{ invariant: "PRIVATE INVARIANT", status: "pass" }],
    } as unknown as EspnDraftCalibrationReportV1;
    const evidence = accumulator.observe(poisoned);
    const extraFieldEvidence = {
      ...evidence,
      privateField: "SWID={secret} espn_s2=secret $87 PRIVATE TEAM",
    } as typeof evidence;
    const serialized = serializeEspnDraftCalibrationSessionEvidence(extraFieldEvidence);

    for (const forbidden of [
      "PRIVATE",
      "espn_s2",
      "SWID",
      "$87",
      "38172910",
      "leagueId",
      "fantasy.espn.com",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toContain("\n");
    expect(serialized.length).toBeLessThanOrEqual(
      ESPN_DRAFT_CALIBRATION.maximumSessionEvidenceSerializedLength,
    );
  });

  it("records row-bucket regression as negative continuity evidence", () => {
    const accumulator = createEspnDraftCalibrationSessionAccumulator(mockRoute.roomKind);
    accumulator.observe(
      createEspnDraftCalibrationReport(
        salaryCapSessionFrame({ state: "live", completedRows: 9 }),
        mockRoute,
      ),
    );
    const evidence = accumulator.observe(
      createEspnDraftCalibrationReport(
        salaryCapSessionFrame({ state: "live", completedRows: 1 }),
        mockRoute,
      ),
    );
    expect(evidence.roomEvidenceObserved.completedRowBucketRegressed).toBe(true);
    expect(evidence.continuityLimits.nonVirtualizedCompleteHistory).toBe(
      "not-proven-by-single-page-dom-observation",
    );
  });
});

describe("local calibration browser entry point", () => {
  it("emits locally once per changed safe report and never invokes a bridge", () => {
    const lines: string[] = [];
    const badgeReports: unknown[] = [];
    let removed = false;
    const runner = runLocalEspnDraftCalibration({
      href: "https://fantasy.espn.com/football/draft?mockDraftId=abc&seasonId=2026",
      root: salaryCapRoom(),
      emit: (line) => lines.push(line),
      badge: {
        update: (report) => badgeReports.push(report),
        remove: () => {
          removed = true;
        },
      },
    });
    expect(runner.active).toBe(true);
    runner.refresh();
    expect(lines).toHaveLength(2);
    expect(lines[0]?.startsWith(`${ESPN_CALIBRATION_CONSOLE_MARKER} {`)).toBe(true);
    expect(lines[1]?.startsWith(`${ESPN_CALIBRATION_SESSION_CONSOLE_MARKER} {`)).toBe(true);
    expect(badgeReports).toHaveLength(1);
    runner.stop();
    expect(removed).toBe(true);
  });

  it("emits one accumulated line per changed snapshot and resets with a new page runner", () => {
    let frame = salaryCapSessionFrame({
      state: "live",
      completedRows: 0,
      currentAmount: "Current offer: $1",
    });
    const mutableRoot: DraftRoomElement = {
      getAttribute: (name) => frame.getAttribute(name),
      get textContent() {
        return frame.textContent;
      },
      querySelector: (selector) => frame.querySelector(selector),
      querySelectorAll: (selector) => frame.querySelectorAll(selector),
    };
    const lines: string[] = [];
    const runner = runLocalEspnDraftCalibration({
      href: "https://fantasy.espn.com/football/draft?mockDraftId=abc&seasonId=2026",
      root: mutableRoot,
      emit: (line) => lines.push(line),
      badge: { update: () => undefined, remove: () => undefined },
    });
    runner.refresh();
    expect(
      lines.filter((line) => line.startsWith(ESPN_CALIBRATION_SESSION_CONSOLE_MARKER)),
    ).toHaveLength(1);

    frame = salaryCapSessionFrame({
      state: "live",
      completedRows: 0,
      currentAmount: "Current offer: $14",
      highBidLine: "$14 PRIVATE HIGH BID TEAM",
    });
    runner.refresh();
    runner.refresh();
    const sessionLines = lines.filter((line) =>
      line.startsWith(`${ESPN_CALIBRATION_SESSION_CONSOLE_MARKER} `),
    );
    expect(sessionLines).toHaveLength(2);
    const accumulated = JSON.parse(
      sessionLines.at(-1)?.slice(ESPN_CALIBRATION_SESSION_CONSOLE_MARKER.length + 1) ?? "{}",
    ) as Record<string, unknown>;
    expect(accumulated).toMatchObject({
      changedFramesObserved: "two-to-eight",
      auctionEvidenceObserved: {
        currentOnlyPositive: true,
        acceptedHighestBidLineParseable: true,
        acceptedCurrentAmountCorrelated: true,
      },
    });

    const reloadedLines: string[] = [];
    runLocalEspnDraftCalibration({
      href: "https://fantasy.espn.com/football/draft?mockDraftId=abc&seasonId=2026",
      root: salaryCapSessionFrame({ state: "complete", completedRows: 1 }),
      emit: (line) => reloadedLines.push(line),
      badge: { update: () => undefined, remove: () => undefined },
    });
    const reloadedSessionLine = reloadedLines.find((line) =>
      line.startsWith(`${ESPN_CALIBRATION_SESSION_CONSOLE_MARKER} `),
    );
    expect(
      JSON.parse(
        reloadedSessionLine?.slice(ESPN_CALIBRATION_SESSION_CONSOLE_MARKER.length + 1) ?? "{}",
      ),
    ).toMatchObject({
      changedFramesObserved: "one",
      statesObserved: { waiting: false, live: false, paused: false, complete: true },
      continuityLimits: { reload: "requires-separate-page-session-report" },
    });
  });

  it("is inert off the exact ESPN room routes", () => {
    const lines: string[] = [];
    const runner = runLocalEspnDraftCalibration({
      href: "https://example.com/football/draft?mockDraftId=abc",
      root: salaryCapRoom(),
      emit: (line) => lines.push(line),
      badge: { update: () => undefined, remove: () => undefined },
    });
    expect(runner.active).toBe(false);
    runner.refresh();
    expect(lines).toEqual([]);
  });

  it("adds one bounded structural-discovery line only when every selector misses", () => {
    const lines: string[] = [];
    const runner = runLocalEspnDraftCalibration({
      href: "https://fantasy.espn.com/football/draft?mockDraftId=abc&seasonId=2026",
      root: fake({}),
      emit: (line) => lines.push(line),
      badge: { update: () => undefined, remove: () => undefined },
    });
    expect(runner.active).toBe(true);
    runner.refresh();
    expect(lines).toHaveLength(3);
    expect(lines[0]?.startsWith(`${ESPN_CALIBRATION_CONSOLE_MARKER} {`)).toBe(true);
    expect(lines[1]?.startsWith(`${ESPN_CALIBRATION_SESSION_CONSOLE_MARKER} {`)).toBe(true);
    expect(lines[2]?.startsWith(`${ESPN_CALIBRATION_DISCOVERY_CONSOLE_MARKER} {`)).toBe(true);
    expect(lines.every((line) => !line.includes("\n"))).toBe(true);
  });

  it("uses fixed badge copy and a single serialized console line", () => {
    const report = createEspnDraftCalibrationReport(salaryCapRoom(), mockRoute);
    expect(calibrationBadgeText(report)).toBe(
      "Laces Out: local draft calibration passed; copy the latest safe DevTools reports.",
    );
    expect(calibrationConsoleLine(report).split("\n")).toHaveLength(1);
    const session = createEspnDraftCalibrationSessionAccumulator(mockRoute.roomKind);
    expect(calibrationSessionEvidenceConsoleLine(session.observe(report)).split("\n")).toHaveLength(
      1,
    );
  });

  it("uses fixed fallback badge copy without provider material", () => {
    const report = createEspnDraftCalibrationReport(fake({}), mockRoute);
    expect(calibrationBadgeText(report)).toBe(
      "Laces Out: selectors missed; copy all safe DevTools reports.",
    );
  });
});
