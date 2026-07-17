import { describe, expect, it } from "vitest";

import {
  CredentialEnvelopeError,
  decryptCredential,
  encryptCredential,
  parseCredentialKey,
} from "./credentials.js";

const KEY = parseCredentialKey(`base64:${Buffer.alloc(32, 7).toString("base64")}`, {
  keyId: "test-key-2026",
});

describe("credential envelopes", () => {
  it("round trips credentials in a versioned AES-256-GCM envelope", () => {
    const envelope = encryptCredential(
      { accessToken: "access-value", refreshToken: "refresh-value" },
      KEY,
      {
        purpose: "provider:yahoo",
        now: () => new Date("2026-07-16T12:00:00.000Z"),
        randomBytes: () => Uint8Array.from({ length: 12 }, (_, index) => index),
      },
    );

    expect(envelope).toMatchObject({
      version: 1,
      algorithm: "aes-256-gcm",
      keyId: "test-key-2026",
      purpose: "provider:yahoo",
      createdAt: "2026-07-16T12:00:00.000Z",
    });
    expect(envelope.ciphertext).not.toContain("access-value");
    expect(decryptCredential(envelope, KEY, { expectedPurpose: "provider:yahoo" })).toEqual({
      accessToken: "access-value",
      refreshToken: "refresh-value",
    });
  });

  it("authenticates ciphertext and metadata", () => {
    const envelope = encryptCredential({ refreshToken: "secret" }, KEY, {
      purpose: "provider:yahoo",
    });
    const tampered = {
      ...envelope,
      ciphertext: `${envelope.ciphertext.slice(0, -1)}${
        envelope.ciphertext.endsWith("A") ? "B" : "A"
      }`,
    };

    expect(() =>
      decryptCredential(tampered, KEY, { expectedPurpose: "provider:yahoo" }),
    ).toThrowError(CredentialEnvelopeError);
    expect(() => decryptCredential(envelope, KEY, { expectedPurpose: "provider:espn" })).toThrow(
      /purpose/i,
    );
    expect(() =>
      decryptCredential({ ...envelope, debug: "unauthenticated metadata" }, KEY, {
        expectedPurpose: "provider:yahoo",
      }),
    ).toThrow(/unknown fields/i);
  });

  it("requires an explicitly encoded 32-byte key", () => {
    expect(() => parseCredentialKey("correct horse battery staple")).toThrow(/prefix/i);
    expect(() => parseCredentialKey("hex:abcd")).toThrow(/64 hexadecimal/i);
    expect(parseCredentialKey(`hex:${"ab".repeat(32)}`).keyBytes).toHaveLength(32);
    expect(
      parseCredentialKey(`base64url:${Buffer.alloc(32, 3).toString("base64url")}`).keyBytes,
    ).toHaveLength(32);
  });
});
