import { copyFile } from "node:fs/promises";

await Promise.all([
  copyFile(
    new URL("../manifest.json", import.meta.url),
    new URL("../dist/manifest.json", import.meta.url),
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
