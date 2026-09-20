import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  FIRST_PARTY_ROS_MODEL_VERSION,
  FIRST_PARTY_ROS_RETAINED_V12_MODEL_VERSION,
} from "@laces-out/projections";

import type { RosHistoricalCorpusForecast } from "./ros-historical-corpus.js";
import {
  restoreCachedRosHistoricalOutcome,
  restoreRetainedV12CachedRosHistoricalOutcome,
} from "./ros-historical-outcome-replay.js";
import {
  createRosOutcomeCache,
  type RosOutcomeCache,
  type RosOutcomeCacheEnsemble,
  type RosOutcomeCacheKey,
} from "./ros-outcome-cache.js";

const V12 = FIRST_PARTY_ROS_RETAINED_V12_MODEL_VERSION;
const V13 = FIRST_PARTY_ROS_MODEL_VERSION;
const VERSION = "ros-compatible-reference-vector-v1";
const SHA = /^[a-f0-9]{64}$/u;
const SCENARIOS = 16_384;
const MAX_MANIFEST = 192 * 1_024;
const MAX_FILE = 12 + MAX_MANIFEST + 65 * 1_024 * 1_024;
const MAX_ENTRY_JSON = 2 * 1_024 * 1_024;
const MAX_TOTAL_JSON = 128 * 1_024 * 1_024;
const NAMESPACES = ["original-v12", "native-dst-v13", "expanded-dst-v13"] as const;
type Namespace = (typeof NAMESPACES)[number];
type Strategy = "contextual" | "availability-aware-recency";
/** Observed labels are authenticated by the enclosing evaluation, never by a vector adapter. */
export type RosDerivedOutcomeRow = Pick<
  RosHistoricalCorpusForecast,
  "forecast" | "contextualKey" | "recencyKey" | "scheduledGames"
>;

export interface RosDerivedOutcomeSource {
  readonly namespace: Namespace;
  readonly key: RosOutcomeCacheKey;
  readonly filename: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly manifestChecksum: string;
  readonly manifest: Readonly<Record<string, unknown>>;
}

export interface RosDerivedOutcomeDependencies {
  readonly sourceRow: RosDerivedOutcomeRow;
  readonly targetRow: RosDerivedOutcomeRow;
  readonly strategy: Strategy;
  readonly source: RosDerivedOutcomeSource;
  readonly sourceCorpusIdentity: string;
  /** Independently authenticated exhaustive proof; a self-hashed submitted record is not proof. */
  readonly auditVector: Readonly<Record<string, unknown>> | null;
}

export interface RosDerivedOutcomeRecord {
  readonly version: typeof VERSION;
  readonly kind: "native-v13" | "compatible-v12-nondst";
  readonly sourceCorpusIdentity: string;
  readonly originalForecast: RosDerivedOutcomeRow["forecast"];
  readonly targetForecast: RosDerivedOutcomeRow["forecast"];
  readonly scheduledGames: number;
  readonly strategy: Strategy;
  readonly source: RosDerivedOutcomeSource;
  readonly targetKey: RosOutcomeCacheKey;
  readonly proof: {
    readonly auditVectorSha256: string;
    readonly completeInputSha256: string;
  } | null;
  readonly generationModelVersion: string;
  readonly compatibleModelVersion: string;
}

export interface RosDerivedOutcomeReceipt {
  readonly targetKeyChecksum: string;
  readonly recordSha256: string;
  readonly sourceFileSha256: string;
  readonly originalManifestChecksum: string;
  readonly virtualManifestChecksum: string;
  readonly generationModelVersion: string;
  readonly compatibleModelVersion: string;
  readonly noOriginalWrites: true;
  readonly noSimulation: true;
  readonly canAuthorizeRelease: false;
}

export interface RosDerivedOutcomeCache extends RosOutcomeCache {
  expectedManifestChecksum(key: RosOutcomeCacheKey): string;
  receipts(): readonly RosDerivedOutcomeReceipt[];
}

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "Expected object");
  return value as Record<string, unknown>;
}
/** Own bounded plain JSON before any await; getters, cycles, sparse arrays and NaN are rejected. */
function canonical(value: unknown, maximumBytes = MAX_ENTRY_JSON): string {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  function visit(input: unknown, depth: number): string {
    assert(++nodes <= 100_000 && depth <= 24, "Derived reference JSON complexity exceeded");
    let result: string;
    if (input === null || typeof input === "boolean") result = JSON.stringify(input);
    else if (typeof input === "number") {
      assert(Number.isFinite(input), "Nonfinite reference JSON");
      result = JSON.stringify(input);
    } else if (typeof input === "string") {
      assert(Buffer.byteLength(input) <= maximumBytes - bytes, "Reference JSON too large");
      result = JSON.stringify(input);
    } else {
      assert(input !== null && typeof input === "object", "Expected plain reference JSON");
      const row = input as Record<string, unknown>;
      assert(!ancestors.has(row), "Cyclic reference JSON");
      assert(
        Array.isArray(input) ||
          Object.getPrototypeOf(row) === Object.prototype ||
          Object.getPrototypeOf(row) === null,
      );
      ancestors.add(row);
      const keys = Object.keys(row);
      assert(keys.length <= 20_000, "Reference collection too large");
      for (const key of keys)
        assert(
          Object.hasOwn(Object.getOwnPropertyDescriptor(row, key)!, "value"),
          "Reference getter",
        );
      if (Array.isArray(input)) {
        assert(
          keys.length === input.length && keys.every((key, index) => key === String(index)),
          "Reference arrays must be dense",
        );
        result = `[${input.map((child) => visit(child, depth + 1)).join(",")}]`;
      } else
        result = `{${keys
          .sort()
          .map((key) => `${visit(key, depth + 1)}:${visit(row[key], depth + 1)}`)
          .join(",")}}`;
      ancestors.delete(row);
      bytes += keys.length * 2 + 2;
      assert(bytes <= maximumBytes, "Reference JSON too large");
      return result;
    }
    bytes += Buffer.byteLength(result);
    assert(bytes <= maximumBytes, "Reference JSON too large");
    return result;
  }
  return visit(value, 0);
}
const digest = (value: unknown) => hash(canonical(value));
function snapshot<T>(value: T): T {
  return JSON.parse(canonical(value)) as T;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function same(left: unknown, right: unknown, message: string): void {
  assert.equal(canonical(left), canonical(right), message);
}
function sha(value: unknown): void {
  assert(typeof value === "string" && SHA.test(value), "SHA256 required");
}
function exactKeys(value: unknown, keys: readonly string[]): void {
  assert.equal(
    Object.keys(object(value)).sort().join(","),
    [...keys].sort().join(","),
    "Unexpected reference fields",
  );
}
function cacheFilename(key: RosOutcomeCacheKey): string {
  exactKeys(key, ["modelVersion", "identity"]);
  sha(key.identity);
  assert(key.modelVersion === V12 || key.modelVersion === V13, "Unsupported physical model");
  return `${digest({ version: 1, ...key })}.ros-outcomes`;
}
function validateSource(source: RosDerivedOutcomeSource): void {
  exactKeys(source, [
    "namespace",
    "key",
    "filename",
    "sha256",
    "bytes",
    "manifestChecksum",
    "manifest",
  ]);
  assert(NAMESPACES.includes(source.namespace), "Unconfigured source namespace");
  sha(source.sha256);
  sha(source.manifestChecksum);
  assert.equal(
    source.filename,
    cacheFilename(source.key),
    "Source basename must derive from physical key",
  );
  assert(
    Number.isSafeInteger(source.bytes) && source.bytes > 12 && source.bytes <= MAX_FILE,
    "Source file size exceeded",
  );
  const manifest = source.manifest;
  assert.equal(digest(manifest), source.manifestChecksum, "Complete original manifest checksum");
  assert.equal(manifest.format, "laces-ros-outcomes");
  assert.equal(manifest.version, 1);
  assert.equal(manifest.modelVersion, source.key.modelVersion);
  assert.equal(manifest.identity, source.key.identity);
  const metadata = object(manifest.metadata);
  assert.equal(metadata.identity, source.key.identity);
  assert.equal(object(object(metadata.core).provenance).modelVersion, source.key.modelVersion);
  assert.equal(manifest.scenarioCount, SCENARIOS);
  assert.equal(manifest.encoding, "float64-le-columns+uint8-games");
  assert.equal(manifest.compression, "gzip");
  const columns = manifest.columnNames;
  assert(Array.isArray(columns) && columns.length > 0 && columns.length <= 512);
  assert(
    columns.every(
      (name: unknown, index: number) =>
        typeof name === "string" &&
        /^[a-z][a-z0-9_]{0,127}$/u.test(name) &&
        (index === 0 || name > columns[index - 1]),
    ),
  );
  assert.equal(manifest.dataBytes, 24 + SCENARIOS * (8 * columns.length + 1));
  assert(
    Number.isSafeInteger(manifest.compressedBytes) &&
      Number(manifest.compressedBytes) > 0 &&
      Number(manifest.compressedBytes) <= 65 * 1_024 * 1_024,
  );
  sha(manifest.dataChecksum);
  sha(manifest.compressedChecksum);
  canonical(metadata, 64 * 1_024);
}
function keyFor(row: RosDerivedOutcomeRow, strategy: Strategy): RosOutcomeCacheKey {
  return strategy === "contextual" ? row.contextualKey : row.recencyKey;
}
function physicalRow(row: RosDerivedOutcomeRow): RosDerivedOutcomeRow {
  return {
    forecast: row.forecast,
    contextualKey: row.contextualKey,
    recencyKey: row.recencyKey,
    scheduledGames: row.scheduledGames,
  };
}

/** The caller authenticates these dependencies independently; this reconstructs, never trusts, a mapping. */
export function createRosDerivedOutcomeRecord(
  input: RosDerivedOutcomeDependencies,
): RosDerivedOutcomeRecord {
  const { sourceRow, targetRow, strategy, source, sourceCorpusIdentity, auditVector } =
    snapshot(input);
  assert(strategy === "contextual" || strategy === "availability-aware-recency");
  sha(sourceCorpusIdentity);
  validateSource(source);
  same(source.key, keyFor(sourceRow, strategy), "Original corpus key");
  const native = sourceRow.forecast.position === "DST";
  assert(["QB", "RB", "WR", "TE", "K", "DST"].includes(sourceRow.forecast.position));
  assert(
    native
      ? source.namespace === "native-dst-v13" || source.namespace === "expanded-dst-v13"
      : source.namespace === "original-v12",
    "DST compatibility mapping is forbidden",
  );
  assert.equal(source.key.modelVersion, native ? V13 : V12);
  assert(
    Number.isInteger(sourceRow.scheduledGames) &&
      sourceRow.scheduledGames >= 0 &&
      sourceRow.scheduledGames <= 18,
  );
  const targetKey = keyFor(targetRow, strategy);
  assert.equal(targetKey.modelVersion, V13);
  cacheFilename(targetKey);
  const core = object(object(source.manifest.metadata).core);
  const provenance = object(core.provenance);
  for (const [name, expected] of Object.entries({
    playerId: sourceRow.forecast.playerId,
    position: sourceRow.forecast.position,
    scheduledGames: sourceRow.scheduledGames,
  }))
    assert.equal(core[name], expected, `Original core ${name}`);
  for (const [name, expected] of Object.entries({
    strategy,
    season: sourceRow.forecast.forecastSeason,
    asOfWeek: sourceRow.forecast.asOfWeek,
    inputChecksum: sourceRow.forecast.inputChecksum,
    windowStartWeek: sourceRow.forecast.windowStartWeek,
    windowEndWeek: sourceRow.forecast.windowEndWeek,
  }))
    assert.equal(provenance[name], expected, `Original provenance ${name}`);
  let proof: RosDerivedOutcomeRecord["proof"] = null;
  if (native) {
    assert.equal(auditVector, null, "Native DST cannot carry compatibility proof");
    same(
      physicalRow(sourceRow),
      physicalRow(targetRow),
      "Native DST physical identity cannot change",
    );
  } else {
    assert(auditVector, "Independently authenticated non-DST equivalence proof required");
    const f = sourceRow.forecast;
    assert.equal(
      auditVector.forecastIdentity,
      `${f.forecastSeason}:${f.asOfWeek}:${f.position}:${f.playerId}`,
    );
    assert.equal(auditVector.strategy, strategy);
    assert.equal(auditVector.position, f.position);
    assert.equal(auditVector.originalModelVersion, V12);
    assert.equal(auditVector.originalCorpusIdentity, sourceCorpusIdentity);
    same(auditVector.originalKey, source.key, "Proof original key");
    same(auditVector.currentProposedKey, targetKey, "Proof target key");
    same(auditVector.originalManifest, source.manifest, "Proof physical manifest");
    same(auditVector.originalProvenance, provenance, "Proof original seed/provenance");
    assert.equal(auditVector.originalCacheFile, source.filename);
    assert.equal(auditVector.originalFileSha256, source.sha256);
    assert.equal(auditVector.originalManifestChecksum, source.manifestChecksum);
    assert.equal(auditVector.originalUncompressedPayloadChecksum, source.manifest.dataChecksum);
    for (const flag of ["inputChecksumEqual", "seedEqual", "windowEqual", "allPayloadChecksPassed"])
      assert.equal(auditVector[flag], true, `Equivalence proof ${flag}`);
    assert.equal(auditVector.fullReferencePaths, SCENARIOS);
    assert.equal(auditVector.scheduledGames, sourceRow.scheduledGames);
    sha(auditVector.currentCanonicalFullInputSha256);
    assert(f.contextualModelVersion.startsWith(`${V12}:contextual:`));
    assert(f.recencyModelVersion.startsWith(`${V12}:availability-aware-recency:`));
    same(
      {
        ...physicalRow(sourceRow),
        forecast: {
          ...f,
          contextualModelVersion: f.contextualModelVersion.replace(`${V12}:`, `${V13}:`),
          recencyModelVersion: f.recencyModelVersion.replace(`${V12}:`, `${V13}:`),
        },
        contextualKey: targetRow.contextualKey,
        recencyKey: targetRow.recencyKey,
      },
      physicalRow(targetRow),
      "Only proven keys and transient model view change",
    );
    proof = {
      auditVectorSha256: digest(auditVector),
      completeInputSha256: auditVector.currentCanonicalFullInputSha256 as string,
    };
  }
  return freeze({
    version: VERSION,
    kind: native ? "native-v13" : "compatible-v12-nondst",
    sourceCorpusIdentity,
    originalForecast: sourceRow.forecast,
    targetForecast: targetRow.forecast,
    scheduledGames: sourceRow.scheduledGames,
    strategy,
    source,
    targetKey,
    proof,
    generationModelVersion: source.key.modelVersion,
    compatibleModelVersion: V13,
  });
}

const stamp = (stat: BigIntStats) =>
  [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
async function rootIdentity(directory: string): Promise<string> {
  assert.equal(await realpath(directory), directory, "Source root or ancestor is a symlink");
  const stat = await lstat(directory, { bigint: true });
  assert(stat.isDirectory() && !stat.isSymbolicLink(), "Source root is not a directory");
  return `${stat.dev}:${stat.ino}`;
}
async function exactRead(
  handle: FileHandle,
  count: number,
  position: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const buffer = Buffer.alloc(count);
  let offset = 0;
  while (offset < count) {
    signal?.throwIfAborted();
    const result = await handle.read(buffer, offset, count - offset, position + offset);
    assert(result.bytesRead > 0, "Truncated reference file");
    offset += result.bytesRead;
  }
  return buffer;
}
/** Read-only inventory creation for explicit package preparation, never replay/admission proof. */
export async function inspectRosDerivedOutcomeSource(input: {
  readonly directory: string;
  readonly namespace: RosDerivedOutcomeSource["namespace"];
  readonly key: RosOutcomeCacheKey;
  readonly signal?: AbortSignal;
}): Promise<RosDerivedOutcomeSource> {
  const { directory, signal, namespace } = input;
  assert(path.isAbsolute(directory) && path.resolve(directory) === directory);
  assert(NAMESPACES.includes(namespace));
  const key = freeze(snapshot(input.key));
  const filename = cacheFilename(key);
  signal?.throwIfAborted();
  const root = await rootIdentity(directory);
  const handle = await open(
    path.join(directory, filename),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const initial = await handle.stat({ bigint: true });
    assert(initial.isFile() && initial.size > 12n && initial.size <= BigInt(MAX_FILE));
    const prefix = await exactRead(handle, 12, 0, signal);
    assert.equal(prefix.subarray(0, 8).toString(), "LOROSC01");
    const count = prefix.readUInt32LE(8);
    assert(count > 0 && count <= MAX_MANIFEST);
    const envelope = object(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await exactRead(handle, count, 12, signal),
        ),
      ),
    );
    const digest = createHash("sha256"),
      chunk = Buffer.alloc(1_024 * 1_024);
    const bytes = Number(initial.size);
    let offset = 0;
    while (offset < bytes) {
      signal?.throwIfAborted();
      const read = await handle.read(chunk, 0, Math.min(chunk.length, bytes - offset), offset);
      assert(read.bytesRead > 0, "Truncated inventory source");
      digest.update(chunk.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const source: RosDerivedOutcomeSource = {
      namespace,
      key,
      filename,
      sha256: digest.digest("hex"),
      bytes,
      manifest: object(envelope.manifest),
      manifestChecksum: String(envelope.checksum),
    };
    validateSource(source);
    assert.equal(stamp(await handle.stat({ bigint: true })), stamp(initial));
    assert.equal(
      stamp(await lstat(path.join(directory, filename), { bigint: true })),
      stamp(initial),
    );
    assert.equal(await rootIdentity(directory), root);
    signal?.throwIfAborted();
    return freeze(source);
  } finally {
    await handle.close();
  }
}

/** Physical authentication only; callers must separately authenticate the pinned source manifest. */
export async function readAuthenticatedRosOutcomeSource(
  directory: string,
  source: RosDerivedOutcomeSource,
  signal?: AbortSignal,
) {
  assert(
    path.isAbsolute(directory) && path.resolve(directory) === directory,
    "Source root must be an explicit normalized absolute directory",
  );
  source = freeze(snapshot(source));
  validateSource(source);
  signal?.throwIfAborted();
  const root = await rootIdentity(directory);
  const filename = path.join(directory, source.filename);
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const initial = await handle.stat({ bigint: true });
    assert(
      initial.isFile() && initial.size === BigInt(source.bytes) && initial.size <= BigInt(MAX_FILE),
      "Exact bounded regular source file required",
    );
    const checksum = createHash("sha256");
    const chunk = Buffer.alloc(1_024 * 1_024);
    let offset = 0;
    while (offset < source.bytes) {
      signal?.throwIfAborted();
      const read = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, source.bytes - offset),
        offset,
      );
      assert(read.bytesRead > 0, "Truncated source payload");
      checksum.update(chunk.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    assert.equal(checksum.digest("hex"), source.sha256, "Original source file hash");
    const prefix = await exactRead(handle, 12, 0, signal);
    assert.equal(prefix.subarray(0, 8).toString(), "LOROSC01");
    const count = prefix.readUInt32LE(8);
    assert(count > 0 && count <= MAX_MANIFEST, "Source manifest exceeded bounds");
    const envelope = object(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await exactRead(handle, count, 12, signal),
        ),
      ),
    );
    assert.equal(source.bytes, 12 + count + Number(source.manifest.compressedBytes));
    assert.equal(envelope.checksum, source.manifestChecksum);
    same(envelope.manifest, source.manifest, "Authenticated complete source manifest");
    async function unchanged(): Promise<void> {
      assert.equal(
        stamp(await handle.stat({ bigint: true })),
        stamp(initial),
        "Open source changed during read",
      );
      const current = await lstat(filename, { bigint: true });
      assert(current.isFile() && !current.isSymbolicLink());
      assert.equal(stamp(current), stamp(initial), "Source path changed during read");
      assert.equal(await rootIdentity(directory), root, "Source root changed during read");
    }
    await unchanged();
    signal?.throwIfAborted();
    const read = await createRosOutcomeCache({ directory }).read(source.key, {
      expectedScenarioCount: SCENARIOS,
      ...(signal ? { signal } : {}),
    });
    assert.equal(read.state, "hit", "Original real-codec validation failed");
    assert(read.state === "hit");
    assert.equal(read.manifestChecksum, source.manifestChecksum, "Decoded source commitment");
    same(read.ensemble.metadata, source.manifest.metadata, "Decoded original metadata");
    await unchanged();
    signal?.throwIfAborted();
    return read;
  } finally {
    await handle.close();
  }
}
function virtualMetadata(record: RosDerivedOutcomeRecord): RosOutcomeCacheEnsemble["metadata"] {
  const metadata = snapshot(object(record.source.manifest.metadata));
  metadata.identity = record.targetKey.identity;
  object(object(metadata.core).provenance).modelVersion = V13;
  return metadata as RosOutcomeCacheEnsemble["metadata"];
}
function virtualManifestChecksum(record: RosDerivedOutcomeRecord): string {
  return digest({
    ...record.source.manifest,
    modelVersion: V13,
    identity: record.targetKey.identity,
    metadata: virtualMetadata(record),
  });
}

/**
 * Low-level, read-only references. The enclosing verifier must authenticate proof dependencies and
 * retain configured source files for their dependency lifetime. This adapter grants no admission.
 * Original physical bytes/keys/seeds stay untouched; virtual current metadata exists only in RAM.
 */
export function createRosDerivedOutcomeCache(options: {
  readonly records: readonly RosDerivedOutcomeRecord[];
  readonly dependencies: readonly RosDerivedOutcomeDependencies[];
  readonly sourceRoots: Readonly<Partial<Record<Namespace, string>>>;
}): RosDerivedOutcomeCache {
  assert(
    options.records.length > 0 && options.records.length <= 12_000,
    "Reference population exceeded bounds",
  );
  assert.equal(
    options.records.length,
    options.dependencies.length,
    "Independent dependency coverage",
  );
  const roots = snapshot(options.sourceRoots);
  for (const [namespace, directory] of Object.entries(roots)) {
    assert(NAMESPACES.includes(namespace as Namespace), "Unknown configured source namespace");
    assert(
      typeof directory === "string" &&
        path.isAbsolute(directory) &&
        path.resolve(directory) === directory,
      "Source roots must be explicit normalized absolute directories",
    );
  }
  const entries = new Map<
    string,
    {
      record: RosDerivedOutcomeRecord;
      directory: string;
      manifestChecksum: string;
      recordSha256: string;
    }
  >();
  const sources = new Set<string>();
  const receipts = new Map<string, RosDerivedOutcomeReceipt>();
  // A dependency repeats the source manifest/forecast and carries its independent audit proof.
  // Bound the two input populations independently: only reconstructed records are retained by
  // this cache; caller-owned dependencies are consumed one at a time. The complete authenticated
  // release cohort is about 37 MB of records plus 127 MB of dependencies, not one 128 MiB file.
  let recordBytes = 0;
  let dependencyBytes = 0;
  for (const [index, submitted] of options.records.entries()) {
    const dependency = options.dependencies[index]!;
    recordBytes += Buffer.byteLength(canonical(submitted));
    dependencyBytes += Buffer.byteLength(canonical(dependency));
    assert(recordBytes <= MAX_TOTAL_JSON, "Reference record population JSON exceeded bounds");
    assert(
      dependencyBytes <= MAX_TOTAL_JSON,
      "Reference dependency population JSON exceeded bounds",
    );
    const record = createRosDerivedOutcomeRecord(dependency);
    same(submitted, record, "Independent record reconstruction");
    const directory = roots[record.source.namespace];
    assert(directory, "Source namespace has no explicitly configured root");
    const id = digest(record.targetKey);
    const address = path.join(directory, record.source.filename);
    assert(!entries.has(id) && !sources.has(address), "Duplicate target or physical source");
    sources.add(address);
    entries.set(id, {
      record,
      directory,
      manifestChecksum: virtualManifestChecksum(record),
      recordSha256: digest(record),
    });
  }
  function entryFor(key: RosOutcomeCacheKey) {
    cacheFilename(key);
    assert.equal(key.modelVersion, V13, "Only configured virtual current keys are readable");
    const id = digest(key);
    const entry = entries.get(id);
    assert(entry, "Unknown derived reference key");
    return { ...entry, id };
  }
  return Object.freeze({
    async read(key, readOptions = {}) {
      const signal = readOptions.signal;
      signal?.throwIfAborted();
      assert(
        readOptions.expectedScenarioCount === undefined ||
          readOptions.expectedScenarioCount === SCENARIOS,
        "Reference scenario count mismatch",
      );
      const { record, directory, id, manifestChecksum, recordSha256 } = entryFor(key);
      const read = await readAuthenticatedRosOutcomeSource(directory, record.source, signal);
      const expected = {
        ...record.originalForecast,
        strategy: record.strategy,
        weeklyModelVersion: object(object(object(record.source.manifest.metadata).core).provenance)
          .weeklyModelVersion as string,
        scheduledGames: record.scheduledGames,
      };
      let ensemble = read.ensemble;
      if (record.kind === "compatible-v12-nondst") {
        restoreRetainedV12CachedRosHistoricalOutcome(ensemble, record.source.key, expected);
        ensemble = { ...ensemble, metadata: virtualMetadata(record) };
        restoreCachedRosHistoricalOutcome(ensemble, record.targetKey, {
          ...expected,
          ...record.targetForecast,
        });
      } else restoreCachedRosHistoricalOutcome(ensemble, record.targetKey, expected);
      signal?.throwIfAborted();
      receipts.set(
        id,
        freeze({
          targetKeyChecksum: id,
          recordSha256,
          sourceFileSha256: record.source.sha256,
          originalManifestChecksum: record.source.manifestChecksum,
          virtualManifestChecksum: manifestChecksum,
          generationModelVersion: record.generationModelVersion,
          compatibleModelVersion: V13,
          noOriginalWrites: true,
          noSimulation: true,
          canAuthorizeRelease: false,
        }),
      );
      return { state: "hit", ensemble, manifestChecksum };
    },
    write() {
      return Promise.reject(
        new Error("Derived outcome cache is read-only; no simulation or fallback"),
      );
    },
    expectedManifestChecksum(key) {
      return entryFor(key).manifestChecksum;
    },
    receipts() {
      return snapshot([...receipts.values()]);
    },
  } satisfies RosDerivedOutcomeCache);
}
