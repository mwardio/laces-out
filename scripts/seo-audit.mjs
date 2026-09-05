import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Lighthouse's SEO audit runs against the production build, so this script reproduces the
// Dockerfile's web stage: standalone server plus the static and public assets it does not bundle.
//
// The audit build overrides NEXT_PUBLIC_SITE_URL with the loopback origin this run serves from. The
// landing page emits an absolute canonical, and Lighthouse's canonical audit compares root domains,
// so a build carrying the default localhost origin — or an operator's exported production origin —
// would fail that audit against 127.0.0.1 for a reason that has nothing to do with the site. The
// non-HTTPS-origin warning from apps/web/next.config.ts therefore fires during this build by design.
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const webRoot = join(repositoryRoot, "apps/web");
const standaloneRoot = join(webRoot, ".next/standalone");
const standaloneWebRoot = join(standaloneRoot, "apps/web");
const serverEntry = join(standaloneWebRoot, "server.js");
const lighthouseBinary = join(repositoryRoot, "node_modules/.bin/lighthouse");

const minimumSeoScore = 0.95;
const maximumLargestContentfulPaintMilliseconds = 2_500;
const maximumOutputCharacters = 16_000;
const readinessTimeoutMilliseconds = 30_000;

function parseArguments(argumentList) {
  return {
    selfTest: argumentList.includes("--self-test"),
    skipBuild: argumentList.includes("--skip-build"),
  };
}

function summarizeReport(report) {
  const categoryScore = (identifier) => {
    const score = report?.categories?.[identifier]?.score;
    return typeof score === "number" ? score : null;
  };
  const largestContentfulPaint = report?.audits?.["largest-contentful-paint"]?.numericValue;
  return {
    seo: categoryScore("seo"),
    bestPractices: categoryScore("best-practices"),
    performance: categoryScore("performance"),
    largestContentfulPaintMilliseconds:
      typeof largestContentfulPaint === "number" ? Math.round(largestContentfulPaint) : null,
  };
}

function thresholdFailures(summary) {
  const failures = [];
  if (summary.seo === null) {
    failures.push("SEO score missing from the Lighthouse report");
  } else if (summary.seo < minimumSeoScore) {
    failures.push(`SEO ${summary.seo.toFixed(2)} is below the ${minimumSeoScore} minimum`);
  }
  if (summary.largestContentfulPaintMilliseconds === null) {
    failures.push("Largest Contentful Paint missing from the Lighthouse report");
  } else if (
    summary.largestContentfulPaintMilliseconds > maximumLargestContentfulPaintMilliseconds
  ) {
    failures.push(
      `LCP ${summary.largestContentfulPaintMilliseconds} ms is above the ${maximumLargestContentfulPaintMilliseconds} ms maximum`,
    );
  }
  return failures;
}

function formatScore(score) {
  return score === null ? "n/a" : score.toFixed(2);
}

function formatSummary(summary) {
  const rows = [
    ["SEO", formatScore(summary.seo)],
    ["Best practices", formatScore(summary.bestPractices)],
    ["Performance", formatScore(summary.performance)],
    [
      "LCP",
      summary.largestContentfulPaintMilliseconds === null
        ? "n/a"
        : `${summary.largestContentfulPaintMilliseconds} ms`,
    ],
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(labelWidth)}  ${value}`).join("\n");
}

// Exercised by `node scripts/seo-audit.mjs --self-test`, which needs neither a build nor Chrome.
function runSelfTest() {
  const passingReport = {
    categories: {
      seo: { score: 1 },
      "best-practices": { score: 0.96 },
      performance: { score: 0.9 },
    },
    audits: { "largest-contentful-paint": { numericValue: 1234.6 } },
  };
  const passing = summarizeReport(passingReport);
  assert.deepEqual(passing, {
    seo: 1,
    bestPractices: 0.96,
    performance: 0.9,
    largestContentfulPaintMilliseconds: 1235,
  });
  assert.deepEqual(thresholdFailures(passing), []);

  const failingReport = {
    categories: { seo: { score: 0.94 }, "best-practices": {}, performance: { score: 0.5 } },
    audits: { "largest-contentful-paint": { numericValue: 3200 } },
  };
  const failing = summarizeReport(failingReport);
  assert.equal(failing.bestPractices, null);
  assert.deepEqual(thresholdFailures(failing), [
    "SEO 0.94 is below the 0.95 minimum",
    "LCP 3200 ms is above the 2500 ms maximum",
  ]);

  const emptyFailures = thresholdFailures(summarizeReport({}));
  assert.equal(emptyFailures.length, 2);
  assert.match(formatSummary(passing), /^SEO {13}1\.00$/mu);
  assert.match(formatSummary(passing), /^LCP {13}1235 ms$/mu);
  process.stdout.write("seo-audit self-test passed\n");
}

function build(origin) {
  const result = spawnSync("npm", ["run", "build", "-w", "@laces-out/web"], {
    cwd: repositoryRoot,
    env: { ...process.env, NEXT_PUBLIC_SITE_URL: origin },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("npm run build -w @laces-out/web failed");
  }
}

// The standalone output omits these two trees; the Dockerfile web stage copies them the same way.
async function stageStandaloneAssets() {
  if (!existsSync(serverEntry)) {
    throw new Error(
      `Missing ${serverEntry}. Build the web app first, or drop --skip-build so this script builds it.`,
    );
  }
  await cp(join(webRoot, ".next/static"), join(standaloneWebRoot, ".next/static"), {
    recursive: true,
  });
  await cp(join(webRoot, "public"), join(standaloneWebRoot, "public"), { recursive: true });
}

// Held open across the build so nothing else can take the port that was baked into the metadata.
async function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      probe.unref();
      const { port } = probe.address();
      resolve({ port, release: () => new Promise((released) => probe.close(released)) });
    });
  });
}

function startServer(port) {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: standaloneRoot,
    env: { ...process.env, NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk) => {
    output = `${output}${String(chunk)}`.slice(-maximumOutputCharacters);
  };
  let spawnError = null;
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.once("error", (error) => {
    spawnError = error;
    collect(`spawn failed: ${error.message}\n`);
  });
  return { child, output: () => output, error: () => spawnError };
}

// A child killed by a signal reports `exitCode === null` and sets `signalCode`, so testing the exit
// code alone would read a SIGTERM-ed server as still running.
function hasExited(processHandle) {
  return processHandle.exitCode !== null || processHandle.signalCode !== null;
}

async function stop(processHandle) {
  if (hasExited(processHandle)) return;
  processHandle.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => processHandle.once("exit", resolve)),
    // unref'd so a server that exits promptly does not hold the event loop open for ten seconds.
    new Promise((resolve) => setTimeout(resolve, 10_000).unref()),
  ]);
  if (!hasExited(processHandle)) processHandle.kill("SIGKILL");
}

async function waitForHttp(url, processState) {
  const deadline = Date.now() + readinessTimeoutMilliseconds;
  while (Date.now() < deadline) {
    if (processState.error()) {
      throw new Error(`Web server could not start: ${processState.error().message}`);
    }
    if (hasExited(processState.child)) {
      throw new Error(`Web server exited before readiness:\n${processState.output()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Startup races are expected until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Web server did not become ready:\n${processState.output()}`);
}

// Mobile is Lighthouse's default preset; --form-factor is passed anyway so the intent is explicit.
async function runLighthouse(url, reportPath) {
  const lighthouse = spawn(
    process.execPath,
    [
      lighthouseBinary,
      url,
      "--only-categories=seo,best-practices,performance",
      "--form-factor=mobile",
      "--output=json",
      `--output-path=${reportPath}`,
      "--chrome-flags=--headless=new --no-sandbox",
    ],
    { cwd: repositoryRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const collect = (chunk) => {
    output = `${output}${String(chunk)}`.slice(-maximumOutputCharacters);
  };
  lighthouse.stdout.on("data", collect);
  lighthouse.stderr.on("data", collect);
  lighthouse.once("error", (error) => collect(`spawn failed: ${error.message}\n`));
  const exitCode = await new Promise((resolve) => lighthouse.once("close", resolve));
  if (exitCode !== 0) {
    if (/chrome/iu.test(output)) {
      process.stderr.write(
        "Lighthouse could not launch a browser. Set CHROME_PATH to a Chrome or Chromium binary, " +
          "for example CHROME_PATH=/usr/bin/chromium npm run audit:seo\n",
      );
    }
    throw new Error(`Lighthouse exited with code ${exitCode}:\n${output}`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.selfTest) {
    runSelfTest();
    return;
  }
  if (!existsSync(lighthouseBinary)) {
    throw new Error(`Missing ${lighthouseBinary}. Run npm install first.`);
  }
  if (process.env.CHROME_PATH && !existsSync(process.env.CHROME_PATH)) {
    throw new Error(`CHROME_PATH points at ${process.env.CHROME_PATH}, which does not exist.`);
  }
  // The port is chosen first because the build bakes it into every absolute metadata URL.
  const { port, release } = await reserveFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const url = `${origin}/`;
  if (options.skipBuild) {
    process.stdout.write(
      `Reusing the existing build. Its canonical URL comes from that build's NEXT_PUBLIC_SITE_URL, so Lighthouse's canonical audit fails here unless it already matches ${origin}.\n`,
    );
  } else {
    build(origin);
  }
  await stageStandaloneAssets();

  const reportDirectory = await mkdtemp(join(tmpdir(), "laces-seo-audit-"));
  const reportPath = join(reportDirectory, "report.json");
  await release();
  const server = startServer(port);
  let summary;
  try {
    await waitForHttp(url, server);
    await runLighthouse(url, reportPath);
    summary = summarizeReport(JSON.parse(await readFile(reportPath, "utf8")));
  } finally {
    await stop(server.child);
    await rm(reportDirectory, { recursive: true, force: true });
  }

  process.stdout.write(`${formatSummary(summary)}\n`);
  const failures = thresholdFailures(summary);
  if (failures.length > 0) {
    process.stderr.write(`${failures.map((failure) => `FAIL ${failure}`).join("\n")}\n`);
    process.exitCode = 1;
  }
}

await main();
