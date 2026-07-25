import { createHash } from "node:crypto";

import { loadEnvironment } from "@fantasy/config";
import {
  espnLiveDraftDigestSource,
  espnLiveDraftIngestResponseSchema,
  type EspnLiveDraftIngestRequest,
  type EspnLiveDraftIngestResponse,
} from "@fantasy/contracts";
import { describe, expect, it } from "vitest";

import { buildApp, type EspnLiveDraftPort } from "./app.js";
import { DraftStreamHub, serverSentEvent } from "./draft-stream.js";

const DEVICE_TOKEN = `lo_espn_${"b".repeat(43)}`;

/** Problem documents are not contract-typed, so narrow them explicitly rather than reading `any`. */
function problemType(body: unknown): string {
  return typeof body === "object" &&
    body !== null &&
    "type" in body &&
    typeof body.type === "string"
    ? body.type
    : "";
}
const DRAFT_ID = "20000000-0000-4000-8000-000000000001";
const PAGE_SESSION = "7f1a2b3c-4d5e-4f60-8a71-9b2c3d4e5f60";

function observation(): EspnLiveDraftIngestRequest {
  const draft = {
    schemaVersion: 1 as const,
    kind: "espn-live-draft" as const,
    leagueId: "1234567",
    season: 2026,
    pageSessionId: PAGE_SESSION,
    revision: 7,
    capturedAt: "2026-08-24T18:04:58.000Z",
    state: "live" as const,
    draftType: "snake" as const,
    expectedTeamCount: 2,
    expectedRosterSize: 1,
    pickOwnership: [{ overallPick: 1, providerTeamId: "1", teamName: "Ditka's Revenge" }],
    picks: [
      {
        sequence: 1,
        round: 1,
        roundPick: 1,
        keeper: false,
        providerTeamId: "1",
        teamName: "Ditka's Revenge",
        providerPlayerId: "3139477",
        playerName: "Patrick Mahomes",
        proTeam: "KC",
        position: "QB",
        price: null,
        nominatingProviderTeamId: null,
      },
    ],
    currentAuction: null,
    completeness: { contiguousThrough: 1, duplicateSequences: 0, unresolvedRows: 0 },
  };
  return {
    ...draft,
    checksumSha256: createHash("sha256")
      .update(espnLiveDraftDigestSource(draft), "utf8")
      .digest("hex"),
  };
}

const acceptedResponse: EspnLiveDraftIngestResponse = {
  status: "accepted",
  draftId: DRAFT_ID,
  serverSequence: 1,
  feedState: "live",
  acceptedChecksum: "a".repeat(64),
  unresolvedTeams: 0,
  unresolvedPlayers: 0,
  issueCode: null,
  sourceLeaseExpiresAt: "2026-08-24T18:05:25.000Z",
};

function port(
  response: EspnLiveDraftIngestResponse,
  captured: { token?: string; request?: EspnLiveDraftIngestRequest } = {},
): EspnLiveDraftPort {
  return {
    ingest: (deviceToken, request) => {
      captured.token = deviceToken;
      captured.request = request;
      return Promise.resolve(response);
    },
  };
}

async function appWith(espnLiveDraft?: EspnLiveDraftPort, draftStream?: DraftStreamHub) {
  // Bridge ingest is cookie-less by design, so these build without an auth service. The stream
  // route still refuses an anonymous caller through its own guard, which is what that test proves.
  return buildApp({
    environment: loadEnvironment({ NODE_ENV: "test" }),
    logger: false,
    requireAuthentication: false,
    ...(espnLiveDraft ? { espnLiveDraft } : {}),
    ...(draftStream ? { draftStream } : {}),
  });
}

describe("POST /v1/bridge/espn/live-draft", () => {
  it("serves 503 when live draft sync is not configured", async () => {
    const app = await appWith();
    const response = await app.inject({
      method: "POST",
      url: "/v1/bridge/espn/live-draft",
      headers: { authorization: `Bridge ${DEVICE_TOKEN}` },
      payload: observation(),
    });
    expect(response.statusCode).toBe(503);
    expect(problemType(response.json())).toContain("espn-live-draft-unavailable");
    await app.close();
  });

  it("requires bridge device authorization and never a session cookie", async () => {
    const app = await appWith(port(acceptedResponse));
    const response = await app.inject({
      method: "POST",
      url: "/v1/bridge/espn/live-draft",
      payload: observation(),
    });
    expect(response.statusCode).toBe(401);
    expect(problemType(response.json())).toContain("bridge-unauthorized");
    await app.close();
  });

  it("rejects a malformed authorization scheme", async () => {
    const app = await appWith(port(acceptedResponse));
    const response = await app.inject({
      method: "POST",
      url: "/v1/bridge/espn/live-draft",
      headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
      payload: observation(),
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("accepts a valid observation without a session cookie and answers 202", async () => {
    const captured: { token?: string } = {};
    const app = await appWith(port(acceptedResponse, captured));
    const response = await app.inject({
      method: "POST",
      url: "/v1/bridge/espn/live-draft",
      headers: { authorization: `Bridge ${DEVICE_TOKEN}` },
      payload: observation(),
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: "accepted", draftId: DRAFT_ID });
    expect(captured.token).toBe(DEVICE_TOKEN);
    await app.close();
  });

  it("answers 200 rather than 202 when the board did not advance", async () => {
    const app = await appWith(
      port({ ...acceptedResponse, status: "held", issueCode: "UNRESOLVED_PLAYER" }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/bridge/espn/live-draft",
      headers: { authorization: `Bridge ${DEVICE_TOKEN}` },
      payload: observation(),
    });
    expect(response.statusCode).toBe(200);
    expect(espnLiveDraftIngestResponseSchema.parse(response.json()).issueCode).toBe(
      "UNRESOLVED_PLAYER",
    );
    await app.close();
  });

  it("rejects a payload carrying unexpected fields", async () => {
    const app = await appWith(port(acceptedResponse));
    const response = await app.inject({
      method: "POST",
      url: "/v1/bridge/espn/live-draft",
      headers: { authorization: `Bridge ${DEVICE_TOKEN}` },
      payload: { ...observation(), rawHtml: "<table></table>" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("never echoes the device token back to the caller", async () => {
    const app = await appWith(port(acceptedResponse));
    const response = await app.inject({
      method: "POST",
      url: "/v1/bridge/espn/live-draft",
      headers: { authorization: `Bridge ${DEVICE_TOKEN}` },
      payload: observation(),
    });
    expect(response.body).not.toContain(DEVICE_TOKEN);
    await app.close();
  });

  it("publishes an invalidation only when the board actually advanced", async () => {
    const hub = new DraftStreamHub();
    const seen: unknown[] = [];
    hub.subscribe(DRAFT_ID, (event) => seen.push(event));

    const accepting = await appWith(port(acceptedResponse), hub);
    await accepting.inject({
      method: "POST",
      url: "/v1/bridge/espn/live-draft",
      headers: { authorization: `Bridge ${DEVICE_TOKEN}` },
      payload: observation(),
    });
    await accepting.close();
    expect(seen).toHaveLength(1);

    const holding = await appWith(port({ ...acceptedResponse, status: "standby" }), hub);
    await holding.inject({
      method: "POST",
      url: "/v1/bridge/espn/live-draft",
      headers: { authorization: `Bridge ${DEVICE_TOKEN}` },
      payload: observation(),
    });
    await holding.close();
    expect(seen).toHaveLength(1);
  });
});

describe("GET /v1/drafts/:draftId/stream", () => {
  it("requires authentication", async () => {
    const app = await appWith(port(acceptedResponse));
    const response = await app.inject({ method: "GET", url: `/v1/drafts/${DRAFT_ID}/stream` });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe("draft stream hub", () => {
  it("delivers an invalidation to every subscriber of that draft only", () => {
    const hub = new DraftStreamHub();
    const mine: unknown[] = [];
    const theirs: unknown[] = [];
    hub.subscribe(DRAFT_ID, (event) => mine.push(event));
    hub.subscribe("30000000-0000-4000-8000-000000000009", (event) => theirs.push(event));
    hub.publish({
      draftId: DRAFT_ID,
      sequence: 4,
      feedRevision: 7,
      occurredAt: "2026-08-24T18:05:00.000Z",
    });
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });

  it("stops delivering after unsubscribe", () => {
    const hub = new DraftStreamHub();
    const seen: unknown[] = [];
    const stop = hub.subscribe(DRAFT_ID, (event) => seen.push(event));
    stop?.();
    hub.publish({
      draftId: DRAFT_ID,
      sequence: 1,
      feedRevision: 1,
      occurredAt: "2026-08-24T18:05:00.000Z",
    });
    expect(seen).toHaveLength(0);
    expect(hub.subscriberCount(DRAFT_ID)).toBe(0);
  });

  it("refuses a subscriber past the per-draft ceiling instead of growing without bound", () => {
    const hub = new DraftStreamHub(2);
    expect(hub.subscribe(DRAFT_ID, () => undefined)).toBeTypeOf("function");
    expect(hub.subscribe(DRAFT_ID, () => undefined)).toBeTypeOf("function");
    expect(hub.subscribe(DRAFT_ID, () => undefined)).toBeUndefined();
  });

  it("drops a throwing subscriber without starving the rest of the league", () => {
    const hub = new DraftStreamHub();
    const healthy: unknown[] = [];
    hub.subscribe(DRAFT_ID, () => {
      throw new Error("client vanished");
    });
    hub.subscribe(DRAFT_ID, (event) => healthy.push(event));
    const event = {
      draftId: DRAFT_ID,
      sequence: 2,
      feedRevision: 3,
      occurredAt: "2026-08-24T18:05:00.000Z",
    };
    hub.publish(event);
    expect(healthy).toHaveLength(1);
    expect(hub.subscriberCount(DRAFT_ID)).toBe(1);
  });

  it("frames an invalidation as a parseable SSE event", () => {
    const frame = serverSentEvent({
      draftId: DRAFT_ID,
      sequence: 12,
      feedRevision: 30,
      occurredAt: "2026-08-24T18:05:00.000Z",
    });
    expect(frame).toContain("event: draft-invalidated");
    expect(frame.endsWith("\n\n")).toBe(true);
    const data = frame.split("data: ")[1]!.trim();
    expect(JSON.parse(data)).toMatchObject({ sequence: 12, feedRevision: 30 });
  });
});
