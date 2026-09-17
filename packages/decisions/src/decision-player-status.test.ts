import { describe, expect, it } from "vitest";
import {
  decisionStatusSourceIsCurrent,
  normalizedDecisionStatus,
  resolveDecisionHealthStatus,
  type DecisionStatusSource,
} from "./decision-player-status.js";

const now = new Date("2026-09-17T23:00:00Z");
const kickoff = new Date("2026-09-20T20:05:00Z");
const source: DecisionStatusSource = {
  enabled: true,
  lastChecksum: "current",
  lastSuccessfulAt: now,
  lastCheckedAt: now,
  consecutiveFailures: 0,
  checkIntervalMinutes: 60,
  metadata: {},
};

describe("decision player health evidence", () => {
  it.each(["ACT", "active", "Healthy"])(
    "normalizes %s without assuming it is verified health evidence",
    (raw) => {
      expect(normalizedDecisionStatus(raw)).toBe("ACTIVE");
      expect(resolveDecisionHealthStatus([], kickoff, now)).toBe("UNKNOWN");
    },
  );
  it.each([
    ["Q", "QUESTIONABLE"],
    ["O", "OUT"],
    ["D", "DOUBTFUL"],
    ["Reserve/Injured", "IR"],
    ["inactive", "NA"],
  ])("preserves %s as %s", (raw, expected) => {
    expect(normalizedDecisionStatus(raw)).toBe(expected);
  });
  it("keeps known injury separate from active roster eligibility and clears it after explicit newer recovery", () => {
    const injury = {
      status: "QUESTIONABLE" as const,
      observedAt: new Date("2026-09-17T18:00:00Z"),
    };
    expect(
      resolveDecisionHealthStatus(
        [injury, { status: "ACTIVE", observedAt: new Date("2026-09-17T17:00:00Z") }],
        kickoff,
        now,
      ),
    ).toBe("QUESTIONABLE");
    expect(
      resolveDecisionHealthStatus(
        [injury, { status: "ACTIVE", observedAt: new Date("2026-09-17T19:00:00Z") }],
        kickoff,
        now,
      ),
    ).toBe("ACTIVE");
    expect(
      resolveDecisionHealthStatus([{ status: "OUT", observedAt: now }, injury], kickoff, now),
    ).toBe("OUT");
  });
  it("does not admit future observations or stretch short-term injuries beyond a week", () => {
    expect(
      resolveDecisionHealthStatus(
        [{ status: "QUESTIONABLE", observedAt: new Date(now.getTime() + 1) }],
        kickoff,
        now,
      ),
    ).toBe("UNKNOWN");
    expect(
      resolveDecisionHealthStatus(
        [{ status: "QUESTIONABLE", observedAt: now }],
        new Date("2026-09-27T17:00:00Z"),
        now,
      ),
    ).toBe("UNKNOWN");
    expect(
      resolveDecisionHealthStatus(
        [{ status: "IR", observedAt: now }],
        new Date("2026-09-27T17:00:00Z"),
        now,
      ),
    ).toBe("IR");
    expect(
      resolveDecisionHealthStatus(
        [{ status: "IR", observedAt: now }],
        new Date("2026-10-27T17:00:00Z"),
        now,
      ),
    ).toBe("UNKNOWN");
    expect(resolveDecisionHealthStatus([{ status: "OUT", observedAt: now }], null, now)).toBe(
      "UNKNOWN",
    );
  });
  it("requires the selected source to be fresh, healthy and outside a refresh transaction", () => {
    expect(decisionStatusSourceIsCurrent(source, now)).toBe(true);
    for (const overrides of [
      { enabled: false },
      { lastChecksum: null },
      { consecutiveFailures: 1 },
      { lastCheckedAt: new Date(now.getTime() + 1) },
      { lastSuccessfulAt: new Date(now.getTime() - 211 * 60_000) },
      { metadata: { availability: "unavailable" } },
      { metadata: { publishable: false } },
      { metadata: { refreshClaimedAt: now.toISOString() } },
    ])
      expect(decisionStatusSourceIsCurrent({ ...source, ...overrides }, now)).toBe(false);
  });
});
