import { describe, expect, it } from "vitest";

import type { BridgeLiveDraftRequest, BridgeLiveDraftResponse } from "../protocol.js";
import type { DraftRoomElement } from "./dom-adapter.js";
import { ESPN_DRAFT_SELECTORS } from "./dom-adapter.js";
import { espnLiveDraftDigestSource, validateEspnLiveDraftObservation } from "./dom-contract.js";
import {
  createLiveDraftPreflightController,
  LIVE_DRAFT_STANDBY_PREFLIGHT_RETRY_MS,
  liveDraftSeasonBounds,
  overlayMessage,
  recognizeDraftRoomHref,
  startLiveDraftSession,
} from "./content-script.js";
import type { EspnLiveDraftSnapshot } from "./observation.js";
import type { LiveDraftMutationSource, LiveDraftTimers } from "./observer.js";
import { createLiveDraftStatusOverlay, type OverlayNode } from "./status-overlay.js";
import { defaultLiveDraftStatus, liveDraftActiveSessionTtlMs } from "./uplink.js";

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

const pairedDraftScope = { leagueId: "1234567", season: 2026 } as const;

describe("draft route activation", () => {
  it("recognizes only a real ESPN football draft room", () => {
    expect(
      recognizeDraftRoomHref(
        "https://fantasy.espn.com/football/draft?leagueId=1234567&seasonId=2026",
      ),
    ).toEqual(pairedDraftScope);
    expect(
      recognizeDraftRoomHref("https://fantasy.espn.com/football/draft?leagueId=1234567"),
    ).toEqual({ leagueId: "1234567" });
    expect(
      recognizeDraftRoomHref("https://fantasy.espn.com/football/league/draftrecap"),
    ).toBeNull();
    expect(recognizeDraftRoomHref("https://laces.mward.io/draft")).toBeNull();
    expect(recognizeDraftRoomHref("https://fantasy.espn.com/football/draft")).toBeNull();
    expect(
      recognizeDraftRoomHref("https://fantasy.espn.com/football/draft?leagueId=1234567&seasonId="),
    ).toBeNull();
  });

  it("bounds recognized seasons to the wire contract's range", () => {
    expect(liveDraftSeasonBounds).toEqual({ minimum: 2019, maximum: 2100 });
    expect(LIVE_DRAFT_STANDBY_PREFLIGHT_RETRY_MS).toBe(liveDraftActiveSessionTtlMs);
  });

  it("keeps one passive standby retry and activates exactly once after source failover", async () => {
    const scheduled: { readonly handler: () => void; readonly delayMs: number }[] = [];
    let sends = 0;
    let activations = 0;
    let sessionStops = 0;
    const standbyStatus = {
      ...defaultLiveDraftStatus,
      scope: "in-scope" as const,
      state: "standby" as const,
    };
    const controller = createLiveDraftPreflightController({
      route: { leagueId: "1234567", season: 2026 },
      pageSessionId: "3f8a1c62-9b4d-4a2e-8f1b-5c7d9e0a1b23",
      timers: {
        setTimeout: (handler, delayMs) => {
          scheduled.splice(0, scheduled.length, { handler, delayMs });
          return 1;
        },
        clearTimeout: () => {
          scheduled.length = 0;
        },
      },
      send: () => {
        sends += 1;
        return Promise.resolve(
          sends === 1
            ? { ok: false, status: standbyStatus, resolvedScope: pairedDraftScope }
            : {
                ok: true,
                status: { ...standbyStatus, state: "observing" as const },
                resolvedScope: pairedDraftScope,
              },
        );
      },
      activate: () => {
        activations += 1;
        return { stop: () => (sessionStops += 1) };
      },
    });

    controller.start();
    controller.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(sends).toBe(1);
    expect(activations).toBe(0);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(LIVE_DRAFT_STANDBY_PREFLIGHT_RETRY_MS);

    const retry = scheduled[0]?.handler;
    scheduled.length = 0;
    retry?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(sends).toBe(2);
    expect(activations).toBe(1);
    expect(controller.active).toBe(true);
    expect(scheduled).toHaveLength(0);

    controller.start();
    expect(sends).toBe(2);
    controller.stop();
    expect(sessionStops).toBe(1);
  });

  it("cancels a standby retry and will not activate after the page leaves", async () => {
    const scheduled: (() => void)[] = [];
    let activations = 0;
    const controller = createLiveDraftPreflightController({
      route: { leagueId: "1234567", season: 2026 },
      pageSessionId: "3f8a1c62-9b4d-4a2e-8f1b-5c7d9e0a1b23",
      timers: {
        setTimeout: (handler) => {
          scheduled.splice(0, scheduled.length, handler);
          return 1;
        },
        clearTimeout: () => {
          scheduled.length = 0;
        },
      },
      send: () =>
        Promise.resolve({
          ok: false,
          resolvedScope: pairedDraftScope,
          status: {
            ...defaultLiveDraftStatus,
            scope: "in-scope" as const,
            state: "standby" as const,
          },
        }),
      activate: () => {
        activations += 1;
        return { stop: () => undefined };
      },
    });
    controller.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduled).toHaveLength(1);
    const retry = scheduled[0];
    controller.stop();
    retry?.();
    await Promise.resolve();
    expect(activations).toBe(0);
  });

  it("activates only from an explicit observing preflight response", async () => {
    let activations = 0;
    const controller = createLiveDraftPreflightController({
      route: { leagueId: "1234567", season: 2026 },
      pageSessionId: "3f8a1c62-9b4d-4a2e-8f1b-5c7d9e0a1b23",
      timers: { setTimeout: () => 1, clearTimeout: () => undefined },
      send: () =>
        Promise.resolve({
          ok: true,
          resolvedScope: pairedDraftScope,
          status: {
            ...defaultLiveDraftStatus,
            scope: "in-scope" as const,
            state: "accepted" as const,
          },
        }),
      activate: () => {
        activations += 1;
        return { stop: () => undefined };
      },
    });
    controller.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(activations).toBe(0);
    expect(controller.active).toBe(false);
  });

  it("uses only the exact scope returned for a seasonless paired preflight", async () => {
    const sent: BridgeLiveDraftRequest[] = [];
    const activated: { readonly leagueId: string; readonly season: number }[] = [];
    const controller = createLiveDraftPreflightController({
      route: { leagueId: "1234567" },
      pageSessionId: "3f8a1c62-9b4d-4a2e-8f1b-5c7d9e0a1b23",
      timers: { setTimeout: () => 1, clearTimeout: () => undefined },
      send: (request) => {
        sent.push(request);
        return Promise.resolve({
          ok: true,
          resolvedScope: pairedDraftScope,
          status: {
            ...defaultLiveDraftStatus,
            scope: "in-scope" as const,
            state: "observing" as const,
          },
        });
      },
      activate: (scope) => {
        activated.push(scope);
        return { stop: () => undefined };
      },
    });

    controller.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([
      {
        type: "GET_LIVE_DRAFT_STATUS",
        leagueId: "1234567",
        pageSessionId: "3f8a1c62-9b4d-4a2e-8f1b-5c7d9e0a1b23",
      },
    ]);
    expect(activated).toEqual([pairedDraftScope]);
    expect(controller.activeScope).toEqual(pairedDraftScope);
  });

  it("stays inert when preflight does not return one matching exact scope", async () => {
    for (const resolvedScope of [null, { leagueId: "1234567", season: 2025 }]) {
      let activations = 0;
      const controller = createLiveDraftPreflightController({
        route: { leagueId: "1234567" },
        pageSessionId: "3f8a1c62-9b4d-4a2e-8f1b-5c7d9e0a1b23",
        timers: { setTimeout: () => 1, clearTimeout: () => undefined },
        send: () =>
          Promise.resolve({
            ok: resolvedScope !== null,
            resolvedScope,
            status: {
              ...defaultLiveDraftStatus,
              scope: resolvedScope === null ? "not-configured" : "in-scope",
              state: "observing" as const,
            },
          }),
        activate: () => {
          activations += 1;
          return { stop: () => undefined };
        },
      });
      controller.start();
      await Promise.resolve();
      await Promise.resolve();
      expect(activations).toBe(resolvedScope === null ? 0 : 1);
    }

    let mismatchedActivations = 0;
    const mismatched = createLiveDraftPreflightController({
      route: pairedDraftScope,
      pageSessionId: "3f8a1c62-9b4d-4a2e-8f1b-5c7d9e0a1b23",
      timers: { setTimeout: () => 1, clearTimeout: () => undefined },
      send: () =>
        Promise.resolve({
          ok: true,
          resolvedScope: { leagueId: "1234567", season: 2025 },
          status: {
            ...defaultLiveDraftStatus,
            scope: "in-scope" as const,
            state: "observing" as const,
          },
        }),
      activate: () => {
        mismatchedActivations += 1;
        return { stop: () => undefined };
      },
    });
    mismatched.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(mismatchedActivations).toBe(0);
  });

  it("fails closed when an old or malformed worker response has no usable resolved scope", async () => {
    const observingStatus = {
      ...defaultLiveDraftStatus,
      scope: "in-scope" as const,
      state: "observing" as const,
    };
    const responses: readonly unknown[] = [
      null,
      { ok: true, status: observingStatus },
      { ok: true, status: null, resolvedScope: pairedDraftScope },
      { ok: true, status: observingStatus, resolvedScope: "not-an-object" },
      { ok: true, status: observingStatus, resolvedScope: {} },
    ];

    for (const response of responses) {
      let activations = 0;
      const controller = createLiveDraftPreflightController({
        route: { leagueId: "1234567" },
        pageSessionId: "3f8a1c62-9b4d-4a2e-8f1b-5c7d9e0a1b23",
        timers: { setTimeout: () => 1, clearTimeout: () => undefined },
        send: () => Promise.resolve(response as BridgeLiveDraftResponse),
        activate: () => {
          activations += 1;
          return { stop: () => undefined };
        },
      });
      controller.start();
      await Promise.resolve();
      await Promise.resolve();
      expect(activations).toBe(0);
      expect(controller.activeScope).toBeNull();
    }
  });
});

// The publish path awaits a real SHA-256 digest. Poll for its observable result so this test does
// not depend on one event-loop turn being long enough under a busy full-suite run.
async function settle(sent: readonly BridgeLiveDraftRequest[]): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (sent.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("live draft session", () => {
  function session(picks: readonly { sequence: string; player: string }[]) {
    const sent: BridgeLiveDraftRequest[] = [];
    const sanitizedPicks = picks.map((pick) => ({
      sequence: Number(pick.sequence),
      round: 1,
      roundPick: Number(pick.sequence),
      keeper: false,
      providerTeamId: "1",
      teamName: "Ditka's Revenge",
      providerPlayerId: "3139477",
      playerName: pick.player,
      proTeam: "KC",
      position: "QB",
      price: null,
      nominatingProviderTeamId: null,
    }));
    const board = {
      leagueId: "1234567",
      season: 2026,
      state: "live",
      draftType: "snake",
      expectedTeamCount: 12,
      expectedRosterSize: 16,
      pickOwnership: [],
      picks: sanitizedPicks,
    } as const;
    const scanned: EspnLiveDraftSnapshot = {
      ...board,
      currentAuction: null,
      completeness: {
        contiguousThrough: sanitizedPicks.length,
        duplicateSequences: 0,
        unresolvedRows: 0,
      },
      digestSource: espnLiveDraftDigestSource(board),
    };
    const handle = startLiveDraftSession({
      route: { leagueId: "1234567", season: 2026 },
      root: draftRoomFixture(picks),
      pageSessionId: "3f8a1c62-9b4d-4a2e-8f1b-5c7d9e0a1b23",
      timers: inertTimers,
      mutations: inertMutations,
      now: () => new Date("2026-08-23T18:04:05.000Z"),
      scan: () => ({ ok: true, snapshot: scanned }),
      send: (request) => {
        sent.push(request);
        return Promise.resolve<BridgeLiveDraftResponse>({
          ok: true,
          status: defaultLiveDraftStatus,
          resolvedScope: null,
        });
      },
    });
    return { sent, handle };
  }

  it("sends only a sanitized observation the wire validator accepts", async () => {
    const { sent } = session([{ sequence: "1", player: "Patrick Mahomes" }]);
    await settle(sent);

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
    await settle(sent);

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

  it("fails closed without the injected replay seam while live selectors are unverified", () => {
    const sent: BridgeLiveDraftRequest[] = [];
    startLiveDraftSession({
      route: { leagueId: "1234567", season: 2026 },
      root: draftRoomFixture([{ sequence: "1", player: "Patrick Mahomes" }]),
      pageSessionId: "3f8a1c62-9b4d-4a2e-8f1b-5c7d9e0a1b23",
      timers: inertTimers,
      mutations: inertMutations,
      now: () => new Date("2026-08-23T18:04:05.000Z"),
      send: (request) => {
        sent.push(request);
        return Promise.resolve({ ok: true, status: defaultLiveDraftStatus, resolvedScope: null });
      },
    });
    expect(sent).toEqual([]);
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
        Promise.resolve<BridgeLiveDraftResponse>({
          ok: true,
          status: defaultLiveDraftStatus,
          resolvedScope: null,
        }),
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
    let writes = 0;
    const node: OverlayNode = {
      get textContent() {
        return attributes.text ?? null;
      },
      set textContent(value: string | null) {
        writes += 1;
        if (value === null) delete attributes.text;
        else attributes.text = value;
      },
      setAttribute: (name, value) => {
        writes += 1;
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
      get writes() {
        return writes;
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

  it("does not rewrite identical state inside the observed draft subtree", () => {
    const test = overlayHarness();
    test.overlay.show("attention", "Laces Out: cannot read this draft room.");
    const firstWrites = test.writes;
    test.overlay.show("attention", "Laces Out: cannot read this draft room.");
    expect(test.writes).toBe(firstWrites);

    test.overlay.show("synced", "Laces Out: cannot read this draft room.");
    expect(test.writes).toBeGreaterThan(firstWrites);
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
