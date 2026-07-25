import { access, copyFile, readFile, writeFile } from "node:fs/promises";

// `dev` (default) keeps localhost and the broad optional host so an unpacked
// build can point at a local API. `store` pins the extension to the production
// Laces Out origin and tightens the CSP so the Chrome Web Store review sees only
// named, single-purpose hosts. The compiled service worker is identical for both
// targets; the API base URL is user-configured, never baked into code.
const target = process.env.BRIDGE_TARGET === "store" ? "store" : "dev";
const API_ORIGIN = "https://laces.mward.io";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));

if (target === "store") {
  manifest.optional_host_permissions = [`${API_ORIGIN}/*`];
  // Store uploads must not carry a `key`; the Chrome Web Store assigns the
  // published extension ID. The `key` only pins the unpacked dev-build ID.
  delete manifest.key;
  // Web-to-extension pairing is offered only from the production origin in the
  // store build; localhost offers are a dev-only affordance.
  manifest.externally_connectable = { matches: [`${API_ORIGIN}/*`] };
  manifest.content_security_policy.extension_pages =
    "default-src 'self'; " +
    `connect-src https://fantasy.espn.com https://lm-api-reads.fantasy.espn.com ${API_ORIGIN}; ` +
    "img-src 'self'; style-src 'self'";
}

// The live ESPN draft feed only works if the content script survives manifest rewriting and is
// actually compiled into `dist`. The store branch above rewrites host and CSP fields, so this
// asserts — for both targets — that it never quietly drops the declaration or ships a manifest
// pointing at a file that was not built. A silent miss here would look like ESPN changing its
// markup, which is the hardest failure of this feature to diagnose.
const contentScripts = manifest.content_scripts ?? [];
const declaredFiles = contentScripts.flatMap((entry) => entry.js ?? []);
if (declaredFiles.length === 0) {
  throw new Error("manifest.json lost its ESPN draft content script declaration");
}
if (
  !contentScripts.every((entry) =>
    (entry.matches ?? []).every((match) => match.startsWith("https://fantasy.espn.com/")),
  )
) {
  throw new Error("content scripts must stay scoped to https://fantasy.espn.com");
}
for (const file of declaredFiles) {
  await access(new URL(`../dist/${file}`, import.meta.url)).catch(() => {
    throw new Error(`manifest.json declares ${file} but the build did not produce it`);
  });
}

await Promise.all([
  writeFile(
    new URL("../dist/manifest.json", import.meta.url),
    `${JSON.stringify(manifest, null, 2)}\n`,
  ),
  copyFile(
    new URL("../src/popup.html", import.meta.url),
    new URL("../dist/popup.html", import.meta.url),
  ),
  copyFile(
    new URL("../src/popup.css", import.meta.url),
    new URL("../dist/popup.css", import.meta.url),
  ),
  ...[16, 32, 48, 128].map((size) =>
    copyFile(
      new URL(`../assets/icon-${size}.png`, import.meta.url),
      new URL(`../dist/icon-${size}.png`, import.meta.url),
    ),
  ),
]);
