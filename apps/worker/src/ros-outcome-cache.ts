import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { endianness } from "node:os";
import path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { assertRosCacheHeadroom, rosCacheCompressedWriteBudget } from "./ros-cache-disk-space.js";

export const ROS_OUTCOME_CACHE_VERSION = 1;
const FILE_MAGIC = Buffer.from("LOROSC01");
const DATA_MAGIC = Buffer.from("LOROSD01");
const FILE_HEADER_BYTES = 12;
const DATA_HEADER_BYTES = 24;
const LITTLE_ENDIAN = endianness() === "LE";
const MAXIMUM_MANIFEST_BYTES = 192 * 1_024;
const SHA256 = /^[a-f0-9]{64}$/u;
const COLUMN_NAME = /^[a-z][a-z0-9_]{0,127}$/u;

export interface RosOutcomeCacheKey {
  readonly modelVersion: string;
  /** SHA256 of the complete scoring-independent inputs, source lineage, seed and strategy. */
  readonly identity: string;
}

export type RosOutcomeCacheJson =
  | null
  | boolean
  | number
  | string
  | readonly RosOutcomeCacheJson[]
  | { readonly [key: string]: RosOutcomeCacheJson };

export interface RosOutcomeCacheEnsemble {
  readonly scenarioCount: number;
  readonly columns: Readonly<Record<string, Float64Array>>;
  readonly games: Uint8Array;
  /** Reproducibility data only. Callers must never include credentials or private league data. */
  readonly metadata: Readonly<Record<string, RosOutcomeCacheJson>>;
}

export interface RosOutcomeCacheLimits {
  readonly maximumScenarioCount: number;
  readonly maximumColumns: number;
  readonly maximumDataBytes: number;
  readonly maximumCompressedBytes: number;
  readonly maximumMetadataBytes: number;
}

export const ROS_OUTCOME_CACHE_LIMITS: RosOutcomeCacheLimits = Object.freeze({
  maximumScenarioCount: 16_384,
  maximumColumns: 512,
  maximumDataBytes: 64 * 1_024 * 1_024,
  maximumCompressedBytes: 65 * 1_024 * 1_024,
  maximumMetadataBytes: 64 * 1_024,
});

type CorruptionReason =
  | "manifest_invalid"
  | "manifest_checksum_mismatch"
  | "identity_mismatch"
  | "payload_invalid"
  | "payload_checksum_mismatch"
  | "limits_exceeded"
  | "nonfinite_component";

export type RosOutcomeCacheLookup =
  | { readonly state: "missing" }
  | { readonly state: "corrupt"; readonly reason: CorruptionReason }
  | {
      readonly state: "hit";
      readonly ensemble: RosOutcomeCacheEnsemble;
      readonly manifestChecksum: string;
    };

export interface RosOutcomeCache {
  read(
    key: RosOutcomeCacheKey,
    options?: { readonly signal?: AbortSignal; readonly expectedScenarioCount?: number },
  ): Promise<RosOutcomeCacheLookup>;
  write(
    key: RosOutcomeCacheKey,
    ensemble: RosOutcomeCacheEnsemble,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly state: "written" | "existing"; readonly manifestChecksum: string }>;
}

export class RosOutcomeCacheError extends Error {
  constructor(readonly code: "invalid_input" | "identity_conflict" | "existing_entry_corrupt") {
    super(`ROS outcome cache ${code}`);
    this.name = "RosOutcomeCacheError";
  }
}

class CorruptEntry extends Error {
  constructor(readonly reason: CorruptionReason) {
    super(`ROS outcome cache ${reason}`);
  }
}

interface Manifest {
  readonly format: "laces-ros-outcomes";
  readonly version: typeof ROS_OUTCOME_CACHE_VERSION;
  readonly modelVersion: string;
  readonly identity: string;
  readonly scenarioCount: number;
  readonly columnNames: readonly string[];
  readonly encoding: "float64-le-columns+uint8-games";
  readonly compression: "gzip";
  readonly dataBytes: number;
  readonly compressedBytes: number;
  readonly dataChecksum: string;
  readonly compressedChecksum: string;
  readonly metadata: RosOutcomeCacheEnsemble["metadata"];
}

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validCount = (value: unknown, maximum: number): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum;
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

/** Canonical, bounded plain JSON. Rejects cycles, toJSON, undefined and nonfinite values. */
function canonicalJson(value: unknown, maximumBytes: number): string {
  let remaining = maximumBytes;
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (input: unknown, depth: number): string => {
    nodes += 1;
    if (depth > 16 || nodes > 8_192) throw new RosOutcomeCacheError("invalid_input");
    let result: string;
    if (input === null || typeof input === "boolean") result = JSON.stringify(input);
    else if (typeof input === "number" && Number.isFinite(input)) result = JSON.stringify(input);
    else if (typeof input === "string") {
      if (Buffer.byteLength(input) > remaining) throw new RosOutcomeCacheError("invalid_input");
      result = JSON.stringify(input);
    } else if (typeof input === "object" && input !== null) {
      if (ancestors.has(input)) throw new RosOutcomeCacheError("invalid_input");
      ancestors.add(input);
      if (Array.isArray(input)) {
        if (input.length > 8_192) throw new RosOutcomeCacheError("invalid_input");
        const values: string[] = [];
        for (let index = 0; index < input.length; index += 1) {
          values.push(visit(input[index], depth + 1));
        }
        result = `[${values.join(",")}]`;
      } else {
        if (
          Object.getPrototypeOf(input) !== Object.prototype &&
          Object.getPrototypeOf(input) !== null
        )
          throw new RosOutcomeCacheError("invalid_input");
        const keys = Object.keys(input).sort();
        if (keys.length > 8_192) throw new RosOutcomeCacheError("invalid_input");
        result = `{${keys
          .map(
            (key) =>
              `${visit(key, depth + 1)}:${visit((input as Record<string, unknown>)[key], depth + 1)}`,
          )
          .join(",")}}`;
      }
      ancestors.delete(input);
      // Children already consumed their byte budget; charge just structural punctuation here.
      remaining -= Array.isArray(input) ? input.length + 2 : Object.keys(input).length * 2 + 2;
      if (remaining < 0) throw new RosOutcomeCacheError("invalid_input");
      return result;
    } else throw new RosOutcomeCacheError("invalid_input");
    remaining -= Buffer.byteLength(result);
    if (remaining < 0) throw new RosOutcomeCacheError("invalid_input");
    return result;
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(result) > maximumBytes) throw new RosOutcomeCacheError("invalid_input");
  return result;
}

function validateKey(key: RosOutcomeCacheKey): void {
  if (
    typeof key.identity !== "string" ||
    typeof key.modelVersion !== "string" ||
    !SHA256.test(key.identity) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(key.modelVersion)
  )
    throw new RosOutcomeCacheError("invalid_input");
}

function dataSize(scenarios: number, columns: number): number {
  return DATA_HEADER_BYTES + scenarios * (columns * Float64Array.BYTES_PER_ELEMENT + 1);
}

function validateManifest(
  value: unknown,
  key: RosOutcomeCacheKey,
  limits: RosOutcomeCacheLimits,
  expectedScenarioCount?: number,
): Manifest {
  if (
    !object(value) ||
    value.format !== "laces-ros-outcomes" ||
    value.version !== ROS_OUTCOME_CACHE_VERSION ||
    value.encoding !== "float64-le-columns+uint8-games" ||
    value.compression !== "gzip" ||
    typeof value.dataChecksum !== "string" ||
    !SHA256.test(value.dataChecksum) ||
    typeof value.compressedChecksum !== "string" ||
    !SHA256.test(value.compressedChecksum) ||
    !object(value.metadata) ||
    !Array.isArray(value.columnNames)
  )
    throw new CorruptEntry("manifest_invalid");
  if (value.modelVersion !== key.modelVersion || value.identity !== key.identity)
    throw new CorruptEntry("identity_mismatch");
  if (
    !validCount(value.scenarioCount, limits.maximumScenarioCount) ||
    !validCount(value.columnNames.length, limits.maximumColumns) ||
    !validCount(value.dataBytes, limits.maximumDataBytes) ||
    !validCount(value.compressedBytes, limits.maximumCompressedBytes)
  )
    throw new CorruptEntry("limits_exceeded");
  if (expectedScenarioCount !== undefined && value.scenarioCount !== expectedScenarioCount)
    throw new CorruptEntry("identity_mismatch");
  const columnNames = value.columnNames;
  if (
    columnNames.some((name: unknown) => typeof name !== "string" || !COLUMN_NAME.test(name)) ||
    columnNames.some(
      (name: string, index: number) => index > 0 && name <= columnNames[index - 1]!,
    ) ||
    value.dataBytes !== dataSize(value.scenarioCount, value.columnNames.length)
  )
    throw new CorruptEntry("manifest_invalid");
  try {
    canonicalJson(value.metadata, limits.maximumMetadataBytes);
  } catch {
    throw new CorruptEntry("manifest_invalid");
  }
  return value as unknown as Manifest;
}

function byteMeter(maximum: number, onChunk: (chunk: Buffer) => void, failure: () => Error) {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maximum) callback(failure());
      else {
        onChunk(chunk);
        callback(null, chunk);
      }
    },
  });
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  position: number,
) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(buffer, offset, size - offset, position + offset);
    if (result.bytesRead === 0) throw new CorruptEntry("payload_invalid");
    offset += result.bytesRead;
  }
  return buffer;
}

function decodePayload(
  payload: Buffer,
  manifest: Manifest,
  signal?: AbortSignal,
): RosOutcomeCacheEnsemble {
  if (
    payload.length !== manifest.dataBytes ||
    !payload.subarray(0, 8).equals(DATA_MAGIC) ||
    payload.readUInt32LE(8) !== ROS_OUTCOME_CACHE_VERSION ||
    payload.readUInt32LE(12) !== manifest.scenarioCount ||
    payload.readUInt32LE(16) !== manifest.columnNames.length ||
    payload.readUInt32LE(20) !== manifest.scenarioCount
  )
    throw new CorruptEntry("payload_invalid");
  const columns: Record<string, Float64Array> = Object.create(null) as Record<string, Float64Array>;
  let offset = DATA_HEADER_BYTES;
  for (const name of manifest.columnNames) {
    signal?.throwIfAborted();
    const values = new Float64Array(manifest.scenarioCount);
    if (LITTLE_ENDIAN) {
      // Copy bytes into owned storage; a view would retain and alias the complete payload.
      new Uint8Array(values.buffer).set(payload.subarray(offset, offset + values.byteLength));
      offset += values.byteLength;
      for (let index = 0; index < values.length; index += 1) {
        if (!Number.isFinite(values[index])) throw new CorruptEntry("nonfinite_component");
      }
    } else {
      for (let index = 0; index < values.length; index += 1) {
        const value = payload.readDoubleLE(offset);
        if (!Number.isFinite(value)) throw new CorruptEntry("nonfinite_component");
        values[index] = value;
        offset += 8;
      }
    }
    columns[name] = values;
  }
  return {
    scenarioCount: manifest.scenarioCount,
    columns,
    games: new Uint8Array(payload.subarray(offset)),
    metadata: manifest.metadata,
  };
}

/**
 * One forecast/strategy per immutable file. It never triggers model work on a miss, evicts
 * evidence, or accumulates a corpus in memory. Corrupt evidence is distinct from a cold cache.
 */
export function createRosOutcomeCache(options: {
  readonly directory: string;
  readonly limits?: Partial<RosOutcomeCacheLimits>;
}): RosOutcomeCache {
  const limits = { ...ROS_OUTCOME_CACHE_LIMITS, ...options.limits };
  for (const name of Object.keys(ROS_OUTCOME_CACHE_LIMITS) as (keyof RosOutcomeCacheLimits)[]) {
    if (!validCount(limits[name], ROS_OUTCOME_CACHE_LIMITS[name]))
      throw new RosOutcomeCacheError("invalid_input");
  }
  const entryPath = (key: RosOutcomeCacheKey) =>
    path.join(
      options.directory,
      `${digest(canonicalJson({ version: ROS_OUTCOME_CACHE_VERSION, modelVersion: key.modelVersion, identity: key.identity }, 1_024))}.ros-outcomes`,
    );

  const read: RosOutcomeCache["read"] = async (requestedKey, readOptions = {}) => {
    const key = { modelVersion: requestedKey.modelVersion, identity: requestedKey.identity };
    validateKey(key);
    const { signal, expectedScenarioCount } = readOptions;
    signal?.throwIfAborted();
    if (
      expectedScenarioCount !== undefined &&
      !validCount(expectedScenarioCount, limits.maximumScenarioCount)
    )
      throw new RosOutcomeCacheError("invalid_input");
    let handle;
    try {
      handle = await open(entryPath(key), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { state: "missing" };
      if (errorCode(error) === "ELOOP") return { state: "corrupt", reason: "manifest_invalid" };
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new CorruptEntry("manifest_invalid");
      if (stat.size > FILE_HEADER_BYTES + MAXIMUM_MANIFEST_BYTES + limits.maximumCompressedBytes)
        throw new CorruptEntry("limits_exceeded");
      const header = await readExactly(handle, FILE_HEADER_BYTES, 0);
      if (!header.subarray(0, 8).equals(FILE_MAGIC)) throw new CorruptEntry("manifest_invalid");
      const manifestBytes = header.readUInt32LE(8);
      if (!validCount(manifestBytes, MAXIMUM_MANIFEST_BYTES))
        throw new CorruptEntry("limits_exceeded");
      const serialized = await readExactly(handle, manifestBytes, FILE_HEADER_BYTES);
      let envelope: unknown;
      try {
        envelope = JSON.parse(serialized.toString("utf8"));
      } catch {
        throw new CorruptEntry("manifest_invalid");
      }
      if (
        !object(envelope) ||
        typeof envelope.checksum !== "string" ||
        !SHA256.test(envelope.checksum)
      )
        throw new CorruptEntry("manifest_invalid");
      let canonical: string;
      try {
        canonical = canonicalJson(envelope.manifest, MAXIMUM_MANIFEST_BYTES);
      } catch {
        throw new CorruptEntry("manifest_invalid");
      }
      if (digest(canonical) !== envelope.checksum)
        throw new CorruptEntry("manifest_checksum_mismatch");
      const manifest = validateManifest(envelope.manifest, key, limits, expectedScenarioCount);
      const payloadOffset = FILE_HEADER_BYTES + manifestBytes;
      if (stat.size !== payloadOffset + manifest.compressedBytes)
        throw new CorruptEntry("payload_invalid");
      const compressedHash = createHash("sha256");
      const dataHash = createHash("sha256");
      const chunks: Buffer[] = [];
      let compressedBytes = 0;
      let rawBytes = 0;
      await pipeline(
        handle.createReadStream({ start: payloadOffset, autoClose: false }),
        byteMeter(
          manifest.compressedBytes,
          (chunk) => {
            compressedBytes += chunk.length;
            compressedHash.update(chunk);
          },
          () => new CorruptEntry("limits_exceeded"),
        ),
        createGunzip({ chunkSize: 256 * 1_024 }),
        new Writable({
          write(chunk: Buffer, _encoding, callback) {
            rawBytes += chunk.length;
            if (rawBytes > manifest.dataBytes) callback(new CorruptEntry("limits_exceeded"));
            else {
              dataHash.update(chunk);
              chunks.push(chunk);
              callback();
            }
          },
        }),
        { signal },
      );
      signal?.throwIfAborted();
      if (compressedBytes !== manifest.compressedBytes || rawBytes !== manifest.dataBytes)
        throw new CorruptEntry("payload_invalid");
      if (
        compressedHash.digest("hex") !== manifest.compressedChecksum ||
        dataHash.digest("hex") !== manifest.dataChecksum
      )
        throw new CorruptEntry("payload_checksum_mismatch");
      return {
        state: "hit",
        ensemble: decodePayload(Buffer.concat(chunks, rawBytes), manifest, signal),
        manifestChecksum: envelope.checksum,
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof CorruptEntry) return { state: "corrupt", reason: error.reason };
      if (
        ["Z_DATA_ERROR", "Z_BUF_ERROR", "ERR_STREAM_PREMATURE_CLOSE"].includes(
          errorCode(error) ?? "",
        )
      )
        return { state: "corrupt", reason: "payload_invalid" };
      throw error;
    } finally {
      await handle.close();
    }
  };

  const write: RosOutcomeCache["write"] = async (requestedKey, ensemble, writeOptions = {}) => {
    const key = { modelVersion: requestedKey.modelVersion, identity: requestedKey.identity };
    validateKey(key);
    const { signal } = writeOptions;
    signal?.throwIfAborted();
    const scenarioCount = ensemble.scenarioCount;
    const columnNames = Object.keys(ensemble.columns).sort();
    const dataBytes = dataSize(scenarioCount, columnNames.length);
    if (
      !validCount(scenarioCount, limits.maximumScenarioCount) ||
      !validCount(columnNames.length, limits.maximumColumns) ||
      dataBytes > limits.maximumDataBytes ||
      !(ensemble.games instanceof Uint8Array) ||
      ensemble.games.length !== scenarioCount ||
      columnNames.some(
        (name) =>
          !COLUMN_NAME.test(name) ||
          !(ensemble.columns[name] instanceof Float64Array) ||
          ensemble.columns[name].length !== scenarioCount,
      ) ||
      !object(ensemble.metadata)
    )
      throw new RosOutcomeCacheError("invalid_input");
    // Snapshot the one bounded forecast before awaiting I/O; callers may reuse their buffers
    // once write() returns its promise without changing the evidence being committed.
    const metadata = JSON.parse(
      canonicalJson(ensemble.metadata, limits.maximumMetadataBytes),
    ) as Manifest["metadata"];
    const columns = Object.fromEntries(
      columnNames.map((name) => {
        const values = new Float64Array(ensemble.columns[name]!);
        if (values.some((value) => !Number.isFinite(value)))
          throw new RosOutcomeCacheError("invalid_input");
        return [name, values];
      }),
    );
    const games = new Uint8Array(ensemble.games);
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    await assertRosCacheHeadroom(
      options.directory,
      rosCacheCompressedWriteBudget(dataBytes),
      signal,
    );
    const temporary = await mkdtemp(path.join(options.directory, ".ros-outcomes-partial-"));
    try {
      const compressedPath = path.join(temporary, "data.gz");
      const dataHash = createHash("sha256");
      const compressedHash = createHash("sha256");
      let compressedBytes = 0;
      function* encode() {
        signal?.throwIfAborted();
        const header = Buffer.alloc(DATA_HEADER_BYTES);
        DATA_MAGIC.copy(header);
        header.writeUInt32LE(ROS_OUTCOME_CACHE_VERSION, 8);
        header.writeUInt32LE(scenarioCount, 12);
        header.writeUInt32LE(columnNames.length, 16);
        header.writeUInt32LE(scenarioCount, 20);
        yield header;
        for (const name of columnNames) {
          signal?.throwIfAborted();
          const values = columns[name]!;
          const buffer = Buffer.alloc(values.length * 8);
          for (let index = 0; index < values.length; index += 1) {
            const value = values[index]!;
            if (!Number.isFinite(value)) throw new RosOutcomeCacheError("invalid_input");
            buffer.writeDoubleLE(value, index * 8);
          }
          yield buffer;
        }
        yield Buffer.from(games);
      }
      await pipeline(
        Readable.from(encode()),
        byteMeter(
          dataBytes,
          (chunk) => {
            dataHash.update(chunk);
          },
          () => new RosOutcomeCacheError("invalid_input"),
        ),
        createGzip({ level: 1 }),
        byteMeter(
          limits.maximumCompressedBytes,
          (chunk) => {
            compressedBytes += chunk.length;
            compressedHash.update(chunk);
          },
          () => new RosOutcomeCacheError("invalid_input"),
        ),
        createWriteStream(compressedPath, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      const manifest: Manifest = {
        format: "laces-ros-outcomes",
        version: ROS_OUTCOME_CACHE_VERSION,
        modelVersion: key.modelVersion,
        identity: key.identity,
        scenarioCount,
        columnNames,
        encoding: "float64-le-columns+uint8-games",
        compression: "gzip",
        dataBytes,
        compressedBytes,
        dataChecksum: dataHash.digest("hex"),
        compressedChecksum: compressedHash.digest("hex"),
        metadata,
      };
      const manifestChecksum = digest(canonicalJson(manifest, MAXIMUM_MANIFEST_BYTES));
      const envelope = Buffer.from(
        canonicalJson({ manifest, checksum: manifestChecksum }, MAXIMUM_MANIFEST_BYTES),
      );
      const prefix = Buffer.alloc(FILE_HEADER_BYTES + envelope.length);
      FILE_MAGIC.copy(prefix);
      prefix.writeUInt32LE(envelope.length, 8);
      envelope.copy(prefix, FILE_HEADER_BYTES);
      const temporaryEntry = path.join(temporary, "entry");
      // The compressed temporary already occupies disk. Reserve the exact second copy before
      // allocating it; a failure removes this attempt's partial directory in finally.
      await assertRosCacheHeadroom(options.directory, prefix.length + compressedBytes, signal);
      await writeFile(temporaryEntry, prefix, { flag: "wx", mode: 0o600 });
      await pipeline(
        createReadStream(compressedPath),
        createWriteStream(temporaryEntry, { flags: "a" }),
        { signal },
      );
      const handle = await open(temporaryEntry, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      signal?.throwIfAborted();
      try {
        // An atomic hard link cannot replace an existing winner. Both paths share a filesystem.
        await link(temporaryEntry, entryPath(key));
        return { state: "written", manifestChecksum };
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const existing = await read(key, { ...(signal ? { signal } : {}) });
        if (existing.state !== "hit") throw new RosOutcomeCacheError("existing_entry_corrupt");
        if (existing.manifestChecksum !== manifestChecksum)
          throw new RosOutcomeCacheError("identity_conflict");
        return { state: "existing", manifestChecksum };
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  };
  return { read, write };
}
