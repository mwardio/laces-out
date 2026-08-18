import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const bridgeDirectory = dirname(scriptDirectory);
const distributionDirectory = join(bridgeDirectory, "dist");

const target = ["store", "calibration"].includes(process.env.BRIDGE_TARGET)
  ? process.env.BRIDGE_TARGET
  : "dev";
const { version } = JSON.parse(await readFile(join(bridgeDirectory, "package.json"), "utf8"));

// Both archives are local, reproducible build artifacts. User installation is
// distributed through the Chrome Web Store; no package is copied into the
// publicly served web tree.
const outputDirectory = join(bridgeDirectory, "dist-package");
const outputPath = join(
  outputDirectory,
  target === "store"
    ? `laces-out-espn-bridge-store-v${version}.zip`
    : target === "calibration"
      ? `laces-out-espn-bridge-calibration-v${version}.zip`
      : `laces-out-espn-bridge-v${version}.zip`,
);

function localHeader(name, contents) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0x0021, 12);
  header.writeUInt32LE(crc32(contents) >>> 0, 14);
  header.writeUInt32LE(contents.length, 18);
  header.writeUInt32LE(contents.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(name, contents, localOffset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0x0021, 14);
  header.writeUInt32LE(crc32(contents) >>> 0, 16);
  header.writeUInt32LE(contents.length, 20);
  header.writeUInt32LE(contents.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(localOffset, 42);
  return header;
}

const fileNames = (await readdir(distributionDirectory))
  .filter((name) => !name.endsWith(".map"))
  .sort();
if (target === "calibration") {
  const allowed = [
    "calibration-content-script.global.js",
    "icon-128.png",
    "icon-16.png",
    "icon-32.png",
    "icon-48.png",
    "manifest.json",
  ].sort();
  if (JSON.stringify(fileNames) !== JSON.stringify(allowed)) {
    throw new Error("calibration package contains an unexpected executable or asset");
  }
  const calibrationBundle = await readFile(
    join(distributionDirectory, "calibration-content-script.global.js"),
    "utf8",
  );
  for (const forbidden of [
    "fetch(",
    "XMLHttpRequest",
    "WebSocket",
    "EventSource",
    "WebTransport",
    "RTCPeerConnection",
    "navigator.sendBeacon",
    "chrome.",
    "document.cookie",
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "caches.open(",
    "innerHTML",
    "outerHTML",
  ]) {
    if (calibrationBundle.includes(forbidden)) {
      throw new Error(`calibration bundle contains forbidden capability: ${forbidden}`);
    }
  }
}
const localParts = [];
const centralParts = [];
let localOffset = 0;

for (const fileName of fileNames) {
  const contents = await readFile(join(distributionDirectory, fileName));
  const name = Buffer.from(fileName, "utf8");
  const local = localHeader(name, contents);
  const central = centralHeader(name, contents, localOffset);
  localParts.push(local, name, contents);
  centralParts.push(central, name);
  localOffset += local.length + name.length + contents.length;
}

const centralDirectory = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(fileNames.length, 8);
end.writeUInt16LE(fileNames.length, 10);
end.writeUInt32LE(centralDirectory.length, 12);
end.writeUInt32LE(localOffset, 16);
end.writeUInt16LE(0, 20);

await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, Buffer.concat([...localParts, centralDirectory, end]));
process.stdout.write(`Packaged ${fileNames.length} bridge files at ${outputPath}\n`);
