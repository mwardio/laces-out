import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

import { assertRosCacheHeadroom } from "./ros-cache-disk-space.js";

export const ROS_LIVE_GENERATION_STORE_VERSION = "ros-live-generation-v1";
export const ROS_LIVE_GENERATION_STORE_LIMITS = Object.freeze({
  maximumCalibrationBytes: 8 * 1_024 * 1_024,
  maximumTargetsBytes: 32 * 1_024 * 1_024,
  maximumDepth: 32,
  maximumNodes: 1_000_000,
});
export type RosLiveGenerationStoreLimits = Readonly<{
  [K in keyof typeof ROS_LIVE_GENERATION_STORE_LIMITS]: number;
}>;
type Kind = "generation" | "calibration" | "targets";
interface OperationOptions {
  readonly signal?: AbortSignal;
}
export type RosLiveGenerationJsonRead =
  | { readonly state: "missing" }
  | { readonly state: "hit"; readonly value: unknown; readonly checksum: string };
export interface RosLiveGenerationJsonWrite {
  readonly state: "written" | "existing";
  readonly checksum: string;
}
export interface RosLiveGenerationPin {
  readonly physicalIdentity: string;
  readonly asOfAt: string;
}
export interface RosLiveGenerationStore {
  getOrCreateGeneration(
    physicalIdentity: string,
    requestedAsOfAt: string,
    options?: OperationOptions,
  ): Promise<RosLiveGenerationPin>;
  readCalibration(
    inputDigest: string,
    options?: OperationOptions,
  ): Promise<RosLiveGenerationJsonRead>;
  writeCalibration(
    inputDigest: string,
    value: unknown,
    options?: OperationOptions,
  ): Promise<RosLiveGenerationJsonWrite>;
  readTargets(inputDigest: string, options?: OperationOptions): Promise<RosLiveGenerationJsonRead>;
  writeTargets(
    inputDigest: string,
    value: unknown,
    options?: OperationOptions,
  ): Promise<RosLiveGenerationJsonWrite>;
}

export class RosLiveGenerationStoreError extends Error {
  constructor(
    readonly code: "invalid_input" | "corrupt_entry" | "identity_conflict" | "unsafe_directory",
  ) {
    super(`ROS live generation store ${code}`);
    this.name = "RosLiveGenerationStoreError";
  }
}
const SHA256 = /^[a-f0-9]{64}$/u;
const ENVELOPE_BYTES = 1_024;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function validateIdentity(identity: string): void {
  if (typeof identity !== "string" || !SHA256.test(identity))
    throw new RosLiveGenerationStoreError("invalid_input");
}
function canonicalInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 24 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

/** Reject lossy/non-JSON values and accessors; snapshot synchronously before any awaited I/O. */
function canonicalJson(
  value: unknown,
  maximumBytes: number,
  limits: RosLiveGenerationStoreLimits,
): string {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const emit = (text: string) => {
    bytes += Buffer.byteLength(text);
    if (bytes > maximumBytes) throw new RosLiveGenerationStoreError("invalid_input");
    return text;
  };
  const visit = (item: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > limits.maximumNodes || depth > limits.maximumDepth)
      throw new RosLiveGenerationStoreError("invalid_input");
    if (item === null || typeof item === "boolean") return emit(JSON.stringify(item));
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new RosLiveGenerationStoreError("invalid_input");
      // JSON's -0 spelling round-trips IEEE negative zero instead of silently changing it to +0.
      return emit(Object.is(item, -0) ? "-0" : JSON.stringify(item));
    }
    if (typeof item === "string") {
      if (Buffer.byteLength(item) > maximumBytes - bytes)
        throw new RosLiveGenerationStoreError("invalid_input");
      return emit(JSON.stringify(item));
    }
    if (typeof item !== "object" || ancestors.has(item))
      throw new RosLiveGenerationStoreError("invalid_input");
    const prototype: unknown = Object.getPrototypeOf(item);
    if (
      Array.isArray(item)
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      throw new RosLiveGenerationStoreError("invalid_input");
    ancestors.add(item);
    let result: string;
    if (Array.isArray(item)) {
      if (item.length > limits.maximumNodes) throw new RosLiveGenerationStoreError("invalid_input");
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Reflect.ownKeys(descriptors).length !== item.length + 1)
        throw new RosLiveGenerationStoreError("invalid_input");
      result =
        emit("[") +
        Array.from({ length: item.length }, (_, index) => {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !Object.hasOwn(descriptor, "value"))
            throw new RosLiveGenerationStoreError("invalid_input");
          return (index > 0 ? emit(",") : "") + visit(descriptor.value, depth + 1);
        }).join("") +
        emit("]");
    } else {
      const keys = Reflect.ownKeys(item);
      if (keys.length > limits.maximumNodes || keys.some((key) => typeof key !== "string"))
        throw new RosLiveGenerationStoreError("invalid_input");
      result =
        emit("{") +
        (keys as string[])
          .sort()
          .map((key, index) => {
            const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
            if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
              throw new RosLiveGenerationStoreError("invalid_input");
            return (
              (index > 0 ? emit(",") : "") +
              visit(key, depth + 1) +
              emit(":") +
              visit(descriptor.value, depth + 1)
            );
          })
          .join("") +
        emit("}");
    }
    ancestors.delete(item);
    return result;
  };
  return visit(value, 0);
}

/**
 * Store only public football calibration and canonical templates, never league/member identifiers,
 * roster aliases, credentials, or provider payloads. Callers validate each returned unknown value
 * against their semantic schema before reuse. Keys must cover every consumed input/version.
 *
 * Records never expire on read and this store never prunes them: a running consumer may still own
 * an older generation. Coordinated operators may prune only after its users finish; the namespace,
 * per-record bounds and disk reserve bound writes without unsafe automatic retention guesses.
 */
export function createRosLiveGenerationStore(options: {
  readonly directory: string;
  readonly limits?: Partial<RosLiveGenerationStoreLimits>;
}): RosLiveGenerationStore {
  if (typeof options.directory !== "string" || options.directory.trim() === "")
    throw new RosLiveGenerationStoreError("invalid_input");
  const limits = { ...ROS_LIVE_GENERATION_STORE_LIMITS, ...options.limits };
  for (const name of Object.keys(
    ROS_LIVE_GENERATION_STORE_LIMITS,
  ) as (keyof RosLiveGenerationStoreLimits)[]) {
    if (
      !Number.isSafeInteger(limits[name]) ||
      limits[name] < 1 ||
      limits[name] > ROS_LIVE_GENERATION_STORE_LIMITS[name]
    )
      throw new RosLiveGenerationStoreError("invalid_input");
  }
  const root = path.resolve(options.directory);
  const namespace = path.join(root, ROS_LIVE_GENERATION_STORE_VERSION);
  const maximumBytes = (kind: Kind) =>
    kind === "generation"
      ? 256
      : kind === "calibration"
        ? limits.maximumCalibrationBytes
        : limits.maximumTargetsBytes;
  const location = (kind: Kind, identity: string) => path.join(namespace, kind, `${identity}.json`);
  const directories = (kind: Kind) => [root, namespace, path.join(namespace, kind)];
  const safeDirectories = async (kind: Kind): Promise<boolean> => {
    for (const directory of directories(kind)) {
      try {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new RosLiveGenerationStoreError("unsafe_directory");
      } catch (error) {
        if (errorCode(error) === "ENOENT") return false;
        throw error;
      }
    }
    return true;
  };
  const serializedEntry = (kind: Kind, identity: string, payload: string) =>
    `{"identity":"${identity}","kind":"${kind}","namespace":"${ROS_LIVE_GENERATION_STORE_VERSION}","payload":${payload}}`;
  const syncDirectory = async (directory: string) => {
    const handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  };

  const read = async (
    kind: Kind,
    identity: string,
    operation: OperationOptions = {},
  ): Promise<RosLiveGenerationJsonRead> => {
    validateIdentity(identity);
    operation.signal?.throwIfAborted();
    if (!(await safeDirectories(kind))) return { state: "missing" };
    let handle;
    try {
      // NONBLOCK also makes a malicious FIFO fail the regular-file check without hanging open().
      handle = await open(
        location(kind, identity),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { state: "missing" };
      if (["ELOOP", "ENXIO", "ENODEV"].includes(errorCode(error) ?? ""))
        throw new RosLiveGenerationStoreError("corrupt_entry");
      throw error;
    }
    try {
      operation.signal?.throwIfAborted();
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > maximumBytes(kind) + ENVELOPE_BYTES)
        throw new RosLiveGenerationStoreError("corrupt_entry");
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        operation.signal?.throwIfAborted();
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (result.bytesRead === 0) throw new RosLiveGenerationStoreError("corrupt_entry");
        offset += result.bytesRead;
      }
      const extra = await handle.read(Buffer.alloc(1), 0, 1, stat.size);
      if (extra.bytesRead !== 0) throw new RosLiveGenerationStoreError("corrupt_entry");
      let envelope: unknown;
      try {
        envelope = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new RosLiveGenerationStoreError("corrupt_entry");
      }
      if (
        !object(envelope) ||
        typeof envelope.checksum !== "string" ||
        !SHA256.test(envelope.checksum) ||
        !object(envelope.entry) ||
        envelope.entry.identity !== identity ||
        envelope.entry.kind !== kind ||
        envelope.entry.namespace !== ROS_LIVE_GENERATION_STORE_VERSION ||
        Object.keys(envelope).length !== 2 ||
        Object.keys(envelope.entry).length !== 4 ||
        !Object.hasOwn(envelope.entry, "payload")
      )
        throw new RosLiveGenerationStoreError("corrupt_entry");
      let canonical: string;
      try {
        canonical = serializedEntry(
          kind,
          identity,
          canonicalJson(envelope.entry.payload, maximumBytes(kind), limits),
        );
      } catch {
        throw new RosLiveGenerationStoreError("corrupt_entry");
      }
      if (
        hash(canonical) !== envelope.checksum ||
        !bytes.equals(Buffer.from(`{"checksum":"${envelope.checksum}","entry":${canonical}}`))
      )
        throw new RosLiveGenerationStoreError("corrupt_entry");
      operation.signal?.throwIfAborted();
      return { state: "hit", value: envelope.entry.payload, checksum: envelope.checksum };
    } finally {
      await handle.close();
    }
  };

  const write = async (
    kind: Kind,
    identity: string,
    value: unknown,
    operation: OperationOptions = {},
    firstWriterWins = false,
  ): Promise<RosLiveGenerationJsonWrite> => {
    validateIdentity(identity);
    operation.signal?.throwIfAborted();
    const entry = serializedEntry(kind, identity, canonicalJson(value, maximumBytes(kind), limits));
    const checksum = hash(entry);
    const bytes = Buffer.from(`{"checksum":"${checksum}","entry":${entry}}`);
    const existing = await read(kind, identity, operation);
    if (existing.state === "hit") {
      if (!firstWriterWins && existing.checksum !== checksum)
        throw new RosLiveGenerationStoreError("identity_conflict");
      await syncDirectory(path.join(namespace, kind));
      return { state: "existing", checksum: existing.checksum };
    }
    for (const directory of directories(kind)) {
      await mkdir(directory, { recursive: directory === root, mode: 0o700 }).catch(
        (error: unknown) => {
          if (errorCode(error) !== "EEXIST") throw error;
        },
      );
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new RosLiveGenerationStoreError("unsafe_directory");
    }
    await syncDirectory(root);
    await syncDirectory(namespace);
    const directory = path.join(namespace, kind);
    await assertRosCacheHeadroom(directory, bytes.length, operation.signal);
    const temporary = path.join(directory, `.${identity}-${randomUUID()}.partial`);
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        operation.signal?.throwIfAborted();
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      operation.signal?.throwIfAborted();
      try {
        await link(temporary, location(kind, identity));
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const winner = await read(kind, identity, operation);
        if (winner.state !== "hit") throw new RosLiveGenerationStoreError("corrupt_entry");
        if (!firstWriterWins && winner.checksum !== checksum)
          throw new RosLiveGenerationStoreError("identity_conflict");
        await syncDirectory(directory);
        return { state: "existing", checksum: winner.checksum };
      }
      await syncDirectory(directory);
      operation.signal?.throwIfAborted();
      return { state: "written", checksum };
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (errorCode(error) !== "ENOENT") throw error;
      });
    }
  };

  return {
    async getOrCreateGeneration(physicalIdentity, requestedAsOfAt, operation = {}) {
      if (!canonicalInstant(requestedAsOfAt))
        throw new RosLiveGenerationStoreError("invalid_input");
      await write("generation", physicalIdentity, { asOfAt: requestedAsOfAt }, operation, true);
      const pinned = await read("generation", physicalIdentity, operation);
      if (
        pinned.state !== "hit" ||
        !object(pinned.value) ||
        Object.keys(pinned.value).length !== 1 ||
        !canonicalInstant(pinned.value.asOfAt)
      )
        throw new RosLiveGenerationStoreError("corrupt_entry");
      if (Date.parse(pinned.value.asOfAt) > Date.parse(requestedAsOfAt))
        throw new RosLiveGenerationStoreError("identity_conflict");
      return { physicalIdentity, asOfAt: pinned.value.asOfAt };
    },
    readCalibration: (identity, operation) => read("calibration", identity, operation),
    writeCalibration: (identity, value, operation) =>
      write("calibration", identity, value, operation),
    readTargets: (identity, operation) => read("targets", identity, operation),
    writeTargets: (identity, value, operation) => write("targets", identity, value, operation),
  };
}
