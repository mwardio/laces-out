import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { NflverseFetchLike } from "@laces-out/source-nflverse";

import { assertRosCacheHeadroom } from "./ros-cache-disk-space.js";

export const ROS_VALIDATION_SOURCE_CACHE_MAX_RESPONSE_BYTES = 512 * 1_024 ** 2;
const MAX_METADATA_BYTES = 64 * 1_024;
const MAX_CACHE_FILES = 4_096;
// Leave room for the owned snapshot manifest state transition and its atomic temporary file.
const OWNER_WRITE_RESERVE = 4_096;

const checksum = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

async function boundedInventory(directory: string, maxBytes: number) {
  const stats = await lstat(directory);
  if (!stats.isDirectory()) throw new Error("Invalid bounded ROS source cache directory");
  let bytes = 0;
  let files = 0;
  for await (const entry of await opendir(directory)) {
    if (++files > MAX_CACHE_FILES) throw new Error("ROS source cache file limit exceeded");
    const item = await lstat(path.join(directory, entry.name));
    if (!item.isFile() || item.nlink !== 1 || !Number.isSafeInteger(item.size))
      throw new Error("Invalid bounded ROS source cache file");
    bytes += item.size;
    if (bytes > maxBytes) throw new Error("ROS source cache byte limit exceeded");
  }
  return { bytes, files };
}

async function boundedRead(file: string, maximumBytes: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > maximumBytes)
      throw new Error("ROS source cache read limit exceeded");
    const bytes = await handle.readFile();
    if (bytes.length > maximumBytes) throw new Error("ROS source cache read limit exceeded");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function boundedResponse(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maximumBytes) {
    await response.body?.cancel();
    throw new Error("ROS source response byte limit exceeded");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("ROS source response byte limit exceeded");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Capture official HTTP responses once; replay the exact bytes without network during release. */
export function rosValidationSourceCache(options: {
  readonly directory: string;
  readonly offline: boolean;
  readonly fetch?: NflverseFetchLike;
  /** Explicit bootstrap-only storage bounds; omitted preserves legacy/frozen cache behavior. */
  readonly maxBytes?: number;
  readonly maxResponseBytes?: number;
}): NflverseFetchLike {
  const upstream = options.fetch ?? globalThis.fetch;
  const maximumBytes = options.maxBytes;
  const bounded = maximumBytes !== undefined;
  const maximumResponse =
    options.maxResponseBytes ?? ROS_VALIDATION_SOURCE_CACHE_MAX_RESPONSE_BYTES;
  if (
    (bounded && (!Number.isSafeInteger(maximumBytes) || maximumBytes <= OWNER_WRITE_RESERVE)) ||
    !Number.isSafeInteger(maximumResponse) ||
    maximumResponse <= 0 ||
    (options.maxResponseBytes !== undefined && !bounded)
  )
    throw new RangeError("Invalid bounded ROS source cache options");
  const fetchOne: NflverseFetchLike = async (input, init) => {
    if (init?.method && init.method !== "GET")
      throw new Error("ROS source cache only supports GET");
    const url = String(input);
    const key = checksum(url);
    const metadataPath = path.join(options.directory, `${key}.json`);
    if (bounded) {
      // The owned bootstrap helper creates the directory. Never recursively create or follow a
      // caller-provided symlink in bounded mode; offline replay remains read-only below disk floor.
      await boundedInventory(options.directory, maximumBytes);
    }
    let metadataText: string | undefined;
    try {
      metadataText = bounded
        ? (await boundedRead(metadataPath, MAX_METADATA_BYTES)).toString("utf8")
        : await readFile(metadataPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (metadataText !== undefined) {
      const cached = JSON.parse(metadataText) as {
        url: string;
        status: number;
        headers: Record<string, string>;
        bodyChecksum: string;
      };
      if (cached.url !== url || !/^[a-f0-9]{64}$/u.test(cached.bodyChecksum)) {
        throw new Error(`Invalid ROS source cache identity: ${key}`);
      }
      const cachedBodyPath = path.join(options.directory, `${cached.bodyChecksum}.body`);
      const body = bounded
        ? await boundedRead(cachedBodyPath, Math.min(maximumResponse, maximumBytes))
        : await readFile(cachedBodyPath);
      if (checksum(body) !== cached.bodyChecksum)
        throw new Error(`Corrupt ROS source cache: ${key}`);
      return new Response(
        bounded && [204, 205, 304].includes(cached.status) ? null : new Uint8Array(body),
        { status: cached.status, headers: cached.headers },
      );
    }
    if (options.offline) throw new Error(`Offline ROS source cache miss: ${key}`);
    const response = await upstream(input, init);
    // Failed responses are never pinned. Redirects are pinned too, so their signed target URLs
    // resolve to saved bodies during offline replay even after the upstream signatures expire.
    const cacheable = response.ok || [301, 302, 303, 307, 308].includes(response.status);
    if (!cacheable && !bounded) return response;
    const body = bounded
      ? await boundedResponse(
          response,
          Math.min(maximumResponse, maximumBytes - OWNER_WRITE_RESERVE),
        )
      : new Uint8Array(await response.arrayBuffer());
    const responseBody = [204, 205, 304].includes(response.status) ? null : body;
    if (!cacheable)
      return new Response(responseBody, { status: response.status, headers: response.headers });
    const bodyChecksum = checksum(body);
    const headers = Object.fromEntries(response.headers.entries());
    const bodyPath = path.join(options.directory, `${bodyChecksum}.body`);
    if (!bounded) {
      // Keep the legacy/frozen capture path unchanged unless bounds were explicitly requested.
      await mkdir(options.directory, { recursive: true });
      const temporaryBody = `${bodyPath}.${randomUUID()}.partial`;
      await writeFile(temporaryBody, body, { mode: 0o600 });
      await rename(temporaryBody, bodyPath);
      const temporaryMetadata = `${metadataPath}.${randomUUID()}.partial`;
      await writeFile(
        temporaryMetadata,
        JSON.stringify({ url, status: response.status, headers, bodyChecksum }),
        { mode: 0o600 },
      );
      await rename(temporaryMetadata, metadataPath);
      return new Response(body, { status: response.status, headers });
    }
    const metadata = JSON.stringify({ url, status: response.status, headers, bodyChecksum });
    const metadataBytes = Buffer.byteLength(metadata);
    let bodyExists = false;
    if (bounded) {
      try {
        const existing = await boundedRead(bodyPath, maximumResponse);
        if (checksum(existing) !== bodyChecksum) throw new Error("Corrupt ROS source cache body");
        bodyExists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const inventory = await boundedInventory(options.directory, maximumBytes);
      const pendingBytes = (bodyExists ? 0 : body.byteLength) + metadataBytes;
      if (
        metadataBytes > MAX_METADATA_BYTES ||
        inventory.bytes + pendingBytes + OWNER_WRITE_RESERVE > maximumBytes ||
        inventory.files + (bodyExists ? 1 : 2) > MAX_CACHE_FILES
      )
        throw new Error("ROS source cache byte or file limit exceeded");
      await assertRosCacheHeadroom(options.directory, pendingBytes, init?.signal ?? undefined);
    }
    const temporaryBody = `${bodyPath}.${randomUUID()}.partial`;
    const temporaryMetadata = `${metadataPath}.${randomUUID()}.partial`;
    try {
      if (!bodyExists) {
        await writeFile(temporaryBody, body, { mode: 0o600, flag: "wx" });
        await rename(temporaryBody, bodyPath);
      }
      await writeFile(temporaryMetadata, metadata, { mode: 0o600, flag: "wx" });
      await rename(temporaryMetadata, metadataPath);
    } finally {
      // Remove only this invocation's known temporary files; an interrupted process leaves regular
      // partials counted against its budget for conservative later ownership-verified cleanup.
      await Promise.all(
        [temporaryBody, temporaryMetadata].map(async (file) => {
          try {
            await unlink(file);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }),
      );
    }
    return new Response(responseBody, { status: response.status, headers });
  };
  if (!bounded) return fetchOne;
  // One response/read/write at a time limits memory and prevents same-process quota races.
  let previous: Promise<unknown> = Promise.resolve();
  return (input, init) => {
    const next = previous.then(() => {
      init?.signal?.throwIfAborted();
      return fetchOne(input, init);
    });
    previous = next.catch(() => undefined);
    return next;
  };
}
