/*
 * Browser env shim — must evaluate before any component module.
 *
 * apps/web/src/lib/public-site.ts (and bridge-extension.ts) read
 * `process.env.NEXT_PUBLIC_*` at module top level. Next.js inlines those at
 * build time; the design-system bundle has no such build step, so `process`
 * is simply undefined in the browser and the very first read throws
 * `ReferenceError: process is not defined` during IIFE init — which aborts
 * the whole bundle before anything is assigned to window.LacesOut.
 *
 * The converter's esbuild pass only defines `process.env.NODE_ENV`, so the
 * NEXT_PUBLIC_* reads are not substituted. Defining an empty env here makes
 * every one of them return undefined, which is exactly the branch each call
 * site already handles (publicSiteUrl falls back to fallbackSiteUrl, and
 * yahooComingSoon resolves true — the shipped default).
 *
 * This file is listed FIRST in cfg.extraEntries so its side effect runs
 * ahead of the component graph.
 */

if (typeof globalThis.process === "undefined") {
  globalThis.process = { env: { NODE_ENV: "development" } };
} else if (typeof globalThis.process.env === "undefined") {
  globalThis.process.env = { NODE_ENV: "development" };
}
