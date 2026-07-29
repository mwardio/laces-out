import { ESPN_BROWSER_BRIDGE_CAPABILITIES } from "@fantasy/connector-espn";
import { YAHOO_CAPABILITIES } from "@fantasy/connector-yahoo";
import type { AuthenticationCapability, ProviderCapabilities } from "@fantasy/connectors";
import type { ProviderName } from "@fantasy/db";

/**
 * A connection-scoped circuit breaker.
 *
 * `ENHANCEMENT_PLAN.md` §2.4 requires repeated failure to open a circuit "without taking down
 * unrelated analysis". The state lives on the `provider_connections` row and nothing else reads it,
 * so an open circuit for one connection is structurally incapable of affecting another connection,
 * another provider, another league's analysis, the `recommendation-recompute` queue, or any
 * `data_sources`-gated projection work.
 *
 * Both functions are pure: no clock, no database, no `Math.random`.
 */

/**
 * Matches the `league-sync` queue's `retryLimit: 5`. One job's exhausted retry budget is therefore
 * exactly what opens the circuit — the two numbers are one decision, not two.
 */
export const CONNECTION_CIRCUIT_FAILURE_THRESHOLD = 5;

/** One minute after the threshold, doubling per additional failure, capped at one hour. */
const CIRCUIT_BASE_COOLDOWN_SECONDS = 60;
const CIRCUIT_MAX_COOLDOWN_SECONDS = 60 * 60;

/**
 * The credential mode that lets a server refresh a league on the user's behalf. ESPN advertises
 * `browser-session`, so its credential never reaches Laces Out and no server-initiated read is
 * possible (ADR 0002); Yahoo advertises the PKCE authorization-code flow, whose refresh token the
 * server holds.
 */
const SERVER_REFRESHABLE_AUTHENTICATION: AuthenticationCapability =
  "oauth2-authorization-code-pkce";

const providerCapabilities: Partial<Record<ProviderName, ProviderCapabilities>> = {
  yahoo: YAHOO_CAPABILITIES,
  espn: ESPN_BROWSER_BRIDGE_CAPABILITIES,
};

/**
 * Derived from the existing capability objects rather than a new provider registry. A provider is
 * server-refreshable exactly when it advertises a credential the server can hold and replay.
 */
export function providerSupportsServerRefresh(provider: ProviderName): boolean {
  const capabilities = providerCapabilities[provider];
  if (!capabilities) return false;
  return capabilities.authentication.includes(SERVER_REFRESHABLE_AUTHENTICATION);
}

export interface ConnectionCircuitState {
  readonly state: "closed" | "open";
  readonly retryAfterSeconds: number | null;
}

export interface ConnectionCircuitInput {
  readonly consecutiveFailures: number;
  readonly circuitOpenUntil: Date | null;
  readonly now: Date;
}

/**
 * Open only while *both* the failure count has reached the threshold and the cooldown has not
 * elapsed. Requiring both means a stale `circuit_open_until` left behind by a reset counter cannot
 * block a healthy connection, and an elapsed cooldown always closes the circuit on its own — no
 * manual intervention is needed to recover from a transient provider outage.
 */
export function evaluateConnectionCircuit(input: ConnectionCircuitInput): ConnectionCircuitState {
  const closed = { state: "closed", retryAfterSeconds: null } as const;
  if (input.consecutiveFailures < CONNECTION_CIRCUIT_FAILURE_THRESHOLD) return closed;
  if (!input.circuitOpenUntil) return closed;
  const remainingMs = input.circuitOpenUntil.getTime() - input.now.getTime();
  if (remainingMs <= 0) return closed;
  return { state: "open", retryAfterSeconds: Math.ceil(remainingMs / 1000) };
}

export interface CircuitCooldownInput {
  readonly consecutiveFailures: number;
  readonly now: Date;
}

/**
 * Deliberately shorter and independently derived from the six duplicated `data_sources` backoff
 * formulas: a provider connection recovers on a user action (re-authorize, repair the league) far
 * sooner than a vendor data release lands, so an hour is the right ceiling rather than a day.
 */
export function nextCircuitOpenUntil(input: CircuitCooldownInput): Date | null {
  if (input.consecutiveFailures < CONNECTION_CIRCUIT_FAILURE_THRESHOLD) return null;
  const excess = input.consecutiveFailures - CONNECTION_CIRCUIT_FAILURE_THRESHOLD;
  // Cap the exponent before shifting so a long-broken connection cannot overflow to Infinity.
  const cooldownSeconds = Math.min(
    CIRCUIT_BASE_COOLDOWN_SECONDS * 2 ** Math.min(excess, 16),
    CIRCUIT_MAX_COOLDOWN_SECONDS,
  );
  return new Date(input.now.getTime() + cooldownSeconds * 1000);
}
