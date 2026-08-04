import { describe, expect, it } from "vitest";

import {
  espnBridgeDeviceRequestSchema,
  espnBridgeSnapshotSchema,
  espnSupplementalBridgeSnapshotSchema,
} from "./index.js";

const nativeEnvelope = {
  schemaVersion: 1,
  provider: "espn",
  authority: "native-local",
  readOnly: true,
  leagueId: "123456789",
  season: 2026,
  capturedAt: "2026-08-03T18:00:00.000Z",
  endpoint:
    "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/123456789?view=mSettings",
  checksumSha256: "a".repeat(64),
  checksumAlgorithm: "canonical-json-v1-sha256",
  payload: { id: 123456789, seasonId: 2026 },
} as const;

describe("ESPN automated refresh contracts", () => {
  it("retains an explicit native client, agent capability, and league-season scope", () => {
    expect(
      espnBridgeDeviceRequestSchema.parse({
        name: "Mack's iPhone",
        clientKind: "ios-app",
        agentCapabilities: ["refresh-intents-v1"],
        season: 2026,
        allowedLeagueIds: ["123456789"],
      }),
    ).toEqual({
      name: "Mack's iPhone",
      clientKind: "ios-app",
      agentCapabilities: ["refresh-intents-v1"],
      season: 2026,
      allowedLeagueIds: ["123456789"],
    });
    expect(
      espnBridgeDeviceRequestSchema.safeParse({
        name: "Mack's iPhone",
        clientKind: "ios-app",
        season: 2026,
        allowedLeagueIds: ["123456789"],
      }).success,
    ).toBe(false);
    expect(
      espnBridgeDeviceRequestSchema.safeParse({
        name: "Mack's iPhone",
        clientKind: "ios-app",
        agentCapabilities: ["refresh-intents-v1"],
        allowedLeagueIds: ["123456789"],
      }).success,
    ).toBe(false);
  });

  it("requires portable checksum provenance from native core and supplemental agents", () => {
    expect(espnBridgeSnapshotSchema.safeParse(nativeEnvelope).success).toBe(true);
    expect(
      espnBridgeSnapshotSchema.safeParse({ ...nativeEnvelope, checksumAlgorithm: undefined })
        .success,
    ).toBe(false);
    expect(
      espnSupplementalBridgeSnapshotSchema.safeParse({
        ...nativeEnvelope,
        kind: "structured-transactions",
        week: 4,
      }).success,
    ).toBe(true);
    expect(
      espnSupplementalBridgeSnapshotSchema.safeParse({
        ...nativeEnvelope,
        checksumAlgorithm: "json-stringify-sha256",
        kind: "structured-transactions",
        week: 4,
      }).success,
    ).toBe(false);
  });

  it("keeps published browser envelopes compatible without an algorithm field", () => {
    expect(
      espnBridgeSnapshotSchema.safeParse({
        ...nativeEnvelope,
        authority: "browser-local",
        checksumAlgorithm: undefined,
      }).success,
    ).toBe(true);
  });
});
