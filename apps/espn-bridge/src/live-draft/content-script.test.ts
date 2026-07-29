import { describe, expect, it } from "vitest";

import type { BridgeLiveDraftRequest, BridgeLiveDraftResponse } from "../protocol.js";
import type { DraftRoomElement } from "./dom-adapter.js";
import { ESPN_DRAFT_SELECTORS } from "./dom-adapter.js";
import { validateEspnLiveDraftObservation } from "./dom-contract.js";
import {
  liveDraftSeasonBounds,
  overlayMessage,
  recognizeDraftRoomHref,
  startLiveDraftSession,
} from "./content-script.js";
import type { EspnLiveDraftSnapshot } from "./observation.js";
import type { LiveDraftMutationSource, LiveDraftTimers } from "./observer.js";
import { createLiveDraftStatusOverlay, type OverlayNode } from "./status-overlay.js";
import { defaultLiveDraftStatus } from "./uplink.js";

/**
 * Minimal invented draft room. Selector keys come from the exported table, so live validation can
 * replace the provisional selectors without touching this fixture.
 */
function draftRoomFixture(
  picks: readonly { sequence: string; player: string }[],
): DraftRoomElement {
  const cell = (attribute: string, value: string): DraftRoomElement =>
    node({ [attribute]: value }, null, {});
  const text = (value: string): DraftRoomElement => node({}, value, {});

  function node(
    attributes: Record<string, string>,
    textContent: string | null,
    matches: Record<string, readonly DraftRoomElement[]>,
  ): DraftRoomElement {
    return {
      getAttribute: (name) => attributes[name] ?? null,
      textContent,
      querySelector: (selector) => matches[selector]?.[0] ?? null,
      querySelectorAll: (selector) => matches[selector] ?? [],
    };
  }

  const rows = picks.map((pick) =>
    node({}, null, {
      [ESPN_DRAFT_SELECTORS.pickSequence.candidates[0]]: [
        cell(ESPN_DRAFT_SELECTORS.pickSequence.attribute, pick.sequence),
      ],
      [ESPN_DRAFT_SELECTORS.pickTeamName.candidates[0]]: [text("Ditka's Revenge")],
      [ESPN_DRAFT_SELECTORS.pickPlayerName.candidates[0]]: [text(pick.player)],
    }),
  );

  const room = node({}, null, {
    [ESPN_DRAFT_SELECTORS.draftState.candidates[0]]: [
      cell(ESPN_DRAFT_SELECTORS.draftState.attribute, "live"),
    ],
    [ESPN_DRAFT_SELECTORS.draftType.candidates[0]]: [
      cell(ESPN_DRAFT_SELECTORS.draftType.attribute, "snake"),
    ],
    [ESPN_DRAFT_SELECTORS.expectedTeamCount.candidates[0]]: [
      cell(ESPN_DRAFT_SELECTORS.expectedTeamCount.attribute, "12"),
    ],
    [ESPN_DRAFT_SELECTORS.pickRow.candidates[0]]: rows,
  });
  return node({}, null, { [ESPN_DRAFT_SELECTORS.draftRoot.candidates[0]]: [room] });
}

const inertTimers: LiveDraftTimers = {
  now: () => 0,
  setTimeout: () => 1,
  clearTimeout: () => undefined,
  setInterval: () => 2,
  clearInterval: () => undefined,
};

const inertMutations: LiveDraftMutationSource = {
  start: () => undefined,
  stop: () => undefined,
};

describe("draft route activation", () => {
  it("recognizes only a real ESPN football draft room", () => {
    expect(
      recognizeDraftRoomHref(
        "https://fantasy.espn.com/football/draft?leagueId=1234567&seasonId=2026",
      ),
    ).toEqual({ leagueId: "1234567", season: 2026 });
    expect(
      recognizeDraftRoomHref("https://fantasy.espn.com/football/league/draftrecap"),
    ).toBeNull();
    expect(recognizeDraftRoomHref("https://laces.mward.io/draft")).toBeNull();
  });

  it("bounds recognized seasons to the wire contract's range", () => {
    expect(liveDraftSeasonBounds).toEqual({ minimum: 2019, maximum: 2100 });
  });
});

// The publish path awaits a real SHA-256 digest, so a microtask turn is not enough.
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("live draft session", () => {
  function session(picks: readonly { sequence: string; player: string }[]) {
    const sent: BridgeLiveDraftRequest[] = [];
    const handle = startLiveDraftSession({
      route: { leagueId: "1234567", season: 2026 },
      root: draftRoomFixture(picks),
      pageSessionId: "3f8a1c62-9b4d-4a2e-8f1b-5c7d9e0a1b23",
      timers: inertTimers,
      mutations: inertMutations,
      now: () => new Date("2026-08-23T18:04:05.000Z"),
      send: (request) => {
        sent.push(request);
        return Promise.resolve<BridgeLiveDraftResponse>({
          ok: true,
          status: defaultLiveDraftStatus,
        });
      },
    });
    return { sent, handle };
  }

  it("sends only a sanitized observation the wire validator accepts", async () => {
    const { sent } = session([{ sequence: "1", player: "Patrick Mahomes" }]);
    await settle();

    expect(sent).toHaveLength(1);
    const message = sent[0];
    expect(message?.type).toBe("LIVE_DRAFT_OBSERVATION");
    if (message?.type !== "LIVE_DRAFT_OBSERVATION") return;
    const observation = validateEspnLiveDraftObservation(message.observation);
    expect(observation).toMatchObject({
      leagueId: "1234567",
      season: 2026,
      pageSessionId: "3f8a1c62-9b4d-4a2e-8f1b-5c7d9e0a1b23",
      revision: 1,
      state: "live",
      draftType: "snake",
    });
    expect(observation.picks[0]?.playerName).toBe("Patrick Mahomes");
  });

  it("never puts raw markup, page text, or credentials on the wire", async () => {
    const { sent } = session([{ sequence: "1", player: "Patrick Mahomes" }]);
    await settle();

    const body = JSON.stringify(sent).toLowerCase();
    for (const forbidden of [
      "<div",
      "<script",
      "textcontent",
      "innerhtml",
      "cookie",
      "swid",
      "espn_s2",
      "authorization",
      "devicetoken",
      "querySelector".toLowerCase(),
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("stops cleanly and removes the overlay", () => {
    const removals: string[] = [];
    const handle = startLiveDraftSession({
      route: { leagueId: "1234567", season: 2026 },
      root: draftRoomFixture([]),
      pageSessionId: "3f8a1c62-9b4d-4a2e-8f1b-5c7d9e0a1b23",
      timers: inertTimers,
      mutations: inertMutations,
      now: () => new Date("2026-08-23T18:04:05.000Z"),
      send: () =>
        Promise.resolve<BridgeLiveDraftResponse>({ ok: true, status: defaultLiveDraftStatus }),
      overlay: {
        show: () => undefined,
        remove: () => removals.push("removed"),
      },
    });
    handle.stop();
    expect(removals).toEqual(["removed"]);
  });

  it("describes the board in fixed language that never quotes the provider page", () => {
    const board = (state: EspnLiveDraftSnapshot["state"], picks: number): EspnLiveDraftSnapshot =>
      ({
        state,
        picks: Array.from({ length: picks }, () => ({ playerName: "Patrick Mahomes" })),
      }) as unknown as EspnLiveDraftSnapshot;
    expect(overlayMessage(board("live", 1))).toBe("Laces Out: live sync following 1 pick.");
    expect(overlayMessage(board("live", 24))).toBe("Laces Out: live sync following 24 picks.");
    expect(overlayMessage(board("paused", 24))).toBe("Laces Out: ESPN draft paused.");
    expect(overlayMessage(board("complete", 24))).toBe(
      "Laces Out: draft complete, results synced.",
    );
    expect(overlayMessage(board("waiting", 0))).not.toContain("Mahomes");
  });
});

describe("status overlay", () => {
  function overlayHarness() {
    const attributes: Record<string, string> = {};
    let removed = false;
    const node: OverlayNode = {
      textContent: null,
      setAttribute: (name, value) => {
        attributes[name] = value;
      },
      remove: () => {
        removed = true;
      },
    };
    let attachCount = 0;
    const overlay = createLiveDraftStatusOverlay({
      attach: () => {
        attachCount += 1;
        return node;
      },
    });
    return {
      overlay,
      node,
      attributes,
      get attachCount() {
        return attachCount;
      },
      get removed() {
        return removed;
      },
    };
  }

  it("attaches once and is announced but never interactive", () => {
    const test = overlayHarness();
    test.overlay.show("observing", "Laces Out: watching");
    test.overlay.show("synced", "Laces Out: live sync following 3 picks.");
    expect(test.attachCount).toBe(1);
    expect(test.node.textContent).toBe("Laces Out: live sync following 3 picks.");
    expect(test.attributes.role).toBe("status");
    // No buttons, no inputs, and no pointer events: it cannot act on ESPN.
    expect(test.attributes.style).toContain("pointer-events:none");
  });

  it("bounds the badge text", () => {
    const test = overlayHarness();
    test.overlay.show("attention", "x".repeat(500));
    expect(test.node.textContent).toHaveLength(120);
  });

  it("is a no-op when there is nowhere to attach", () => {
    const overlay = createLiveDraftStatusOverlay({ attach: () => null });
    expect(() => {
      overlay.show("observing", "nothing to attach to");
      overlay.remove();
    }).not.toThrow();
  });

  it("removes the badge when the session stops", () => {
    const test = overlayHarness();
    test.overlay.show("synced", "Laces Out");
    test.overlay.remove();
    expect(test.removed).toBe(true);
  });
});
