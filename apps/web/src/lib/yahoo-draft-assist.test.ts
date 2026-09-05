import type { YahooDraftFeedStatus } from "@laces-out/contracts";
import { describe, expect, it } from "vitest";

import {
  draftLedgerStateLabel,
  draftRoomStartLabel,
  providerLocksManualDraftEntry,
  shouldRequestYahooDraftRefresh,
  yahooAssistAvailable,
  yahooAssistSelection,
  YAHOO_DRAFT_ASSIST_COPY,
  YAHOO_DRAFT_REFRESH_REQUEST_MS,
} from "./yahoo-draft-assist.js";

const yahooFeed: YahooDraftFeedStatus = {
  provider: "yahoo",
  state: "waiting",
  providerLeagueId: "461.l.12345",
  season: 2026,
  fresh: false,
  ageSeconds: null,
  lastAcceptedAt: null,
  lastMaterialEventAt: null,
  pickCount: 0,
  unresolvedTeams: 0,
  unresolvedPlayers: 0,
  manualBackupActive: false,
  pendingReconciliation: 0,
  standbySources: 0,
  verification: "pending",
  lastIssueCode: null,
  currentAuction: null,
  applicationMode: "append",
  releaseState: "append-beta",
  pollIntervalSeconds: 15,
};

describe("Yahoo draft-assist setup", () => {
  it("is offered only for Yahoo and stays off until explicitly selected", () => {
    expect(yahooAssistAvailable("yahoo", true)).toBe(true);
    expect(yahooAssistAvailable("yahoo", false)).toBe(false);
    expect(yahooAssistAvailable("espn", true)).toBe(false);
    expect(yahooAssistSelection("yahoo", false, true)).toBeUndefined();
    expect(yahooAssistSelection("espn", true, true)).toBeUndefined();
    expect(yahooAssistSelection("yahoo", true, false)).toBeUndefined();
    expect(yahooAssistSelection("yahoo", true, true)).toBe("yahoo");
  });

  it("labels the opt-in and default paths honestly", () => {
    expect(draftRoomStartLabel("yahoo", false, true)).toBe("Start manual room");
    expect(draftRoomStartLabel("yahoo", true, true)).toBe("Start assisted room");
    expect(draftRoomStartLabel("yahoo", true, false)).toBe("Start manual room");
    expect(draftRoomStartLabel("espn", true, true)).toBe("Start manual room");
    expect(YAHOO_DRAFT_ASSIST_COPY.label).toBe("Automatically check Yahoo for picks (beta)");
    expect(YAHOO_DRAFT_ASSIST_COPY.detail).toContain("up to every 15 seconds");
    expect(YAHOO_DRAFT_ASSIST_COPY.detail).toContain("active draft");
    expect(YAHOO_DRAFT_ASSIST_COPY.detail).toContain("format validation");
    expect(YAHOO_DRAFT_ASSIST_COPY.detail).toContain("manual entry remains available");
    expect(YAHOO_DRAFT_ASSIST_COPY.safety).toContain("no keepers or traded picks");
    expect(YAHOO_DRAFT_ASSIST_COPY.safety).toContain("never submits actions to Yahoo");
  });

  it("does not expose the internal live ledger state as a Yahoo product claim", () => {
    expect(draftLedgerStateLabel("yahoo-assisted", "live")).toBe("in progress");
    expect(draftLedgerStateLabel("espn-live", "live")).toBe("live");
    expect(draftLedgerStateLabel("manual", "complete")).toBe("complete");
  });
});

describe("Yahoo draft refresh requests", () => {
  it("uses a modest browser cadence and only targets an attached Yahoo-assisted feed", () => {
    expect(YAHOO_DRAFT_REFRESH_REQUEST_MS).toBe(15_000);
    expect(
      shouldRequestYahooDraftRefresh({
        transport: "yahoo-assisted",
        providerFeed: yahooFeed,
      }),
    ).toBe(true);
    expect(
      shouldRequestYahooDraftRefresh({
        transport: "manual",
        providerFeed: null,
      }),
    ).toBe(false);
    expect(
      shouldRequestYahooDraftRefresh({
        transport: "espn-live",
        providerFeed: { ...yahooFeed, provider: "yahoo" },
      }),
    ).toBe(false);
    expect(
      shouldRequestYahooDraftRefresh({
        transport: "yahoo-assisted",
        providerFeed: { ...yahooFeed, state: "complete" },
      }),
    ).toBe(false);
  });

  it("never lets Yahoo-assisted checks lock manual entry", () => {
    expect(
      providerLocksManualDraftEntry({
        transport: "yahoo-assisted",
        providerFeed: { provider: "yahoo" },
      }),
    ).toBe(false);
    expect(
      providerLocksManualDraftEntry({
        transport: "espn-live",
        providerFeed: { provider: "espn", manualBackupActive: false },
      }),
    ).toBe(true);
    expect(
      providerLocksManualDraftEntry({
        transport: "espn-live",
        providerFeed: { provider: "espn", manualBackupActive: true },
      }),
    ).toBe(false);
  });
});
