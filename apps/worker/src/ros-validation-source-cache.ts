import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { NflverseFetchLike } from "@laces-out/source-nflverse";

const checksum = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Capture official HTTP responses once; replay the exact bytes without network during release. */
export function rosValidationSourceCache(options: {
  readonly directory: string;
  readonly offline: boolean;
  readonly fetch?: NflverseFetchLike;
}): NflverseFetchLike {
  const upstream = options.fetch ?? globalThis.fetch;
  return async (input, init) => {
    if (init?.method && init.method !== "GET")
      throw new Error("ROS source cache only supports GET");
    const url = String(input);
    const key = checksum(url);
    const metadataPath = path.join(options.directory, `${key}.json`);
    let metadataText: string | undefined;
    try {
      metadataText = await readFile(metadataPath, "utf8");
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
      const body = await readFile(path.join(options.directory, `${cached.bodyChecksum}.body`));
      if (checksum(body) !== cached.bodyChecksum)
        throw new Error(`Corrupt ROS source cache: ${key}`);
      return new Response(new Uint8Array(body), { status: cached.status, headers: cached.headers });
    }
    if (options.offline) throw new Error(`Offline ROS source cache miss: ${key}`);
    const response = await upstream(input, init);
    // Failed responses are never pinned. Redirects are pinned too, so their signed target URLs
    // resolve to saved bodies during offline replay even after the upstream signatures expire.
    if (!response.ok && ![301, 302, 303, 307, 308].includes(response.status)) return response;
    const body = new Uint8Array(await response.arrayBuffer());
    const bodyChecksum = checksum(body);
    const headers = Object.fromEntries(response.headers.entries());
    await mkdir(options.directory, { recursive: true });
    const bodyPath = path.join(options.directory, `${bodyChecksum}.body`);
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
  };
}
