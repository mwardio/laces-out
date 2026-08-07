/*
 * Style entry for the design-system bundle.
 *
 * apps/web/src/app/layout.tsx loads globals.css then polish.css, and that
 * order is load-bearing: globals.css opens with
 * `@layer reset, base, components, utilities, polish;`, which is what fixes
 * the cascade order. CSS registers a layer at its first appearance, so if
 * polish.css were parsed first the `polish` layer would register as the
 * LOWEST priority and the whole visual system would lose to the base layer.
 *
 * Only globals.css is pulled through esbuild here. polish.css is wired as
 * cfg.cssEntry instead, which appends it verbatim AFTER this bundled CSS —
 * same relative order, and it keeps esbuild from trying to resolve the
 * `url("/brand/…webp")` in polish.css, which is a Next public/ path that
 * has no filesystem equivalent (see brand.css for how that mark is restored).
 */

import "../apps/web/src/app/globals.css";
import "./brand.css";
