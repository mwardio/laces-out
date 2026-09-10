import type { CaptureResult, Properties } from "posthog-js";

const pages = new Set([
  "/",
  "/app",
  "/login",
  "/register",
  "/invite",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
  "/account-deleted",
  "/connections",
  "/connections/yahoo/connect",
  "/decisions",
  "/draft",
  "/film-room",
  "/analytics",
  "/projections",
  "/rankings",
  "/rankings/shared",
  "/stats",
  "/schedule",
  "/settings",
  "/ios",
  "/methodology",
  "/privacy",
  "/terms",
]);

export const productEvents = [
  "tour_started",
  "signup_submitted",
  "signup_verification_required",
  "signup_completed",
  "email_verified",
  "invitation_accepted",
  "login_completed",
  "league_sync_completed",
  "film_room_analysis_completed",
  "reckoning_recap_generated",
  "feature_viewed",
] as const;
export type ProductEvent = (typeof productEvents)[number];

export interface ProductEventProperties {
  readonly provider?: "espn" | "yahoo";
  readonly method?: "open" | "invite_code" | "invitation" | "email_verification";
  readonly feature?: string;
}

export function analyticsPath(pathname: string): string {
  if (pages.has(pathname)) return pathname;
  if (/^\/stats\/players\/[^/]+\/?$/u.test(pathname)) return "/stats/players/:playerId";
  return "/other";
}

const allowedEvents = new Set<string>(["$pageview", "$identify", ...productEvents]);
const allowedProperties = new Set([
  "token",
  "distinct_id",
  "$anon_distinct_id",
  "$device_id",
  "$user_id",
  "$session_id",
  "$window_id",
  "$insert_id",
  "$time",
  "$lib",
  "$lib_version",
  "$browser",
  "$browser_version",
  "$os",
  "$os_version",
  "$device_type",
  "$host",
  "$screen_height",
  "$screen_width",
  "$viewport_height",
  "$viewport_width",
  "$is_identified",
  "$process_person_profile",
  "$referring_domain",
  "$initial_referring_domain",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "$initial_utm_source",
  "$initial_utm_medium",
  "$initial_utm_campaign",
  "provider",
  "method",
  "feature",
  "mode",
]);
const urlProperties = new Set([
  "$current_url",
  "$initial_current_url",
  "$session_entry_url",
  "$referrer",
  "$initial_referrer",
]);

function safeUrl(value: unknown, referrer: boolean): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "$direct" && referrer) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    // Referring paths can contain another site's private identifiers. Only retain its origin.
    return referrer ? url.origin : `${url.origin}${analyticsPath(url.pathname)}`;
  } catch {
    return undefined;
  }
}

function safeProperties(properties: Properties, nested = false): Properties {
  const safe: Properties = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!nested && (key === "$set" || key === "$set_once")) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        safe[key] = safeProperties(value as Properties, true);
      }
    } else if (urlProperties.has(key)) {
      const url = safeUrl(value, key.endsWith("referrer"));
      if (url) safe[key] = url;
    } else if (key === "$pathname") {
      if (typeof value === "string") safe[key] = analyticsPath(value);
    } else if (allowedProperties.has(key)) {
      if (typeof value === "string") safe[key] = value.slice(0, 200);
      else if (
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      ) {
        safe[key] = value;
      }
    }
  }
  return safe;
}

/** Applied to SDK-generated properties too, including nested first-touch person properties. */
export function sanitizeAnalyticsEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event || !allowedEvents.has(event.event)) return null;
  return {
    uuid: event.uuid,
    event: event.event,
    properties: safeProperties(event.properties),
    ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    ...(event.$set ? { $set: safeProperties(event.$set, true) } : {}),
    ...(event.$set_once ? { $set_once: safeProperties(event.$set_once, true) } : {}),
  };
}

export const featureForPath: Readonly<Record<string, string>> = {
  "/decisions": "decision_desk",
  "/draft": "draft_studio",
  "/film-room": "film_room",
  "/analytics": "weekly_reckoning",
  "/projections": "projection_lab",
  "/rankings": "rankings",
  "/stats": "research",
  "/schedule": "matchup_outlook",
};

/** A first status read is history, not a new sync. Subsequent new receipts count once. */
export function createLeagueSyncObserver() {
  let previous: Map<string, string | null> | null = null;
  return (
    receipts: readonly { readonly id: string; readonly observedAt: string | null }[],
  ): number => {
    if (!previous) {
      previous = new Map(receipts.map(({ id, observedAt }) => [id, observedAt]));
      return 0;
    }
    let completed = 0;
    for (const receipt of receipts) {
      const last = previous.get(receipt.id);
      if (receipt.observedAt && (!last || receipt.observedAt > last)) {
        completed++;
        previous.set(receipt.id, receipt.observedAt);
      }
    }
    return completed;
  };
}
