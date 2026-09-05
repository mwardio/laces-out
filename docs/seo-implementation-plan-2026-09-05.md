# Landing page SEO and organic discovery: implementation plan

Date: 2026-09-05. Baseline audited on `main` at `689875e` (the refreshed landing page) using a
production build served locally with `NEXT_PUBLIC_SITE_URL=https://laces.example.com`.

Scope: behind-the-scenes only. No copy, layout, or visual changes to the landing page. Everything
below is metadata, crawl policy, structured data, caching, CSS delivery, edge configuration, tests,
and operator runbook.

## 1. What is already right (do not redo)

- `metadataBase` derives from `NEXT_PUBLIC_SITE_URL`; the root layout defaults to `noindex`, and
  only `/`, `/privacy`, `/terms`, `/methodology` opt in. Every product route renders
  `noindex, nofollow`.
- `/` renders one `h1`, `lang="en"`, canonical, `index, follow`, full Open Graph and Twitter card
  tags, a generated 1200x630 PNG social image with alt text, a `SoftwareApplication` JSON-LD block,
  the Apple smart-app-banner meta, manifest, and icons.
- `robots.txt`, `sitemap.xml`, and `manifest.webmanifest` exist as Next metadata routes.
- The landing page is a static, ISR-revalidated Server Component (`revalidate = 3600`,
  `Cache-Control: s-maxage=3600, stale-while-revalidate=3600`, ETag). It ships zero `<img>` tags,
  so the LCP element is the hero heading. The brand font is self-hosted, subset to latin, and
  preloaded.
- Caddy compresses (zstd, gzip), strips `Server`, sends HSTS, and `poweredByHeader` is off.
- `scripts/runtime-smoke.mjs` already asserts the canonical tag, the absence of `noindex`, the
  presence of JSON-LD, and that the social image is a 1200x630 PNG.

## 2. Findings, ranked by impact

| #   | Finding                                                                                                                              | Evidence                                                                                                                                 | Impact                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | `robots.txt` blocks `/_next/static/` (all CSS, JS, fonts) and `/opengraph-image`                                                     | Rendered rules: `Allow: /$`, `/privacy`, `/terms`, `/methodology`; `Disallow: /`                                                         | Googlebot renders the page without stylesheets or scripts, which Google documents as harmful to rendering, indexing, and ranking. Unfurlers that honor robots (X/Twitter, Slack) cannot fetch the card image. |
| F2  | `/privacy` is `index, nofollow` and has no canonical                                                                                 | `apps/web/src/app/privacy/page.tsx:10-14`                                                                                                | Inconsistent with `/terms`; nofollow drops internal link equity back to `/`; missing canonical invites duplicate URLs.                                                                                        |
| F3  | JSON-LD is a single thin `SoftwareApplication` with no `url`, `image`, publisher, or `sameAs`; no `WebSite` or `Organization` entity | `apps/web/src/app/page.tsx:58-72`                                                                                                        | Weak entity signals for the brand name, App Store listing, and GitHub repo.                                                                                                                                   |
| F4  | Sitemap `lastmod` and robots allow list are hand-maintained in two files with no link to the pages they describe                     | `sitemap.ts`, `robots.ts`; landing date already drifted once to a manual bump                                                            | Drift risk; F2 is an instance of it.                                                                                                                                                                          |
| F5  | The landing route loads the whole product stylesheet                                                                                 | 4 stylesheets, 212.7 KB raw / 38.4 KB gzip; the 146 KB `globals.css`+`polish.css` chunk is 97% unused on `/`, the 24 KB chunk 95% unused | Render-blocking bytes inflate FCP/LCP on mobile. Roughly 24 KB of the 38 KB gzip is dead weight.                                                                                                              |
| F6  | No verification hooks, no operator runbook for Search Console / Bing, no way to add site-verification meta without editing source    | `layout.tsx` has no `verification` block; docs have no SEO section                                                                       | Slows or blocks Search Console setup, sitemap submission, and CWV monitoring.                                                                                                                                 |
| F7  | Enabling Cloudflare Web Analytics would be blocked by CSP                                                                            | Caddyfile CSP is `script-src 'self'`, `connect-src 'self'`; the flag only toggles privacy copy                                           | Operator cannot measure organic traffic without hand-editing the Caddyfile.                                                                                                                                   |
| F8  | No canonical-host redirect at the edge                                                                                               | Caddyfile serves one `SITE_ADDRESS`; no `www` handling                                                                                   | If DNS ever answers for `www.`, two hosts serve identical content.                                                                                                                                            |
| F9  | Social image and metadata routes are `max-age=0, must-revalidate`                                                                    | `/opengraph-image` regenerates per request (56.7 KB PNG, ~7 ms)                                                                          | Minor; cheap to cache at the edge.                                                                                                                                                                            |
| F10 | Trailing-slash mismatch on the root URL                                                                                              | canonical/og:url `https://host`, sitemap `https://host/`                                                                                 | Cosmetic; Google normalizes the root, but consistency is free.                                                                                                                                                |

Not actionable without visible changes, so explicitly out of scope: FAQ schema (needs visible Q&A),
`aggregateRating` (no on-page ratings; fabricating violates Google's policies), additional
crawlable pages, and copy changes to headings or descriptions. The JS payload is Next 16 + React 19
baseline (two framework chunks, 128 KB gzip); the landing-specific chunk is 10.7 KB and only the
contact dialog and the brand-mark easter egg hydrate. No action there.

## 3. Work items

Effort: S (under an hour), M (half a day including verification), L (a day or more).

### Phase 1: crawl access and correctness (S)

**1.1 Open the asset paths in `robots.ts`.** Keep the allowlist model; add
`/_next/static/`, `/opengraph-image`, `/icon.png`, `/apple-icon.png`, `/manifest.webmanifest`,
`/brand/`, `/sitemap.xml`, `/robots.txt`. Longest-match precedence makes these win over
`Disallow: /`. Do not open `/_next/image` (Caddy already answers 404) or `/api/`.

Acceptance: a unit test on `robots()` that every asset URL referenced from the landing HTML
(`<link rel="stylesheet">`, `<script src>`, preloaded font, `og:image`, icons, manifest) is allowed
by the rules, using a small longest-match evaluator in the test. Extend `runtime-smoke.mjs` with the
same check against the live `robots.txt` and the served landing HTML.

**1.2 Fix `/privacy` metadata.** `alternates.canonical: "/privacy"`, `robots: { index: true,
follow: true }`. Covered by the registry test in 3.1 going forward.

**1.3 Root-level Open Graph defaults.** In `layout.tsx` add
`openGraph: { type: "website", siteName: "Laces Out", locale: "en_US" }` so `/privacy`, `/terms`,
`/methodology` inherit `og:site_name` and `og:locale` (they currently emit only `og:title` and
`og:image`). Set `openGraph.url` on each indexable page to its canonical path.

**1.4 Root URL consistency (F10).** Emit the sitemap root entry as `publicSiteUrl.origin` plus `/`
and set the landing canonical so both render the same string. One assertion in the smoke test.

**1.5 Build-time guard for the public origin.** In `next.config.ts`, when `NODE_ENV=production` and
`NEXT_PUBLIC_SITE_URL` is unset, `localhost`, or not `https:`, print a single loud warning naming
the consequence (canonical, sitemap, and social URLs will point at the wrong origin). Warning only:
`runtime:smoke` builds with localhost on purpose. Docker builds already pass `PUBLIC_URL` through
`Dockerfile:56-71` and the compose build args, so no wiring changes.

### Phase 2: single source of truth for public pages (S to M)

**2.1 Public page registry.** Add `apps/web/src/lib/public-pages.ts` exporting one array of
`{ path, lastModified, changeFrequency, priority }` for the four indexable pages. `sitemap.ts` maps
it; `robots.ts` builds its page allow list from it (plus the asset prefixes from 1.1). Page files
cannot export extra constants under Next's page type check, so the registry is the place dates
live; a comment on each entry names the page file it describes.

**2.2 Registry test.** `public-pages.test.ts`: every registry path has a `page.tsx` whose exported
`metadata` sets `robots.index === true` and a canonical equal to the path; every `page.tsx` under
`apps/web/src/app` with `robots.index === true` is in the registry; no registry entry is a route
that also sets `index: false`. This is what would have caught F2.

**2.3 Date discipline.** `lastModified` stays a hand-set ISO date (Git is excluded from the Docker
build context, so commit dates are unavailable at build time, and a build timestamp is a false
signal that search engines learn to ignore). The registry test asserts each date is not in the
future and not older than the newest date, so a page update is a one-line diff next to the path.

### Phase 3: structured data (S to M)

**3.1 Move the schema to `apps/web/src/lib/structured-data.ts`** and emit a single `@graph`:

- `Organization` (`@id: <origin>/#organization`): `name`, `url`, `logo` (`/icon.png`, 512x512),
  `sameAs` [App Store URL, `https://github.com/mwardio/laces-out`].
- `WebSite` (`@id: <origin>/#website`): `name`, `url`, `publisher` → organization `@id`,
  `inLanguage: "en"`.
- `SoftwareApplication` (`@id: <origin>/#app`): keep the existing fields; add `url`,
  `image` (the `/opengraph-image` URL), `operatingSystem: ["iOS", "Web browser"]`,
  `applicationSubCategory: "Fantasy sports"`, `installUrl` (App Store), `isAccessibleForFree: true`,
  `publisher`/`author` → organization `@id`, `featureList` drawn from the existing feature titles
  already on the page (no new copy).

Keep the `<` escaping. Note in the module doc that Google's Software App rich result requires a
real `aggregateRating` or `review`, which this deployment does not have, so the markup is for entity
understanding and knowledge-panel linkage, not for a rich result.

**3.2 Test.** `structured-data.test.ts`: the graph parses, every `@id` reference resolves within the
graph, every URL is absolute and on `publicSiteUrl`, `downloadUrl`/`installUrl` equal
`publicAppStoreUrl`, and the serialized string contains no `<`. Extend the smoke test to parse the
served JSON-LD and assert the three `@type`s. After deploy, run Google's Rich Results Test and the
Schema.org validator once by hand and record the result in `docs/operations.md`.

### Phase 4: CSS delivery on the landing route (M)

**4.1 Split product CSS out of the root layout.** In the App Router, global CSS may be imported
from any component, and a stylesheet imported by a component ships only on routes that render it.
Move the product-only rules (everything for the signed-in shell: `.draft-*`, `.ranking-*`,
`.live-*`, `.connection-*`, `.bridge-*`, `.login-*`, `.session-*`, `.import-*`, `.yahoo-*`, and
similar) from `globals.css` and `polish.css` into `product.css`, imported from
`components/app-shell.tsx` (and any product page that renders without `AppShell`). The root layout
keeps a `base.css` with design tokens, resets, `.brand-mark`, and the `not-found` styles (the root
`not-found.tsx` uses global classes and must keep working). Landing and public chrome styles are
already CSS modules and stay as they are.

Cascade note: Next orders stylesheets by import order, so tie-breaks between `product.css` and CSS
modules can shift. Verify with before/after screenshots of every product route using the
preinstalled Chromium (Playwright's `executablePath` is `/opt/pw-browsers/chromium`); the README
screenshots under `docs/screenshots/` are a starting checklist of surfaces.

Target: landing CSS from ~38 KB gzip to ~14 KB gzip; two stylesheets instead of four.

**4.2 CSS leak test.** In the smoke test, fetch each stylesheet referenced by `/` and assert none
contains a product-only selector (`.draft-board`, `.ranking-studio`, or whichever sentinel classes
are chosen). This is the regression guard for 4.1.

**4.3 Keep the measurement script.** Commit the rule-level unused-CSS estimator used for this audit
as `scripts/css-usage.mjs` (postcss walk over a built stylesheet against a served HTML file). It is
approximate (selector presence, not runtime coverage) but cheap and dependency-free.

### Phase 5: edge configuration (S)

**5.1 Canonical host redirect.** Add an optional `WWW_REDIRECT_FROM` (or derive from a new
`SITE_HOST`) and a second Caddy site block: `www.{$SITE_HOST} { redir https://{$SITE_HOST}{uri}
permanent }`. Document in `docs/operations.md` that it only applies when DNS answers for `www.`.
Caddy already redirects HTTP to HTTPS for hostname site addresses.

**5.2 Edge caching for metadata routes.** Caddy `header` matchers: `/opengraph-image*` →
`public, max-age=86400, stale-while-revalidate=604800`; `/robots.txt`, `/sitemap.xml`,
`/manifest.webmanifest` → `public, max-age=3600`. The social image URL from the landing page carries
a content hash query string, so a day of caching is safe; `/ios` references the un-hashed URL, which
is fine at 24 h.

**5.3 CSP for Cloudflare Web Analytics (F7).** Template the CSP in the Caddyfile so that when
`NEXT_PUBLIC_CLOUDFLARE_ANALYTICS=enabled` the header gains
`https://static.cloudflareinsights.com` in `script-src` and `https://cloudflareinsights.com` in
`connect-src`. Caddy supports env placeholders in header values; use a `CSP_SCRIPT_EXTRA` /
`CSP_CONNECT_EXTRA` pair set by compose from the same flag so the default deployment's CSP is
unchanged. Add a compose-level assertion (or a note in `docs/security.md`) that the privacy page
copy and the CSP flip together.

### Phase 6: verification hooks, runbook, and audit tooling (S to M)

**6.1 Site verification via env.** `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` and
`NEXT_PUBLIC_BING_SITE_VERIFICATION` → `metadata.verification` in `layout.tsx` (`google`, and
`other: { "msvalidate.01": ... }`). Tags render only when set. Thread through `Dockerfile` ARG/ENV,
compose build args, `.env.example`, `.env.docker.example`, and the README configuration table.
Recommend DNS TXT verification first in the runbook; the env hook is the fallback.

**6.2 Operator runbook** (`docs/operations.md`, new "Search presence" section): set `PUBLIC_URL` to
the canonical HTTPS origin and rebuild; verify the property in Google Search Console and Bing
Webmaster Tools; submit `/sitemap.xml`; check the "Page indexing" and "Core Web Vitals" reports
after the first crawl; re-run the Rich Results Test after any change to `structured-data.ts`;
optional IndexNow key file in `apps/web/public/` plus a post-deploy ping.

**6.3 Lighthouse audit script (optional).** Add `lighthouse` as a root devDependency and
`scripts/seo-audit.mjs` that builds, starts the standalone server, and runs Lighthouse against `/`
with the SEO, best-practices, and performance categories on the mobile preset, failing under
SEO < 0.95 or LCP > 2.5 s. Expose as `npm run audit:seo`. Keep it out of `npm run check` (too slow);
note it in `AGENTS.md` next to the Mini validation commands, with the usual Darwin/ARM64 caveat.

## 4. Sequencing and dependencies

1. Phase 1 first; 1.1 alone is the highest-value change in this document.
2. Phase 2 before Phase 3 so the registry supplies the URLs the graph needs.
3. Phase 4 independently; it is the only item needing visual regression work.
4. Phase 5 and 6 can land in any order; 6.1 is a prerequisite for 6.2 only if DNS verification is
   unavailable.

## 5. Baseline measurements (for before/after comparison)

| Measurement                    | Value                                                 |
| ------------------------------ | ----------------------------------------------------- |
| Landing HTML                   | 91.3 KB                                               |
| Stylesheets on `/`             | 4 files, 212.7 KB raw, 38.4 KB gzip                   |
| Unused CSS on `/` (estimate)   | 163 KB raw of 212.7 KB                                |
| Framework JS (modern browsers) | 2 chunks, 441 KB raw, 128.5 KB gzip                   |
| Landing route JS               | 10.7 KB raw                                           |
| Social image                   | 1200x630 PNG, 56.7 KB, generated per request in ~7 ms |
| Sitemap entries                | 4 (`/`, `/privacy`, `/terms`, `/methodology`)         |
| Public pages with canonical    | 3 of 4 (`/privacy` missing)                           |

Reproduce: build `@laces-out/web` with `NEXT_PUBLIC_SITE_URL` set, copy `.next/static` and
`public` into the standalone output as the Dockerfile does, start
`node .next/standalone/apps/web/server.js`, then `curl` `/`, `/robots.txt`, `/sitemap.xml`,
`/opengraph-image`, and the public sub-pages; extract `<head>` and compare against Section 2.
