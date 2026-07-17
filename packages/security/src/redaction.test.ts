import { describe, expect, it } from "vitest";

import { REDACTED, redactSecrets, redactText } from "./redaction.js";

describe("secret redaction", () => {
  it("redacts provider tokens and cookie fields recursively without mutating input", () => {
    const input = {
      access_token: "access-secret",
      nested: {
        refreshToken: "refresh-secret",
        token_type: "bearer",
        headers: { Cookie: "espn_s2=session-secret; SWID={fake-guid}" },
      },
    };

    expect(redactSecrets(input)).toEqual({
      access_token: REDACTED,
      nested: {
        refreshToken: REDACTED,
        token_type: "bearer",
        headers: { Cookie: REDACTED },
      },
    });
    expect(input.access_token).toBe("access-secret");
  });

  it("redacts OAuth values in JSON, URLs, and headers", () => {
    const message = [
      'failed {"refresh_token":"rotate-me"}',
      "https://example.test/cb?access_token=visible&ok=1",
      "Authorization: Bearer access-value",
      "Cookie: espn_s2=session-value; SWID={value}",
      "request contained Cookie: arbitrary-session=value",
    ].join("\n");

    const redacted = redactText(message);
    expect(redacted).not.toContain("rotate-me");
    expect(redacted).not.toContain("visible");
    expect(redacted).not.toContain("access-value");
    expect(redacted).not.toContain("session-value");
    expect(redacted).not.toContain("arbitrary-session");
    expect(redacted).toContain("ok=1");
  });
});
