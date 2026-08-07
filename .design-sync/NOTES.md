# design-sync notes — Laces Out

Repo-specific gotchas for syncing this repo to claude.ai/design. Read this
before re-running the sync.

## The big one: this repo is not a component library

`@laces-out/web` is a **private Next.js application**, not a published package.
There is no `dist/`, no `exports` field, and no shipped `.d.ts`. The converter
therefore runs in **synth-entry mode** (`[NO_DIST]` on every build — expected,
not an error): it synthesizes an entry that does `export * from` each file under
`cfg.srcDir`.

Two consequences that are easy to trip over:

- **`export *` does not re-export default exports.** Any component declared as
  `export default` is invisible to the bundle. This is why `FinkleBroadcast`
  (`finkle-broadcast.tsx`) is not synced — it is the only default-exported
  component in the scoped set. Adding it would need a named re-export shim.
- **No shipped `.d.ts` means no prop extraction.** Every generated
  `<Name>.d.ts` came out as `[key: string]: unknown`, which would leave the
  design agent with no API contract at all. All ten contracts are therefore
  hand-written in `cfg.dtsPropsFor`, transcribed from the component source.
  **If a component's props change in source, `dtsPropsFor` will NOT follow —
  update it by hand.** This is the single most likely thing to silently rot.

## Scope: 10 of 47 components

`apps/web/src/components` holds 47 components, but most are feature surfaces
that fetch on mount (34 of 47 call `fetch()` directly) and cannot render in a
design agent's browser runtime. The synced set is the 10 that genuinely render
standalone, pinned explicitly in `cfg.componentSrcMap`.

Deliberately excluded:

- **`ScrollCues`** — returns `null` by construction. It is a behavior-only
  scroll-shadow helper; it can never produce a preview card.
- **`FinkleBroadcast`** — default export (see above).
- The 34 `fetch()`-driven workbenches — they would render as empty or error
  states, and per the sync contract a component that renders wrong here renders
  wrong in every design built with it.

Note the synth entry still *bundles* all 47 files (that resolves fine), so
`window.LacesOut` exposes 48 symbols while only 10 have cards. That is
harmless, but do not read the export count as the component count.

## Config path resolution — the `../../../` trap

`cfg` path fields resolve against `PKG_DIR`, which is the **npm workspace
symlink** `node_modules/@laces-out/web`, *not* the real `apps/web` directory,
and it is not realpath'd first. So a path to the repo root needs **three**
levels up, not two:

    ../../../.design-sync/ds-styles.mjs      ✅
    ../../.design-sync/ds-styles.mjs         ❌ resolves to node_modules/.design-sync/

A wrong depth fails **silently** — the build just prints
`! extraEntries: … not found — skipped` and carries on producing a bundle that
is missing the CSS and fonts. Always check that line.

## CSS wiring — order is load-bearing

`apps/web/src/app/layout.tsx` loads `globals.css` then `polish.css`, and that
order matters: `globals.css` opens with
`@layer reset, base, components, utilities, polish;`. CSS registers a layer at
its **first appearance**, so if `polish.css` is parsed first the `polish` layer
registers as the *lowest* priority and the entire visual system silently loses
to the base layer. Nothing errors; it just renders wrong.

The two files therefore take deliberately different routes:

- `globals.css` → esbuild module graph, via `.design-sync/ds-styles.mjs`
  (`cfg.extraEntries`).
- `polish.css` → `cfg.cssEntry`, which appends it **verbatim, after** the
  bundled CSS. Correct order, and it also dodges the problem below.

`cfg.tokensGlob` is **not** a route for this: `copyTokens()` returns early
unless `cfg.tokensPkg` is also set, so a lone `tokensGlob` is silently ignored.
And tokens are `@import`ed *before* `_ds_bundle.css`, which would have put
`polish.css` on the wrong side of the layer declaration anyway.

### Why polish.css cannot go through esbuild

`polish.css:55` has `background: url("/brand/laces-out-playbook-mark-96.webp")`
— a Next `public/` URL. esbuild resolves a leading `/` as a filesystem path,
fails, and aborts the whole build with `[UNRESOLVED_IMPORT]`. Appending it via
`cssEntry` sidesteps the parse entirely.

## `.design-sync/brand.css` — three bundle-only fixups

The app relies on the Next runtime for things the bundle has no equivalent for.
All three rules are deliberately **unlayered** so they outrank `@layer polish`
regardless of source order:

1. **`--font-brand`** — set in the app by a class `next/font` generates onto
   `<html>`. Undefined in the bundle, so `font-family: var(--font-brand),
   var(--font-sans)` would silently fall back to system sans.
2. **`Sora Fallback` `@font-face`** — lives here, not in `fonts/sora.css`,
   because `cfg.extraFonts` only ships faces that reference a `url()`; a
   `local()`-only face is dropped and resurfaces as `[FONT_MISSING]`.
3. **`.brand-mark` background** — inlined as a data URI. `LacesOutMark` renders
   an *empty* `<span>`; the background image is its entire appearance, so
   without this its card is a blank 38px box.

## Fonts

`--font-sans` and `--font-mono` are plain **system stacks** — nothing to ship.
Only `--font-brand` (Sora, via `next/font/google`) needed real files. The two
woff2 subsets in `.design-sync/fonts/` were harvested from Next's build output
(`apps/web/.next/static/media/`) and are committed so the sync does not depend
on `.next/` existing. Sora is SIL OFL 1.1, so redistribution is fine.
Regenerate the `@font-face` rules from `.next/static/css/*.css` if the font
config in `layout.tsx` changes.

## `process is not defined`

`apps/web/src/lib/public-site.ts` reads `process.env.NEXT_PUBLIC_*` at module
top level. Next inlines those at build time; the bundle has no such step, so
the first read threw during IIFE init and **aborted the whole bundle** — which
surfaced confusingly as `[BUNDLE_EXPORT] 10/10 not a component on
window.LacesOut`, not as an obvious env problem. `.design-sync/ds-env.mjs`
defines an empty `process.env` and is listed **first** in `cfg.extraEntries` so
it evaluates ahead of the component graph. Every affected call site already
handles `undefined` (falls back to `fallbackSiteUrl`, `yahooComingSoon` → true).

## Toolchain

- **Node**: v22.22.1 (repo pins `>=22.22 <25`).
- **Install**: `npm ci` was **not** re-run. `node_modules` was already present
  and `react`, `react-dom`, and `lucide-react` all resolved, so a destructive
  reinstall was skipped. If a future build fails on a missing dep, run
  `npm ci` at the repo root first.
- **`--node-modules` must be the repo root**, not `apps/web/node_modules` —
  the latter is sparse (only `@img`, `@next`, `next`, `postcss`) because npm
  hoists `react` to the root.
- **Playwright must be version-matched to the cached chromium.** The cache has
  chromium builds 1228 and 1232; latest playwright (1.62.1) pins **1234** and
  fails with `Executable doesn't exist`. **playwright 1.61.1 pins 1228** and
  works. Install into `.ds-sync/` with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` —
  the browsers are already cached, so no ~200MB download is needed.

## Preview authoring rules for this repo

Learned across the authoring waves; they apply to any component added later.

- **Page-level surfaces need an explicit desktop viewport override.** The card
  captures at a default `900x700`, which is *below* this app's
  `@media (max-width: 960px)` breakpoint — so a full-page component silently
  photographs its collapsed tablet layout with the right rails missing, and
  looks like a broken card rather than a small one. `cfg.overrides` carries
  `1440x1320` for `DraftWorkspace` / `DemoRankingsStudio` and `1440x2000` for
  `PortfolioDashboard`. Any new component in the `workspaces` group needs the
  same treatment.
- **`package-capture.mjs` clamps each viewport axis to 2000px.**
  `PortfolioDashboard.WithCoachingTour` is 2167px tall, so its last two
  exposure rows are out of frame. Best available framing, not a render fault.
- **A `cfg.overrides` edit trips `[CONFIG_STALE]` in `preview-rebuild.mjs`** —
  override changes must go through a full `package-build.mjs`, not the
  targeted preview loop.
- **Full-page components need an explicit page background.** The card HTML
  hard-codes `body { background: #fff }` in an *unlayered* `<style>`, which
  beats `globals.css`'s layered `body { background: var(--paper-100) }`. These
  surfaces are stacks of white panels on paper, so on a bare white card the
  structure between panels vanishes. Wrap them in
  `{ background: "var(--paper-100)", padding: "16px 24px 40px" }`.
- **To reach a variant that only the component's own controls can set**, mount
  it inside a `display: contents` ref host and click the real control in an
  effect. `DraftWorkspace.SnakeBoard` does this to exercise the genuine
  `selectMode` path instead of faking markup; `display: contents` keeps the
  host from adding a layout box.
- **`YahooNativeConnect` attempts a real navigation during capture** —
  `window.location.replace("lacesout://…")` after its mount fetch fails
  offline. Chromium no-ops the unknown scheme so the card is fine, but a
  component redirecting to an `http(s)` URL would navigate its card away.
- Raw cell shots are non-fullPage at the declared viewport, so short stories
  leave a large blank area beneath them on the review sheet. Harness constant,
  not a defect.

## Product bug found during this sync (NOT fixed here)

`apps/web/src/app/polish.css` ~L282-301 — `PortfolioDashboard` overflows its
container horizontally by a constant 163px at any width above 820px, pushing
the `Snapshot · …` freshness label out of frame and wrapping the `h1` to
"League / overview".

```css
.live-dashboard-page .dashboard-heading { display: grid; … }  /* scoped   */
.dashboard-heading > div:first-child     { width: 100%; … }   /* UNSCOPED */
.dashboard-heading .heading-actions      { width: 100%; … }   /* UNSCOPED */
```

Only `dashboard-experience.tsx` applies `.live-dashboard-page`, so a bare
`.dashboard-page` keeps `.page-heading`'s `display: flex; justify-content:
space-between` — and a `width: 100%` flex item lays out at full container
width *after* the title. Reproduces in the product (no `overflow-x: hidden` on
`.app-shell` or `.main-content`) and is not fixed by a wider viewport. The fix
is to scope the two `width: 100%` rules to `.live-dashboard-page
.dashboard-heading`, matching their companion.

Deliberately **not** patched in `brand.css`: overriding it there would make
designs built with this DS look correct while the real app stays broken, which
is worse than an honest card. The card shows real product behavior today.

## Known render warns

**This sync ended with validate completely clean — zero warnings, 10/10
previews rendering.** So any warn on a re-sync is new; look at it. The two
below were seen and resolved during the run, and are recorded so a
reappearance is recognised as a regression rather than treated as normal:

- `[RENDER_THIN]` on **RouteLoading** — it is a bare spinner that paints almost
  nothing on its own. Resolved by authoring a preview that gives it a bounded,
  painted context. If it returns, that preview regressed.
- `[GRID_OVERFLOW]` on **YahooAttribution**, **TeamAvatar**, and
  **RouteLoading** — their stories rendered wider than a grid cell and the
  product card cropped them. Resolved with `{"cardMode": "column"}` in
  `cfg.overrides`. Column cards cannot re-flag as wide, so a new overflow warn
  on any of these means something else changed.
- `LacesOutMark` **Default vs Compact** are only 38px vs 31px. If
  `variants render identically` ever fires here it is expected — the variant is
  real but subtle, and the cell labels carry the distinction.

## Re-sync risks — what can silently go stale

- **`cfg.dtsPropsFor` is hand-transcribed.** It does not track source. A prop
  added, removed, or retyped in `apps/web/src/components/*.tsx` leaves the
  design agent coding against a stale contract, with no warning from any check.
  Re-read the component sources on any re-sync that follows UI work.
- **The Sora woff2 files are a snapshot** of what `next/font` produced. If
  `layout.tsx` changes weights, subsets, or font family, the committed files
  and the `@font-face` rules in `.design-sync/fonts/sora.css` are both stale.
- **The `.brand-mark` data URI is a copy** of
  `apps/web/public/brand/laces-out-playbook-mark-96.webp`. Re-run the `base64`
  command in `brand.css`'s header comment if the mark is redesigned.
- **New components are not picked up automatically.** `componentSrcMap` pins an
  explicit list; anything added to `apps/web/src/components` is ignored until
  someone adds it (and its `dtsPropsFor` entry and doc).
- **`polish.css` is appended verbatim**, so any *new* absolute `url()` in it
  ships as a dead link rather than failing the build. Grep for
  `url("/` in the global CSS on re-sync.
- **Scope was a deliberate product decision**, not a technical ceiling: the 34
  fetch-driven components were excluded because they cannot render without live
  API data. If the app ever grows presentational variants of those workbenches,
  they become sync candidates.
