import type { PostHog } from "posthog-js/dist/module.no-external";

import { apiBaseUrl, parseAuthenticatedSession, type SessionUser } from "./api-session";
import {
  analyticsPath,
  featureForPath,
  sanitizeAnalyticsEvent,
  type ProductEvent,
  type ProductEventProperties,
} from "./product-analytics-policy";
import { publicSiteUrl } from "./public-site";

const exclusionKey = "laces-out:analytics-excluded";
let clientPromise: Promise<PostHog | null> | undefined;
let client: PostHog | null = null;
let stopped = false;
let memberId: string | null = null;
let lastPath: string | null = null;
let tourCaptured = false;

function enabled(): boolean {
  return (
    typeof window !== "undefined" &&
    process.env.NODE_ENV === "production" &&
    Boolean(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN?.trim()) &&
    ["us", "eu"].includes(process.env.NEXT_PUBLIC_POSTHOG_REGION ?? "") &&
    window.location.origin === publicSiteUrl.origin &&
    publicSiteUrl.protocol === "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(publicSiteUrl.hostname)
  );
}

async function initialize(): Promise<PostHog | null> {
  if (!enabled() || stopped) return null;
  try {
    if (window.localStorage.getItem(exclusionKey) === "true" || navigator.doNotTrack === "1") {
      return null;
    }
    // Check before loading the SDK or sending the first pageview, including on public pages.
    const response = await fetch(`${apiBaseUrl}/v1/auth/session`, {
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    const session = response.ok ? parseAuthenticatedSession(await response.json()) : null;
    if (response.status !== 401 && !session) return null;
    if (session?.user.role === "admin") {
      window.localStorage.setItem(exclusionKey, "true");
      return null;
    }
    if (stopped) return null;
    // Bundle locally and load after hydration. No remote replay, toolbar, or survey scripts.
    const { default: posthog } = await import("posthog-js/dist/module.no-external");
    if (stopped) return null;
    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!.trim(), {
      api_host:
        process.env.NEXT_PUBLIC_POSTHOG_REGION === "eu"
          ? "https://eu.i.posthog.com"
          : "https://us.i.posthog.com",
      ui_host:
        process.env.NEXT_PUBLIC_POSTHOG_REGION === "eu"
          ? "https://eu.posthog.com"
          : "https://us.posthog.com",
      persistence: "localStorage",
      person_profiles: "identified_only",
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      capture_performance: false,
      capture_exceptions: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_external_dependency_loading: true,
      advanced_disable_flags: true,
      disable_capture_url_hashes: true,
      respect_dnt: true,
      before_send: sanitizeAnalyticsEvent,
    });
    client = posthog;
    // An expired login must not attribute a subsequent guest visit to the previous member.
    if (!session && posthog.get_property("$user_id")) posthog.reset();
    if (session) identifyUser(session.user);
    return posthog;
  } catch {
    // Analytics availability must never change the application's behavior.
    return null;
  }
}

function getClient(): Promise<PostHog | null> {
  clientPromise ??= initialize();
  return clientPromise;
}

function identifyUser(user: SessionUser): void {
  if (user.role === "admin") {
    stopped = true;
    client?.opt_out_capturing();
    try {
      window.localStorage.setItem(exclusionKey, "true");
    } catch {
      /* Storage may be blocked. */
    }
    return;
  }
  if (memberId === user.id) return;
  if (memberId) client?.reset();
  memberId = user.id;
  client?.identify(user.id);
}

/** Auth responses contain identity; only the opaque member ID is given to PostHog. */
export async function identifyProductAnalytics(payload: unknown): Promise<void> {
  if (!enabled()) return;
  try {
    const session = parseAuthenticatedSession({
      authenticated: true,
      user: payload && typeof payload === "object" && "user" in payload ? payload.user : null,
    });
    if (!session) return;
    if (session.user.role === "admin") {
      identifyUser(session.user);
      return;
    }
    await getClient();
    if (!stopped) identifyUser(session.user);
  } catch {
    /* Do not fail sign-in if analytics fails. */
  }
}

/** Give a navigation-bound beacon a short opportunity to send without holding up authentication. */
export async function captureAuthenticationEvent(
  payload: unknown,
  event: "signup_completed" | "login_completed" | "invitation_accepted" | "email_verified",
  properties: ProductEventProperties = {},
): Promise<void> {
  await Promise.race([
    (async () => {
      await identifyProductAnalytics(payload);
      await captureProductEvent(event, properties);
    })(),
    new Promise<void>((resolve) => setTimeout(resolve, 200)),
  ]);
}

export function resetProductAnalytics(): void {
  stopped = true;
  memberId = null;
  try {
    client?.reset();
  } catch {
    /* Do not fail sign-out if storage is blocked. */
  }
}

export async function captureProductEvent(
  event: ProductEvent,
  properties: ProductEventProperties = {},
): Promise<void> {
  try {
    const analytics = await getClient();
    if (!analytics || stopped) return;
    analytics.capture(
      event,
      { ...properties, mode: memberId ? "member" : "demo" },
      {
        transport: "sendBeacon",
        send_instantly: true,
      },
    );
  } catch {
    /* Selected events are best effort. */
  }
}

export async function captureProductPage(pathname: string): Promise<void> {
  try {
    const analytics = await getClient();
    if (!analytics || stopped || pathname.startsWith("/admin") || lastPath === pathname) return;
    lastPath = pathname;
    const path = analyticsPath(pathname);
    analytics.capture("$pageview", {
      $current_url: `${publicSiteUrl.origin}${path}`,
      $pathname: path,
      mode: memberId ? "member" : "demo",
    });
    const feature = featureForPath[path];
    if (feature) await captureProductEvent("feature_viewed", { feature });
    if (path === "/app" && !memberId && !tourCaptured) {
      tourCaptured = true;
      await captureProductEvent("tour_started");
    }
  } catch {
    /* Navigation must work even when analytics does not. */
  }
}
