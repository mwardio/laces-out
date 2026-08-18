import { createHash } from "node:crypto";

import { loadEnvironment } from "@laces-out/config";
import {
  espnLiveDraftDigestSource,
  espnLiveDraftIngestResponseSchema,
  espnLiveDraftPulseResponseSchema,
  type EspnLiveDraftIngestRequest,
  type EspnLiveDraftIngestResponse,
  type EspnLiveDraftPulseResponse,
} from "@laces-out/contracts";
import { describe, expect, it } from "vitest";

import { buildApp, type EspnLiveDraftPort } from "./app.js";
import { mintDraftReadToken } from "./draft-read.js";
import { DraftStreamHub, serverSentEvent } from "./draft-stream.js";
import { EspnLiveDraftError } from "./espn-live-draft-service.js";

const DEVICE_TOKEN = `lo_espn_${"b".repeat(43)}`;
const DRAFT_READ_SECRET = "d".repeat(48);
const USER_ID = "10000000-0000-4000-8000-000000000001";

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

function observation(overrides: { readonly revision?: number } = {}): EspnLiveDraftIngestRequest {
  const draft = {
    schemaVersion: 1 as const,
    kind: "espn-live-draft" as const,
    leagueId: "1234567",
    season: 2026,
    pageSessionId: PAGE_SESSION,
    revision: overrides.revision ?? 7,
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
  feedCursor: "1000008",
};

const pulseResponse: EspnLiveDraftPulseResponse = {
  schemaVersion: 1,
  provider: "espn",
  providerLeagueId: "1234567",
  season: 2026,
  cursor: "1000012",
  pageRevision: 11,
  generatedAt: "2026-08-24T18:05:00.000Z",
  observedAt: "2026-08-24T18:04:59.000Z",
  lastReceivedAt: "2026-08-24T18:05:00.000Z",
  fresh: true,
  ageSeconds: 0,
  feedState: "live",
  manualBackupActive: false,
  draft: {
    id: DRAFT_ID,
    sequence: 1,
    persistedState: "live",
    mode: "AUCTION",
    minimumBid: 1,
    complete: false,
    teams: [
      {
        id: "40000000-0000-4000-8000-00000000000a",
        name: "Ditka's Revenge",
        budget: 200,
        spent: 42,
        remainingBudget: 158,
        openSlots: 1,
        maximumBid: 158,
        rosterPlayerIds: ["50000000-0000-4000-8000-000000000001"],
        rosterPlayers: [
          {
            playerId: "50000000-0000-4000-8000-000000000001",
            playerName: "Patrick Mahomes",
            positions: ["QB"],
          },
        ],
        rosterSlots: [
          {
            id: "bench-1",
            type: "BENCH",
            label: "Bench 1",
            kind: "BENCH",
            eligiblePositions: ["QB", "RB", "WR", "TE"],
          },
        ],
      },
      {
        id: "40000000-0000-4000-8000-00000000000b",
        name: "Finkle Is Einhorn",
        budget: 200,
        spent: 0,
        remainingBudget: 200,
        openSlots: 2,
        maximumBid: 199,
        rosterPlayerIds: [],
        rosterPlayers: [],
        rosterSlots: [
          {
            id: "bench-1",
            type: "BENCH",
            label: "Bench 1",
            kind: "BENCH",
            eligiblePositions: ["QB", "RB", "WR", "TE"],
          },
          {
            id: "bench-2",
            type: "BENCH",
            label: "Bench 2",
            kind: "BENCH",
            eligiblePositions: ["QB", "RB", "WR", "TE"],
          },
        ],
      },
    ],
    completedSales: [
      {
        sequence: 1,
        playerId: "50000000-0000-4000-8000-000000000001",
        playerName: "Patrick Mahomes",
        positions: ["QB"],
        teamId: "40000000-0000-4000-8000-00000000000a",
        teamName: "Ditka's Revenge",
        price: 42,
      },
    ],
  },
  controlledTeamId: "40000000-0000-4000-8000-00000000000a",
  currentAuction: {
    nominationNumber: 2,
    nominatingTeamId: "40000000-0000-4000-8000-00000000000b",
    playerId: "50000000-0000-4000-8000-000000000002",
    playerPositions: ["WR"],
    playerName: "Ja'Marr Chase",
    proTeam: "CIN",
    position: "WR",
    highBidTeamId: "40000000-0000-4000-8000-00000000000b",
    highBid: 20,
    observedAt: "2026-08-24T18:04:59.000Z",
    nextBid: 21,
    nextBidSource: "ESPN_MINIMUM_INCREMENT",
    rosterFit: true,
    marketInflationFactor: null,
  },
  auctionTransitions: {
    sampling: "sampled",
    maximumItems: 64,
    observationsScanned: 2,
    items: [
      {
        pageRevision: 11,
        nominationNumber: 2,
        nominatingTeamId: "40000000-0000-4000-8000-00000000000b",
        playerId: "50000000-0000-4000-8000-000000000002",
        playerName: "Ja'Marr Chase",
        proTeam: "CIN",
        position: "WR",
        highBidTeamId: "40000000-0000-4000-8000-00000000000b",
        highBid: 20,
        observedAt: "2026-08-24T18:04:59.000Z",
      },
    ],
  },
};

function port(
  response: EspnLiveDraftIngestResponse,
  captured: {
    token?: string;
    request?: EspnLiveDraftIngestRequest;
    latest?: { token: string; leagueId: string; season: number };
    latestForMember?: { userId: string; leagueId: string; season: number };
  } = {},
): EspnLiveDraftPort {
  return {
    ingest: (deviceToken, request) => {
      captured.token = deviceToken;
      captured.request = request;
      return Promise.resolve(response);
    },
    latest: (deviceToken, leagueId, season) => {
      captured.latest = { token: deviceToken, leagueId, season };
      return Promise.resolve(pulseResponse);
    },
    latestForMember: (userId, leagueId, season) => {
      captured.latestForMember = { userId, leagueId, season };
      return Promise.resolve(pulseResponse);
    },
  };
}

async function appWith(espnLiveDraft?: EspnLiveDraftPort, draftStream?: DraftStreamHub) {
  // Bridge ingest is cookie-less by design, so these build without an auth service. The stream
  // route still refuses an anonymous caller through its own guard, which is what that test proves.
  return buildApp({
    environment: loadEnvironment({ NODE_ENV: "test", SESSION_SECRET: DRAFT_READ_SECRET }),
    logger: false,
    requireAuthentication: false,
    ...(espnLiveDraft ? { espnLiveDraft } : {}),
    ...(draftStream ? { draftStream } : {}),
  });
}

describe("GET /v1/bridge/espn/live-draft/latest", () => {
  it("is unavailable when live draft sync is not configured", async () => {
    const app = await appWith();
    const response = await app.inject({
      method: "GET",
      url: "/v1/bridge/espn/live-draft/latest?leagueId=1234567&season=2026",
      headers: { authorization: `Bridge ${DEVICE_TOKEN}` },
    });
    expect(response.statusCode).toBe(503);
    expect(problemType(response.json())).toContain("espn-live-draft-unavailable");
    await app.close();
  });

  it("requires a Bridge device credential and ignores session cookies", async () => {
    const app = await appWith(port(acceptedResponse));
    const response = await app.inject({
      method: "GET",
      url: "/v1/bridge/espn/live-draft/latest?leagueId=1234567&season=2026",
      headers: { cookie: "fantasy_session=not-a-bridge-token" },
    });
    expect(response.statusCode).toBe(401);
    expect(problemType(response.json())).toContain("bridge-unauthorized");
    await app.close();
  });

  it("strictly validates the paired league-season query", async () => {
    const app = await appWith(port(acceptedResponse));
    for (const url of [
      "/v1/bridge/espn/live-draft/latest?leagueId=abc&season=2026",
      "/v1/bridge/espn/live-draft/latest?leagueId=1234567&season=2018",
      "/v1/bridge/espn/live-draft/latest?leagueId=1234567&season=2026&deviceId=leak",
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bridge ${DEVICE_TOKEN}` },
      });
      expect(response.statusCode).toBe(400);
    }
    await app.close();
  });

  it("returns a bounded normalized pulse and forwards the exact scope", async () => {
    const captured: {
      latest?: { token: string; leagueId: string; season: number };
    } = {};
    const app = await appWith(port(acceptedResponse, captured));
    const response = await app.inject({
      method: "GET",
      url: "/v1/bridge/espn/live-draft/latest?leagueId=1234567&season=2026",
      headers: { authorization: `Bridge ${DEVICE_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    const pulse = espnLiveDraftPulseResponseSchema.parse(response.json());
    expect(pulse).toMatchObject({
      cursor: "1000012",
      controlledTeamId: "40000000-0000-4000-8000-00000000000a",
      currentAuction: { nextBid: 21, rosterFit: true },
      auctionTransitions: { sampling: "sampled", maximumItems: 64 },
    });
    expect(captured.latest).toEqual({
      token: DEVICE_TOKEN,
      leagueId: "1234567",
      season: 2026,
    });
    expect(response.body).not.toContain(DEVICE_TOKEN);
    expect(response.body).not.toMatch(
      /deviceId|userId|pageSessionId|cookie|checksum|providerPlayerId/u,
    );
    await app.close();
  });

  it("accepts DraftRead only for an explicitly permitted league season", async () => {
    const captured: {
      latestForMember?: { userId: string; leagueId: string; season: number };
    } = {};
    const capability = mintDraftReadToken({
      sessionSecret: DRAFT_READ_SECRET,
      userId: USER_ID,
      leagues: [{ leagueId: "1234567", season: 2026 }],
      lifetimeSeconds: 3_600,
    });
    const app = await appWith(port(acceptedResponse, captured));
    const accepted = await app.inject({
      method: "GET",
      url: "/v1/bridge/espn/live-draft/latest?leagueId=1234567&season=2026",
      headers: { authorization: `DraftRead ${capability.token}` },
    });
    expect(accepted.statusCode).toBe(200);
    expect(captured.latestForMember).toEqual({
      userId: USER_ID,
      leagueId: "1234567",
      season: 2026,
    });
    expect(accepted.body).not.toContain(capability.token);

    delete captured.latestForMember;
    const outsideScope = await app.inject({
      method: "GET",
      url: "/v1/bridge/espn/live-draft/latest?leagueId=1234567&season=2027",
      headers: { authorization: `DraftRead ${capability.token}` },
    });
    expect(outsideScope.statusCode).toBe(403);
    expect(problemType(outsideScope.json())).toContain("draft-read-forbidden");
    expect(captured.latestForMember).toBeUndefined();
    await app.close();
  });

  it("rejects tampered and expired DraftRead capabilities", async () => {
    const valid = mintDraftReadToken({
      sessionSecret: DRAFT_READ_SECRET,
      userId: USER_ID,
      leagues: [{ leagueId: "1234567", season: 2026 }],
      lifetimeSeconds: 3_600,
    }).token;
    const expired = mintDraftReadToken({
      sessionSecret: DRAFT_READ_SECRET,
      userId: USER_ID,
      leagues: [{ leagueId: "1234567", season: 2026 }],
      lifetimeSeconds: 60,
      now: new Date(Date.now() - 120_000),
    }).token;
    const tampered = `${valid.slice(0, -1)}${valid.endsWith("A") ? "B" : "A"}`;
    const app = await appWith(port(acceptedResponse));

    for (const token of [tampered, expired]) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/bridge/espn/live-draft/latest?leagueId=1234567&season=2026",
        headers: { authorization: `DraftRead ${token}` },
      });
      expect(response.statusCode).toBe(401);
      expect(problemType(response.json())).toContain("draft-read-unauthorized");
    }
    await app.close();
  });

  it("returns one stable bounded problem when an authorized pulse is not available yet", async () => {
    const token = mintDraftReadToken({
      sessionSecret: DRAFT_READ_SECRET,
      userId: USER_ID,
      leagues: [{ leagueId: "1234567", season: 2026 }],
      lifetimeSeconds: 3_600,
    }).token;
    const unavailable: EspnLiveDraftPort = {
      ...port(acceptedResponse),
      latestForMember: () =>
        Promise.reject(
          new EspnLiveDraftError(
            "NOT_FOUND",
            "No ESPN live draft pulse is available for this paired league season",
          ),
        ),
    };
    const app = await appWith(unavailable);
    const response = await app.inject({
      method: "GET",
      url: "/v1/bridge/espn/live-draft/latest?leagueId=1234567&season=2026",
      headers: { authorization: `DraftRead ${token}` },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      type: "https://fantasy.local/problems/espn-live-draft-pulse-not-found",
      status: 404,
      instance: "/v1/bridge/espn/live-draft/latest",
    });
    expect(response.body).not.toContain(USER_ID);
    expect(response.body).not.toContain(token);
    await app.close();
  });

  it("shares one bounded invalid-token bucket across forged DraftRead strings", async () => {
    const app = await appWith(port(acceptedResponse));
    let response;
    for (let index = 0; index <= 60; index += 1) {
      response = await app.inject({
        method: "GET",
        url: "/v1/bridge/espn/live-draft/latest?leagueId=1234567&season=2026",
        headers: { authorization: `DraftRead dr1.forged${index}.${"x".repeat(43)}` },
      });
    }
    expect(response?.statusCode).toBe(429);
    expect(problemType(response?.json())).toContain("rate-limit");
    await app.close();
  });

  it("bounds rotating well-formed Bridge tokens by source IP before allocating more buckets", async () => {
    const capability = mintDraftReadToken({
      sessionSecret: DRAFT_READ_SECRET,
      userId: USER_ID,
      leagues: [{ leagueId: "1234567", season: 2026 }],
      lifetimeSeconds: 3_600,
    });
    const guardedPort: EspnLiveDraftPort = {
      ...port(acceptedResponse),
      latest: (deviceToken) =>
        deviceToken === DEVICE_TOKEN
          ? Promise.resolve(pulseResponse)
          : Promise.reject(
              new EspnLiveDraftError(
                "OUT_OF_SCOPE",
                "ESPN league season is outside this bridge device scope",
              ),
            ),
    };
    const app = await appWith(guardedPort);

    const validBridge = await app.inject({
      method: "GET",
      url: "/v1/bridge/espn/live-draft/latest?leagueId=1234567&season=2026",
      headers: { authorization: `Bridge ${DEVICE_TOKEN}` },
    });
    expect(validBridge.statusCode).toBe(200);
    expect(validBridge.headers["x-ratelimit-limit"]).toBe("960");

    let lastRotatedResponse;
    for (let index = 0; index < 1_919; index += 1) {
      lastRotatedResponse = await app.inject({
        method: "GET",
        url: "/v1/bridge/espn/live-draft/latest?leagueId=1234567&season=2026",
        headers: { authorization: `Bridge ${`forged-${index}`.padEnd(32, "x")}` },
      });
    }
    expect(lastRotatedResponse?.statusCode).toBe(403);

    const blockedRotation = await app.inject({
      method: "GET",
      url: "/v1/bridge/espn/live-draft/latest?leagueId=1234567&season=2026",
      headers: { authorization: `Bridge ${"z".repeat(32)}` },
    });
    expect(blockedRotation.statusCode).toBe(429);
    expect(blockedRotation.headers["x-ratelimit-limit"]).toBe("1920");
    expect(problemType(blockedRotation.json())).toContain("rate-limit");

    const validDraftRead = await app.inject({
      method: "GET",
      url: "/v1/bridge/espn/live-draft/latest?leagueId=1234567&season=2026",
      headers: { authorization: `DraftRead ${capability.token}` },
    });
    expect(validDraftRead.statusCode).toBe(200);
    expect(validDraftRead.headers["x-ratelimit-limit"]).toBe("960");
    await app.close();
  });

  it("rejects DraftRead route confusion before any mutating bridge handler", async () => {
    const token = mintDraftReadToken({
      sessionSecret: DRAFT_READ_SECRET,
      userId: USER_ID,
      leagues: [{ leagueId: "1234567", season: 2026 }],
      lifetimeSeconds: 3_600,
    }).token;
    const app = await appWith(port(acceptedResponse));
    for (const request of [
      { method: "POST" as const, url: "/v1/bridge/espn/live-draft", payload: observation() },
      { method: "POST" as const, url: "/v1/bridge/espn/snapshots", payload: {} },
      { method: "GET" as const, url: "/health/live" },
    ]) {
      const response = await app.inject({
        ...request,
        headers: { authorization: `DraftRead ${token}` },
      });
      expect(response.statusCode).toBe(401);
      expect(problemType(response.json())).toContain("draft-read-unauthorized");
    }
    await app.close();
  });

  it("refuses an accidental response field instead of leaking repository identity", async () => {
    const leakingPort: EspnLiveDraftPort = {
      ...port(acceptedResponse),
      latest: () =>
        Promise.resolve({
          ...pulseResponse,
          deviceId: "60000000-0000-4000-8000-000000000001",
        } as EspnLiveDraftPulseResponse),
    };
    const app = await appWith(leakingPort);
    const response = await app.inject({
      method: "GET",
      url: "/v1/bridge/espn/live-draft/latest?leagueId=1234567&season=2026",
      headers: { authorization: `Bridge ${DEVICE_TOKEN}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("60000000-0000-4000-8000-000000000001");
    await app.close();
  });

  it("keeps the polling path outside browser CORS", async () => {
    const app = await appWith(port(acceptedResponse));
    const response = await app.inject({
      method: "OPTIONS",
      url: "/v1/bridge/espn/live-draft/latest?leagueId=1234567&season=2026",
      headers: {
        origin: "https://fantasy.espn.com",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    await app.close();
  });
});

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

  it("publishes for accepted boards and idempotent transient revisions, but not standby", async () => {
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
    expect(seen).toEqual([expect.objectContaining({ feedRevision: 1_000_008 })]);
    expect(seen[0]).not.toHaveProperty("feedCursor");

    const transient = await appWith(
      port({ ...acceptedResponse, status: "idempotent", feedCursor: "2000004" }),
      hub,
    );
    await transient.inject({
      method: "POST",
      url: "/v1/bridge/espn/live-draft",
      headers: { authorization: `Bridge ${DEVICE_TOKEN}` },
      payload: observation({ revision: 2 }),
    });
    await transient.close();
    expect(seen).toEqual([
      expect.objectContaining({ feedRevision: 1_000_008 }),
      expect.objectContaining({ feedRevision: 2_000_004 }),
    ]);

    const holding = await appWith(port({ ...acceptedResponse, status: "standby" }), hub);
    await holding.inject({
      method: "POST",
      url: "/v1/bridge/espn/live-draft",
      headers: { authorization: `Bridge ${DEVICE_TOKEN}` },
      payload: observation(),
    });
    await holding.close();
    expect(seen).toHaveLength(2);

    const unsafeCursor = await appWith(
      port({ ...acceptedResponse, status: "idempotent", feedCursor: "9007199254740992" }),
      hub,
    );
    await unsafeCursor.inject({
      method: "POST",
      url: "/v1/bridge/espn/live-draft",
      headers: { authorization: `Bridge ${DEVICE_TOKEN}` },
      payload: observation({ revision: 3 }),
    });
    await unsafeCursor.close();
    expect(seen).toHaveLength(2);
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
      feedRevision: 1_000_031,
      occurredAt: "2026-08-24T18:05:00.000Z",
    });
    expect(frame).toContain("event: draft-invalidated");
    expect(frame.endsWith("\n\n")).toBe(true);
    const data = frame.split("data: ")[1]!.trim();
    expect(JSON.parse(data)).toMatchObject({
      sequence: 12,
      feedRevision: 1_000_031,
    });
  });
});
