import { describe, expect, it } from "vitest";

import {
  escapeHtml,
  renderEmailConfirmationEmail,
  renderLeagueSyncNudgeEmail,
  renderPasswordResetEmail,
} from "./templates.js";

const webUrl = "https://lacesout.app";

describe("escapeHtml", () => {
  it("neutralizes every HTML metacharacter", () => {
    expect(escapeHtml(`<img src="x" onerror='alert(1)'>&`)).toBe(
      "&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;&amp;",
    );
  });
});

describe("renderEmailConfirmationEmail", () => {
  const confirmUrl = "https://lacesout.app/verify-email#abc123";

  it("carries the confirmation link as button and paste-able fallback, and states the window", () => {
    const rendered = renderEmailConfirmationEmail({
      displayName: "Mack",
      confirmUrl,
      expiresHours: 24,
    });
    expect(rendered.subject).toBe("Confirm your email to open your locker room");
    expect(rendered.html.split(escapeHtml(confirmUrl))).toHaveLength(3);
    expect(rendered.text).toContain(confirmUrl);
    expect(rendered.html).toContain("24 hours");
    expect(rendered.text).toContain("24 hours");
    expect(rendered.text).toContain("Mack");
  });

  it("tells an unintended recipient that ignoring it is safe", () => {
    const rendered = renderEmailConfirmationEmail({
      displayName: "Mack",
      confirmUrl,
      expiresHours: 24,
    });
    expect(rendered.text).toContain("Ignore this email and nothing will happen");
  });

  it("escapes a hostile display name instead of rendering it", () => {
    const rendered = renderEmailConfirmationEmail({
      displayName: `<script>alert("x")</script>`,
      confirmUrl,
      expiresHours: 24,
    });
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;");
  });
});

describe("renderPasswordResetEmail", () => {
  const resetUrl = "https://lacesout.app/reset-password#abc123";

  it("carries the reset link as button and paste-able fallback, and states the window", () => {
    const rendered = renderPasswordResetEmail({
      displayName: "Mack",
      resetUrl,
      expiresMinutes: 30,
    });
    expect(rendered.subject).toBe("Reset your Laces Out password");
    expect(rendered.html.split(escapeHtml(resetUrl))).toHaveLength(3);
    expect(rendered.text).toContain(resetUrl);
    expect(rendered.html).toContain("30 minutes");
    expect(rendered.text).toContain("30 minutes");
  });

  it("tells an unintended recipient the account is safe", () => {
    const rendered = renderPasswordResetEmail({
      displayName: "Mack",
      resetUrl,
      expiresMinutes: 30,
    });
    expect(rendered.text).toContain("your password is unchanged");
    expect(rendered.text).toContain("signs out every device");
  });
});

describe("renderLeagueSyncNudgeEmail", () => {
  it("links to connections and offers the settings opt-out", () => {
    const rendered = renderLeagueSyncNudgeEmail({ displayName: "Mack", webUrl });
    expect(rendered.subject).toBe("One step left: sync your league");
    expect(rendered.html).toContain(`href="https://lacesout.app/connections"`);
    expect(rendered.html).toContain(`href="https://lacesout.app/settings"`);
    expect(rendered.text).toContain("https://lacesout.app/connections");
    expect(rendered.text).toContain("https://lacesout.app/settings");
    expect(rendered.text).toContain("only reminder");
  });
});

describe("shared layout", () => {
  it("renders a plain-text alternative for every message", () => {
    for (const rendered of [
      renderEmailConfirmationEmail({
        displayName: "A",
        confirmUrl: `${webUrl}/v`,
        expiresHours: 24,
      }),
      renderPasswordResetEmail({ displayName: "A", resetUrl: `${webUrl}/r`, expiresMinutes: 30 }),
      renderLeagueSyncNudgeEmail({ displayName: "A", webUrl }),
    ]) {
      expect(rendered.text).not.toContain("<");
      expect(rendered.text.length).toBeGreaterThan(100);
      expect(rendered.html).toContain("LACES&nbsp;OUT");
    }
  });
});
