import type { AuthenticationCapability } from "@laces-out/connectors";
import type { ProviderName } from "@laces-out/db";

/**
 * A server-refresh circuit breaker whose storage scope is chosen by the caller.
 *
 * Yahoo stores it on a provider connection; ESPN stores it on the exact provider/league link.
 * Repeated failure therefore opens a circuit without taking down unrelated analysis, another
 * provider, another ESPN league, the `recommendation-recompute` queue, or any `data_sources`-gated
 * projection work.
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
 * a replayable, explicitly authorized credential. Browser-only ESPN devices are not provider
 * connections and therefore never enter this circuit.
 */
const SERVER_REFRESHABLE_AUTHENTICATION: Readonly<
  Record<"yahoo" | "espn", AuthenticationCapability>
> = {
  yahoo: "oauth2-authorization-code-pkce",
  espn: "server-session-cookie",
};

/**
 * Decide from the stored connection capability, not the provider name. ESPN can have browser-only,
 * public, and encrypted server-session connections at the same time; treating every ESPN row as
 * replayable would send browser-only work into a server credential path that can never succeed.
 */
export function connectionSupportsServerRefresh(
  provider: ProviderName,
  capabilities: unknown,
): boolean {
  if (provider !== "yahoo" && provider !== "espn") return false;
  if (capabilities === null || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return false;
  }
  if (!("authentication" in capabilities)) return false;
  const { authentication } = capabilities;
  if (!Array.isArray(authentication)) return false;
  return authentication.includes(SERVER_REFRESHABLE_AUTHENTICATION[provider]);
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
 * formulas: a provider sync recovers on a user action (re-authorize, repair the league) far sooner
 * than a vendor data release lands, so an hour is the right ceiling rather than a day.
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
