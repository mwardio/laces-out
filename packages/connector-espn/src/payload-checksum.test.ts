import { describe, expect, it } from "vitest";

import {
  canonicalEspnPayloadChecksumV1,
  canonicalEspnPayloadJsonV1,
  espnPayloadChecksumMatches,
  legacyBrowserEspnPayloadChecksum,
} from "./payload-checksum.js";

describe("portable ESPN payload checksums", () => {
  it("pins a cross-client canonical JSON golden vector", () => {
    const payload = {
      zebra: [true, null, "line\nfeed", -0, 12.5],
      "10": { é: "snowman ☃", a: 1 },
      "2": "numeric-looking keys are sorted as text",
      alpha: { y: 2, x: 1 },
    };

    expect(canonicalEspnPayloadJsonV1(payload)).toBe(
      '{"10":{"a":1,"é":"snowman ☃"},"2":"numeric-looking keys are sorted as text","alpha":{"x":1,"y":2},"zebra":[true,null,"line\\nfeed",0,12.5]}',
    );
    expect(canonicalEspnPayloadChecksumV1(payload)).toBe(
      "54cf737c0dd3548b299f364e15f7b2b7e73c30dcf24b00d841aa7fc5e34429a2",
    );
  });

  it("requires portable checksums for native agents but accepts published browser checksums", () => {
    const payload = { z: 1, a: 2 };
    const legacy = legacyBrowserEspnPayloadChecksum(payload);
    const portable = canonicalEspnPayloadChecksumV1(payload);
    expect(legacy).not.toBe(portable);
    expect(
      espnPayloadChecksumMatches({ payload, checksumSha256: legacy, authority: "browser-local" }),
    ).toBe(true);
    expect(
      espnPayloadChecksumMatches({ payload, checksumSha256: legacy, authority: "native-local" }),
    ).toBe(false);
    expect(
      espnPayloadChecksumMatches({ payload, checksumSha256: portable, authority: "native-local" }),
    ).toBe(true);
  });

  it("rejects values that cannot occur in JSON", () => {
    expect(() => canonicalEspnPayloadJsonV1({ invalid: undefined })).toThrow("only JSON values");
    expect(() => canonicalEspnPayloadJsonV1(Number.POSITIVE_INFINITY)).toThrow("finite");
  });
});
