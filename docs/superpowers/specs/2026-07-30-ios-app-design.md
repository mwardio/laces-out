# Laces Out for iOS — Design

**Date:** 2026-07-30
**Status:** Approved (brainstorm with Mack, 2026-07-30)

## Goal

A native iOS app that wraps the existing Laces Out web UI and feels like a legit app, not a
website in a frame. Distribution starts with TestFlight for Mack's leagues; the design keeps a
clear runway to a public App Store release (bring-your-own-server model), so App Store
requirements inform v1 choices but do not gate them.

## Shape

A new `apps/ios` app: a SwiftUI shell (iOS 17+) with a native tab bar, where each tab hosts a
`WKWebView` rendering the existing web UI from the user's instance. Native onboarding, APNs push,
Face ID app lock, and a share-sheet bridge provide the native feel. Server-side changes are
contained: an APNs transport in the API's push module and a small bridge module in the web app.

## Decisions made during brainstorming

| Decision | Choice |
| --- | --- |
| Distribution | TestFlight for Mack's leagues first; public App Store later |
| Shell technology | SwiftUI + WKWebView (not Capacitor, not React Native) |
| Push | Native APNs in v1 |
| Native extras in v1 | Share sheet bridge, Face ID app lock + persistent session |
| Deferred to v1.1+ | WidgetKit widget, Draft Live Activity, App Store submission |
| Build environment | Mack's Mac (Xcode); this repo authored from Linux via XcodeGen |
| Tab bar | Locker Room, Decisions, Coach, League, Research |

## Shell architecture

- **Tabs:** Locker Room (`/app`), Decisions (`/decisions`), Coach (`/film-room`), League
  (`/analytics`, includes the Weekly Reckoning), Research (`/stats`). Each tab owns its own
  `WKWebView` so scroll position and in-page state persist per tab. All webviews share one
  persistent `WKWebsiteDataStore`, so the `fantasy_session` cookie is shared. Draft rooms,
  rankings, projections, schedule, and settings remain reachable through the web app's own
  navigation inside any tab.
- **Navigation policy:** same-origin navigation stays in the webview. External links open in
  `SFSafariViewController`. The Yahoo OAuth connect flow runs inside the webview (Yahoo permits
  embedded webviews today); if Yahoo ever blocks embedded user agents, the fallback is
  `ASWebAuthenticationSession` against the same connect URL.
- **Feel:** native pull-to-refresh on each webview; a native offline/unreachable screen with a
  retry button (never a WebKit error page); no browser chrome anywhere.
- **Identification:** the shell appends `LacesOutiOS/<version>` to the webview user agent so the
  web app can detect it is embedded.

## Web ↔ native bridge

A small typed contract over `window.webkit.messageHandlers.lacesout`:

- `{ type: "share", title, text, url }` — opens the native share sheet.
- The shell injects `window.__lacesOutNative = { version, capabilities }` at document start as the
  authoritative detection signal (user agent is the fallback).

Web side, `apps/web/src/lib/native-bridge.ts`:

- Detects the shell and exposes `isNativeShell()` / `nativeShare(payload)`.
- Reckoning cards and recap views use `nativeShare` instead of copy-link buttons when embedded.
- The settings push panel shows "Game day alerts are managed by the Laces Out app" instead of
  web-push prompts when embedded (web push cannot work inside WKWebView).

## Onboarding and server URL

- First launch: branded welcome screen → enter instance URL → validate against `/health` → store
  in `UserDefaults`. The instance can be switched later in native settings.
- TestFlight builds prefill Mack's instance URL via build configuration; the field remains
  editable.
- This bring-your-own-server model is the eventual App Store story (Home Assistant style), with
  the lacesout.app no-account locker-room tour as the reviewer demo.

## Auth and Face ID

- The 30-day session cookie persists in the shared `WKWebsiteDataStore`; login is rare.
- Optional native app lock (off by default): app content blurs when backgrounded; returning to the
  foreground requires Face ID / Touch ID / passcode via `LAContext`.

## APNs push

- **Contracts:** the push subscription request becomes a discriminated union — the existing
  web-push shape (default, backward compatible) or
  `{ transport: "apns", deviceToken, environment: "development" | "production" }`.
- **Storage:** the subscriptions table gains a transport discriminator; APNs rows store the device
  token where web-push rows store endpoint + keys. One device token maps to at most one row per
  user (re-registration updates, never duplicates).
- **Sending:** `createApnsSender` (token-based `.p8` auth over HTTP/2) sits alongside
  `createWebPushSender` behind the existing `PushSender` port. Fan-out picks the sender by row
  transport, so recap-drop and every other existing trigger reaches both transports with no
  call-site changes.
- **Configuration:** `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, `APNS_BUNDLE_ID`,
  `APNS_ENVIRONMENT`. Absent configuration degrades to "unavailable, not broken," matching the
  existing push philosophy — `/v1/push/config` reports per-transport availability.
- **iOS behavior:** the app requests notification permission after first successful login (never
  at first launch), registers the device token with the instance, and tapping a notification
  deep-links to the correct tab and URL. Registration failures degrade silently.

## Build and repo layout

- `apps/ios/` holds a **XcodeGen** project: `project.yml` plus Swift sources, authored entirely
  from Linux. Mack runs `xcodegen generate`, builds, tests, and archives in Xcode on his Mac.
- One-time Mac-side setup: Apple Developer Program membership, APNs auth key (`.p8`), App Store
  Connect app record, TestFlight group.
- The implementation plan batches Swift work between explicit Mac-side checkpoints (compile,
  device test, TestFlight upload), since Swift cannot be compiled or tested on this machine.

## Testing

- **API (vitest, existing patterns):** unit tests for the APNs sender against a fake transport;
  route tests covering discriminated registration, per-transport config reporting, revocation, and
  backward compatibility of the web-push shape.
- **Web (vitest):** the bridge module — detection, share dispatch, and graceful no-op outside the
  shell.
- **iOS (XCTest):** navigation-policy decisions (same-origin vs external), deep-link routing from
  notification payloads to tab + URL, server-URL validation. Plus a manual TestFlight smoke
  checklist (login, all five tabs, share, Face ID lock, push round-trip).

## Error handling

- Unreachable instance or failed `/health` validation → native error states with retry, never raw
  WebKit errors.
- Push: unconfigured APNs answers unavailable; the app hides alert settings accordingly. Expired
  or revoked device tokens are pruned on APNs feedback, mirroring web-push GONE handling.
- Session expiry surfaces the web login page normally inside the webview; the shell does nothing
  special beyond keeping the cookie store persistent.

## Out of scope (v1.1+ candidates)

- WidgetKit matchup / Reckoning widget and Draft Live Activity (both strengthen the App Store
  guideline 4.2 minimum-functionality case).
- Sliding session renewal on the API.
- App Store submission work: privacy manifest, privacy nutrition label, review notes, account-
  deletion policy statement (accounts are operator-invited, not created in-app).
