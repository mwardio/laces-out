import type { DraftSessionSnapshot, EspnLiveDraftFeedStatus } from "@laces-out/contracts";
import { describe, expect, it } from "vitest";

import {
  describeDraftSetupCapability,
  describeLiveDraft,
  describeLiveDraftIssue,
  describeMobileDecision,
  effectiveFeedAgeSeconds,
  formatFeedAge,
  formatLastAccepted,
  liveDraftEntryState,
  liveDraftFreshness,
  type LiveDraftStatusInput,
} from "./live-draft-status.js";

const NOW = Date.parse("2026-08-24T18:00:00.000Z");
const TEAM_A = "11111111-1111-4111-8111-111111111111";
const TEAM_B = "22222222-2222-4222-8222-222222222222";
const PLAYER_A = "33333333-3333-4333-8333-333333333333";
const PLAYER_B = "44444444-4444-4444-8444-444444444444";

function feed(overrides: Partial<EspnLiveDraftFeedStatus> = {}): EspnLiveDraftFeedStatus {
  return {
    provider: "espn",
    state: "live",
    providerLeagueId: "1234567",
    season: 2026,
    fresh: true,
    ageSeconds: 2,
    lastAcceptedAt: "2026-08-24T17:59:58.000Z",
    lastMaterialEventAt: "2026-08-24T17:59:40.000Z",
    pickCount: 14,
    unresolvedTeams: 0,
    unresolvedPlayers: 0,
    manualBackupActive: false,
    pendingReconciliation: 0,
    standbySources: 0,
    verification: "pending",
    lastIssueCode: null,
    currentAuction: null,
    ...overrides,
  };
}

function snakeSession(overrides: Partial<DraftSessionSnapshot> = {}): DraftSessionSnapshot {
  const rosterSlots = [
    { id: "qb", type: "QB", label: "QB", kind: "STARTER", eligiblePositions: ["QB"] },
    { id: "rb", type: "RB", label: "RB", kind: "STARTER", eligiblePositions: ["RB"] },
    { id: "bn", type: "BENCH", label: "Bench", kind: "BENCH", eligiblePositions: ["QB", "RB"] },
  ] as const;
  return {
    id: "55555555-5555-4555-8555-555555555555",
    leagueSeasonId: "66666666-6666-4666-8666-666666666666",
    transport: "espn-live",
    providerPolling: true,
    accessRole: "owner",
    sequence: 14,
    persistedState: "live",
    config: {
      mode: "SNAKE",
      teams: [
        { id: TEAM_A, name: "Ditka's Revenge", rosterSlots: [...rosterSlots] },
        { id: TEAM_B, name: "Finkle Is Einhorn", rosterSlots: [...rosterSlots] },
      ],
      players: [
        { id: PLAYER_A, name: "Patrick Mahomes", positions: ["QB"] },
        { id: PLAYER_B, name: "Bijan Robinson", positions: ["RB"] },
      ],
      pickOrder: [TEAM_A, TEAM_B, TEAM_B, TEAM_A],
    },
    state: {
      mode: "SNAKE",
      teams: [
        {
          teamId: TEAM_A,
          name: "Ditka's Revenge",
          roster: [
            { playerId: PLAYER_A, eventId: "e1", acquisition: "SNAKE_PICK", overallPick: 1 },
          ],
          openSlots: 2,
        },
        { teamId: TEAM_B, name: "Finkle Is Einhorn", roster: [], openSlots: 3 },
      ],
      draftedPlayerIds: [PLAYER_A],
      activeEventIds: ["e1"],
      revertedEventIds: [],
      nextPick: { overallPick: 15, teamId: TEAM_B },
      activeNomination: null,
      complete: false,
    },
    events: [],
    providerFeed: feed(),
    createdAt: "2026-08-24T17:00:00.000Z",
    updatedAt: "2026-08-24T17:59:58.000Z",
    ...overrides,
  } as DraftSessionSnapshot;
}

function auctionSession(overrides: Partial<DraftSessionSnapshot> = {}): DraftSessionSnapshot {
  const base = snakeSession();
  return {
    ...base,
    config: {
      mode: "AUCTION",
      teams: base.config.teams,
      players: base.config.players,
      minimumBid: 1,
    },
    state: {
      ...base.state,
      mode: "AUCTION",
      teams: [
        {
          teamId: TEAM_A,
          name: "Ditka's Revenge",
          roster: [],
          openSlots: 3,
          spent: 58,
          remainingBudget: 142,
          maximumBid: 140,
        },
        {
          teamId: TEAM_B,
          name: "Finkle Is Einhorn",
          roster: [],
          openSlots: 3,
          remainingBudget: 200,
          maximumBid: 198,
        },
      ],
      nextPick: null,
    },
    ...overrides,
  };
}

function input(overrides: Partial<LiveDraftStatusInput> = {}): LiveDraftStatusInput {
  return {
    session: snakeSession(),
    pollFailures: 0,
    lastSyncedAt: NOW,
    now: NOW,
    streaming: true,
    ...overrides,
  };
}

describe("live draft freshness", () => {
  it("carries the held response forward instead of trusting a frozen server age", () => {
    const held = effectiveFeedAgeSeconds(feed({ ageSeconds: 2 }), NOW - 300_000, NOW);
    expect(held).toBe(302);
    expect(effectiveFeedAgeSeconds(feed({ ageSeconds: 2 }), null, NOW)).toBe(2);
    expect(effectiveFeedAgeSeconds(feed({ ageSeconds: null }), NOW, NOW)).toBeNull();
  });

  it("never reports a negative age when the client clock runs behind", () => {
    expect(effectiveFeedAgeSeconds(feed({ ageSeconds: 4 }), NOW + 5_000, NOW)).toBe(4);
  });

  it("grades freshness against the shared contract thresholds", () => {
    expect(liveDraftFreshness(null)).toBe("missing");
    expect(liveDraftFreshness(9)).toBe("fresh");
    expect(liveDraftFreshness(10)).toBe("fresh");
    expect(liveDraftFreshness(11)).toBe("aging");
    expect(liveDraftFreshness(25)).toBe("aging");
    expect(liveDraftFreshness(26)).toBe("stale");
  });

  it("refuses to call a feed fresh when the server already said it is not", () => {
    expect(liveDraftFreshness(3, false)).toBe("aging");
  });

  it("formats age and last accepted pick in human units", () => {
    expect(formatFeedAge(null)).toBe("no update yet");
    expect(formatFeedAge(3.4)).toBe("updated 3s ago");
    expect(formatFeedAge(125)).toBe("updated 2m ago");
    expect(formatFeedAge(7_200)).toBe("updated 2h ago");
    expect(formatLastAccepted(null, NOW)).toBe("no pick accepted yet");
    expect(formatLastAccepted("not-a-date", NOW)).toBe("last pick time unavailable");
    expect(formatLastAccepted("2026-08-24T17:59:40.000Z", NOW)).toBe("last pick 20s ago");
    expect(formatLastAccepted("2026-08-24T18:00:02.000Z", NOW)).toBe("last pick 0s ago");
  });
});

describe("live draft entry state", () => {
  it("reports a manual room whenever no provider feed is attached", () => {
    const session = snakeSession({
      transport: "manual",
      providerPolling: false,
      providerFeed: null,
    });
    expect(liveDraftEntryState(input({ session }))).toBe("manual");
  });

  it("ignores a stray provider feed on a manual-transport room", () => {
    const session = snakeSession({ transport: "manual", providerFeed: feed() });
    const status = describeLiveDraft(input({ session }));
    expect(status.entryState).toBe("manual");
    expect(status.strip).toBeNull();
  });

  it("is live while a fresh source is supplying picks", () => {
    expect(liveDraftEntryState(input())).toBe("live");
  });

  it("is ready when a fresh source has the room open but the draft has not started", () => {
    const session = snakeSession({ providerFeed: feed({ state: "waiting", pickCount: 0 }) });
    expect(liveDraftEntryState(input({ session }))).toBe("ready");
  });

  it("is waiting when no source is reporting a draft room", () => {
    const session = snakeSession({
      providerFeed: feed({ state: "waiting", pickCount: 0, fresh: false, ageSeconds: null }),
    });
    expect(liveDraftEntryState(input({ session }))).toBe("waiting");
  });

  it("is paused when ESPN paused, and stale once the paused source goes quiet", () => {
    const paused = snakeSession({ providerFeed: feed({ state: "paused" }) });
    expect(liveDraftEntryState(input({ session: paused }))).toBe("paused");
    expect(liveDraftEntryState(input({ session: paused, lastSyncedAt: NOW - 40_000 }))).toBe(
      "stale",
    );
  });

  it("goes stale once a live source misses the fresh window", () => {
    expect(liveDraftEntryState(input({ lastSyncedAt: NOW - 20_000 }))).toBe("stale");
    const flagged = snakeSession({ providerFeed: feed({ fresh: false }) });
    expect(liveDraftEntryState(input({ session: flagged }))).toBe("stale");
    const declared = snakeSession({ providerFeed: feed({ state: "stale" }) });
    expect(liveDraftEntryState(input({ session: declared }))).toBe("stale");
  });

  it("goes stale when this client's own reload loop is failing", () => {
    expect(liveDraftEntryState(input({ pollFailures: 1 }))).toBe("stale");
  });

  it("needs attention for unresolved identities, degraded feeds, and mismatched results", () => {
    for (const override of [
      { unresolvedPlayers: 1 },
      { unresolvedTeams: 2 },
      { state: "degraded" as const },
      { verification: "mismatched" as const },
    ]) {
      const session = snakeSession({ providerFeed: feed(override) });
      expect(liveDraftEntryState(input({ session }))).toBe("attention");
    }
  });

  it("puts attention ahead of completion so a mismatch is not hidden by a finished draft", () => {
    const session = snakeSession({
      providerFeed: feed({ state: "complete", verification: "mismatched" }),
    });
    expect(liveDraftEntryState(input({ session }))).toBe("attention");
  });

  it("reports completion, and completion outranks staleness", () => {
    const session = snakeSession({
      providerFeed: feed({ state: "complete", fresh: false, ageSeconds: 4_000 }),
    });
    expect(liveDraftEntryState(input({ session }))).toBe("complete");
  });

  it("puts manual backup ahead of every provider state", () => {
    const session = snakeSession({
      providerFeed: feed({
        state: "degraded",
        manualBackupActive: true,
        unresolvedPlayers: 3,
        pendingReconciliation: 2,
      }),
    });
    expect(liveDraftEntryState(input({ session, pollFailures: 4 }))).toBe("manual-backup");
  });
});

describe("live draft display copy", () => {
  it("gives every state a distinct honest heading", () => {
    const headings = new Set<string>();
    const cases: readonly LiveDraftStatusInput[] = [
      input({ session: snakeSession({ transport: "manual", providerFeed: null }) }),
      input({ session: snakeSession({ providerFeed: feed({ state: "waiting", pickCount: 0 }) }) }),
      input({
        session: snakeSession({
          providerFeed: feed({ state: "waiting", fresh: false, ageSeconds: null }),
        }),
      }),
      input(),
      input({ session: snakeSession({ providerFeed: feed({ state: "paused" }) }) }),
      input({ pollFailures: 1 }),
      input({ session: snakeSession({ providerFeed: feed({ manualBackupActive: true }) }) }),
      input({ session: snakeSession({ providerFeed: feed({ state: "complete" }) }) }),
      input({ session: snakeSession({ providerFeed: feed({ unresolvedPlayers: 1 }) }) }),
    ];
    for (const candidate of cases) {
      const status = describeLiveDraft(candidate);
      expect(status.heading.length).toBeGreaterThan(0);
      expect(status.detail.length).toBeGreaterThan(0);
      headings.add(status.heading);
    }
    expect([...headings]).toEqual([
      "Manual draft ledger",
      "Ready for ESPN draft",
      "Waiting for an ESPN draft room",
      "Live ESPN Sync",
      "ESPN draft paused",
      "Feed stale",
      "Manual backup active",
      "Draft complete",
      "Live sync needs attention",
    ]);
  });

  it("explains the desktop source requirement only where it changes what to do", () => {
    const waiting = describeLiveDraft(
      input({
        session: snakeSession({ providerFeed: feed({ state: "waiting", ageSeconds: null }) }),
      }),
    );
    expect(waiting.sourceRequirement).toContain("desktop Chrome");
    expect(waiting.sourceRequirement).toContain("do not need");
    expect(describeLiveDraft(input()).sourceRequirement).toBeNull();
    expect(
      describeLiveDraft(
        input({ session: snakeSession({ transport: "manual", providerFeed: null }) }),
      ).sourceRequirement,
    ).toBeNull();
  });

  it("keeps the transport chip and ledger note honest for each room kind", () => {
    const manual = describeLiveDraft(
      input({ session: snakeSession({ transport: "manual", providerFeed: null }) }),
    );
    expect(manual.transportChip).toBe("Shared app ledger · no provider feed attached");
    expect(manual.ledgerNote).toContain("No provider feed writes to this room.");

    const live = describeLiveDraft(input());
    expect(live.transportChip).toBe("ESPN live sync · read-only");
    expect(live.ledgerNote).toContain("never writes anything back to ESPN");

    const mock = describeLiveDraft(input({ localMock: true }));
    expect(mock.transportChip).toBe("Local memory only · nothing sent to a provider");
    expect(mock.ledgerNote).toContain("only in this browser tab");
    expect(mock.indicator).toBe("mock");
  });

  it("maps entry state onto the existing header indicator vocabulary", () => {
    expect(describeLiveDraft(input()).indicator).toBe("ok");
    expect(describeLiveDraft(input({ pollFailures: 2 })).indicator).toBe("stale");
    expect(describeLiveDraft(input({ pollFailures: 2 })).indicatorTitle).toBe("Reconnecting");
    expect(
      describeLiveDraft(
        input({ session: snakeSession({ providerFeed: feed({ unresolvedTeams: 1 }) }) }),
      ).indicator,
    ).toBe("stale");
  });

  it("translates every bounded issue code without naming a player or team", () => {
    const codes = [
      "UNRESOLVED_TEAM",
      "UNRESOLVED_PLAYER",
      "PICK_SEQUENCE_GAP",
      "DUPLICATE_PICK_SEQUENCE",
      "EMPTY_RENDER",
      "PICK_OWNERSHIP_UNKNOWN",
      "DRAFT_TYPE_MISMATCH",
      "TEAM_COUNT_MISMATCH",
      "ROSTER_CAPACITY_EXCEEDED",
      "PRICE_ILLEGAL",
      "REDUCER_INVARIANT",
      "DESTRUCTIVE_PENDING",
      "MANUAL_BACKUP_ACTIVE",
      "STALE_PAGE_REVISION",
      "CHECKSUM_MISMATCH",
      "SESSION_NOT_READY",
    ] as const;
    const sentences = codes.map((code) => describeLiveDraftIssue(code));
    expect(new Set(sentences).size).toBe(codes.length);
    for (const sentence of sentences) {
      expect(sentence.endsWith(".")).toBe(true);
      expect(sentence).not.toMatch(/_/u);
    }
  });

  it("prefers the reported issue code over a generic unresolved count", () => {
    const session = snakeSession({
      providerFeed: feed({ unresolvedPlayers: 1, lastIssueCode: "UNRESOLVED_PLAYER" }),
    });
    const status = describeLiveDraft(input({ session }));
    expect(status.detail).toBe(describeLiveDraftIssue("UNRESOLVED_PLAYER"));
    expect(status.strip?.issueCount).toBe(1);
  });
});

describe("live status strip", () => {
  it("carries every field the plan requires and no source identity", () => {
    const session = snakeSession({
      providerFeed: feed({ standbySources: 2, lastMaterialEventAt: "2026-08-24T17:58:00.000Z" }),
    });
    const strip = describeLiveDraft(input({ session })).strip;
    expect(strip).not.toBeNull();
    expect(strip?.providerName).toBe("ESPN");
    expect(strip?.sourceLabel).toBe("ESPN league 1234567 · 2026");
    expect(strip?.statusLabel).toBe("Live ESPN Sync");
    expect(strip?.freshnessLabel).toBe("updated 2s ago");
    expect(strip?.freshness).toBe("fresh");
    expect(strip?.lastAcceptedLabel).toBe("last pick 2m ago");
    expect(strip?.currentActionCaption).toBe("Pick 15");
    expect(strip?.currentActionLabel).toBe("Finkle Is Einhorn");
    expect(strip?.pickCountLabel).toBe("14 picks");
    expect(strip?.issueLabel).toBeNull();
    expect(strip?.standbyLabel).toBe("2 standby browsers ready to take over");
    expect(strip?.updateChannelLabel).toBe("Live updates streaming");
    expect(JSON.stringify(strip)).not.toMatch(/token|cookie|swid|espn_s2|device/iu);
  });

  it("names the update channel honestly when the stream is not connected", () => {
    expect(describeLiveDraft(input({ streaming: false })).strip?.updateChannelLabel).toBe(
      "Checking for updates every 5 seconds",
    );
  });

  it("overlays the transient auction nomination when ESPN exposes one", () => {
    const session = auctionSession({
      providerFeed: feed({
        currentAuction: {
          nominationNumber: 31,
          nominatingTeamId: TEAM_A,
          playerId: PLAYER_B,
          playerName: "Bijan Robinson",
          proTeam: "ATL",
          position: "RB",
          highBidTeamId: TEAM_B,
          highBid: 44,
          observedAt: "2026-08-24T17:59:58.000Z",
        },
      }),
    });
    const strip = describeLiveDraft(input({ session })).strip;
    expect(strip?.currentActionCaption).toBe("Nomination 31");
    expect(strip?.currentActionLabel).toBe("Bijan Robinson · high bid $44");
  });

  it("says so plainly when a nomination has no bid yet", () => {
    const session = auctionSession({
      providerFeed: feed({
        currentAuction: {
          nominationNumber: 32,
          nominatingTeamId: TEAM_A,
          playerId: null,
          playerName: "Unmatched Rookie",
          proTeam: null,
          position: null,
          highBidTeamId: null,
          highBid: null,
          observedAt: "2026-08-24T17:59:58.000Z",
        },
      }),
    });
    expect(describeLiveDraft(input({ session })).strip?.currentActionLabel).toBe(
      "Unmatched Rookie · no bid yet",
    );
  });

  it("labels post-draft verification only once it means something", () => {
    const pendingLive = describeLiveDraft(input()).strip;
    expect(pendingLive?.verificationLabel).toBeNull();
    const pendingComplete = describeLiveDraft(
      input({ session: snakeSession({ providerFeed: feed({ state: "complete" }) }) }),
    ).strip;
    expect(pendingComplete?.verificationLabel).toBe("Completed ESPN result not published yet");
    const verified = describeLiveDraft(
      input({
        session: snakeSession({
          providerFeed: feed({ state: "complete", verification: "verified" }),
        }),
      }),
    ).strip;
    expect(verified?.verificationLabel).toBe("Matches the completed ESPN result");
  });

  it("gives reconnect guidance only when someone can act on it", () => {
    expect(describeLiveDraft(input()).reconnectGuidance).toBeNull();
    expect(describeLiveDraft(input({ pollFailures: 1 })).reconnectGuidance).toContain(
      "retrying automatically",
    );
    const stale = describeLiveDraft(input({ lastSyncedAt: NOW - 60_000 }));
    expect(stale.reconnectGuidance).toContain("paired desktop Chrome");
  });
});

describe("manual backup controls", () => {
  it("offers nothing to a manual room", () => {
    const status = describeLiveDraft(
      input({ session: snakeSession({ transport: "manual", providerFeed: null }) }),
    );
    expect(status.manualBackup.available).toBe(false);
    expect(status.manualBackup.requiresChoice).toBe(false);
  });

  it("authorizes only owners and commissioners", () => {
    for (const role of ["owner", "commissioner"] as const) {
      const session = snakeSession({ accessRole: role });
      expect(describeLiveDraft(input({ session })).manualBackup.authorized).toBe(true);
    }
    for (const role of ["manager", "viewer"] as const) {
      const session = snakeSession({ accessRole: role });
      const controls = describeLiveDraft(input({ session })).manualBackup;
      expect(controls.authorized).toBe(false);
      expect(controls.available).toBe(true);
    }
  });

  it("counts held provider snapshots and demands an explicit choice to return", () => {
    const session = snakeSession({
      providerFeed: feed({ manualBackupActive: true, pendingReconciliation: 3 }),
    });
    const controls = describeLiveDraft(input({ session })).manualBackup;
    expect(controls.active).toBe(true);
    expect(controls.pendingReconciliation).toBe(3);
    expect(controls.requiresChoice).toBe(true);
    expect(controls.returnLabel).toBe("Review 3 differences");
    expect(controls.choiceSummary).toContain("3 held ESPN updates");
    expect(controls.summary).toContain("still being validated");
  });

  it("returns directly when nothing was held while backup was active", () => {
    const session = snakeSession({ providerFeed: feed({ manualBackupActive: true }) });
    const controls = describeLiveDraft(input({ session })).manualBackup;
    expect(controls.requiresChoice).toBe(false);
    expect(controls.returnLabel).toBe("Return to ESPN sync");
    expect(controls.choiceSummary).toBeNull();
  });
});

describe("mobile decision summary", () => {
  it("exposes the next pick, roster needs, and feed health for a snake room", () => {
    const session = snakeSession();
    const status = describeLiveDraft(input({ session }));
    const mobile = describeMobileDecision(session, TEAM_A, status);
    expect(mobile.headlineCaption).toBe("Pick 15");
    expect(mobile.headline).toBe("Finkle Is Einhorn");
    expect(mobile.needsLabel).toBe("2 open slots · need RB");
    expect(mobile.budgetLabel).toBeNull();
    expect(mobile.feedLabel).toBe("Live ESPN Sync · updated 2s ago");
    expect(mobile.stale).toBe(false);
    expect(mobile.staleLabel).toBeNull();
  });

  it("exposes remaining budget and legal maximum for an auction room", () => {
    const session = auctionSession();
    const status = describeLiveDraft(input({ session }));
    const mobile = describeMobileDecision(session, TEAM_A, status);
    expect(mobile.budgetLabel).toBe("$142 left · $140 legal max");
    expect(mobile.needsLabel).toBe("3 open slots · need QB, RB");
  });

  it("makes a stale feed unmistakable on the phone", () => {
    const session = snakeSession();
    const stale = describeMobileDecision(
      session,
      TEAM_A,
      describeLiveDraft(input({ session, lastSyncedAt: NOW - 90_000 })),
    );
    expect(stale.stale).toBe(true);
    expect(stale.staleLabel).toBe("ESPN feed stale — showing last accepted board");

    const offline = describeMobileDecision(
      session,
      TEAM_A,
      describeLiveDraft(input({ session, pollFailures: 3 })),
    );
    expect(offline.staleLabel).toBe("Not connected — showing last accepted board");
  });

  it("still answers without a selected team", () => {
    const session = snakeSession();
    const mobile = describeMobileDecision(
      session,
      undefined,
      describeLiveDraft(input({ session })),
    );
    expect(mobile.needsLabel).toBe("Select a team for roster needs");
  });

  it("falls back to the room state when there is no provider strip", () => {
    const session = snakeSession({ transport: "manual", providerFeed: null });
    const mobile = describeMobileDecision(session, TEAM_B, describeLiveDraft(input({ session })));
    expect(mobile.headlineCaption).toBe("Pick 15");
    expect(mobile.feedLabel).toBe("Shared ledger · event 14");
  });
});

describe("draft setup capability copy", () => {
  it("names Yahoo's gap without promising anything", () => {
    expect(describeDraftSetupCapability("yahoo")).toContain("not available yet");
    expect(describeDraftSetupCapability(null)).toContain("No live-draft provider feed");
  });

  // Guards the reason the ESPN branch is currently withheld: this function only sees the league's
  // provider, and `providerFeed: null` means both "flag off" and "flag on, no source yet". Until
  // the server reports capability, no provider may be promised live sync here.
  it("promises live sync to nobody while capability is not reported", () => {
    for (const provider of ["espn", "yahoo", "manual", null]) {
      const copy = describeDraftSetupCapability(provider);
      expect(copy).not.toMatch(/live while/u);
      expect(copy).not.toMatch(/paired desktop Chrome/u);
      expect(copy).not.toMatch(/drive this room live/u);
    }
  });
});
