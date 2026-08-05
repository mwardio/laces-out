import { describe, expect, it } from "vitest";

import {
  CONNECTION_CIRCUIT_FAILURE_THRESHOLD,
  connectionSupportsServerRefresh,
  evaluateConnectionCircuit,
  nextCircuitOpenUntil,
} from "./connection-circuit.js";

const now = new Date("2026-09-10T12:00:00.000Z");

describe("evaluateConnectionCircuit", () => {
  it("stays closed below the failure threshold", () => {
    expect(
      evaluateConnectionCircuit({
        consecutiveFailures: CONNECTION_CIRCUIT_FAILURE_THRESHOLD - 1,
        circuitOpenUntil: null,
        now,
      }),
    ).toEqual({ state: "closed", retryAfterSeconds: null });
  });

  it("reports an open circuit while the cooldown has not elapsed", () => {
    expect(
      evaluateConnectionCircuit({
        consecutiveFailures: CONNECTION_CIRCUIT_FAILURE_THRESHOLD,
        circuitOpenUntil: new Date(now.getTime() + 120_000),
        now,
      }),
    ).toEqual({ state: "open", retryAfterSeconds: 120 });
  });

  it("closes again once the cooldown elapses so one bad hour is not permanent", () => {
    expect(
      evaluateConnectionCircuit({
        consecutiveFailures: 9,
        circuitOpenUntil: new Date(now.getTime() - 1_000),
        now,
      }),
    ).toEqual({ state: "closed", retryAfterSeconds: null });
  });

  it("never opens on a stale timestamp without accumulated failures", () => {
    expect(
      evaluateConnectionCircuit({
        consecutiveFailures: 0,
        circuitOpenUntil: new Date(now.getTime() + 600_000),
        now,
      }),
    ).toEqual({ state: "closed", retryAfterSeconds: null });
  });

  it("rounds a sub-second remainder up so an open circuit never reports zero seconds", () => {
    expect(
      evaluateConnectionCircuit({
        consecutiveFailures: CONNECTION_CIRCUIT_FAILURE_THRESHOLD,
        circuitOpenUntil: new Date(now.getTime() + 400),
        now,
      }),
    ).toEqual({ state: "open", retryAfterSeconds: 1 });
  });
});

describe("nextCircuitOpenUntil", () => {
  it("returns null until the threshold is reached", () => {
    expect(nextCircuitOpenUntil({ consecutiveFailures: 4, now })).toBeNull();
  });

  it("backs off exponentially from the threshold and caps at one hour", () => {
    expect(nextCircuitOpenUntil({ consecutiveFailures: 5, now })?.toISOString()).toBe(
      "2026-09-10T12:01:00.000Z",
    );
    expect(nextCircuitOpenUntil({ consecutiveFailures: 6, now })?.toISOString()).toBe(
      "2026-09-10T12:02:00.000Z",
    );
    expect(nextCircuitOpenUntil({ consecutiveFailures: 60, now })?.toISOString()).toBe(
      "2026-09-10T13:00:00.000Z",
    );
  });
});

describe("connectionSupportsServerRefresh", () => {
  it("admits Yahoo OAuth connections", () => {
    expect(
      connectionSupportsServerRefresh("yahoo", {
        authentication: ["oauth2-authorization-code-pkce"],
      }),
    ).toBe(true);
  });

  it("admits only ESPN connections with a stored server-session capability", () => {
    expect(
      connectionSupportsServerRefresh("espn", { authentication: ["server-session-cookie"] }),
    ).toBe(true);
    expect(connectionSupportsServerRefresh("espn", { authentication: ["browser-session"] })).toBe(
      false,
    );
  });

  it("fails closed for manual or malformed capability records", () => {
    expect(connectionSupportsServerRefresh("manual", { authentication: ["manual-import"] })).toBe(
      false,
    );
    expect(connectionSupportsServerRefresh("espn", {})).toBe(false);
    expect(
      connectionSupportsServerRefresh("espn", { authentication: "server-session-cookie" }),
    ).toBe(false);
  });
});
