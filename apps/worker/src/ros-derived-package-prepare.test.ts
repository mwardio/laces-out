import { createHash } from "node:crypto";
import type * as PackageLoader from "./ros-derived-package-loader.js";
import type * as FileSystemPromises from "node:fs/promises";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createRosDerivedProductionPackage,
  prepareRosDerivedProductionPackage,
} from "./ros-derived-package-prepare.js";
import { rosDerivedProductionEvaluationFixture } from "./ros-derived-evaluation.test-fixtures.js";
import { readPinnedRosDerivedArtifact } from "./ros-derived-package-loader.js";
import type { RosCorpusLock } from "./ros-corpus-lock.js";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./ros-derived-package-loader.js", async (original) => ({
  ...(await original<typeof PackageLoader>()),
  loadVerifiedRosDerivedPackage: mocks.load,
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof FileSystemPromises>()),
  statfs: vi.fn().mockResolvedValue({ bsize: 4096n, bavail: 16_777_216n }),
}));
const dirs: string[] = [];
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
beforeEach(() => {
  mocks.load.mockReset();
});
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "derived-prepare-"));
  dirs.push(directory);
  const sources = path.join(directory, "source-proofs");
  await mkdir(sources);
  const { productionPackage } = rosDerivedProductionEvaluationFixture();
  const artifacts: Record<string, { directory: string; filename: string }> = {};
  const files: Record<
    string,
    { filename: string; sha256: string; encoding: "json" | "utf8-text" }
  > = {};
  for (const [role, logical] of Object.entries(productionPackage.dependencies)) {
    const text =
      role === "qualificationProtocol"
        ? "# Qualification\n\nPreserve exactly.\n"
        : JSON.stringify({ role });
    const filename = role + ".input";
    await writeFile(path.join(sources, filename), text);
    artifacts[logical] = { directory: sources, filename };
    const sha256 = sha(text);
    const encoding = role === "qualificationProtocol" ? "utf8-text" : "json";
    files[logical] = {
      filename: `${sha256}.${encoding === "utf8-text" ? "txt" : "json"}`,
      sha256,
      encoding,
    };
  }
  const input = createRosDerivedProductionPackage({ ...productionPackage, files });
  const read = vi.fn(async () => ({ state: "hit" as const }));
  const row = (position: string) => ({
    forecast: { position },
    contextualKey: { identity: "x" },
    recencyKey: { identity: "y" },
  });
  mocks.load.mockImplementation(async () => ({
    originalCandidate: { forecasts: Array.from({ length: 3264 }, () => row("WR")) },
    originalCandidateCache: { read },
    original: { forecasts: Array.from({ length: 3264 }, (_, i) => row(i < 544 ? "DST" : "WR")) },
    originalCache: { read },
    training: { forecasts: Array.from({ length: 2176 }, () => row("DST")) },
    trainingCache: { read },
  }));
  const assertHeld = vi.fn(async () => {});
  const signal = new AbortController().signal;
  const lock: RosCorpusLock = async (_identity, _signal, run) => run({ signal, assertHeld });
  return {
    input,
    directory,
    read,
    assertHeld,
    options: {
      directory,
      ...input,
      artifacts,
      sourceRoots: {
        "original-v12": "/read-only/v12",
        "native-dst-v13": "/read-only/old-native",
        "expanded-dst-v13": { "yahoo-2022-v1": "/read-only/new-native" },
      },
      lock,
      signal,
    },
  };
}
it("publishes one exact content-addressed manifest only after all vectors and artifacts pass under the fence", async () => {
  const f = await fixture();
  const destination = path.join(f.directory, "marginal-bundles", `${f.input.packageChecksum}.json`);
  f.read.mockImplementation(async () => {
    await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
    return { state: "hit" };
  });
  expect(await prepareRosDerivedProductionPackage(f.options)).toBe(f.input.packageChecksum);
  expect(f.read).toHaveBeenCalledTimes(11968);
  expect(f.assertHeld.mock.calls.length).toBeGreaterThan(370);
  expect(await readFile(destination, "utf8")).toBe(f.input.packageJson);
  expect(mocks.load).toHaveBeenCalledWith(
    expect.objectContaining({
      unpublishedPackageJson: f.input.packageJson,
      sourceRoots: f.options.sourceRoots,
    }),
  );
  const protocol = f.input.manifest.files[f.input.manifest.dependencies.qualificationProtocol]!;
  expect(
    await readFile(path.join(f.directory, "derived-artifacts", protocol.filename), "utf8"),
  ).toBe("# Qualification\n\nPreserve exactly.\n");
  expect((await readdir(path.dirname(destination))).some((file) => file.endsWith(".partial"))).toBe(
    false,
  );
});
it.each(["bad-pin", "failed-proof", "missing-vector", "lost-lock"] as const)(
  "never publishes ready for %s",
  async (failure) => {
    const f = await fixture();
    if (failure === "bad-pin") {
      const source = Object.values(f.options.artifacts)[0]!;
      await writeFile(path.join(source.directory, source.filename), "tampered");
    }
    if (failure === "failed-proof") mocks.load.mockRejectedValue(new Error("proof failed"));
    if (failure === "missing-vector") f.read.mockResolvedValue({ state: "missing" } as never);
    if (failure === "lost-lock") f.assertHeld.mockRejectedValue(new Error("lock lost"));
    await expect(prepareRosDerivedProductionPackage(f.options)).rejects.toThrow();
    await expect(
      readFile(path.join(f.directory, "marginal-bundles", `${f.input.packageChecksum}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);
it("rejects incomplete artifact closure before filesystem mutation and rejects symlink reads", async () => {
  const f = await fixture();
  await expect(prepareRosDerivedProductionPackage({ ...f.options, artifacts: {} })).rejects.toThrow(
    /artifact closure/,
  );
  expect(mocks.load).not.toHaveBeenCalled();
  expect(await readdir(f.directory)).toEqual(["source-proofs"]);
  const source = Object.values(f.options.artifacts)[0]!;
  await symlink(path.join(source.directory, source.filename), path.join(source.directory, "link"));
  await expect(
    readPinnedRosDerivedArtifact(source.directory, "link", sha("anything"), 1024, f.options.signal),
  ).rejects.toThrow();
  await expect(
    readPinnedRosDerivedArtifact(
      source.directory,
      "../outside",
      sha("anything"),
      1024,
      f.options.signal,
    ),
  ).rejects.toThrow();
});
it("authenticates abort and exact byte pins on direct bounded dependency reads", async () => {
  const f = await fixture();
  const source = Object.values(f.options.artifacts)[0]!;
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(
    readPinnedRosDerivedArtifact(
      source.directory,
      source.filename,
      sha("anything"),
      1024,
      controller.signal,
    ),
  ).rejects.toThrow("cancelled");
  await expect(
    readPinnedRosDerivedArtifact(
      source.directory,
      source.filename,
      sha("anything"),
      1024,
      f.options.signal,
    ),
  ).rejects.toThrow("byte pin");
});
