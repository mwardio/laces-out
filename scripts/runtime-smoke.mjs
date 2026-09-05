import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const apiPort = 41_073;
const webPort = 41_074;
const maximumOutputCharacters = 16_000;
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const webRoot = fileURLToPath(new URL("../apps/web", import.meta.url));
const webRequire = createRequire(new URL("../apps/web/package.json", import.meta.url));
const nextBinary = webRequire.resolve("next/dist/bin/next");
const expectedCanonicalUrl = new URL(
  "/",
  process.env.NEXT_PUBLIC_SITE_URL?.trim() || "http://localhost:3000",
)
  .toString()
  .replace(/\/$/u, "");

/**
 * Robots rules, parsed from the served `robots.txt` and evaluated the way Google and Bing document:
 * the longest matching pattern wins, `*` matches any run of characters, a trailing `$` anchors the
 * end of the path, Allow wins a tie, and an unmatched path is crawlable.
 *
 * `apps/web/src/app/robots.test.ts` runs the same evaluation over the rules the route returns. The
 * duplication is deliberate: this Node build has no TypeScript support, so a `.mjs` script cannot
 * import the evaluator from there.
 */
function parseRobotsRules(text, userAgent = "*") {
  const rules = [];
  let inGroup = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      inGroup = value === userAgent;
    } else if (inGroup && field === "allow" && value) {
      rules.push({ pattern: value, allow: true });
    } else if (inGroup && field === "disallow" && value) {
      rules.push({ pattern: value, allow: false });
    }
  }
  return rules;
}

function matchesRobotsPattern(pattern, path) {
  const anchored = pattern.endsWith("$");
  const literal = anchored ? pattern.slice(0, -1) : pattern;
  const source = literal
    .split("*")
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`, "u").test(path);
}

function isCrawlable(rules, path) {
  let winner;
  for (const rule of rules) {
    if (!matchesRobotsPattern(rule.pattern, path)) continue;
    if (
      !winner ||
      rule.pattern.length > winner.pattern.length ||
      (rule.pattern.length === winner.pattern.length && rule.allow)
    ) {
      winner = rule;
    }
  }
  return winner ? winner.allow : true;
}

/** Every same-origin asset the served landing HTML asks a browser (or a crawler) to fetch. */
function referencedAssetPaths(html) {
  const paths = new Set();
  const add = (value) => {
    if (!value) return;
    if (value.startsWith("/")) {
      paths.add(value);
      return;
    }
    if (!value.startsWith("http")) return;
    const url = new URL(value);
    paths.add(`${url.pathname}${url.search}`);
  };
  for (const [, href] of html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/gu)) add(href);
  for (const [, source] of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gu)) add(source);
  for (const [, content] of html.matchAll(/<meta property="og:image" content="([^"]+)"/gu))
    add(content);
  return [...paths];
}

function startNode(arguments_, extraEnvironment = {}, workingDirectory = repositoryRoot) {
  const child = spawn(process.execPath, arguments_, {
    cwd: workingDirectory,
    env: { ...process.env, ...extraEnvironment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk) => {
    output = `${output}${String(chunk)}`.slice(-maximumOutputCharacters);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  return { child, output: () => output };
}

async function stop(processHandle) {
  if (processHandle.exitCode !== null) return;
  processHandle.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => processHandle.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  if (processHandle.exitCode === null) processHandle.kill("SIGKILL");
}

async function waitForHttp(url, processState) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (processState.child.exitCode !== null) {
      throw new Error(`Process exited before readiness:\n${processState.output()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return response;
    } catch {
      // Startup races are expected until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Process did not become ready:\n${processState.output()}`);
}

async function waitForText(processState, expected) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (processState.output().includes(expected)) return;
    if (processState.child.exitCode !== null) {
      throw new Error(`Process exited before startup:\n${processState.output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Process did not report startup:\n${processState.output()}`);
}

const api = startNode(["apps/api/dist/server.js"], {
  PORT: String(apiPort),
  API_URL: `http://127.0.0.1:${apiPort}`,
  SESSION_SECRET: process.env.SESSION_SECRET ?? "runtime-smoke-session-secret-at-least-32-bytes",
});
try {
  const live = await (await waitForHttp(`http://127.0.0.1:${apiPort}/health/live`, api)).json();
  const ready = await (await waitForHttp(`http://127.0.0.1:${apiPort}/health/ready`, api)).json();
  assert.equal(live.status, "ok");
  assert.equal(ready.status, "ok");
} finally {
  await stop(api.child);
}

const worker = startNode(["apps/worker/dist/worker.js"]);
try {
  await waitForText(worker, "fantasy worker started");
} finally {
  await stop(worker.child);
}

const web = startNode(
  [nextBinary, "start", "-p", String(webPort)],
  { NEXT_PUBLIC_API_URL: `http://127.0.0.1:${apiPort}` },
  webRoot,
);
try {
  const landingResponse = await waitForHttp(`http://127.0.0.1:${webPort}/`, web);
  const landingHtml = await landingResponse.text();
  assert.match(landingHtml, /Connect your leagues/u);
  assert.match(landingHtml, /Create your account/u);
  assert.match(landingHtml, /Fresh league data/u);
  assert.match(landingHtml, /Ask the Film Room why/u);
  assert.match(landingHtml, /It never touches your roster or asks for your password/u);
  assert.doesNotMatch(landingHtml, /never shows you an ad/u);
  assert.match(landingHtml, /Waiver move/u);
  assert.match(landingHtml, /Add M\. Wilson/u);
  assert.match(landingHtml, /Drop T\. Benson/u);
  assert.match(landingHtml, /Chrome companion or iOS app/u);
  assert.doesNotMatch(landingHtml, /Chrome companion\./u);
  assert.match(landingHtml, /Upload a CSV for your eyes only/u);
  assert.match(landingHtml, /share it with your entire league/u);
  assert.match(landingHtml, /application\/ld\+json/u);
  assert.doesNotMatch(landingHtml, /Automated league brief/u);
  assert.ok(landingHtml.includes(`<link rel="canonical" href="${expectedCanonicalUrl}"`));
  assert.doesNotMatch(landingHtml, /noindex/u);
  assert.match(landingHtml, /<meta property="og:site_name" content="Laces Out"\/>/u);
  assert.match(landingHtml, /<meta property="og:locale" content="en_US"\/>/u);

  // The landing canonical, its og:url, and the sitemap's root entry must all be the same string.
  const landingSocialUrl = landingHtml.match(/<meta property="og:url" content="([^"]+)"/u)?.[1];
  assert.equal(landingSocialUrl, expectedCanonicalUrl);
  const sitemapResponse = await waitForHttp(`http://127.0.0.1:${webPort}/sitemap.xml`, web);
  const sitemapXml = await sitemapResponse.text();
  const sitemapLocations = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(([, loc]) => loc);
  assert.equal(sitemapLocations[0], expectedCanonicalUrl);
  // 4 is the size of the public page registry (apps/web/src/lib/public-pages.ts); the list below is
  // inclusion-only, so without this count a page added to the registry would go unchecked here.
  assert.equal(sitemapLocations.length, 4);
  for (const path of ["/privacy", "/terms", "/methodology"]) {
    assert.ok(
      sitemapLocations.includes(`${expectedCanonicalUrl}${path}`),
      `sitemap missing ${path}`,
    );
  }

  // Googlebot must be able to fetch everything the landing page renders with.
  const robotsResponse = await waitForHttp(`http://127.0.0.1:${webPort}/robots.txt`, web);
  const robotsRules = parseRobotsRules(await robotsResponse.text());
  assert.ok(robotsRules.length > 0, "robots.txt declared no rules for *");
  const landingAssetPaths = referencedAssetPaths(landingHtml);
  for (const expected of [
    /^\/_next\/static\/css\//u,
    /^\/_next\/static\/chunks\//u,
    /\.woff2$/u,
    /^\/opengraph-image/u,
    /^\/icon\.png/u,
    /^\/apple-icon\.png/u,
    /^\/manifest\.webmanifest/u,
  ]) {
    assert.ok(
      landingAssetPaths.some((path) => expected.test(path)),
      `landing HTML referenced no asset matching ${expected}`,
    );
  }
  for (const path of landingAssetPaths) {
    assert.ok(isCrawlable(robotsRules, path), `robots.txt blocks ${path}`);
  }
  for (const path of ["/app", "/draft", "/settings", "/api/anything", "/_next/image?url=x"]) {
    assert.ok(!isCrawlable(robotsRules, path), `robots.txt exposes ${path}`);
  }

  // One JSON-LD graph naming the three entities the landing page publishes.
  const landingJsonLd = landingHtml.match(
    /<script type="application\/ld\+json">(.*?)<\/script>/su,
  )?.[1];
  assert.ok(landingJsonLd, "landing HTML carried no JSON-LD block");
  const landingGraph = JSON.parse(landingJsonLd);
  assert.deepEqual(
    landingGraph["@graph"].map((node) => node["@type"]),
    ["Organization", "WebSite", "SoftwareApplication"],
  );
  if (process.env.NEXT_PUBLIC_YAHOO_ACCESS_STATUS?.trim().toLowerCase() === "available") {
    assert.match(landingHtml, /ESPN &amp; Yahoo syncing/u);
    assert.doesNotMatch(landingHtml, /Yahoo sync is next on the roadmap/u);
  } else {
    assert.match(landingHtml, /ESPN syncing/u);
    assert.match(landingHtml, /Yahoo sync is next on the roadmap/u);
  }
  const landingSocialImageUrl = landingHtml.match(
    /<meta property="og:image" content="([^"]+)"/u,
  )?.[1];
  assert.ok(landingSocialImageUrl);
  const landingSocialImagePath = new URL(landingSocialImageUrl);
  const landingSocialImageResponse = await waitForHttp(
    `http://127.0.0.1:${webPort}${landingSocialImagePath.pathname}${landingSocialImagePath.search}`,
    web,
  );
  assert.equal(landingSocialImageResponse.headers.get("content-type"), "image/png");
  const landingSocialImage = Buffer.from(await landingSocialImageResponse.arrayBuffer());
  assert.deepEqual([...landingSocialImage.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(landingSocialImage.readUInt32BE(16), 1200);
  assert.equal(landingSocialImage.readUInt32BE(20), 630);

  const legacySocialImageRedirect = await fetch(`http://127.0.0.1:${webPort}/opengraph-image.jpg`, {
    redirect: "manual",
  });
  assert.equal(legacySocialImageRedirect.status, 308);
  assert.equal(legacySocialImageRedirect.headers.get("location"), "/opengraph-image");

  const workspaceResponse = await waitForHttp(`http://127.0.0.1:${webPort}/app`, web);
  const workspaceHtml = await workspaceResponse.text();
  assert.match(workspaceHtml, /Laces Out/u);
  assert.match(workspaceHtml, /Overview/u);

  // 4.1 guard: the landing route must ship base.css only — no signed-in product CSS.
  const landingStylesheets = [
    ...landingHtml.matchAll(/<link rel="stylesheet" href="([^"]+)"/gu),
  ].map((match) => match[1]);
  // 2 is what Next's current chunk grouping emits, not a requirement. Turning on
  // `experimental.cssChunking` — the accepted follow-up for the `/analytics` regrouping — is expected
  // to trip this; re-derive the expectation from the built HTML rather than loosening the assert.
  assert.equal(landingStylesheets.length, 2);
  const productOnlySelectors = [".draft-board", ".ranking-studio", ".login-form", ".bottom-nav"];
  for (const href of landingStylesheets) {
    const stylesheet = await (await waitForHttp(`http://127.0.0.1:${webPort}${href}`, web)).text();
    for (const selector of productOnlySelectors) {
      assert.ok(
        !stylesheet.includes(selector),
        `${href} ships product-only CSS (${selector}); it belongs in apps/web/src/app/product.css`,
      );
    }
  }
  const workspaceStylesheets = [
    ...workspaceHtml.matchAll(/<link rel="stylesheet" href="([^"]+)"/gu),
  ].map((match) => match[1]);
  // Same caveat: that both routes lead with the same sheet is today's chunk grouping, not a rule.
  // `experimental.cssChunking` is expected to trip this too; re-derive it from the built HTML.
  assert.equal(workspaceStylesheets[0], landingStylesheets[0]);
  const workspaceCss = await Promise.all(
    workspaceStylesheets.map(async (href) =>
      (await waitForHttp(`http://127.0.0.1:${webPort}${href}`, web)).text(),
    ),
  );
  assert.ok(workspaceCss.some((stylesheet) => stylesheet.includes(".draft-board")));

  const scheduleResponse = await waitForHttp(`http://127.0.0.1:${webPort}/schedule`, web);
  const scheduleHtml = await scheduleResponse.text();
  assert.match(scheduleHtml, /Matchup Outlook/u);
  assert.match(scheduleHtml, /Roster \+ bye outlook/u);

  const inviteResponse = await waitForHttp(`http://127.0.0.1:${webPort}/invite`, web);
  const inviteHtml = await inviteResponse.text();
  assert.match(inviteHtml, /Laces Out/u);
  assert.match(inviteHtml, /Accept invitation/u);
} finally {
  await stop(web.child);
}

process.stdout.write(
  `${JSON.stringify({ apiLive: true, apiReady: true, workerStarted: true, officialLandingStarted: true, landingSocialImageStarted: true, landingAssetsCrawlable: true, landingRootUrlConsistent: true, landingStructuredDataParsed: true, workspaceStarted: true, scheduleStarted: true })}\n`,
);
