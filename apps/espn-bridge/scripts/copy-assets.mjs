import { access, copyFile, readFile, writeFile } from "node:fs/promises";

// `dev` (default) allows direct localhost testing. `store` keeps arbitrary HTTPS
// hosts as optional permissions so one signed companion can serve self-hosted
// instances, while externally initiated one-click offers remain pinned to the
// official hosted origins. The API base URL is user-approved at runtime and is
// never baked into compiled code.
const target = ["store", "calibration"].includes(process.env.BRIDGE_TARGET)
  ? process.env.BRIDGE_TARGET
  : "dev";
// Both origins front the same deployment; pairing is offered from either, and
// the popup follows whichever origin the device actually paired against.
const PRODUCTION_ORIGINS = ["https://laces.mward.io", "https://lacesout.app"];

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));

if (target === "calibration") {
  // Calibration is an explicit unpacked/local build. Enforce that boundary in the artifact: no
  // worker, pairing, cookie/storage permission, popup, optional hosts, or upload-capable content
  // script survives. The remaining script writes only a sanitized report to local DevTools.
  manifest.name = `${manifest.name} (Local Calibration)`;
  manifest.description = "Local-only structural calibration for an ESPN Fantasy draft room.";
  delete manifest.key;
  delete manifest.permissions;
  delete manifest.host_permissions;
  delete manifest.optional_host_permissions;
  delete manifest.externally_connectable;
  delete manifest.background;
  delete manifest.action;
  delete manifest.content_security_policy;
  manifest.content_scripts = [
    {
      matches: ["https://fantasy.espn.com/football/draft*"],
      js: ["calibration-content-script.global.js"],
      run_at: "document_idle",
      all_frames: false,
    },
  ];

  for (const forbidden of [
    "key",
    "permissions",
    "host_permissions",
    "optional_host_permissions",
    "externally_connectable",
    "background",
    "action",
    "content_security_policy",
  ]) {
    if (forbidden in manifest) {
      throw new Error(`calibration manifest must not contain ${forbidden}`);
    }
  }
}

if (target === "store") {
  // Store uploads must not carry a `key`; the Chrome Web Store assigns the
  // published extension ID. The `key` only pins the unpacked dev-build ID.
  delete manifest.key;
  // Web-to-extension pairing is offered only from the production origins in the
  // store build; localhost offers are a dev-only affordance.
  manifest.externally_connectable = { matches: PRODUCTION_ORIGINS.map((origin) => `${origin}/*`) };
  // Self-hosted pairing starts inside the extension, validates HTTPS (or loopback), asks Chrome
  // for the exact host at that moment, then performs a one-time credential exchange. A random
  // website still cannot message or configure the extension.
  manifest.optional_host_permissions = ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"];
  manifest.content_security_policy.extension_pages =
    "default-src 'self'; " +
    "connect-src https://fantasy.espn.com https://lm-api-reads.fantasy.espn.com https: http://localhost:* http://127.0.0.1:*; " +
    "img-src 'self'; style-src 'self'";
}

// League discovery, core sync, and supplemental sync each require exactly one of these ESPN
// hosts. The store branch above rewrites permission fields, so this asserts — for both targets —
// that the required host list survives intact: a dropped entry only fails inside the packaged
// build, where a credentialed cross-origin fetch silently loses its cookies.
const REQUIRED_HOST_PERMISSIONS = [
  "https://fantasy.espn.com/*",
  "https://lm-api-reads.fantasy.espn.com/*",
  "https://fan.api.espn.com/*",
];
if (
  target !== "calibration" &&
  JSON.stringify([...(manifest.host_permissions ?? [])].sort()) !==
    JSON.stringify([...REQUIRED_HOST_PERMISSIONS].sort())
) {
  throw new Error("manifest.json host_permissions must be exactly the three ESPN hosts");
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
  ...(target === "calibration"
    ? []
    : [
        copyFile(
          new URL("../src/popup.html", import.meta.url),
          new URL("../dist/popup.html", import.meta.url),
        ),
        copyFile(
          new URL("../src/popup.css", import.meta.url),
          new URL("../dist/popup.css", import.meta.url),
        ),
      ]),
  ...[16, 32, 48, 128].map((size) =>
    copyFile(
      new URL(`../assets/icon-${size}.png`, import.meta.url),
      new URL(`../dist/icon-${size}.png`, import.meta.url),
    ),
  ),
]);
