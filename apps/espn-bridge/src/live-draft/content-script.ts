/**
 * ESPN draft-room content script.
 *
 * Boundary, in one place:
 *
 * - It activates only on a recognized ESPN football draft route, and only after the service worker
 *   confirms the league and season match the stored bridge configuration.
 * - It reads already-rendered fantasy facts through `dom-adapter`, sanitizes them through
 *   `observation`, and sends nothing else. No raw HTML, no arbitrary text nodes, no chat, no page
 *   storage, no script state.
 * - It never reads cookies, `SWID`, `espn_s2`, authorization headers, or draft security tokens, and
 *   it never touches ESPN's WebSocket, EventSource, or network stack. Observation plus periodic
 *   reconciliation only.
 * - It never receives the Laces Out device credential. It messages the service worker, which is the
 *   sole holder of that token.
 * - It never writes to ESPN. The only DOM it creates is a non-interactive status badge.
 */

import {
  extractDraftRoom,
  recognizeEspnDraftRoute,
  type DraftRoomElement,
  type EspnDraftRoute,
} from "./dom-adapter.js";
import { ESPN_LIVE_DRAFT_LIMITS, type EspnLiveDraftHeartbeatV1 } from "./dom-contract.js";
import {
  buildEspnLiveDraftSnapshot,
  sealEspnLiveDraftObservation,
  type EspnLiveDraftSnapshot,
  type EspnLiveDraftSnapshotResult,
} from "./observation.js";
import {
  createLiveDraftObserver,
  type LiveDraftMutationSource,
  type LiveDraftSnapshotReason,
  type LiveDraftTimers,
} from "./observer.js";
import {
  createLiveDraftStatusOverlay,
  type OverlayHost,
  type OverlayTone,
} from "./status-overlay.js";
import type { BridgeLiveDraftRequest, BridgeLiveDraftResponse } from "../protocol.js";

export { recognizeEspnDraftRoute };

/** Season bounds the route recognizer applies, mirroring the wire contract. */
export const liveDraftSeasonBounds = {
  minimum: ESPN_LIVE_DRAFT_LIMITS.minimumSeason,
  maximum: ESPN_LIVE_DRAFT_LIMITS.maximumSeason,
} as const;

export function recognizeDraftRoomHref(href: string): EspnDraftRoute | null {
  return recognizeEspnDraftRoute(href, liveDraftSeasonBounds);
}

const OVERLAY_TONE: Readonly<Record<LiveDraftSnapshotReason, OverlayTone>> = {
  attach: "observing",
  reconnect: "observing",
  rescan: "synced",
  "completed-pick": "synced",
  "completed-sale": "synced",
  rollback: "attention",
  complete: "synced",
};

/** Human-readable badge text. Fixed strings only; no provider text is ever interpolated. */
export function overlayMessage(snapshot: EspnLiveDraftSnapshot): string {
  if (snapshot.state === "complete") return "Laces Out: draft complete, results synced.";
  if (snapshot.state === "paused") return "Laces Out: ESPN draft paused.";
  if (snapshot.state === "waiting") return "Laces Out: waiting for the draft to start.";
  const noun = snapshot.picks.length === 1 ? "pick" : "picks";
  return `Laces Out: live sync following ${snapshot.picks.length} ${noun}.`;
}

/** Wraps a real `MutationObserver` in the observer's injectable seam. */
export function browserMutationSource(target: Node): LiveDraftMutationSource {
  let observer: MutationObserver | null = null;
  return {
    start(onMutation): void {
      observer = new MutationObserver(() => {
        onMutation();
      });
      observer.observe(target, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    },
    stop(): void {
      observer?.disconnect();
      observer = null;
    },
  };
}

/** Attaches the badge to the live page. The only DOM this extension adds to ESPN. */
export const browserOverlayHost: OverlayHost = {
  attach(): HTMLElement | null {
    const body: HTMLElement | null = document.body;
    if (body === null) return null;
    const node = document.createElement("div");
    body.append(node);
    return node;
  },
};

// `Number(...)` rather than a cast: a browser already returns a numeric handle, and the repository
// typecheck also compiles this file with node's `Timeout` in scope, which coerces to its own id.
export const browserTimers: LiveDraftTimers = {
  now: () => Date.now(),
  setTimeout: (handler, delayMs) => Number(globalThis.setTimeout(handler, delayMs)),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle);
  },
  setInterval: (handler, periodMs) => Number(globalThis.setInterval(handler, periodMs)),
  clearInterval: (handle) => {
    globalThis.clearInterval(handle);
  },
};

function send(request: BridgeLiveDraftRequest): Promise<BridgeLiveDraftResponse> {
  return chrome.runtime.sendMessage(request);
}

/**
 * Starts observing one recognized draft room.
 *
 * Exported and dependency-injected so the whole activation path can be exercised without a browser.
 * `revision` is monotonic within this page session; the random `pageSessionId` is generated here and
 * is never derived from anything ESPN provided.
 */
export function startLiveDraftSession(options: {
  readonly route: EspnDraftRoute;
  readonly root: DraftRoomElement;
  readonly pageSessionId: string;
  readonly timers: LiveDraftTimers;
  readonly mutations: LiveDraftMutationSource;
  readonly now: () => Date;
  readonly send: (request: BridgeLiveDraftRequest) => Promise<BridgeLiveDraftResponse>;
  readonly overlay?: { show(tone: OverlayTone, message: string): void; remove(): void };
}): { stop(): void } {
  let revision = 0;
  let lastChecksum: string | null = null;

  const scan = (): EspnLiveDraftSnapshotResult =>
    buildEspnLiveDraftSnapshot(extractDraftRoom(options.root), {
      leagueId: options.route.leagueId,
      season: options.route.season,
    });

  const publish = (snapshot: EspnLiveDraftSnapshot, transient: boolean): void => {
    revision += 1;
    void sealEspnLiveDraftObservation(snapshot, {
      pageSessionId: options.pageSessionId,
      revision,
      capturedAt: options.now().toISOString(),
    })
      .then(async (observation) => {
        lastChecksum = observation.checksumSha256;
        await options.send({ type: "LIVE_DRAFT_OBSERVATION", observation, transient });
      })
      .catch(() => {
        // The service worker owns retry and status. A failed message here is recovered by the next
        // periodic rescan rather than by an unbounded local retry loop.
      });
  };

  const observer = createLiveDraftObserver({
    scan,
    timers: options.timers,
    mutations: options.mutations,
    sink: {
      snapshot(snapshot, reason): void {
        options.overlay?.show(OVERLAY_TONE[reason], overlayMessage(snapshot));
        publish(snapshot, false);
      },
      transientAuction(snapshot): void {
        publish(snapshot, true);
      },
      heartbeat(state): void {
        const heartbeat: EspnLiveDraftHeartbeatV1 = {
          schemaVersion: 1,
          kind: "espn-live-draft-heartbeat",
          leagueId: options.route.leagueId,
          season: options.route.season,
          pageSessionId: options.pageSessionId,
          revision,
          capturedAt: options.now().toISOString(),
          state,
          lastChecksumSha256: lastChecksum,
        };
        void options.send({ type: "LIVE_DRAFT_HEARTBEAT", heartbeat }).catch(() => {
          // Missed heartbeats surface as feed staleness on the server; nothing to do locally.
        });
      },
      failure(): void {
        // Fail closed and stay quiet. The board is not published, the previous accepted state
        // stands, and the badge tells the source user that sync needs attention.
        options.overlay?.show("attention", "Laces Out: cannot read this draft room.");
      },
    },
  });

  observer.start();
  return {
    stop(): void {
      observer.stop();
      options.overlay?.remove();
    },
  };
}

async function bootstrap(): Promise<void> {
  const route = recognizeDraftRoomHref(globalThis.location.href);
  if (route === null) return;

  // Ask before observing: the service worker holds the configuration and answers only with a
  // bounded status. Nothing about the pairing, and certainly not the device token, is exposed here.
  const preflight = await send({
    type: "GET_LIVE_DRAFT_STATUS",
    leagueId: route.leagueId,
    season: route.season,
  });
  if (preflight.status.scope !== "in-scope") return;

  const session = startLiveDraftSession({
    route,
    root: document.documentElement,
    pageSessionId: crypto.randomUUID(),
    timers: browserTimers,
    mutations: browserMutationSource(document.documentElement),
    now: () => new Date(),
    send,
    overlay: createLiveDraftStatusOverlay(browserOverlayHost),
  });

  globalThis.addEventListener("pagehide", () => {
    session.stop();
    void send({
      type: "LIVE_DRAFT_PAGE_LEFT",
      leagueId: route.leagueId,
      season: route.season,
    }).catch(() => {
      // The tab is going away; the server lease expires on its own if this never lands.
    });
  });
}

// Only bootstraps inside a real extension content script. In a node test this module is inert, so
// every exported function above stays directly testable.
if (
  typeof document !== "undefined" &&
  typeof chrome !== "undefined" &&
  typeof chrome.runtime?.id === "string"
) {
  void bootstrap();
}
