import { describe, expect, it } from "vitest";

import type { EspnLiveDraftObservationV1 } from "./dom-contract.js";
import {
  LIVE_DRAFT_RETRY,
  LiveDraftUploadQueue,
  classifyUploadStatus,
  defaultLiveDraftStatus,
  liveDraftIngestPath,
  liveDraftPendingStorageKey,
  liveDraftRetryDelayMs,
  liveDraftStatusStorageKey,
  validateLiveDraftScope,
  validateLiveDraftSender,
  validateStoredLiveDraftStatus,
  type LiveDraftQueueEvent,
  type LiveDraftUploadOutcome,
} from "./uplink.js";

const extensionId = "jmbijafllioopigmpacjkdjhbjkplndh";
const draftUrl = "https://fantasy.espn.com/football/draft?leagueId=1234567&seasonId=2026";

function contentScriptSender(overrides: Record<string, unknown> = {}) {
  return { id: extensionId, url: draftUrl, frameId: 0, tab: { id: 42 }, ...overrides };
}

function observation(overrides: Partial<EspnLiveDraftObservationV1> = {}) {
  return {
    schemaVersion: 1,
    kind: "espn-live-draft",
    leagueId: "1234567",
    season: 2026,
    pageSessionId: "3f8a1c62-9b4d-4a2e-8f1b-5c7d9e0a1b23",
    revision: 1,
    capturedAt: "2026-08-23T18:04:05.000Z",
    state: "live",
    draftType: "snake",
    expectedTeamCount: 12,
    expectedRosterSize: 16,
    pickOwnership: [],
    picks: [],
    currentAuction: null,
    completeness: { contiguousThrough: 0, duplicateSequences: 0, unresolvedRows: 0 },
    checksumSha256: "a".repeat(64),
    ...overrides,
  } as EspnLiveDraftObservationV1;
}

describe("internal sender validation", () => {
  it("accepts this extension's own content script on a draft route and returns the attested route", () => {
    const result = validateLiveDraftSender(contentScriptSender(), extensionId);
    expect(result).toEqual({ ok: true, route: { leagueId: "1234567", season: 2026 } });
  });

  it("refuses another extension, a missing sender, and a non-tab sender", () => {
    expect(
      validateLiveDraftSender(contentScriptSender({ id: "someotherextensionid" }), extensionId),
    ).toEqual({ ok: false, reason: "foreign-extension" });
    expect(validateLiveDraftSender(undefined, extensionId)).toEqual({
      ok: false,
      reason: "foreign-extension",
    });
    // An extension page (the popup) has no tab and may not move the feed.
    expect(
      validateLiveDraftSender({ id: extensionId, url: draftUrl, frameId: 0 }, extensionId),
    ).toEqual({ ok: false, reason: "not-a-content-script" });
  });

  it("refuses a subframe, since an ESPN iframe must not speak for the page", () => {
    expect(validateLiveDraftSender(contentScriptSender({ frameId: 3 }), extensionId)).toEqual({
      ok: false,
      reason: "not-top-frame",
    });
  });

  it("refuses any URL that is not a recognized ESPN draft room", () => {
    for (const url of [
      "https://fantasy.espn.com/football/draftrecap?leagueId=1234567&seasonId=2026",
      "https://evil.example/football/draft?leagueId=1234567&seasonId=2026",
      undefined,
    ]) {
      expect(validateLiveDraftSender(contentScriptSender({ url }), extensionId)).toEqual({
        ok: false,
        reason: "not-a-draft-route",
      });
    }
  });
});

describe("league scope enforcement", () => {
  const route = { leagueId: "1234567", season: 2026 } as const;
  const configuration = { leagueIds: ["1234567", "7654321"], season: 2026 } as const;

  it("accepts a claim matching both the attested URL and the stored bridge scope", () => {
    expect(validateLiveDraftScope(route, route, configuration)).toEqual({ ok: true });
  });

  it("refuses a claim for a different league than the tab is actually on", () => {
    // The ESPN page is untrusted: a mutation must not be able to select another league.
    expect(
      validateLiveDraftScope({ leagueId: "9999999", season: 2026 }, route, configuration),
    ).toEqual({ ok: false, reason: "route-league-mismatch" });
    expect(
      validateLiveDraftScope({ leagueId: "1234567", season: 2025 }, route, configuration),
    ).toEqual({ ok: false, reason: "route-league-mismatch" });
  });

  it("refuses a league outside the paired device's scope and a mismatched season", () => {
    const otherLeague = { leagueId: "5555555", season: 2026 } as const;
    expect(validateLiveDraftScope(otherLeague, otherLeague, configuration)).toEqual({
      ok: false,
      reason: "league-not-in-scope",
    });
    expect(validateLiveDraftScope(route, route, { leagueIds: ["1234567"], season: 2025 })).toEqual({
      ok: false,
      reason: "season-mismatch",
    });
  });

  it("refuses everything when the bridge is not paired", () => {
    expect(validateLiveDraftScope(route, route, undefined)).toEqual({
      ok: false,
      reason: "not-configured",
    });
  });
});

describe("bounded retry schedule", () => {
  it("backs off exponentially and caps the delay", () => {
    expect(liveDraftRetryDelayMs(1, 1)).toBe(1_000);
    expect(liveDraftRetryDelayMs(2, 1)).toBe(2_000);
    expect(liveDraftRetryDelayMs(3, 1)).toBe(4_000);
    expect(liveDraftRetryDelayMs(99, 1)).toBe(LIVE_DRAFT_RETRY.maximumDelayMs);
  });

  it("jitters within the lower half of each step so bridges do not retry in lockstep", () => {
    expect(liveDraftRetryDelayMs(1, 0)).toBe(500);
    expect(liveDraftRetryDelayMs(1, 0.5)).toBe(750);
    for (const random of [0, 0.3, 0.7, 1]) {
      const delay = liveDraftRetryDelayMs(2, random);
      expect(delay).toBeGreaterThanOrEqual(1_000);
      expect(delay).toBeLessThanOrEqual(2_000);
    }
  });

  it("maps upload status codes to bounded outcomes", () => {
    expect(classifyUploadStatus(202)).toEqual({ kind: "accepted" });
    expect(classifyUploadStatus(401)).toEqual({ kind: "unauthorized" });
    expect(classifyUploadStatus(403)).toEqual({ kind: "unauthorized" });
    expect(classifyUploadStatus(429)).toEqual({ kind: "retry" });
    expect(classifyUploadStatus(503)).toEqual({ kind: "retry" });
    expect(classifyUploadStatus(422)).toEqual({ kind: "rejected", statusCode: 422 });
  });
});

interface QueueHarness {
  readonly queue: LiveDraftUploadQueue;
  readonly bodies: string[];
  readonly events: LiveDraftQueueEvent[];
  readonly delays: number[];
}

function queueHarness(outcomes: readonly LiveDraftUploadOutcome[]): QueueHarness {
  const bodies: string[] = [];
  const events: LiveDraftQueueEvent[] = [];
  const delays: number[] = [];
  let call = 0;
  const queue = new LiveDraftUploadQueue({
    transport: (body) => {
      bodies.push(body);
      const outcome = outcomes[Math.min(call, outcomes.length - 1)] ?? { kind: "accepted" };
      call += 1;
      return Promise.resolve(outcome);
    },
    sleep: (delayMs) => {
      delays.push(delayMs);
      return Promise.resolve();
    },
    random: () => 0.5,
    onEvent: (event) => events.push(event),
  });
  return { queue, bodies, events, delays };
}

describe("replace-latest upload queue", () => {
  it("uploads a submitted snapshot once and reports the outcome", async () => {
    const test = queueHarness([{ kind: "accepted" }]);
    await test.queue.submit(observation(), "snapshot");
    expect(test.bodies).toHaveLength(1);
    expect(test.events).toEqual([
      { kind: "settled", slot: "snapshot", outcome: { kind: "accepted" } },
    ]);
    expect(test.queue.queued).toEqual({ snapshot: false, transient: false });
  });

  it("replaces a queued snapshot rather than replaying every intermediate mutation", async () => {
    const test = queueHarness([{ kind: "retry" }, { kind: "accepted" }]);
    const first = test.queue.submit(observation({ revision: 1 }), "snapshot");
    // A newer board arrives while the first upload is still being retried.
    await test.queue.submit(observation({ revision: 2 }), "snapshot");
    await first;

    const sent = test.bodies.map((body) => (JSON.parse(body) as { revision: number }).revision);
    // The stale revision 1 body is never resent; the cumulative revision 2 board subsumes it.
    expect(sent).toEqual([1, 2]);
    expect(test.queue.queued.snapshot).toBe(false);
  });

  it("drops a queued transient update when a full snapshot supersedes it", async () => {
    const test = queueHarness([{ kind: "accepted" }]);
    await test.queue.submit(observation({ revision: 5 }), "transient");
    await test.queue.submit(observation({ revision: 6 }), "snapshot");
    const slots = test.events.map((event) => event.slot);
    expect(slots).toEqual(["transient", "snapshot"]);
    expect(test.queue.queued).toEqual({ snapshot: false, transient: false });
  });

  it("retries a failing upload a bounded number of times, then abandons it", async () => {
    const test = queueHarness([{ kind: "retry" }]);
    await test.queue.submit(observation(), "snapshot");
    expect(test.bodies).toHaveLength(LIVE_DRAFT_RETRY.maximumAttempts);
    expect(test.delays).toHaveLength(LIVE_DRAFT_RETRY.maximumAttempts - 1);
    expect(test.events.at(-1)).toEqual({ kind: "abandoned", slot: "snapshot" });
    // Nothing is left queued: the next observation carries the whole cumulative board anyway.
    expect(test.queue.queued.snapshot).toBe(false);
  });

  it("does not retry a rejection or an authorization failure", async () => {
    const rejected = queueHarness([{ kind: "rejected", statusCode: 422 }]);
    await rejected.queue.submit(observation(), "snapshot");
    expect(rejected.bodies).toHaveLength(1);

    const unauthorized = queueHarness([{ kind: "unauthorized" }]);
    await unauthorized.queue.submit(observation(), "snapshot");
    expect(unauthorized.bodies).toHaveLength(1);
    expect(unauthorized.events.at(-1)).toEqual({
      kind: "settled",
      slot: "snapshot",
      outcome: { kind: "unauthorized" },
    });
  });

  it("sends a maximum-size legal board but discards anything past the body limit", async () => {
    const maximumLegalBoard = observation({
      picks: Array.from({ length: 1_000 }, (_, index) => ({
        sequence: index + 1,
        round: 1,
        roundPick: 1,
        keeper: false,
        providerTeamId: "1",
        teamName: "T".repeat(80),
        providerPlayerId: "3139477",
        playerName: "P".repeat(120),
        proTeam: "KC",
        position: "QB",
        price: null,
        nominatingProviderTeamId: null,
      })),
    });
    const legal = queueHarness([{ kind: "accepted" }]);
    await legal.queue.submit(maximumLegalBoard, "snapshot");
    // The per-field limits already keep the largest contract-legal board well under 1 MiB.
    expect(legal.bodies).toHaveLength(1);

    // The size guard is the belt for anything that got past the field limits.
    const oversized = queueHarness([{ kind: "accepted" }]);
    await oversized.queue.submit(
      { ...maximumLegalBoard, leagueId: "9".repeat(1_048_576) },
      "snapshot",
    );
    expect(oversized.bodies).toHaveLength(0);
    expect(oversized.events).toEqual([{ kind: "oversized", slot: "snapshot" }]);
  });

  it("clears both slots when the draft room is closed", async () => {
    const test = queueHarness([{ kind: "accepted" }]);
    await test.queue.submit(observation(), "snapshot");
    test.queue.clear();
    expect(test.queue.queued).toEqual({ snapshot: false, transient: false });
    expect(test.queue.pendingSnapshot).toBeNull();
  });
});

describe("bounded stored status", () => {
  it("uses the Laces Out live-draft storage namespaces and ingest path", () => {
    expect([liveDraftStatusStorageKey, liveDraftPendingStorageKey, liveDraftIngestPath]).toEqual([
      "lacesOutEspnLiveDraftStatus",
      "lacesOutEspnLiveDraftPending",
      "/v1/bridge/espn/live-draft",
    ]);
  });

  it("round-trips a valid stored status", () => {
    const status = {
      ...defaultLiveDraftStatus,
      scope: "in-scope",
      state: "accepted",
      message: "Live draft sync is current.",
      leagueId: "1234567",
      season: 2026,
      draftState: "live",
      pickCount: 24,
      lastAcceptedAt: "2026-08-23T18:04:05.000Z",
      lastChecksumSha256: "b".repeat(64),
    } as const;
    expect(validateStoredLiveDraftStatus(status)).toEqual(status);
  });

  it("fails closed to the default on corrupt, foreign, or oversized stored values", () => {
    expect(validateStoredLiveDraftStatus(undefined)).toEqual(defaultLiveDraftStatus);
    expect(validateStoredLiveDraftStatus({ scope: "in-scope" })).toEqual(defaultLiveDraftStatus);
    expect(
      validateStoredLiveDraftStatus({ ...defaultLiveDraftStatus, message: "x".repeat(181) }),
    ).toEqual(defaultLiveDraftStatus);
    expect(
      validateStoredLiveDraftStatus({ ...defaultLiveDraftStatus, pickCount: 100_000 }),
    ).toEqual(defaultLiveDraftStatus);
    expect(
      validateStoredLiveDraftStatus({ ...defaultLiveDraftStatus, leagueId: "not-a-league" }),
    ).toEqual(defaultLiveDraftStatus);
  });

  it("drops a stored checksum that is not a hex digest", () => {
    expect(
      validateStoredLiveDraftStatus({
        ...defaultLiveDraftStatus,
        lastChecksumSha256: "espn-session-token",
      }).lastChecksumSha256,
    ).toBeNull();
  });

  it("keeps no credential field in the status contract", () => {
    // The popup and the content script both read this object; neither may ever see the token.
    const keys = Object.keys(defaultLiveDraftStatus).join(" ").toLowerCase();
    for (const forbidden of ["token", "cookie", "swid", "espn_s2", "authorization", "secret"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
