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
  // Assert on the hero headline, which is what proves the page server-rendered its own copy.
  // This drifted once already: the "Know the room" hero was replaced without updating the smoke.
  assert.match(landingHtml, /Connect your leagues/u);
  assert.match(landingHtml, /Create your account/u);

  const workspaceResponse = await waitForHttp(`http://127.0.0.1:${webPort}/app`, web);
  const workspaceHtml = await workspaceResponse.text();
  assert.match(workspaceHtml, /Laces Out/u);
  assert.match(workspaceHtml, /Overview/u);

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
  `${JSON.stringify({ apiLive: true, apiReady: true, workerStarted: true, landingStarted: true, workspaceStarted: true, scheduleStarted: true })}\n`,
);
